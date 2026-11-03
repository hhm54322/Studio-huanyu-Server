import { z } from 'zod'

export const analyticsLocales = ['zh', 'en', 'id', 'ms', 'pt'] as const
// Public service keys only; kept in step with the M02 frontend allowlist.
export const analyticsTopics = [
  'general', 'oncology', 'cardiovascular', 'neurosurgery', 'orthopedics', 'dental', 'gynecology',
  'ophthalmology', 'gastroenterology', 'respiratory', 'urology', 'plastic_surgery', 'cell_therapy',
  'pediatrics', 'traditional_medicine', 'breast_cancer', 'lung_cancer', 'nasopharyngeal_cancer',
  'liver_cancer', 'cardiovascular_tumor', 'spine_surgery', 'premium_checkup',
  'cardiology_cardiothoracic', 'endocrinology', 'implant', 'whitening', 'veneer', 'aligner',
  'crown', 'periodontal', 'root-canal', 'children',
] as const
export const analyticsPages = [
  'patient-home', 'patient-why-china', 'patient-trust', 'patient-insurance', 'patient-hospitals',
  'patient-doctors', 'patient-report', 'patient-professional-report', 'patient-cases', 'patient-dental',
  'patient-dental-doctor', 'patient-diseases-technologies', 'patient-equipment', 'patient-visa',
  'patient-steps', 'patient-toolkit-detail', 'patient-about',
] as const
export const marketingKeys = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'source_id'] as const
const marketingLabel = z.string().trim().min(1).max(80).regex(/^[\p{L}\p{N}_. -]+$/u)
const filterLabel = z.union([z.literal(''), marketingLabel])
export const entrySchema = z.string().regex(/^(?:floating|footer-shared|footer-report|footer-\d+-\d+)$/)
const attributionSchema = z.object({
  utm_source: marketingLabel.optional(), utm_medium: marketingLabel.optional(),
  utm_campaign: marketingLabel.optional(), utm_content: marketingLabel.optional(),
  utm_term: marketingLabel.optional(), source_id: marketingLabel.optional(),
}).strict()
export const contactEventSchema = z.object({
  schemaVersion: z.literal(1), event: z.literal('whatsapp_click'), eventId: z.string().uuid(),
  visitorId: z.string().uuid(), sessionId: z.string().uuid(),
  occurredAt: z.string().datetime({ offset: true }).refine(value => {
    const age = Date.now() - Date.parse(value)
    return age >= -5 * 60_000 && age <= 24 * 60 * 60_000
  }, 'Event must be within the previous 24 hours'),
  locale: z.enum(analyticsLocales), topic: z.enum(analyticsTopics), page: z.enum(analyticsPages),
  entry: entrySchema, country: z.string().regex(/^[A-Z]{2}$/).optional(), attribution: attributionSchema,
}).strict()
export type ContactEvent = z.infer<typeof contactEventSchema>

export const analyticsDimensions = ['day', 'locale', 'topic', 'page', 'entry', 'country', 'source', 'medium', 'campaign', 'content', 'keyword', 'sourceId'] as const
export type AnalyticsDimension = (typeof analyticsDimensions)[number]
const calendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const parsed = new Date(`${value}T00:00:00Z`)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}, 'Invalid calendar date')
const timezone = z.string().max(80).refine(value => {
  try { new Intl.DateTimeFormat('en', { timeZone: value }); return true } catch { return false }
}, 'Invalid IANA timezone')
export const statsQuerySchema = z.object({
  from: calendarDate.optional(), to: calendarDate.optional(), timezone: timezone.default('UTC'),
  groupBy: z.string().default('day').transform(value => value.split(',')).pipe(z.array(z.enum(analyticsDimensions)).min(1).max(3))
    .refine(value => new Set(value).size === value.length, 'Duplicate grouping dimensions'),
  locale: z.enum(analyticsLocales).optional(), topic: z.enum(analyticsTopics).optional(),
  page: z.enum(analyticsPages).optional(), entry: entrySchema.optional(),
  country: z.string().regex(/^[A-Z]{2}$/).optional(),
  source: filterLabel.optional(), medium: filterLabel.optional(), campaign: filterLabel.optional(),
  content: filterLabel.optional(), keyword: filterLabel.optional(), sourceId: filterLabel.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
}).strict().transform((query, context) => {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: query.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts()
  const part = (key: string) => parts.find(value => value.type === key)!.value
  const today = `${part('year')}-${part('month')}-${part('day')}`
  const to = query.to || today
  const from = query.from || new Date(Date.parse(`${to}T00:00:00Z`) - 29 * 86400_000).toISOString().slice(0, 10)
  const span = Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)
  if (span < 0 || span > 365 * 86400_000) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Date range must be between 1 and 366 days' })
  return { ...query, from, to }
})
export type StatsQuery = z.infer<typeof statsQuerySchema>
