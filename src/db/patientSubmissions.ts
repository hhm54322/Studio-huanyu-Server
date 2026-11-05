import { createHash, randomBytes } from 'node:crypto'
import { pool } from './pool.js'
import type { ConsultationSubmissionInput, DentalAssessmentInput } from '../validators/patientSubmissions.js'
import { ExpertError } from '../expert/schema.js'

const createSubmissionNo = (prefix: string) => {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  return `${prefix}_${date}_${randomBytes(4).toString('hex')}`
}

export const hashIp = (ip?: string) => ip ? createHash('sha256').update(ip).digest('hex') : null

export const createConsultationSubmission = async (
  input: ConsultationSubmissionInput,
  meta: { userAgent?: string; ip?: string },
) => {
  const payloadHash = createHash('sha256').update(JSON.stringify(input)).digest('hex')
  const inserted = await pool.query(
    `INSERT INTO consultation_submissions
       (request_id, name, contact, country, topic, report_status, budget, time_window, concern, locale, flow_mode, handoff_reason, source_context, payload_hash, user_agent, ip_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
     ON CONFLICT (request_id) DO NOTHING
     RETURNING id, created_at, status`,
    [input.requestId, input.name, input.contact, input.country, input.topic, input.reportStatus, input.budget, input.timeWindow, input.concern, input.locale, input.mode, input.handoffReason, input.sourceContext, payloadHash, meta.userAgent || null, hashIp(meta.ip)],
  )
  if (inserted.rows[0]) {
    return { ...(inserted.rows[0] as { id: string; created_at: string; status: string }), created: true }
  }

  const existing = await pool.query(
    `SELECT id, created_at, status, payload_hash
     FROM consultation_submissions
     WHERE request_id = $1`,
    [input.requestId],
  )
  if (existing.rows[0]?.payload_hash && existing.rows[0].payload_hash !== payloadHash) throw new ExpertError(409, 'CONSULTATION_CONFLICT', '咨询已提交，请勿重复更改。')
  return { ...(existing.rows[0] as { id: string; created_at: string; status: string }), created: false }
}

export type ConsultationStatus = 'submitted' | 'in_progress' | 'waiting_user' | 'handoff' | 'resolved' | 'closed'

const consultationSelect = `
  id, request_id, name, contact, country, topic, report_status, budget, time_window,
  concern, locale, flow_mode, handoff_reason, source_context, status, created_at, updated_at`

export const listConsultationSubmissions = async (query: {
  page: number
  limit: number
  status: ConsultationStatus | 'all'
  search: string
}) => {
  const values: unknown[] = []
  const conditions: string[] = []
  if (query.status !== 'all') {
    values.push(query.status)
    conditions.push(`status = $${values.length}`)
  }
  if (query.search) {
    values.push(`%${query.search}%`)
    conditions.push(`(name ILIKE $${values.length} OR contact ILIKE $${values.length} OR id::text ILIKE $${values.length} OR request_id ILIKE $${values.length})`)
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
  const count = await pool.query(`SELECT count(*)::int AS total FROM consultation_submissions ${where}`, values)
  const offset = (query.page - 1) * query.limit
  values.push(query.limit, offset)
  const rows = await pool.query(
    `SELECT ${consultationSelect} FROM consultation_submissions ${where} ORDER BY (handoff_reason <> 'general') DESC, created_at DESC, id DESC LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values,
  )
  return { items: rows.rows, total: Number(count.rows[0]?.total || 0), page: query.page, limit: query.limit }
}

export const getConsultationSubmission = async (id: string) => {
  const result = await pool.query(`SELECT ${consultationSelect} FROM consultation_submissions WHERE id = $1`, [id])
  return result.rows[0] || null
}

export const updateConsultationStatus = async (id: string, status: ConsultationStatus) => {
  const result = await pool.query(
    `UPDATE consultation_submissions SET status = $2, updated_at = now() WHERE id = $1 RETURNING ${consultationSelect}`,
    [id, status],
  )
  return result.rows[0] || null
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
