import { readFile } from 'node:fs/promises'
import { config } from '../config.js'

export type MedicalOcrInput = {
  absolutePath: string
  originalName: string
  mimeType: string
}

export type MedicalOcrSource = {
  buffer?: Buffer | Uint8Array
  mimeType?: string
  label?: string
}

export type MedicalOcrResult = {
  text: string
  parser: string
  metadata: Record<string, unknown>
}

const supportedOcrProviders = new Set(['auto', 'openai', 'tesseract', 'baidu_medical'])
const supportedFallbackProviders = new Set(['none', 'openai', 'tesseract', 'auto'])
const baiduMedicalEndpoints = {
  healthReport: '/rest/2.0/ocr/v1/health_report',
  labReport: '/rest/2.0/ocr/v1/medical_report_detection',
} as const
const baiduGeneralEndpoints = {
  generalBasic: '/rest/2.0/ocr/v1/general_basic',
  accurateBasic: '/rest/2.0/ocr/v1/accurate_basic',
} as const

let cachedBaiduAccessToken: { token: string; expiresAt: number } | null = null

export const getOcrProvider = () => (
  supportedOcrProviders.has(config.ocrProvider) ? config.ocrProvider : 'auto'
)

export const getOcrFallbackProvider = () => (
  supportedFallbackProviders.has(config.ocrFallbackProvider) ? config.ocrFallbackProvider : 'none'
)

export const shouldUseBaiduMedicalOcr = () => getOcrProvider() === 'baidu_medical'

export const shouldUseVisionOcr = () => ['auto', 'openai'].includes(getOcrProvider())

export const shouldUseVisionOcrFallback = () => ['auto', 'openai'].includes(getOcrFallbackProvider())

export const shouldUseTesseractFallback = () => (
  ['auto', 'tesseract'].includes(getOcrProvider()) || ['auto', 'tesseract'].includes(getOcrFallbackProvider())
)

const extractJson = (content: string) => {
  const trimmed = content.trim()
  if (trimmed.startsWith('{')) return trimmed
  const match = trimmed.match(/\{[\s\S]*\}/)
  return match ? match[0] : trimmed
}

const sanitizeProviderError = (text: string) => text
  .replace(/sk-[A-Za-z0-9_*.-]{8,}/g, 'sk-***')
  .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer ***')
  .replace(/(client_secret=)[^&\s]+/gi, '$1***')
  .replace(/(client_id=)[^&\s]+/gi, '$1***')

const getBaiduAccessToken = async () => {
  if (cachedBaiduAccessToken && cachedBaiduAccessToken.expiresAt > Date.now() + 60_000) {
    return cachedBaiduAccessToken.token
  }

  if (!config.baiduOcrApiKey || !config.baiduOcrSecretKey) {
    throw new Error('baidu medical OCR is enabled but BAIDU_OCR_API_KEY or BAIDU_OCR_SECRET_KEY is missing')
  }

  const tokenUrl = new URL(config.baiduOcrTokenUrl)
  tokenUrl.searchParams.set('grant_type', 'client_credentials')
  tokenUrl.searchParams.set('client_id', config.baiduOcrApiKey)
  tokenUrl.searchParams.set('client_secret', config.baiduOcrSecretKey)

  const response = await fetch(tokenUrl, {
    method: 'POST',
    signal: AbortSignal.timeout(config.baiduOcrTimeoutMs),
  })
  const body = await response.text()
  let parsed: { access_token?: string; expires_in?: number; error?: string; error_description?: string } = {}
  try {
    parsed = JSON.parse(body) as typeof parsed
  } catch {
    // Keep parsed empty and surface the sanitized provider body below.
  }

  if (!response.ok || !parsed.access_token) {
    throw new Error(`baidu OCR token request failed: ${response.status} ${sanitizeProviderError(body).slice(0, 240)}`)
  }

  cachedBaiduAccessToken = {
    token: parsed.access_token,
    expiresAt: Date.now() + Math.max(60, parsed.expires_in || 25 * 24 * 60 * 60) * 1000,
  }
  return cachedBaiduAccessToken.token
}

const isLikelyLabReport = (input: MedicalOcrInput, source: MedicalOcrSource) => {
  const text = `${input.originalName} ${source.label || ''}`.toLowerCase()
  return [
    '检验',
    '化验',
    '实验室',
    'lab',
    'laboratory',
    '血常规',
    '尿常规',
    '生化',
    '肝功',
    '肾功',
    '肿瘤标志物',
    'cea',
    'afp',
    'ca125',
    'ca15',
    'ca19',
  ].some((keyword) => text.includes(keyword.toLowerCase()))
}

const getBaiduMedicalEndpoint = (input: MedicalOcrInput, source: MedicalOcrSource) => {
  const configured = config.baiduMedicalOcrEndpoint
  if (configured === 'health_report') return baiduMedicalEndpoints.healthReport
  if (configured === 'medical_report_detection' || configured === 'lab_report') return baiduMedicalEndpoints.labReport
  return isLikelyLabReport(input, source) ? baiduMedicalEndpoints.labReport : baiduMedicalEndpoints.healthReport
}

