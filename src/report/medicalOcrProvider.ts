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

const supportedOcrProviders = new Set(['auto', 'openai', 'tesseract'])

export const getOcrProvider = () => (
  supportedOcrProviders.has(config.ocrProvider) ? config.ocrProvider : 'auto'
)

export const shouldUseVisionOcr = () => ['auto', 'openai'].includes(getOcrProvider())

export const shouldUseTesseractFallback = () => ['auto', 'tesseract'].includes(getOcrProvider())

const extractJson = (content: string) => {
  const trimmed = content.trim()
  if (trimmed.startsWith('{')) return trimmed
  const match = trimmed.match(/\{[\s\S]*\}/)
  return match ? match[0] : trimmed
}

const sanitizeProviderError = (text: string) => text
  .replace(/sk-[A-Za-z0-9_*.-]{8,}/g, 'sk-***')
  .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer ***')

export const recognizeOpenaiVisionImage = async (
  input: MedicalOcrInput,
  source: MedicalOcrSource = {},
): Promise<MedicalOcrResult | null> => {
  if (!shouldUseVisionOcr() || !config.openaiApiKey) return null

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
