import { mkdir, stat } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { type MultipartFile, type MultipartValue } from '@fastify/multipart'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { ZodError } from 'zod'
import { config } from '../config.js'
import {
  createProfessionalReportSubmission,
  getProfessionalReportSubmission,
  updateProfessionalReportSubmissionResult,
} from '../db/professionalReportSubmissions.js'
import { parseUploadedFile } from '../report/fileParser.js'
import {
  getParsedFileStatusCounts,
  type ParsedFileMetric,
  type ReportGenerationEvent,
  writeReportGenerationEvent,
} from '../report/generationEventLog.js'
import { generateProfessionalReport } from '../report/professionalGenerator.js'
import {
  professionalReportSubmissionSchema,
  type ProfessionalParsedFile,
  type ProfessionalUploadedFile,
} from '../validators/professionalReportSubmission.js'

const getErrorMessage = (error: unknown) => error instanceof Error ? error.message : String(error)
type GenerationLogMeta = Pick<
  ReportGenerationEvent,
  | 'locale'
  | 'visitPurpose'
  | 'selectedRegionCount'
  | 'hasUploads'
  | 'uploadedFileCount'
  | 'parsedFileCount'
  | 'parsedFileStatuses'
  | 'uploadedTotalBytes'
  | 'phaseDurationsMs'
  | 'parsedFileMetrics'
>

const allowedMimeTypes = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/dicom',
  'application/octet-stream',
  'text/plain',
])

const isMultipartFile = (part: MultipartFile | MultipartValue): part is MultipartFile => part.type === 'file'

const safeFileName = (fileName: string) => {
  const parsed = path.parse(fileName)
  const name = parsed.name.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80) || 'file'
  const ext = parsed.ext.replace(/[^a-zA-Z0-9.]/g, '').slice(0, 16)
  return `${name}${ext}`
}

const getFieldValue = (value: MultipartValue['value']) => (
  typeof value === 'string' ? value : JSON.stringify(value ?? '')
)

export const saveReportUpload = async (part: MultipartFile, folder: string): Promise<ProfessionalUploadedFile> => {
  if (part.mimetype && !allowedMimeTypes.has(part.mimetype)) {
    throw new Error(`Unsupported file type: ${part.mimetype}`)
  }

  const uploadRoot = path.resolve(config.uploadDir, folder)
  await mkdir(uploadRoot, { recursive: true })

  const originalName = part.filename || 'medical-file'
  const storedName = `${Date.now()}-${Math.random().toString(36).slice(2)}-${safeFileName(originalName)}`
  const fullPath = path.join(uploadRoot, storedName)
  await pipeline(part.file, createWriteStream(fullPath))
  const fileStat = await stat(fullPath)

  return {
    fieldName: part.fieldname,
    originalName,
    storedName,
    relativePath: path.relative(process.cwd(), fullPath),
    mimeType: part.mimetype || 'application/octet-stream',
    size: fileStat.size,
  }
}

const sanitizeMetricText = (value: unknown, limit = 180) => String(value ?? '')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, limit)

const getParsedFileMetric = (
  uploadedFile: ProfessionalUploadedFile,
  parsedFile: ProfessionalParsedFile,
  uploadDurationMs: number,
  parseDurationMs: number,
): ParsedFileMetric => {
  const metadata = parsedFile.metadata || {}
  const attempts = Array.isArray(metadata.attempts) ? metadata.attempts : []

  return {
    originalName: uploadedFile.originalName,
    mimeType: uploadedFile.mimeType,
    size: uploadedFile.size,
    status: parsedFile.status,
    parser: parsedFile.parser,
    textLength: parsedFile.text.length,
    summaryLength: parsedFile.summary.length,
    uploadDurationMs,
    parseDurationMs,
    durationMs: uploadDurationMs + parseDurationMs,
    ocrProvider: typeof metadata.provider === 'string' ? metadata.provider : undefined,
    ocrEndpoint: typeof metadata.endpoint === 'string' ? metadata.endpoint : undefined,
    ocrAttempts: attempts.slice(0, 8).map((attempt) => {
      const item = attempt as Record<string, unknown>
      return {
        parser: typeof item.parser === 'string' ? item.parser : undefined,
        endpoint: typeof item.endpoint === 'string' ? item.endpoint : undefined,
        textLength: typeof item.textLength === 'number' ? item.textLength : undefined,
        durationMs: typeof item.durationMs === 'number' ? item.durationMs : undefined,
      }
    }),
    pdfOcrPagesAttempted: typeof metadata.pdfOcrPagesAttempted === 'number' ? metadata.pdfOcrPagesAttempted : undefined,
    pdfOcrTotalPages: typeof metadata.pdfOcrTotalPages === 'number' ? metadata.pdfOcrTotalPages : undefined,
    error: parsedFile.error ? sanitizeMetricText(parsedFile.error) : undefined,
  }
}

