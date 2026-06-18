import { AsyncLocalStorage } from 'node:async_hooks'
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
  maxTokens?: number
  maxAttempts?: number
  disableFallbackVariants?: boolean
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
const sleep = (ms: number) => new Promise((resolve) => {
  setTimeout(resolve, ms)
})

export type MedicalLlmRequestUsage = {
  id: number
  provider: string
  model: string
  startedAt: string
  durationMs?: number
  variantsTried: number
  httpAttempts: number
  success: boolean
  error?: string
}

export type MedicalLlmUsageMetrics = {
  logicalRequests: number
  successfulLogicalRequests: number
  failedLogicalRequests: number
  httpRequests: number
  requests: MedicalLlmRequestUsage[]
}

let medicalLlmRequestSeq = 0
const medicalLlmUsageStorage = new AsyncLocalStorage<MedicalLlmUsageMetrics>()

export const createMedicalLlmUsageMetrics = (): MedicalLlmUsageMetrics => ({
  logicalRequests: 0,
  successfulLogicalRequests: 0,
  failedLogicalRequests: 0,
  httpRequests: 0,
  requests: [],
})

export const runWithMedicalLlmUsageMetrics = async <T>(
  metrics: MedicalLlmUsageMetrics,
  task: () => Promise<T>,
) => medicalLlmUsageStorage.run(metrics, task)

export const summarizeMedicalLlmUsageMetrics = (metrics: MedicalLlmUsageMetrics) => ({
  logicalRequests: metrics.logicalRequests,
  successfulLogicalRequests: metrics.successfulLogicalRequests,
  failedLogicalRequests: metrics.failedLogicalRequests,
  httpRequests: metrics.httpRequests,
  requests: metrics.requests.map((request) => ({
    id: request.id,
    provider: request.provider,
    model: request.model,
    durationMs: request.durationMs,
    variantsTried: request.variantsTried,
    httpAttempts: request.httpAttempts,
    success: request.success,
    error: request.error,
  })),
})

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
  let rawText = ''

  for (;;) {
    const { done, value } = await reader.read()
    const chunkText = decoder.decode(value || new Uint8Array(), { stream: !done })
    rawText += chunkText
    buffer += chunkText
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

  if (!content.trim()) {
    const fallbackText = rawText.trim()
    if (fallbackText) {
      try {
        const json = JSON.parse(fallbackText) as {
          choices?: Array<{
            delta?: { content?: unknown }
            message?: { content?: unknown }
          }>
        }
        content = normalizeMessageContent(json.choices?.[0]?.message?.content || json.choices?.[0]?.delta?.content)
      } catch {
        const stripped = fallbackText
          .split(/\r?\n/)
          .map((line) => line.trim().replace(/^data:\s*/, ''))
          .filter((line) => line && line !== '[DONE]')
          .join('\n')
          .trim()
        content = stripped
      }
    }
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

  if (settings.provider === 'ant_ling' || /ant/i.test(settings.model)) {
    body.chat_template_kwargs = { enable_thinking: false }
  }

  if (variant.responseFormat) {
    body.response_format = { type: variant.responseFormat }
  }
  if (options.maxTokens) {
    body.max_tokens = options.maxTokens
  }

  return JSON.stringify(body)
}

const getRequestVariants = (settings: ProviderSettings, options: RequestOptions) => {
  const responseFormat = options.responseFormat ?? settings.responseFormat
  const stream = options.stream ?? settings.stream
  if (options.disableFallbackVariants) return [{ responseFormat, stream }]

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

  const metrics = medicalLlmUsageStorage.getStore()
  const requestUsage: MedicalLlmRequestUsage | null = metrics
    ? {
      id: ++medicalLlmRequestSeq,
      provider: settings.provider,
      model: settings.model,
      startedAt: new Date().toISOString(),
      variantsTried: 0,
      httpAttempts: 0,
      success: false,
    }
    : null
  const requestStartedAt = Date.now()
  if (metrics && requestUsage) {
    metrics.logicalRequests += 1
    metrics.requests.push(requestUsage)
  }

  const variants = getRequestVariants(settings, options)
  const maxAttempts = Math.max(options.maxAttempts ?? 2, 3)
  let lastError = ''
  let finalError = ''

  try {
    for (const variant of variants) {
      const body = buildBody(settings, options, variant)
      if (requestUsage) requestUsage.variantsTried += 1

      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        if (metrics) metrics.httpRequests += 1
        if (requestUsage) requestUsage.httpAttempts += 1
        let response: Response
        try {
          response = await fetch(`${settings.baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${settings.apiKey}`,
              'Content-Type': 'application/json',
            },
            body,
            signal: AbortSignal.timeout(options.timeoutMs || settings.timeoutMs),
          })
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error)
          if (attempt < maxAttempts - 1) {
            await sleep(500 * (attempt + 1))
            continue
          }
          break
        }

        if (!response.ok) {
          const responseBody = sanitizeProviderError(await response.text())
          lastError = `${settings.provider} ${settings.model} request failed: ${response.status} ${responseBody.slice(0, 500)}`
          if (attempt < maxAttempts - 1 && retryableStatuses.has(response.status)) {
            await sleep(500 * (attempt + 1))
            continue
          }
          break
        }

        try {
          const content = await readChatCompletionContent(response)
          if (requestUsage) requestUsage.success = true
          return content
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error)
          if (attempt < maxAttempts - 1) continue
          break
        }
      }
    }

    finalError = lastError || `${settings.provider} ${settings.model} request failed`
    throw new Error(finalError)
  } catch (error) {
    finalError = error instanceof Error ? error.message : String(error)
    throw error
  } finally {
    if (metrics && requestUsage) {
      requestUsage.durationMs = Date.now() - requestStartedAt
      if (requestUsage.success) {
        metrics.successfulLogicalRequests += 1
      } else {
        metrics.failedLogicalRequests += 1
        requestUsage.error = sanitizeProviderError(finalError).slice(0, 500)
      }
    }
  }
}
