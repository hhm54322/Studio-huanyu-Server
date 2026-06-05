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
import { generateProfessionalReport } from '../report/professionalGenerator.js'
import {
  professionalReportSubmissionSchema,
  type ProfessionalParsedFile,
  type ProfessionalUploadedFile,
} from '../validators/professionalReportSubmission.js'

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

const parseMultipartSubmission = async (request: FastifyRequest) => {
  const fields: Record<string, string> = {}
  const tempSubmissionNo = `upload_${Date.now()}_${Math.random().toString(36).slice(2)}`
  const uploadedFiles: ProfessionalUploadedFile[] = []
  const parsedFiles: ProfessionalParsedFile[] = []

  for await (const part of request.parts()) {
    if (isMultipartFile(part)) {
      const uploadedFile = await saveReportUpload(part, `professional-reports/${tempSubmissionNo}`)
      uploadedFiles.push(uploadedFile)
      parsedFiles.push(await parseUploadedFile({
        ...uploadedFile,
        absolutePath: path.resolve(uploadedFile.relativePath),
      }))
    } else {
      fields[part.fieldname] = getFieldValue(part.value)
    }
  }

  const rawPayload = fields.payload ? JSON.parse(fields.payload) : fields

  return professionalReportSubmissionSchema.parse({
    ...rawPayload,
    uploadedFiles,
    parsedFiles,
  })
}

export const registerProfessionalReportSubmissionRoutes = async (app: FastifyInstance) => {
  app.post('/api/professional-report-submissions', async (request, reply) => {
    try {
      const input = request.isMultipart()
        ? await parseMultipartSubmission(request)
        : professionalReportSubmissionSchema.parse(request.body)

      const created = await createProfessionalReportSubmission(input, {
        userAgent: request.headers['user-agent'],
        ip: request.ip,
      })
      await updateProfessionalReportSubmissionResult(created.submission_no, 'generating', null)

      const report = await generateProfessionalReport(input, created.submission_no)
      await updateProfessionalReportSubmissionResult(created.submission_no, 'generated', report)

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
      return reply.code(500).send({
        success: false,
        error: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to generate professional report',
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