const getBaiduMedicalEndpointAttempts = (input: MedicalOcrInput, source: MedicalOcrSource) => {
  const primary = getBaiduMedicalEndpoint(input, source)
  if (config.baiduMedicalOcrEndpoint !== 'auto') return [primary]

  const alternate = primary === baiduMedicalEndpoints.labReport
    ? baiduMedicalEndpoints.healthReport
    : baiduMedicalEndpoints.labReport
  return [primary, alternate]
}

const getBaiduGeneralEndpoint = () => (
  config.baiduOcrGeneralEndpoint === 'accurate_basic'
    ? baiduGeneralEndpoints.accurateBasic
    : baiduGeneralEndpoints.generalBasic
)

const getBaiduGeneralOcrOptions = () => ({
  language_type: config.baiduOcrGeneralEndpoint === 'accurate_basic'
    ? 'auto_detect'
    : config.baiduOcrGeneralLanguage,
  detect_direction: 'true',
})

const getBaiduParserName = (endpoint: string) => {
  if (endpoint.includes('medical_report_detection')) return 'baidu-medical-report-detection'
  if (endpoint.includes('health_report')) return 'baidu-health-report'
  if (endpoint.includes('accurate_basic')) return 'baidu-accurate-basic'
  return 'baidu-general-basic'
}

const isBaiduMedicalTextUsable = (text: string) => (
  text.replace(/\s+/g, '').length >= config.baiduMedicalOcrMinTextLength
)

const appendBaiduLine = (lines: string[], label: string, value: unknown) => {
  if (value === undefined || value === null) return
  const text = String(value).replace(/\s+/g, ' ').trim()
  if (!text) return
  lines.push(label ? `${label}: ${text}` : text)
}

const collectBaiduWords = (value: unknown, lines: string[], parentKey = '') => {
  if (Array.isArray(value)) {
    value.forEach((item) => collectBaiduWords(item, lines, parentKey))
    return
  }
  if (!value || typeof value !== 'object') {
    appendBaiduLine(lines, parentKey, value)
    return
  }

  const record = value as Record<string, unknown>
  const wordName = typeof record.word_name === 'string' ? record.word_name : parentKey
  if ('word' in record) {
    appendBaiduLine(lines, wordName, record.word)
    return
  }
  if ('words' in record) {
    appendBaiduLine(lines, wordName, record.words)
    return
  }

  Object.entries(record)
    .filter(([key]) => !['location', 'probability'].includes(key))
    .forEach(([key, child]) => collectBaiduWords(child, lines, key))
}

const compactBaiduResultShape = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.slice(0, 8).map(compactBaiduResultShape)
  if (!value || typeof value !== 'object') return value
  const record = value as Record<string, unknown>
  if ('word_name' in record || 'word' in record || 'words' in record) {
    return {
      word_name: record.word_name,
      word: record.word || record.words,
    }
  }
  return Object.fromEntries(Object.entries(record).slice(0, 12).map(([key, child]) => [key, compactBaiduResultShape(child)]))
}

const requestBaiduOcr = async (
  endpoint: string,
  buffer: Buffer,
  accessToken: string,
  options: Record<string, string> = {},
) => {
  const url = new URL(`${config.baiduOcrBaseUrl}${endpoint}`)
  url.searchParams.set('access_token', accessToken)

  const body = new URLSearchParams()
  body.set('image', buffer.toString('base64'))
  Object.entries(options).forEach(([key, value]) => body.set(key, value))

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
    signal: AbortSignal.timeout(config.baiduOcrTimeoutMs),
  })
  const responseText = await response.text()
  let json: {
    log_id?: number | string
    error_code?: number
    error_msg?: string
    words_result?: unknown
    words_result_num?: number
    CommonData_result_num?: number
    Item_row_num?: number
  } = {}
  try {
    json = JSON.parse(responseText) as typeof json
  } catch {
    // Surface the raw sanitized body below.
  }

  if (!response.ok || json.error_code) {
    throw new Error(`baidu OCR failed: ${response.status} ${json.error_code || ''} ${sanitizeProviderError(json.error_msg || responseText).slice(0, 240)}`)
  }

  const lines: string[] = []
  collectBaiduWords(json.words_result, lines)
  const uniqueLines = Array.from(new Set(lines.map((line) => line.trim()).filter(Boolean)))
  const text = uniqueLines.join('\n').trim()

  return { endpoint, json, text }
}

const buildBaiduOcrResult = (
  attempt: Awaited<ReturnType<typeof requestBaiduOcr>>,
  attempts: Array<{ endpoint: string; parser: string; textLength: number; logId?: number | string }>,
): MedicalOcrResult => {
  const { endpoint, json, text } = attempt

  return {
    text,
    parser: getBaiduParserName(endpoint),
    metadata: {
      provider: 'baidu',
      endpoint,
      attempts,
      logId: json.log_id,
      wordsResultNum: json.words_result_num,
      commonDataResultNum: json.CommonData_result_num,
      itemRowNum: json.Item_row_num,
      resultShape: compactBaiduResultShape(json.words_result),
    },
  }
}

