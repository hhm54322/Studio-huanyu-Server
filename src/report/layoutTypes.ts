import { z } from 'zod'

export const reportLayoutMetricSchema = z.object({
  label: z.string(),
  value: z.string(),
  detail: z.string().optional(),
  tone: z.string().optional(),
})

export const reportLayoutCardSchema = z.object({
  title: z.string(),
  subtitle: z.string().optional(),
  value: z.string().optional(),
  description: z.string().optional(),
  detail: z.string().optional(),
  tag: z.string().optional(),
  tone: z.string().optional(),
})

export const reportLayoutTableSchema = z.object({
  columns: z.array(z.string()).min(1),
  rows: z.array(z.object({
    cells: z.array(z.string()).min(1),
    highlight: z.boolean().optional(),
  })).min(1),
})

export const reportLayoutTimelineItemSchema = z.object({
  time: z.string(),
  title: z.string(),
  description: z.string().optional(),
  items: z.array(z.string()).optional(),
})

export const reportLayoutBlockSchema = z.object({
  type: z.enum(['summary', 'cards', 'table', 'timeline', 'list', 'cost', 'notice']),
  title: z.string(),
  titleEn: z.string().optional(),
  description: z.string().optional(),
  tone: z.string().optional(),
  metrics: z.array(reportLayoutMetricSchema).optional(),
  cards: z.array(reportLayoutCardSchema).optional(),
  table: reportLayoutTableSchema.optional(),
  timeline: z.array(reportLayoutTimelineItemSchema).optional(),
  items: z.array(z.string()).optional(),
})

export const reportLayoutSectionSchema = z.object({
  key: z.string(),
  label: z.string(),
  labelEn: z.string().optional(),
  icon: z.string().optional(),
  summary: z.string().optional(),
  blocks: z.array(reportLayoutBlockSchema).min(1),
})

export type ReportLayoutSection = z.infer<typeof reportLayoutSectionSchema>
