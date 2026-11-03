import { createHash } from 'node:crypto'
import { isIP } from 'node:net'
import type { FastifyError, FastifyInstance, FastifyRequest } from 'fastify'
import { ZodError } from 'zod'
import { config } from '../config.js'
import { contactEventSchema, statsQuerySchema } from '../analytics/schema.js'
import { contactStats, insertContactEvent } from '../analytics/store.js'
import { getSession, requireRole } from '../expert/security.js'
import { ExpertError } from '../expert/schema.js'

export function contactAnalyticsClientIp(request: Pick<FastifyRequest, 'raw' | 'headers'>) {
  const peer = request.raw.socket.remoteAddress || 'unknown'
  // The deployed local Nginx appends its actual peer to X-Forwarded-For.
  // Trust only that final hop from the local proxy, never a caller's first value.
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(peer)) return peer
  const forwarded = request.headers['x-forwarded-for']
  if (typeof forwarded !== 'string') return peer
  const last = forwarded.split(',').at(-1)?.trim()
  return last && isIP(last) ? last : peer
}

export function createAnalyticsRateLimit() {
  const requests = new Map<string, { count: number; expires: number }>()
  return (ip: string, now = Date.now()) => {
    for (const [key, value] of requests) if (value.expires <= now) requests.delete(key)
    const key = createHash('sha256').update(ip).digest('hex')
    const previous = requests.get(key)
    if (!previous && requests.size >= 10_000) return false
    const current = previous || { count: 0, expires: now + 60_000 }
    requests.set(key, current)
    return ++current.count <= 120
  }
}

export async function registerContactAnalyticsRoutes(parent: FastifyInstance) {
  const allow = createAnalyticsRateLimit()
  const origins = new Set((process.env.ANALYTICS_ALLOWED_ORIGINS || `${config.corsOrigin},https://www.huanyumedical.com,https://huanyumedical.com`).split(',').map(value => value.trim()).filter(Boolean))
  await parent.register(async app => {
    app.addHook('onSend', async (_request, reply, payload) => {
      reply.header('Cache-Control', 'private, no-store').header('X-Robots-Tag', 'noindex, nofollow').header('Vary', 'Origin, Cookie')
      return payload
    })
    app.setErrorHandler((error, _request, reply) => {
      if (error instanceof ExpertError) return reply.code(error.status).send({ success: false, error: error.code, message: error.message })
      if (error instanceof ZodError) return reply.code(400).send({ success: false, error: 'INVALID_ANALYTICS_INPUT', message: 'Invalid analytics input' })
      const failure = error as Partial<FastifyError>
      if (failure.statusCode && failure.statusCode < 500) return reply.code(failure.statusCode).send({ success: false, error: 'INVALID_ANALYTICS_REQUEST' })
      // Do not log request payloads, identities or invalid private fields.
      app.log.warn({ code: failure.code || 'ANALYTICS_STORAGE_FAILED' }, 'Contact analytics unavailable')
      return reply.code(503).send({ success: false, error: 'ANALYTICS_UNAVAILABLE' })
    })
    app.post('/api/analytics/events', { bodyLimit: 4096, logLevel: 'warn' }, async (request, reply) => {
      if (!request.headers.origin || !origins.has(request.headers.origin)) return reply.code(403).send({ success: false, error: 'INVALID_ORIGIN' })
      if (!allow(contactAnalyticsClientIp(request))) return reply.header('Retry-After', '60').code(429).send({ success: false, error: 'ANALYTICS_RATE_LIMIT' })
      if (process.env.ANALYTICS_ENABLED === 'false') return reply.code(204).send()
      let body = request.body
      if (typeof body === 'string') {
        try { body = JSON.parse(body) } catch { return reply.code(400).send({ success: false, error: 'INVALID_ANALYTICS_INPUT' }) }
      }
      const input = contactEventSchema.parse(body)
      await insertContactEvent(input)
      return reply.code(202).send({ success: true })
    })
    app.get('/api/expert/analytics/contacts', async request => {
      const session = await getSession(request)
      requireRole(session, ['admin'])
      const query = statsQuerySchema.parse(request.query)
      return { success: true, ...await contactStats(query) }
    })
  })
}
