import type { FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import { createReportSubmission } from '../db/reportSubmissions.js'
import { reportSubmissionSchema } from '../validators/reportSubmission.js'

export const registerReportSubmissionRoutes = async (app: FastifyInstance) => {
  app.post('/api/report-submissions', async (request, reply) => {
    try {
      const input = reportSubmissionSchema.parse(request.body)
      const created = await createReportSubmission(input, {
        userAgent: request.headers['user-agent'],
        ip: request.ip,
      })

      return reply.code(201).send({
        success: true,
        submissionId: created.id,
        submissionNo: created.submission_no,
        status: created.report_status,
        createdAt: created.created_at,
      })
    } catch (error) {
      if (error instanceof ZodError) {
        return reply.code(400).send({
          success: false,
          error: 'VALIDATION_ERROR',
          message: 'Invalid report submission payload',
          issues: error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        })
      }

      request.log.error(error)
      return reply.code(500).send({
        success: false,
        error: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to save report submission',
      })
    }
  })
}
