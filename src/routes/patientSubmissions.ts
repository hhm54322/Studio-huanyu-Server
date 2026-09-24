import type { FastifyInstance } from 'fastify'
import { unlink } from 'node:fs/promises'
import path from 'node:path'
import { ZodError } from 'zod'
import { createConsultationSubmission, createDentalAssessment, type DentalUploadedFile } from '../db/patientSubmissions.js'
import { saveReportUpload } from './professionalReportSubmissions.js'
import { consultationSubmissionSchema, dentalAssessmentSchema } from '../validators/patientSubmissions.js'

const errorResponse = (error: unknown) => {
  if (error instanceof ZodError) {
    return { status: 400, body: { success: false, error: 'VALIDATION_ERROR', message: 'Invalid submission payload', issues: error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })) } }
  }
  const code = typeof error === 'object' && error && 'code' in error ? String(error.code) : ''
  if (code === 'FST_REQ_FILE_TOO_LARGE') {
    return { status: 400, body: { success: false, error: 'FILE_TOO_LARGE', message: '单个文件不能超过 10MB。' } }
  }
  if (code === 'FST_FILES_LIMIT') {
    return { status: 400, body: { success: false, error: 'TOO_MANY_FILES', message: '最多上传 5 个文件。' } }
  }
  return { status: 500, body: { success: false, error: 'SUBMISSION_FAILED', message: '提交失败，请稍后重试。' } }
}

export const registerPatientSubmissionRoutes = async (app: FastifyInstance) => {
  app.post('/api/consultations', async (request, reply) => {
    try {
      const input = consultationSubmissionSchema.parse(request.body)
      const created = await createConsultationSubmission(input, { userAgent: request.headers['user-agent'], ip: request.ip })
      return reply.code(created.created ? 201 : 200).send({ success: true, submissionId: created.id, status: created.status, createdAt: created.created_at })
    } catch (error) {
      request.log.error(error)
      const result = errorResponse(error)
      return reply.code(result.status).send(result.body)
    }
  })

  app.post('/api/dental-assessments', async (request, reply) => {
    const uploadedFiles: DentalUploadedFile[] = []
    const cleanupUploads = () => Promise.all(uploadedFiles.map((file) => unlink(path.resolve(file.relativePath)).catch(() => undefined)))
    try {
      if (!request.isMultipart()) return reply.code(400).send({ success: false, error: 'MULTIPART_REQUIRED', message: 'Dental assessments require uploaded files.' })
      const fields: Record<string, string> = {}
      const folder = `dental-assessments/${Date.now()}-${Math.random().toString(36).slice(2)}`
      for await (const part of request.parts({ limits: { fileSize: 10 * 1024 * 1024, files: 5 } })) {
        if (part.type === 'file') {
          if (!part.filename) continue
          if (uploadedFiles.length >= 5) {
            await cleanupUploads()
            return reply.code(400).send({ success: false, error: 'TOO_MANY_FILES', message: '最多上传 5 个文件。' })
          }
          if (!['image/jpeg', 'image/png', 'application/pdf'].includes(part.mimetype)) {
            await cleanupUploads()
            return reply.code(400).send({ success: false, error: 'UNSUPPORTED_FILE_TYPE', message: '仅支持 JPG、PNG 或 PDF 文件。' })
          }
          const saved = await saveReportUpload(part, folder)
          if (saved.size > 10 * 1024 * 1024) {
            await unlink(path.resolve(saved.relativePath)).catch(() => undefined)
            await cleanupUploads()
            return reply.code(400).send({ success: false, error: 'FILE_TOO_LARGE', message: '单个文件不能超过 10MB。' })
          }
          uploadedFiles.push(saved)
        } else {
          fields[part.fieldname] = typeof part.value === 'string' ? part.value : JSON.stringify(part.value ?? '')
        }
      }
      if (!uploadedFiles.length) return reply.code(400).send({ success: false, error: 'FILE_REQUIRED', message: '请至少上传一份牙片或口腔照片。' })
      const input = dentalAssessmentSchema.parse(fields)
      const created = await createDentalAssessment(input, uploadedFiles, { userAgent: request.headers['user-agent'], ip: request.ip })
      if (!created.created) await cleanupUploads()
      return reply.code(created.created ? 201 : 200).send({ success: true, submissionId: created.id, submissionNo: created.submission_no, status: created.status, createdAt: created.created_at })
    } catch (error) {
      await cleanupUploads()
      request.log.error(error)
      const result = errorResponse(error)
      return reply.code(result.status).send(result.body)
    }
  })
}