type MultipartParseResult = {
  input: ReturnType<typeof professionalReportSubmissionSchema.parse>
  phaseDurationsMs: Record<string, number>
  parsedFileMetrics: ParsedFileMetric[]
}

const parseMultipartSubmission = async (request: FastifyRequest): Promise<MultipartParseResult> => {
  const fields: Record<string, string> = {}
  const tempSubmissionNo = `upload_${Date.now()}_${Math.random().toString(36).slice(2)}`
  const uploadedFiles: ProfessionalUploadedFile[] = []
  const parsedFiles: ProfessionalParsedFile[] = []
  const parsedFileMetrics: ParsedFileMetric[] = []
  const phaseDurationsMs: Record<string, number> = {
    uploadSave: 0,
    fileParse: 0,
  }

  for await (const part of request.parts()) {
    if (isMultipartFile(part)) {
      const uploadStartedAt = Date.now()
      const uploadedFile = await saveReportUpload(part, `professional-reports/${tempSubmissionNo}`)
      const uploadDurationMs = Date.now() - uploadStartedAt
      phaseDurationsMs.uploadSave += uploadDurationMs
      uploadedFiles.push(uploadedFile)

      const parseStartedAt = Date.now()
      const parsedFile = await parseUploadedFile({
        ...uploadedFile,
        absolutePath: path.resolve(uploadedFile.relativePath),
      })
      const parseDurationMs = Date.now() - parseStartedAt
      phaseDurationsMs.fileParse += parseDurationMs
      parsedFiles.push(parsedFile)
      parsedFileMetrics.push(getParsedFileMetric(uploadedFile, parsedFile, uploadDurationMs, parseDurationMs))
    } else {
      fields[part.fieldname] = getFieldValue(part.value)
    }
  }

  const rawPayload = fields.payload ? JSON.parse(fields.payload) : fields

  return {
    input: professionalReportSubmissionSchema.parse({
      ...rawPayload,
      uploadedFiles: [
        ...(Array.isArray(rawPayload.uploadedFiles) ? rawPayload.uploadedFiles : []),
        ...uploadedFiles,
      ],
      parsedFiles: [
        ...(Array.isArray(rawPayload.parsedFiles) ? rawPayload.parsedFiles : []),
        ...parsedFiles,
      ],
    }),
    phaseDurationsMs,
    parsedFileMetrics,
  }
}

