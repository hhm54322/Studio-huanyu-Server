import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z, ZodError } from 'zod'
import { getConsultationSubmission, listConsultationSubmissions, updateConsultationStatus } from '../db/patientSubmissions.js'
import { consultationListQuerySchema, consultationStatusSchema } from '../validators/patientSubmissions.js'
import { audit, getSession, requireCsrf, requireRole } from '../expert/security.js'
import { ExpertError } from '../expert/schema.js'

/** Private operator endpoints for M06/M08 handoff. Patient data never appears in public analytics. */
export async function registerConsultationAdminRoutes(parent: FastifyInstance) {
  await parent.register(async app => {
    app.setErrorHandler((error, _request, reply) => {
      if (error instanceof ExpertError) return reply.code(error.status).send({ success: false, error: error.code, message: error.message })
      if (error instanceof ZodError) return reply.code(400).send({ success: false, error: 'VALIDATION_ERROR', message: '请检查请求内容。' })
      app.log.error({ code: (error as { code?: string }).code }, 'Consultation admin request failed')
      return reply.code(500).send({ success: false, error: 'CONSULTATION_ADMIN_FAILED', message: '操作失败，请稍后重试。' })
    })
    app.addHook('onSend', async (_request, reply, payload) => {
      reply.header('Cache-Control', 'private, no-store').header('X-Robots-Tag', 'noindex, nofollow').header('Vary', 'Origin, Cookie')
      return payload
    })
    app.get('/consultations', async request => {
      const session = await getSession(request)
      requireRole(session, ['admin'])
      const query = consultationListQuerySchema.parse(request.query)
      return { success: true, ...await listConsultationSubmissions(query) }
    })
    app.get('/consultations/:id', async request => {
      const session = await getSession(request)
      requireRole(session, ['admin'])
      const id = z.string().uuid().parse((request.params as { id?: string }).id)
      const item = await getConsultationSubmission(id)
      if (!item) throw new ExpertError(404, 'NOT_FOUND', '咨询记录不存在。')
      return { success: true, item }
    })
    // The public site is fronted by CDN infrastructure that only forwards the
    // common HTTP verbs. Keep PATCH for direct/internal callers, and expose the
    // same CSRF-protected operation over POST for the production workbench.
    const updateStatus = async (request: FastifyRequest) => {
      const session = await getSession(request)
      requireCsrf(request, session)
      requireRole(session, ['admin'])
      const id = z.string().uuid().parse((request.params as { id?: string }).id)
      const input = z.object({ status: consultationStatusSchema }).parse(request.body)
      const item = await updateConsultationStatus(id, input.status)
      if (!item) throw new ExpertError(404, 'NOT_FOUND', '咨询记录不存在。')
      await audit(session.id, 'consultation_status_updated', id, { status: input.status })
      return { success: true, item }
    }
    app.patch('/consultations/:id/status', updateStatus)
    app.post('/consultations/:id/status', updateStatus)
  }, { prefix: '/api/expert' })
}
