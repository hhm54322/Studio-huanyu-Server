import { z } from 'zod'

export const reportCountrySchema = z.object({
  flag: z.string(),
  name: z.string(),
  fee: z.string(),
  wait: z.string(),
  tech: z.string(),
  service: z.string(),
  visa: z.string(),
  follow: z.string(),
  recommended: z.boolean().optional(),
})

export const generatedReportSchema = z.object({
  id: z.string(),
  date: z.string(),
  subtitle: z.string(),
  disease: z.string(),
  treatment: z.string(),
  need: z.string(),
  countries: z.array(reportCountrySchema).min(1),
  score: z.number().int().min(0).max(100),
  advantages: z.array(z.object({
    label: z.string(),
    value: z.string(),
  })).min(1),
  concerns: z.array(z.object({
    concern: z.string(),
    solution: z.string(),
  })).min(1),
  hospitals: z.array(z.object({
    city: z.string(),
    name: z.string(),
    reason: z.string(),
  })).min(1),
  plan: z.object({
    direction: z.string(),
    duration: z.string(),
    totalCost: z.string(),
    breakdown: z.array(z.object({
      item: z.string(),
      cost: z.string(),
    })).min(1),
  }),
  packages: z.array(z.object({
    name: z.string(),
    price: z.string(),
    icon: z.string(),
    highlight: z.boolean(),
    features: z.array(z.string()).min(1),
  })).min(1),
  highlights: z.array(z.string()).min(1),
  disclaimer: z.string(),
  generatedBy: z.enum(['llm', 'rules']),
})

export type GeneratedReport = z.infer<typeof generatedReportSchema>
