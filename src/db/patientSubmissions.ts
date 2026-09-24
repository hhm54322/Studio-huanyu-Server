import { createHash, randomBytes } from 'node:crypto'
import { pool } from './pool.js'
import type { ConsultationSubmissionInput, DentalAssessmentInput } from '../validators/patientSubmissions.js'

const createSubmissionNo = (prefix: string) => {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  return `${prefix}_${date}_${randomBytes(4).toString('hex')}`
}

export const hashIp = (ip?: string) => ip ? createHash('sha256').update(ip).digest('hex') : null

export const createConsultationSubmission = async (
  input: ConsultationSubmissionInput,
  meta: { userAgent?: string; ip?: string },
) => {
  const inserted = await pool.query(
    `INSERT INTO consultation_submissions (request_id, name, contact, concern, user_agent, ip_hash)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (request_id) DO NOTHING
     RETURNING id, created_at, status`,
    [input.requestId, input.name, input.contact, input.concern, meta.userAgent || null, hashIp(meta.ip)],
  )
  if (inserted.rows[0]) {
    return { ...(inserted.rows[0] as { id: string; created_at: string; status: string }), created: true }
  }

  const existing = await pool.query(
    `SELECT id, created_at, status
     FROM consultation_submissions
     WHERE request_id = $1`,
    [input.requestId],
  )
  return { ...(existing.rows[0] as { id: string; created_at: string; status: string }), created: false }
}

export type DentalUploadedFile = {
  fieldName: string
  originalName: string
  storedName: string
  relativePath: string
  mimeType: string
  size: number
}

export const createDentalAssessment = async (
  input: DentalAssessmentInput,
  uploadedFiles: DentalUploadedFile[],
  meta: { userAgent?: string; ip?: string },
) => {
  const submissionNo = createSubmissionNo('dnt')
  const inserted = await pool.query(
    `INSERT INTO dental_assessments
      (submission_no, request_id, project_id, budget, visit_time, notes, uploaded_files, user_agent, ip_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)
     ON CONFLICT (request_id) DO NOTHING
     RETURNING id, submission_no, created_at, status`,
    [submissionNo, input.requestId, input.projectId, input.budget, input.visitTime, input.notes, JSON.stringify(uploadedFiles), meta.userAgent || null, hashIp(meta.ip)],
  )
  if (inserted.rows[0]) {
    return { ...(inserted.rows[0] as { id: string; submission_no: string; created_at: string; status: string }), created: true }
  }

  const existing = await pool.query(
    `SELECT id, submission_no, created_at, status
     FROM dental_assessments
     WHERE request_id = $1`,
    [input.requestId],
  )
  return { ...(existing.rows[0] as { id: string; submission_no: string; created_at: string; status: string }), created: false }
}
