import { before, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import { config } from '../../config.js'
import { pool, closePool } from '../../db/pool.js'
import { migrateExpertReview } from '../../expert/migration.js'
import { cookieName, tokenHash } from '../../expert/security.js'
import { migrateContactAnalytics } from '../migration.js'
import { analyticsPool, closeAnalyticsPool, contactStats, insertContactEvent } from '../store.js'
import { statsQuerySchema, type ContactEvent } from '../schema.js'
import { createAnalyticsRateLimit, registerContactAnalyticsRoutes } from '../../routes/contactAnalytics.js'

// Refuse to seed, truncate or mutate any real application database.
assert.match(new URL(config.databaseUrl).pathname, /^\/huanyu_analytics_qa$/)
const origin = 'http://127.0.0.1:5173'
const app = Fastify({ logger: false })
let admin: string, expert: string
const event = (change: Partial<ContactEvent> = {}): ContactEvent => ({
  schemaVersion: 1, event: 'whatsapp_click', eventId: randomUUID(), visitorId: randomUUID(), sessionId: randomUUID(),
  occurredAt: new Date().toISOString(), locale: 'id', topic: 'dental', page: 'patient-dental', entry: 'floating',
  attribution: { utm_source: 'facebook', utm_campaign: 'HY-dental-id', utm_term: 'dental implant' }, ...change,
})
const post = (payload: Record<string, unknown> | ContactEvent | string, headers: Record<string, string> = {}) => app.inject({ method: 'POST', url: '/api/analytics/events', payload, headers: { origin, ...headers } })
const stats = (query: string, cookie = admin) => app.inject({ method: 'GET', url: `/api/expert/analytics/contacts${query}`, headers: { cookie } })
before(async () => {
  process.env.ANALYTICS_ALLOWED_ORIGINS = origin
  await migrateContactAnalytics(analyticsPool); await migrateContactAnalytics(analyticsPool)
  await migrateExpertReview(pool)
  await analyticsPool.query('TRUNCATE contact_click_events')
  for (const role of ['admin', 'expert']) {
    const token = randomBytes(32).toString('hex')
    const account = await pool.query("INSERT INTO expert_accounts(username,display_name,password_hash,role,test_account) VALUES($1,$1,'qa-unused',$2,true) RETURNING id", [`${role}-${randomUUID()}`, role])
    await pool.query("INSERT INTO expert_sessions(token_hash,account_id,csrf_token,expires_at) VALUES($1,$2,'qa',now()+interval '1 hour')", [tokenHash(token), account.rows[0].id])
    if (role === 'admin') admin = `${cookieName}=${token}`; else expert = `${cookieName}=${token}`
  }
  await app.register(cors, { origin: [origin] })
  await registerContactAnalyticsRoutes(app); await app.ready()
})
after(async () => { await app.close(); await closeAnalyticsPool(); await closePool() })

test('accept JSON and beacon-style text, with atomic idempotency and anonymous storage', async () => {
  const input = event()
  const results = await Promise.all(Array.from({ length: 5 }, () => post(input)))
  assert.ok(results.every(result => result.statusCode === 202))
  const saved = (await analyticsPool.query('SELECT * FROM contact_click_events WHERE event_id=$1', [input.eventId])).rows
  assert.equal(saved.length, 1)
  assert.equal(saved[0].utm_term, 'dental implant')
  assert.match(saved[0].visitor_hash, /^[a-f0-9]{64}$/)
  assert.ok(!JSON.stringify(saved).includes(input.visitorId))
  assert.ok(!JSON.stringify(saved).includes(input.sessionId))
  assert.equal((await post(JSON.stringify(event()), { 'content-type': 'text/plain;charset=UTF-8' })).statusCode, 202)
})
test('reject untrusted origin, personal fields, invalid topics/timestamps and oversized payloads', async () => {
  const count = Number((await analyticsPool.query('SELECT count(*) FROM contact_click_events')).rows[0].count)
  assert.equal((await post(event(), { origin: 'https://other.example' })).statusCode, 403)
  assert.equal((await post(event(), { origin: '' })).statusCode, 403)
  for (const invalid of [
    { ...event(), patientName: 'PRIVATE_PATIENT' }, { ...event(), page: '/report?email=private@example.test' },
    { ...event(), topic: 'free text diagnosis' }, { ...event(), country: 'Malaysia' },
    { ...event(), occurredAt: new Date(Date.now() - 25 * 3600_000).toISOString() },
    { ...event(), occurredAt: new Date(Date.now() + 10 * 60_000).toISOString() },
    { ...event(), attribution: { utm_source: 'facebook', phone: 'PRIVATE_PHONE' } },
    { ...event(), attribution: { utm_campaign: 'https://private/?token=secret' } },
    { ...event(), event: 'payment_completed' },
  ]) assert.equal((await post(invalid)).statusCode, 400)
  assert.equal((await post('{invalid', { 'content-type': 'text/plain' })).statusCode, 400)
  assert.equal((await post('x'.repeat(5000), { 'content-type': 'text/plain' })).statusCode, 413)
  assert.equal(Number((await analyticsPool.query('SELECT count(*) FROM contact_click_events')).rows[0].count), count)
})
test('only an active administrator can read analytics; responses cannot be cached', async () => {
  assert.equal((await stats('', '')).statusCode, 401)
  assert.equal((await stats('', expert)).statusCode, 403)
  const response = await stats('')
  assert.equal(response.statusCode, 200)
  assert.equal(response.headers['cache-control'], 'private, no-store')
  assert.equal(response.json().metrics.conversations, 'not_measured')
  const token = randomBytes(32).toString('hex')
  assert.equal((await stats('', `${cookieName}=${token}`)).statusCode, 401)
})
test('actual PostgreSQL aggregation, distinct counts, filters, timezone boundaries and pagination agree', async () => {
  await analyticsPool.query('TRUNCATE contact_click_events')
  const visitor = randomUUID(), session = randomUUID()
  const seed = [
    event({ visitorId: visitor, sessionId: session, occurredAt: '2026-01-01T23:30:00Z' }),
    event({ visitorId: visitor, sessionId: session, occurredAt: '2026-01-02T01:00:00Z', entry: 'footer-shared' }),
    event({ occurredAt: '2026-01-02T12:00:00Z', locale: 'pt', topic: 'lung_cancer', attribution: { utm_source: 'google', utm_campaign: 'HY-lung-pt', utm_term: 'lung care' } }),
    event({ occurredAt: '2026-01-03T00:00:00Z', attribution: {} }),
  ]
  for (const item of seed) await insertContactEvent(item)
  const summary = await contactStats(statsQuerySchema.parse({ from: '2026-01-01', to: '2026-01-02' }))
  assert.deepEqual(summary.totals, { clicks: 3, uniqueVisitors: 2, sessions: 2 })
  assert.deepEqual(summary.groups.map(row => [row.day, row.clicks, row.uniqueVisitors]), [['2026-01-01', 1, 1], ['2026-01-02', 2, 2]])
  const local = await contactStats(statsQuerySchema.parse({ from: '2026-01-02', to: '2026-01-02', timezone: 'Asia/Shanghai', groupBy: 'day,campaign' }))
  assert.equal(local.totals.clicks, 3)
  assert.equal(local.groups.find(row => row.campaign === 'HY-dental-id')?.clicks, 2)
  const filtered = await stats('?from=2026-01-01&to=2026-01-02&groupBy=campaign,keyword&locale=id&source=facebook&topic=dental')
  assert.equal(filtered.statusCode, 200)
  assert.equal(filtered.json().totals.clicks, 2)
  assert.equal(filtered.json().totals.uniqueVisitors, 1)
  assert.equal(filtered.json().groups[0].keyword, 'dental implant')
  const paged = await contactStats(statsQuerySchema.parse({ from: '2026-01-01', to: '2026-01-02', groupBy: 'campaign', offset: '1', limit: '1' }))
  assert.equal(paged.totalGroups, 2); assert.equal(paged.groups.length, 1)
  const emptyPage = await contactStats(statsQuerySchema.parse({ from: '2026-01-01', to: '2026-01-02', groupBy: 'campaign', offset: '50' }))
  assert.equal(emptyPage.totalGroups, 2); assert.equal(emptyPage.groups.length, 0)
  const unattributed = await stats('?from=2026-01-03&to=2026-01-03&source=')
  assert.equal(unattributed.json().totals.clicks, 1)
  assert.ok(!JSON.stringify(summary).includes('visitor_hash'))
})
test('bounded, parameterized query contract rejects invalid ranges/dimensions and supports zero results', async () => {
  for (const query of ['?from=2026-02-30', '?from=2026-01-02&to=2026-01-01', '?from=2024-01-01&to=2026-01-01', '?groupBy=day;DROP%20TABLE', '?groupBy=day,day', '?timezone=Invalid/Timezone', '?limit=101', '?patient=secret']) {
    assert.equal((await stats(query)).statusCode, 400, query)
  }
  const empty = await stats('?from=2026-01-01&to=2026-01-02&source=nonexistent')
  assert.equal(empty.json().totals.clicks, 0); assert.deepEqual(empty.json().groups, []); assert.equal(empty.json().totalGroups, 0)
})
test('rate limiting is bounded, expires and public collection can be disabled', async () => {
  const allow = createAnalyticsRateLimit()
  for (let i = 0; i < 120; i++) assert.equal(allow('qa-ip', 1000), true)
  assert.equal(allow('qa-ip', 1000), false)
  assert.equal(allow('other-ip', 1000), true)
  assert.equal(allow('qa-ip', 61_000), true)
  process.env.ANALYTICS_ENABLED = 'false'
  const input = event(); assert.equal((await post(input)).statusCode, 204)
  assert.equal((await analyticsPool.query('SELECT * FROM contact_click_events WHERE event_id=$1', [input.eventId])).rowCount, 0)
  delete process.env.ANALYTICS_ENABLED
})
test('local proxy clients have separate limits; spoofed forwarding cannot bypass a limit', async () => {
  const proxyApp = Fastify({ logger: false })
  await registerContactAnalyticsRoutes(proxyApp)
  process.env.ANALYTICS_ENABLED = 'false'
  const ping = (remoteAddress: string, forwarded: string) => proxyApp.inject({
    method: 'POST', url: '/api/analytics/events', remoteAddress,
    headers: { origin, 'x-forwarded-for': forwarded }, payload: {},
  })
  try {
    for (let i = 0; i < 120; i++) assert.equal((await ping('127.0.0.1', `192.0.2.${i}, 198.51.100.10`)).statusCode, 204)
    const limited = await ping('127.0.0.1', '192.0.2.200, 198.51.100.10')
    assert.equal(limited.statusCode, 429); assert.equal(limited.headers['retry-after'], '60')
    assert.equal((await ping('127.0.0.1', '198.51.100.20')).statusCode, 204)
    assert.equal((await ping('::1', '198.51.100.30')).statusCode, 204)
    assert.equal((await ping('::ffff:127.0.0.1', '198.51.100.40')).statusCode, 204)
    for (let i = 0; i < 120; i++) assert.equal((await ping('203.0.113.10', `192.0.2.${i}`)).statusCode, 204)
    assert.equal((await ping('203.0.113.10', '192.0.2.200')).statusCode, 429)
    // Malformed forwarded addresses fall back to the immediate socket peer.
    assert.equal((await ping('127.0.0.1', 'not-an-ip')).statusCode, 204)
  } finally {
    delete process.env.ANALYTICS_ENABLED
    await proxyApp.close()
  }
})
