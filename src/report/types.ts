import { z } from 'zod'
import { reportLayoutSectionSchema } from './layoutTypes.js'

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

const costBreakdownLineSchema = z.object({
  item: z.string().min(1),
  cost: z.string().min(1),
  note: z.string().optional(),
})

const costBreakdownCategorySchema = z.object({
  title: z.string().min(1),
  subtotal: z.string().min(1),
  items: z.array(costBreakdownLineSchema).min(3),
  tip: z.string().optional(),
})

const detailedCostBreakdownSchema = z.object({
  currencyNote: z.string().min(1),
  coreMedical: costBreakdownCategorySchema,
  supportServices: costBreakdownCategorySchema,
  living: costBreakdownCategorySchema,
  summary: z.object({
    formula: z.string().min(1),
    chinaTotal: z.string().min(1),
    referenceCountry: z.string().min(1),
    referenceCost: z.string().min(1),
    savingsPercent: z.number().int().min(0).max(99),
    savingsText: z.string().min(1),
  }),
})

const hospitalDetailItemSchema = z.object({
  label: z.string(),
  value: z.string(),
})

const hospitalRecommendationSchema = z.object({
  city: z.string(),
  name: z.string(),
  reason: z.string(),
  englishName: z.string().optional(),
  department: z.string().optional(),
  matchScore: z.number().int().min(0).max(100).optional(),
  rankLabel: z.string().optional(),
  tags: z.array(z.string()).optional(),
  internationalPatients: z.string().optional(),
  waitTime: z.string().optional(),
  detailItems: z.array(hospitalDetailItemSchema).optional(),
  preparation: z.string().optional(),
})

const advancedTherapySchema = z.object({
  name: z.string().min(1),
  category: z.string().min(1),
  recommendationLevel: z.string().min(1),
  summary: z.string().min(1),
  applicableFor: z.string().min(1),
  mechanism: z.string().min(1),
  chinaAccess: z.string().min(1),
  estimatedCost: z.string().min(1),
  referenceCost: z.string().optional(),
  advantage: z.string().min(1),
  evidence: z.string().min(1),
  limitations: z.string().min(1),
  nextStep: z.string().min(1),
  tags: z.array(z.string()).optional(),
})

const drugCostComparisonItemSchema = z.object({
  drugName: z.string().min(1),
  drugClass: z.string().min(1),
  chinaOption: z.string().min(1),
  referenceOption: z.string().min(1),
  chinaCost: z.string().min(1),
  referenceCost: z.string().min(1),
  efficacyEquivalence: z.string().min(1),
  savingInsight: z.string().min(1),
  eligibility: z.string().min(1),
  note: z.string().optional(),
})

const newDrugCureItemSchema = z.object({
  name: z.string().min(1),
  type: z.string().min(1),
  applicableFor: z.string().min(1),
  evidence: z.string().min(1),
  chinaAvailability: z.string().min(1),
  potentialRole: z.string().min(1),
  limitations: z.string().min(1),
  nextStep: z.string().min(1),
})

const advancedCareSchema = z.object({
  context: z.string().min(1),
  currencyNote: z.string().min(1),
  therapies: z.array(advancedTherapySchema).min(1),
  drugCostComparison: z.object({
    title: z.string().min(1),
    basis: z.string().min(1),
    summary: z.string().min(1),
    items: z.array(drugCostComparisonItemSchema).min(1),
    note: z.string().min(1),
  }),
  newDrugCureAssessment: z.object({
    headline: z.string().min(1),
    answer: z.string().min(1),
    summary: z.string().min(1),
    items: z.array(newDrugCureItemSchema).min(1),
    ctaItems: z.array(z.string()).min(1),
  }),
  disclaimer: z.string().min(1),
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
  hospitals: z.array(hospitalRecommendationSchema).min(1),
  plan: z.object({
    direction: z.string(),
    duration: z.string(),
    totalCost: z.string(),
    breakdown: z.array(z.object({
      item: z.string(),
      cost: z.string(),
    })).min(1),
    costBreakdown: detailedCostBreakdownSchema.optional(),
  }),
  packages: z.array(z.object({
    name: z.string(),
    subtitle: z.string().optional(),
    price: z.string(),
    originalPrice: z.string().optional(),
    badge: z.string().optional(),
    cta: z.string().optional(),
    icon: z.string(),
    highlight: z.boolean(),
    features: z.array(z.string()).min(1),
    featureDetails: z.array(z.object({
      label: z.string(),
      status: z.enum(['included', 'excluded', 'emphasis']).optional(),
    })).optional(),
    footnote: z.string().optional(),
  })).min(1),
  advancedCare: advancedCareSchema.optional(),
  highlights: z.array(z.string()).min(1),
  paymentAndInsurance: z.array(z.string()).min(2).optional(),
  layoutSections: z.array(reportLayoutSectionSchema).optional(),
  disclaimer: z.string(),
  generatedBy: z.enum(['llm', 'rules']),
})

export type GeneratedReport = z.infer<typeof generatedReportSchema>