export const recognizeBaiduMedicalImage = async (
  input: MedicalOcrInput,
  source: MedicalOcrSource = {},
): Promise<MedicalOcrResult | null> => {
  if (!shouldUseBaiduMedicalOcr()) return null

  const buffer = source.buffer ? Buffer.from(source.buffer) : await readFile(input.absolutePath)
  const accessToken = await getBaiduAccessToken()
  const attempts: Array<{ endpoint: string; parser: string; textLength: number; logId?: number | string }> = []

  for (const endpoint of getBaiduMedicalEndpointAttempts(input, source)) {
    const attempt = await requestBaiduOcr(endpoint, buffer, accessToken)
    attempts.push({
      endpoint,
      parser: getBaiduParserName(endpoint),
      textLength: attempt.text.length,
      logId: attempt.json.log_id,
    })
    if (attempt.text && isBaiduMedicalTextUsable(attempt.text)) {
      return buildBaiduOcrResult(attempt, attempts)
    }
  }

  if (!config.baiduOcrGeneralFallback) return null

  try {
    const endpoint = getBaiduGeneralEndpoint()
    const attempt = await requestBaiduOcr(endpoint, buffer, accessToken, getBaiduGeneralOcrOptions())
    attempts.push({
      endpoint,
      parser: getBaiduParserName(endpoint),
      textLength: attempt.text.length,
      logId: attempt.json.log_id,
    })
    if (attempt.text) return buildBaiduOcrResult(attempt, attempts)
    return null
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error([
      'baidu medical OCR returned no readable text; baidu general OCR fallback failed',
      `${message}.`,
      'Enable Baidu 通用文字识别（标准版） or set BAIDU_OCR_GENERAL_ENDPOINT=accurate_basic after enabling 高精度版.',
    ].join(': '))
  }
}

export const recognizeOpenaiVisionImage = async (
  input: MedicalOcrInput,
  source: MedicalOcrSource = {},
): Promise<MedicalOcrResult | null> => {
  if ((!shouldUseVisionOcr() && !shouldUseVisionOcrFallback()) || !config.openaiApiKey) return null

  const buffer = source.buffer ? Buffer.from(source.buffer) : await readFile(input.absolutePath)
  const mimeType = source.mimeType || input.mimeType || 'image/jpeg'
  const dataUrl = `data:${mimeType};base64,${buffer.toString('base64')}`
  const response = await fetch(`${config.openaiBaseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.openaiApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: config.openaiVisionModel,
      messages: [
        {
          role: 'system',
          content: [
            '你是医学资料图片识别与结构化摘要助手。',
            '只读取图片或PDF截图中真实可见的内容，不得补写、推断诊断、扩展治疗建议。',
            '遇到模糊、遮挡、低清晰度、非医学资料，必须在 recognitionNotes 中说明。',
            '输出严格JSON。',
          ].join('\n'),
        },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: [
                `请识别这份医学资料${source.label ? `（${source.label}）` : ''}。`,
                '优先保留原始报告中的日期、检查类型、诊断、病理、免疫组化、影像所见、检验指标、数值、单位和结论。',
                '返回 JSON：{ "extractedText": "尽量完整的原文", "medicalSummary": "关键医学事实摘要", "recognitionNotes": ["无法确认、模糊或需要人工复核之处"] }。',
                '如果无法辨认，extractedText 留空，不要猜测。',
              ].join('\n'),
            },
            {
              type: 'image_url',
              image_url: {
                url: dataUrl,
                detail: 'high',
              },
            },
          ],
        },
      ],
      temperature: 0,
      response_format: { type: 'json_object' },
      stream: false,
    }),
    signal: AbortSignal.timeout(config.openaiVisionTimeoutMs),
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`openai vision OCR failed: ${response.status} ${sanitizeProviderError(body).slice(0, 240)}`)
  }

  const json = await response.json() as { choices?: Array<{ message?: { content?: string } }> }
  const content = json.choices?.[0]?.message?.content
  if (!content) throw new Error('openai vision OCR response did not include content')

  const parsed = JSON.parse(extractJson(content)) as {
    extractedText?: string
    medicalSummary?: string
    recognitionNotes?: string[]
  }
  const text = [
    parsed.extractedText || '',
    parsed.medicalSummary ? `\n\n医学摘要：${parsed.medicalSummary}` : '',
  ].join('').trim()

  if (!text) return null

  return {
    text,
    parser: 'openai-vision',
    metadata: {
      provider: 'openai',
      model: config.openaiVisionModel,
      recognitionNotes: Array.isArray(parsed.recognitionNotes) ? parsed.recognitionNotes : [],
    },
  }
}

export const recognizeTesseractImage = async (image: string | Buffer): Promise<MedicalOcrResult> => {
  const { createWorker } = await import('tesseract.js')
  const worker = await createWorker('eng+chi_sim')
  try {
    const result = await worker.recognize(image)
    return {
      text: result.data.text,
      parser: 'tesseract.js',
      metadata: {
        provider: 'tesseract',
        confidence: result.data.confidence,
      },
    }
  } finally {
    await worker.terminate()
  }
}
