import { z } from 'zod'

const supportedLocales = ['zh', 'en', 'id', 'ru', 'mn'] as const
const genders = ['male', 'female', 'other'] as const
const urgencyLevels = ['routine', 'priority', 'urgent'] as const

const phoneRegex = /^\+?[0-9][0-9\s\-()]{6,19}$/

const isValidBirthDate = (value: string) => {
  const date = new Date(`${value}T00:00:00.000Z`)
  if (Number.isNaN(date.getTime())) return false
  const now = new Date()
  const earliest = new Date(Date.UTC(now.getUTCFullYear() - 120, now.getUTCMonth(), now.getUTCDate()))
  return date <= now && date >= earliest
}

export const professionalUploadedFileSchema = z.object({
  fieldName: z.string().trim().min(1).max(80),
  originalName: z.string().trim().min(1).max(240),
  storedName: z.string().trim().min(1).max(240),
  relativePath: z.string().trim().min(1).max(500),
  mimeType: z.string().trim().max(120).default('application/octet-stream'),
  size: z.number().int().min(0).max(50 * 1024 * 1024),
})

export const professionalParsedFileSchema = z.object({
  originalName: z.string(),
  mimeType: z.string(),
  parser: z.string(),
  status: z.enum(['parsed', 'partial', 'unsupported', 'failed']),
  text: z.string(),
  summary: z.string(),
  metadata: z.record(z.unknown()).default({}),
  error: z.string().optional(),
})

export const professionalReportSubmissionSchema = z.object({
  locale: z.enum(supportedLocales).default('zh'),
  patient: z.object({
    fullName: z.string().trim().min(2).max(120),
    gender: z.enum(genders),
    dateOfBirth: z.string().trim().max(10).optional().default('').refine((value) => (
      !value || (/^\d{4}-\d{2}-\d{2}$/.test(value) && isValidBirthDate(value))
    ), 'Invalid date of birth'),
    nationality: z.string().trim().max(80).optional().default(''),
    phone: z.string().trim().min(7).max(40).refine((value) => phoneRegex.test(value), 'Invalid phone number'),
    email: z.string().trim().max(160).optional().default('').refine((value) => !value || z.string().email().safeParse(value).success, 'Invalid email'),
    city: z.string().trim().max(120).optional().default(''),
    preferredLanguage: z.string().trim().max(40).optional().default(''),
  }),
  medical: z.object({
    visitPurpose: z.string().trim().min(1).max(80),
    diagnosis: z.string().trim().max(160).optional().default(''),
    stage: z.string().trim().max(160).optional().default(''),
    chiefComplaint: z.string().trim().min(6).max(2000),
    pathologySummary: z.string().trim().max(3000).optional().default(''),
    imagingSummary: z.string().trim().max(3000).optional().default(''),
    geneticSummary: z.string().trim().max(3000).optional().default(''),
    treatmentHistory: z.string().trim().max(3000).optional().default(''),
    medicationHistory: z.string().trim().max(2000).optional().default(''),
    comorbidities: z.string().trim().max(2000).optional().default(''),
    allergyHistory: z.string().trim().max(1000).optional().default(''),
  }),
  preferences: z.object({
    selectedRegions: z.array(z.string().trim().min(1).max(80)).min(1).max(20),
    budgetRange: z.string().trim().max(120).optional().default(''),
    insuranceType: z.string().trim().max(160).optional().default(''),
    desiredCity: z.string().trim().max(120).optional().default(''),
    urgency: z.enum(urgencyLevels).optional().default('routine'),
  }),
  uploadedFiles: z.array(professionalUploadedFileSchema).max(20).default([]),
  parsedFiles: z.array(professionalParsedFileSchema).max(20).default([]),
}).superRefine((value, ctx) => {
  if (value.uploadedFiles.length || value.parsedFiles.length) return

  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path: ['uploadedFiles'],
    message: 'Professional report requires at least one uploaded medical record file.',
  })
})

export type ProfessionalReportSubmissionInput = z.infer<typeof professionalReportSubmissionSchema>
export type ProfessionalUploadedFile = z.infer<typeof professionalUploadedFileSchema>
export type ProfessionalParsedFile = z.infer<typeof professionalParsedFileSchema>
