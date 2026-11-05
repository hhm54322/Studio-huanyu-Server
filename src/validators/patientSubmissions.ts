import { z } from 'zod'
import { analyticsTopics } from '../analytics/schema.js'

const countryCode = z.string().trim().max(80).default('').refine(value => !value || /^(?:[A-Z]{2}|OTHER)$/.test(value), 'Invalid country code')
const topicKey = z.string().trim().max(80).default('').refine(value => !value || /^[a-z][a-z0-9_-]{0,79}$/.test(value), 'Invalid topic')
const localeCode = z.enum(['zh', 'en', 'id', 'ms', 'pt']).default('zh')
const handoffReason = z.enum(['general', 'quote', 'report', 'appointment', 'records']).default('general')

export const consultationSubmissionSchema = z.object({
  requestId: z.string().uuid(),
  name: z.string().trim().min(1).max(120),
  contact: z.string().trim().min(3).max(160),
  country: countryCode,
  topic: topicKey,
  reportStatus: z.enum(['', 'none', 'has', 'need_help', 'skip']).default(''),
  budget: z.enum(['', 'unknown', 'under_5000', '5000_15000', '15000_30000', 'over_30000']).default(''),
  timeWindow: z.enum(['', 'one_month', 'one_three', 'three_six', 'flexible']).default(''),
  concern: z.string().trim().max(2000).default(''),
  schemaVersion: z.coerce.number().int().min(1).max(2).default(1),
  locale: localeCode,
  mode: z.enum(['quick', 'guided']).default('quick'),
  handoffReason,
  sourceContext: z.string().trim().max(1200).default(''),
}).strict().superRefine((input, context) => {
  if (input.schemaVersion !== 2) return // Original public clients remain usable during a rolling deployment.
  if (!input.country || !/^(?:[A-Z]{2}|OTHER)$/.test(input.country)) context.addIssue({ code: 'custom', path: ['country'], message: 'Country required' })
  if (!(analyticsTopics as readonly string[]).includes(input.topic)) context.addIssue({ code: 'custom', path: ['topic'], message: 'Unknown care topic' })
  if (!/^\+[1-9]\d{6,14}$/.test(input.contact)) context.addIssue({ code: 'custom', path: ['contact'], message: 'International WhatsApp number required' })
})

export const dentalAssessmentSchema = z.object({
  requestId: z.string().uuid(),
  projectId: z.string().trim().min(1).max(80),
  budget: z.string().trim().max(80).default(''),
  visitTime: z.string().trim().max(80).default(''),
  notes: z.string().trim().max(2000).default(''),
})

export type ConsultationSubmissionInput = z.infer<typeof consultationSubmissionSchema>
export type DentalAssessmentInput = z.infer<typeof dentalAssessmentSchema>

export const consultationStatusSchema = z.enum(['submitted', 'in_progress', 'waiting_user', 'handoff', 'resolved', 'closed'])
export const consultationListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(10000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  status: z.union([consultationStatusSchema, z.literal('all')]).default('all'),
  search: z.string().trim().max(80).default(''),
})
