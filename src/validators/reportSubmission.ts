import { z } from 'zod'

const supportedLocales = ['zh', 'en', 'id', 'ru', 'mn'] as const
const genders = ['male', 'female', 'other'] as const
const idTypes = ['passport', 'id_card', 'other'] as const

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
    dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(isValidBirthDate, 'Invalid date of birth'),
    nationality: z.string().trim().min(1).max(80),
    idType: z.enum(idTypes).optional().default('passport'),
    idNumber: z.string().trim().max(80).optional().default(''),
    phone: z.string().trim().max(40).optional().default(''),
    email: z.string().trim().email().max(160),
    city: z.string().trim().min(2).max(120),
    preferredLanguage: z.string().trim().min(1).max(40),
    visitPurpose: z.string().trim().min(1).max(80),
    chiefComplaint: z.string().trim().min(6).max(500),
  }).superRefine((value, ctx) => {
    if (!value.idNumber) return

    const idNumber = value.idNumber.replace(/\s/g, '')
    if (value.idType === 'passport' && !passportRegex.test(idNumber)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['idNumber'], message: 'Invalid passport number' })
    }
    if (value.idType === 'id_card' && !chineseIdRegex.test(value.idNumber)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['idNumber'], message: 'Invalid national ID number' })
    }
    if (value.idType === 'other' && !otherIdRegex.test(value.idNumber)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['idNumber'], message: 'Invalid ID number' })
    }
  }).refine((value) => !value.phone || phoneRegex.test(value.phone), {
    path: ['phone'],
    message: 'Invalid phone number',
  }),
  selectedRegions: z.array(z.string().trim().min(1).max(80)).min(1).max(20),
})

export type ReportSubmissionInput = z.infer<typeof reportSubmissionSchema>
