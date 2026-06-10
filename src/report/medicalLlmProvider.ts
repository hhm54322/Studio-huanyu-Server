import { config } from '../config.js'

export type MedicalLlmMessage = {
  role: 'system' | 'user' | 'assistant'
  content: string
}

type RequestOptions = {
  messages: MedicalLlmMessage[]
  temperature: number
  timeoutMs?: number
  stream?: boolean
  responseFormat?: 'json_object' | ''
  maxAttempts?: number
}

type ProviderSettings = {
  apiKey: string
  baseUrl: string
  model: string
  timeoutMs: number
  stream: boolean
  responseFormat: 'json_object' | ''
  provider: string
}

const retryableStatuses = new Set([408, 429, 500, 502, 503, 504])

const sanitizeProviderError = (text: string) => text
  .replace(/sk-[A-Za-z0-9_*.-]{8,}/g, 'sk-***')
  .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer ***')

const getProviderSettings = (): ProviderSettings | null => {
  const hasMedicalKey = Boolean(config.medicalLlmApiKey.trim())
  const apiKey = hasMedicalKey ? config.medicalLlmApiKey.trim() : config.openaiApiKey.trim()
  if (!apiKey) return null

  return {
    apiKey,
    baseUrl: hasMedicalKey ? config.medicalLlmBaseUrl : config.openaiBaseUrl,
    model: hasMedicalKey ? config.medicalLlmModel : config.openaiModel,
    timeoutMs: hasMedicalKey ? config.medicalLlmTimeoutMs : config.openaiReportTimeoutMs,
    stream: hasMedicalKey ? config.medicalLlmStream : true,
    responseFormat: hasMedicalKey ? (config.medicalLlmResponseFormat === 'json_object' ? 'json_object' : '') : 'json_object',
    provider: hasMedicalKey ? config.medicalLlmProvider : 'openai-compatible',
  }
}

const normalizeMessageContent = (content: unknown) => {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''

  return content.map((part) => {
    if (typeof part === 'string') return part
    if (part && typeof part === 'object' && 'text' in part) {
      const text = (part as { text?: unknown }).text
      return typeof text === 'string' ? text : ''
    }
    return ''
  }).join('')
}

const readChatCompletionContent = async (response: Response) => {
  const contentType = response.headers.get('content-type') || ''

  if (contentType.includes('application/json')) {
    const json = await response.json() as {
      choices?: Array<{ message?: { content?: unknown } }>
    }
    const content = normalizeMessageContent(json.choices?.[0]?.message?.content)
    if (!content) throw new Error('medical LLM response did not include content')
    return content
  }

  if (!response.body) throw new Error('medical LLM response did not include a readable body')

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let content = ''

  for (;;) {
    const { done, value } = await reader.read()
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done })
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() || ''

    for (const rawLine of lines) {
      const line = rawLine.trim()
      if (!line || !line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (!data || data === '[DONE]') continue

      try {
        const chunk = JSON.parse(data) as {
          choices?: Array<{
            delta?: { content?: unknown }
            message?: { content?: unknown }
          }>
        }
        content += normalizeMessageContent(chunk.choices?.[0]?.delta?.content || chunk.choices?.[0]?.message?.content)
      } catch {
        // Ignore compatible gateway keepalive frames.
      }
    }

    if (done) break
  }

  if (!content.trim()) throw new Error('medical LLM stream did not include content')
  return content
}

const buildBody = (
  settings: ProviderSettings,
  options: RequestOptions,
  variant: { responseFormat: 'json_object' | ''; stream: boolean },
) => {
  const body: Record<string, unknown> = {
    model: settings.model,
    messages: options.messages,
    temperature: options.temperature,
    stream: variant.stream,
  }

  if (variant.responseFormat) {
    body.response_format = { type: variant.responseFormat }
  }

  return JSON.stringify(body)
}

const getRequestVariants = (settings: ProviderSettings, options: RequestOptions) => {
  const responseFormat = options.responseFormat ?? settings.responseFormat
  const stream = options.stream ?? settings.stream
  const variants = [
    { responseFormat, stream },
    { responseFormat: '' as const, stream },
    { responseFormat: '' as const, stream: false },
  ]

  return variants.filter((variant, index) => (
    variants.findIndex((item) => item.responseFormat === variant.responseFormat && item.stream === variant.stream) === index
  ))
}

export const requestMedicalChatCompletion = async (options: RequestOptions) => {
  const settings = getProviderSettings()
  if (!settings) return null

  const variants = getRequestVariants(settings, options)
  const maxAttempts = options.maxAttempts ?? 2
  let lastError = ''

  for (const variant of variants) {
    const body = buildBody(settings, options, variant)

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const response = await fetch(`${settings.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${settings.apiKey}`,
          'Content-Type': 'application/json',
        },
        body,
        signal: AbortSignal.timeout(options.timeoutMs || settings.timeoutMs),
      })

      if (!response.ok) {
        const responseBody = sanitizeProviderError(await response.text())
        lastError = `${settings.provider} ${settings.model} request failed: ${response.status} ${responseBody.slice(0, 500)}`
        if (attempt === 0 && retryableStatuses.has(response.status)) continue
        break
      }

      return readChatCompletionContent(response)
    }
  }

  throw new Error(lastError || `${settings.provider} ${settings.model} request failed`)
}
