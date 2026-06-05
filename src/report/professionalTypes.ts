import { z } from 'zod'
import { reportLayoutSectionSchema } from './layoutTypes.js'

export const professionalReportSchema = z.object({
  id: z.string(),
  date: z.string(),
  title: z.string(),
  subtitle: z.string(),
  patientSnapshot: z.object({
    patient: z.string(),
    profile: z.string(),
    primaryNeed: z.string(),
    diagnosisStatus: z.string(),
    dataCompleteness: z.number().int().min(0).max(100),
    uploadedFiles: z.array(z.string()),
    parsedFiles: z.array(z.object({
      file: z.string(),
      status: z.string(),
      summary: z.string(),
    })),
  }),
  executiveSummary: z.array(z.string()).min(2),
  diagnosticConclusion: z.object({
    finalImpression: z.string(),
    severityInterpretation: z.string(),
    indicatorInterpretations: z.array(z.object({
      indicator: z.string(),
      value: z.string(),
      interpretation: z.string(),
    })),
    evidenceBasis: z.array(z.string()),
  }),
  clinicalAssessment: z.object({
    workingDiagnosis: z.string(),
    severity: z.string(),
    keyFindings: z.array(z.string()).min(1),
    redFlags: z.array(z.string()),
    missingMaterials: z.array(z.string()).min(1),
    decisionQuestions: z.array(z.string()).min(1),
  }),
  treatmentPathway: z.object({
    goal: z.string(),
    phases: z.array(z.object({
      phase: z.string(),
      timeline: z.string(),
      actions: z.array(z.string()).min(1),
      output: z.string(),
    })).min(3),
  }),
  prognosisComparison: z.object({
    positioning: z.string(),
    metrics: z.array(z.object({
      metric: z.string(),
      currentRisk: z.string(),
      chinaReference: z.string(),
      note: z.string(),
    })),
    conclusion: z.string(),
  }),
  technologyAdvantages: z.array(z.object({
    technology: z.string(),
    value: z.string(),
    applicability: z.string(),
  })).min(3),
  costBreakdown: z.object({
    currencyNote: z.string(),
    medical: z.object({
      title: z.string(),
      total: z.string(),
      items: z.array(z.object({
        item: z.string(),
        cost: z.string(),
        note: z.string(),
      })).min(2),
    }),
    services: z.object({
      title: z.string(),
      total: z.string(),
      items: z.array(z.object({
        item: z.string(),
        cost: z.string(),
        note: z.string(),
      })).min(2),
    }),
    living: z.object({
      title: z.string(),
      total: z.string(),
      items: z.array(z.object({
        item: z.string(),
        cost: z.string(),
        note: z.string(),
      })).min(2),
    }),
    grandTotal: z.string(),
    volatilityNote: z.string(),
  }),
  countryComparison: z.array(z.object({
    flag: z.string(),
    country: z.string(),
    cost: z.string(),
    waitTime: z.string(),
    strengths: z.string(),
    limitations: z.string(),
    fitScore: z.number().int().min(0).max(100),
    recommended: z.boolean().optional(),
  })).min(2),
  hospitalRecommendations: z.array(z.object({
    city: z.string(),
    hospital: z.string(),
    department: z.string(),
    whyFit: z.string(),
    preparation: z.string(),
    matchScore: z.number().int().min(0).max(100),
  })).min(1),
  itinerary: z.array(z.object({
    dayRange: z.string(),
    stage: z.string(),
    tasks: z.array(z.string()).min(1),
  })).min(3),
  servicePlan: z.array(z.object({
    service: z.string(),
    value: z.string(),
  })).min(3),
  paymentAndInsurance: z.array(z.string()).min(2),
  risksAndDisclaimers: z.array(z.string()).min(3),
  nextSteps: z.array(z.string()).min(3),
  tabs: z.array(reportLayoutSectionSchema).optional(),
  qualityFlags: z.array(z.string()),
  generatedBy: z.enum(['llm', 'rules']),
})

export type ProfessionalReport = z.infer<typeof professionalReportSchema>
