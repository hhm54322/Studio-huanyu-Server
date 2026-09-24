import { z } from 'zod'

export const consultationSubmissionSchema = z.object({
  requestId: z.string().uuid(),
  name: z.string().trim().min(2).max(120),
  contact: z.string().trim().min(3).max(160),
  concern: z.string().trim().max(2000).default(''),
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
