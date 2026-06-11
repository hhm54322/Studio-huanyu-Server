import { appendFile, mkdir, readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { config } from '../config.js'

export type ReportGenerationMode = 'free' | 'professional'
export type ReportGenerationStatus = 'started' | 'generated' | 'failed'

export type ReportGenerationEvent = {
  timestamp: string
  event: 'generation_started' | 'generation_completed'
  mode: ReportGenerationMode
  status: ReportGenerationStatus
  submissionNo?: string
  durationMs?: number
  locale?: string
  visitPurpose?: string
  selectedRegionCount?: number
  hasUploads?: boolean
  uploadedFileCount?: number
  parsedFileCount?: number
  parsedFileStatuses?: Record<string, number>
  generatedBy?: 'llm' | 'rules'
  errorCode?: string
  errorMessage?: string
  provider: string
  model: string
  strictReports: boolean
}

const logFileDate = (date = new Date()) => date.toISOString().slice(0, 10)

const sanitizeLogText = (value: unknown, limit = 300) => String(value ?? '')
  .replace(/sk-[A-Za-z0-9_*.-]{8,}/g, 'sk-***')
  .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer ***')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, limit)

const withRuntimeFields = (event: Omit<ReportGenerationEvent, 'timestamp' | 'provider' | 'model' | 'strictReports'>): ReportGenerationEvent => ({
  ...event,
  timestamp: new Date().toISOString(),
  provider: config.medicalLlmApiKey.trim() ? config.medicalLlmProvider : 'openai-compatible',
  model: config.medicalLlmApiKey.trim() ? config.medicalLlmModel : config.openaiModel,
  strictReports: config.medicalLlmStrictReports,
  errorMessage: event.errorMessage ? sanitizeLogText(event.errorMessage) : undefined,
})

export const getParsedFileStatusCounts = (files: Array<{ status?: string }>) => files.reduce<Record<string, number>>((acc, file) => {
  const status = file.status || 'unknown'
  acc[status] = (acc[status] || 0) + 1
  return acc
}, {})

export const writeReportGenerationEvent = async (
  event: Omit<ReportGenerationEvent, 'timestamp' | 'provider' | 'model' | 'strictReports'>,
) => {
  const fullEvent = withRuntimeFields(event)
  const logDir = path.resolve(config.reportGenerationLogDir)
  await mkdir(logDir, { recursive: true })
  const logPath = path.join(logDir, `report-generation-${logFileDate()}.jsonl`)
  await appendFile(logPath, `${JSON.stringify(fullEvent)}\n`, 'utf8')
}

export const listReportGenerationLogFiles = async () => {
  const logDir = path.resolve(config.reportGenerationLogDir)
  try {
    const names = await readdir(logDir)
    return names
      .filter((name) => /^report-generation-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
      .sort()
      .map((name) => path.join(logDir, name))
  } catch {
    return []
  }
}

export const readReportGenerationEvents = async () => {
  const files = await listReportGenerationLogFiles()
  const events: ReportGenerationEvent[] = []

  for (const file of files) {
    const content = await readFile(file, 'utf8').catch(() => '')
    for (const line of content.split(/\r?\n/)) {
      if (!line.trim()) continue
      try {
        const parsed = JSON.parse(line) as ReportGenerationEvent
        if (parsed.timestamp && parsed.mode && parsed.status) events.push(parsed)
      } catch {
        // Ignore malformed lines so one bad write does not break analysis.
      }
    }
  }

  return events
}