export const registerProfessionalReportSubmissionRoutes = async (app: FastifyInstance) => {
  app.post('/api/professional-report-submissions', async (request, reply) => {
    let createdSubmissionNo = ''
    let logMeta: Partial<GenerationLogMeta> = {}
    const startedAt = Date.now()
    try {
      const parseStartedAt = Date.now()
      const multipartResult = request.isMultipart()
        ? await parseMultipartSubmission(request)
        : null
      const input = multipartResult
        ? multipartResult.input
        : professionalReportSubmissionSchema.parse(request.body)
      const parseRequestDurationMs = Date.now() - parseStartedAt
      const phaseDurationsMs: Record<string, number> = {
        requestParse: parseRequestDurationMs,
        ...(multipartResult?.phaseDurationsMs || {}),
      }
      logMeta = {
        locale: input.locale,
        visitPurpose: input.medical.visitPurpose,
        selectedRegionCount: input.preferences.selectedRegions.length,
        hasUploads: input.uploadedFiles.length > 0,
        uploadedFileCount: input.uploadedFiles.length,
        parsedFileCount: input.parsedFiles.length,
        parsedFileStatuses: getParsedFileStatusCounts(input.parsedFiles),
        uploadedTotalBytes: input.uploadedFiles.reduce((sum, file) => sum + file.size, 0),
        phaseDurationsMs,
        parsedFileMetrics: multipartResult?.parsedFileMetrics,
      }

      const dbCreateStartedAt = Date.now()
      const created = await createProfessionalReportSubmission(input, {
        userAgent: request.headers['user-agent'],
        ip: request.ip,
      })
      createdSubmissionNo = created.submission_no
      await updateProfessionalReportSubmissionResult(created.submission_no, 'generating', null)
      phaseDurationsMs.dbCreate = Date.now() - dbCreateStartedAt
      await writeReportGenerationEvent({
        event: 'generation_started',
        mode: 'professional',
        status: 'started',
        submissionNo: created.submission_no,
        ...logMeta,
      }).catch((logError) => request.log.error(logError))

      const generationStartedAt = Date.now()
      let report
      try {
        report = await generateProfessionalReport(input, created.submission_no, {
          onPhaseDuration: (phase, durationMs) => {
            phaseDurationsMs[phase] = durationMs
          },
        })
      } finally {
        phaseDurationsMs.reportGeneration = Date.now() - generationStartedAt
      }
      const dbUpdateStartedAt = Date.now()
      await updateProfessionalReportSubmissionResult(created.submission_no, 'generated', report)
      phaseDurationsMs.dbUpdate = Date.now() - dbUpdateStartedAt
      await writeReportGenerationEvent({
        event: 'generation_completed',
        mode: 'professional',
        status: 'generated',
        submissionNo: created.submission_no,
        durationMs: Date.now() - startedAt,
        ...logMeta,
        generatedBy: report.generatedBy,
      }).catch((logError) => request.log.error(logError))

      return reply.code(201).send({
        success: true,
        submissionId: created.id,
        submissionNo: created.submission_no,
        status: 'generated',
        createdAt: created.created_at,
        report,
      })
    } catch (error) {
      if (error instanceof ZodError) {
        return reply.code(400).send({
          success: false,
          error: 'VALIDATION_ERROR',
          message: 'Invalid professional report payload',
          issues: error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        })
      }

      request.log.error(error)
      if (createdSubmissionNo) {
        await writeReportGenerationEvent({
          event: 'generation_completed',
          mode: 'professional',
          status: 'failed',
          submissionNo: createdSubmissionNo,
          durationMs: Date.now() - startedAt,
          ...logMeta,
          errorCode: 'PROFESSIONAL_REPORT_GENERATION_FAILED',
          errorMessage: getErrorMessage(error),
        }).catch((logError) => request.log.error(logError))
        await updateProfessionalReportSubmissionResult(createdSubmissionNo, 'failed', {
          error: 'PROFESSIONAL_REPORT_GENERATION_FAILED',
          message: 'Medical LLM did not return a complete qualified professional report.',
        }).catch((dbError) => request.log.error(dbError))
      }
      return reply.code(500).send({
        success: false,
        error: 'PROFESSIONAL_REPORT_GENERATION_FAILED',
        message: '本次专业报告未通过质量检查，请稍后重试，或确认上传资料清晰完整。我们没有使用通用模板替代，以避免生成不准确的报告。',
      })
    }
  })

  app.get('/api/professional-report-submissions/:submissionNo', async (request, reply) => {
    const { submissionNo } = request.params as { submissionNo: string }
    const row = await getProfessionalReportSubmission(submissionNo)

    if (!row) {
      return reply.code(404).send({
        success: false,
        error: 'NOT_FOUND',
        message: 'Professional report submission not found',
      })
    }

    return reply.send({
      success: true,
      submissionId: row.id,
      submissionNo: row.submission_no,
      status: row.report_status,
      createdAt: row.created_at,
      report: row.report_result,
    })
  })
}
