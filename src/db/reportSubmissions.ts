import { createHash, randomBytes } from 'node:crypto'
import { pool } from './pool.js'
import type { ReportSubmissionInput } from '../validators/reportSubmission.js'

export type ReportSubmissionRow = {
  id: string
  submission_no: string
  locale: string
  full_name: string
  gender: string
  date_of_birth: string
  nationality: string
  id_type: string | null
  id_number: string | null
  phone: string | null
  email: string
  city: string
  preferred_language: string
  visit_purpose: string
  chief_complaint: string
  selected_regions: string[]
  report_status: string
  report_result: unknown
  source: string
  user_agent: string | null
  ip_hash: string | null
  created_at: string
  updated_at: string
}

const createSubmissionNo = () => {
  const now = new Date()
  const date = now.toISOString().slice(0, 10).replace(/-/g, '')
  return `rpt_${date}_${randomBytes(4).toString('hex')}`
}

export const hashIp = (ip?: string) => {
  if (!ip) return null
  return createHash('sha256').update(ip).digest('hex')
}

export const createReportSubmission = async (
  input: ReportSubmissionInput,
  meta: { userAgent?: string; ip?: string },
) => {
  const submissionNo = createSubmissionNo()
  const { basicInfo } = input
  const result = await pool.query<Pick<ReportSubmissionRow, 'id' | 'submission_no' | 'report_status' | 'created_at'>>(
    `
    INSERT INTO report_submissions (
      submission_no, locale, full_name, gender, date_of_birth, nationality,
      id_type, id_number, phone, email, city, preferred_language, visit_purpose,
      chief_complaint, selected_regions, user_agent, ip_hash
    )
    VALUES (
      $1, $2, $3, $4, $5, $6,
      $7, NULLIF($8, ''), NULLIF($9, ''), $10, $11, $12, $13,
      $14, $15::jsonb, $16, $17
    )
    RETURNING id, submission_no, report_status, created_at
    `,
    [
      submissionNo,
      input.locale,
      basicInfo.fullName,
      basicInfo.gender,
      basicInfo.dateOfBirth,
      basicInfo.nationality,
      basicInfo.idType || 'passport',
      basicInfo.idNumber || '',
      basicInfo.phone || '',
      basicInfo.email,
      basicInfo.city,
      basicInfo.preferredLanguage,
      basicInfo.visitPurpose,
      basicInfo.chiefComplaint,
      JSON.stringify(input.selectedRegions),
      meta.userAgent || null,
      hashIp(meta.ip),
    ],
  )

  return result.rows[0]
}

export const listReportSubmissions = async (limit = 20) => {
  const result = await pool.query<ReportSubmissionRow>(
    `
    SELECT *
    FROM report_submissions
    ORDER BY created_at DESC
    LIMIT $1
    `,
    [limit],
  )
  return result.rows
}

export const getReportSubmission = async (submissionNo: string) => {
  const result = await pool.query<ReportSubmissionRow>(
    `
    SELECT *
    FROM report_submissions
    WHERE submission_no = $1 OR id::text = $1
    LIMIT 1
    `,
    [submissionNo],
  )
  return result.rows[0] || null
}

export const exportReportSubmissions = async (from?: string, to?: string) => {
  const params: string[] = []
  const filters: string[] = []

  if (from) {
    params.push(from)
    filters.push(`created_at >= $${params.length}`)
  }
  if (to) {
    params.push(to)
    filters.push(`created_at < ($${params.length}::date + interval '1 day')`)
  }

  const result = await pool.query<ReportSubmissionRow>(
    `
    SELECT *
    FROM report_submissions
    ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''}
    ORDER BY created_at DESC
    `,
    params,
  )
  return result.rows
}
