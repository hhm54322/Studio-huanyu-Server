import { randomBytes } from 'node:crypto'
import { pool } from './pool.js'
import { hashIp } from './reportSubmissions.js'
import type { ProfessionalReportSubmissionInput } from '../validators/professionalReportSubmission.js'

export type ProfessionalReportSubmissionRow = {
  id: string
  submission_no: string
  locale: string
  full_name: string
  gender: string
  date_of_birth: string | null
  nationality: string
  phone: string
  email: string
  city: string
  preferred_language: string
  visit_purpose: string
  diagnosis: string
  stage: string
  chief_complaint: string
  pathology_summary: string
  imaging_summary: string
  genetic_summary: string
  treatment_history: string
  medication_history: string
  comorbidities: string
  allergy_history: string
  budget_range: string
  insurance_type: string
  desired_city: string
  urgency: string
  selected_regions: string[]
  uploaded_files: unknown[]
  parsed_files: unknown[]
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
  return `pro_${date}_${randomBytes(4).toString('hex')}`
}

export const createProfessionalReportSubmission = async (
  input: ProfessionalReportSubmissionInput,
  meta: { userAgent?: string; ip?: string },
) => {
  const submissionNo = createSubmissionNo()
  const { patient, medical, preferences } = input

  const result = await pool.query<Pick<ProfessionalReportSubmissionRow, 'id' | 'submission_no' | 'report_status' | 'created_at'>>(
    `
    INSERT INTO professional_report_submissions (
      submission_no, locale, full_name, gender, date_of_birth, nationality,
      phone, email, city, preferred_language, visit_purpose, diagnosis, stage,
      chief_complaint, pathology_summary, imaging_summary, genetic_summary,
      treatment_history, medication_history, comorbidities, allergy_history,
      budget_range, insurance_type, desired_city, urgency, selected_regions,
      uploaded_files, parsed_files, user_agent, ip_hash
    )
    VALUES (
      $1, $2, $3, $4, $5, $6,
      $7, $8, $9, $10, $11, $12, $13,
      $14, $15, $16, $17,
      $18, $19, $20, $21,
      $22, $23, $24, $25, $26::jsonb,
      $27::jsonb, $28::jsonb, $29, $30
    )
    RETURNING id, submission_no, report_status, created_at
    `,
    [
      submissionNo,
      input.locale,
      patient.fullName,
      patient.gender,
      patient.dateOfBirth || null,
      patient.nationality,
      patient.phone,
      patient.email,
      patient.city,
      patient.preferredLanguage,
      medical.visitPurpose,
      medical.diagnosis,
      medical.stage,
      medical.chiefComplaint,
      medical.pathologySummary,
      medical.imagingSummary,
      medical.geneticSummary,
      medical.treatmentHistory,
      medical.medicationHistory,
      medical.comorbidities,
      medical.allergyHistory,
      preferences.budgetRange,
      preferences.insuranceType,
      preferences.desiredCity,
      preferences.urgency,
      JSON.stringify(preferences.selectedRegions),
      JSON.stringify(input.uploadedFiles),
      JSON.stringify(input.parsedFiles),
      meta.userAgent || null,
      hashIp(meta.ip),
    ],
  )

  return result.rows[0]
}

export const updateProfessionalReportSubmissionResult = async (
  submissionNo: string,
  status: 'generating' | 'generated' | 'failed',
  reportResult: unknown,
) => {
  const result = await pool.query<Pick<ProfessionalReportSubmissionRow, 'id' | 'submission_no' | 'report_status' | 'report_result' | 'updated_at'>>(
    `
    UPDATE professional_report_submissions
    SET report_status = $2,
        report_result = $3::jsonb
    WHERE submission_no = $1
    RETURNING id, submission_no, report_status, report_result, updated_at
    `,
    [submissionNo, status, JSON.stringify(reportResult)],
  )
  return result.rows[0] || null
}

export const getProfessionalReportSubmission = async (submissionNo: string) => {
  const result = await pool.query<ProfessionalReportSubmissionRow>(
    `
    SELECT *
    FROM professional_report_submissions
    WHERE submission_no = $1 OR id::text = $1
    LIMIT 1
    `,
    [submissionNo],
  )
  return result.rows[0] || null
}
