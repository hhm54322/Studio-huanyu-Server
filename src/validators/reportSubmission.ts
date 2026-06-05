import { z } from 'zod'
import { professionalParsedFileSchema, professionalUploadedFileSchema } from './professionalReportSubmission.js'

const supportedLocales = ['zh', 'en', 'id', 'ru', 'mn'] as const
const genders = ['male', 'female', 'other'] as const
const idTypes = ['passport', 'id_card', 'driving_license', 'other'] as const

const passportRegex = /^[A-Z0-9]{6,18}$/i
const chineseIdRegex =
  /^[1-9]\d{5}(18|19|20)\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])\d{3}[\dXx]$/
const otherIdRegex = /^[A-Za-z0-9][A-Za-z0-9 .\-/]{3,39}$/
const phoneRegex = /^\+?[0-9][0-9\s\-()]{6,19}$/

const isValidBirthDate = (value: string) => {
  const date = new Date(`${value}T00:00:00.000Z`)
  if (Number.isNaN(date.getTime())) return false
  const now = new Date()
  const earliest = new Date(Date.UTC(now.getUTCFullYear() - 120, now.getUTCMonth(), now.getUTCDate()))
  return date <= now && date >= earliest
}

export const reportSubmissionSchema = z.object({
  locale: z.enum(supportedLocales).default('zh'),
  basicInfo: z.object({
    fullName: z.string().trim().min(2).max(120),
    gender: z.enum(genders),
    dateOfBirth: z.string().trim().max(10).optional().default('').refine((value) => (
      !value || (/^\d{4}-\d{2}-\d{2}$/.test(value) && isValidBirthDate(value))
    ), 'Invalid date of birth'),
    nationality: z.string().trim().max(80).optional().default(''),
    idType: z.enum(idTypes).or(z.literal('')).optional().default(''),
    idNumber: z.string().trim().max(80).optional().default(''),
    phone: z.string().trim().min(7).max(40).refine((value) => phoneRegex.test(value), 'Invalid phone number'),
    email: z.string().trim().max(160).optional().default('').refine((value) => !value || z.string().email().safeParse(value).success, 'Invalid email'),
    city: z.string().trim().max(120).optional().default(''),
    preferredLanguage: z.string().trim().max(40).optional().default(''),
    visitPurpose: z.string().trim().min(1).max(80),
    chiefComplaint: z.string().trim().max(500).optional().default(''),
  }).superRefine((value, ctx) => {
    if (!value.idNumber) return

    const idNumber = value.idNumber.replace(/\s/g, '')
    if ((!value.idType || value.idType === 'passport') && !passportRegex.test(idNumber)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['idNumber'], message: 'Invalid passport number' })
    }
    if (value.idType === 'id_card' && !chineseIdRegex.test(value.idNumber)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['idNumber'], message: 'Invalid national ID number' })
    }
    if ((value.idType === 'driving_license' || value.idType === 'other') && !otherIdRegex.test(value.idNumber)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['idNumber'], message: 'Invalid ID number' })
    }
  }),
  selectedRegions: z.array(z.string().trim().min(1).max(80)).min(1).max(20),
  uploadedFiles: z.array(professionalUploadedFileSchema).max(20).default([]),
  parsedFiles: z.array(professionalParsedFileSchema).max(20).default([]),
})

export type ReportSubmissionInput = z.infer<typeof reportSubmissionSchema>
