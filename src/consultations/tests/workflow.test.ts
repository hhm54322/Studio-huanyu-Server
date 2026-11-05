import { before, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import Fastify from 'fastify'
import { config } from '../../config.js'
import { pool, closePool } from '../../db/pool.js'
import { baseMigrationSql } from '../../db/migrate.js'
import { consultationMigrationSql } from '../../db/consultationsMigration.js'
import { migrateExpertReview } from '../../expert/migration.js'
import { cookieName, tokenHash } from '../../expert/security.js'
import { registerPatientSubmissionRoutes } from '../../routes/patientSubmissions.js'
import { registerConsultationAdminRoutes } from '../../routes/consultationAdmin.js'

// This suite may create records only in its disposable, dedicated database.
assert.equal(new URL(config.databaseUrl).pathname, '/huanyu_consultation_qa')
const app = Fastify({ logger: false })
const origin = 'http://127.0.0.1:5436'
const payload = (changes: Record<string, unknown> = {}) => ({
  schemaVersion: 2, requestId: randomUUID(), name: 'QA synthetic user', contact: '+12025550123',
  country: 'MY', topic: 'dental', reportStatus: 'has', budget: '5000_15000', timeWindow: 'one_three',
  locale: 'en', mode: 'guided', handoffReason: 'appointment', sourceContext: 'qa-m06m08', concern: 'QA synthetic consultation', ...changes,
})
let admin = '', expert = '', id = '', privateToken = ''
let ip = 0
const post = (body: Record<string, unknown>, customOrigin = origin, remote = `192.0.2.${++ip}`) => app.inject({ method: 'POST', url: '/api/consultations', payload: body, headers: { origin: customOrigin }, remoteAddress: remote })
const list = (query = '', cookie = admin) => app.inject({ method: 'GET', url: `/api/expert/consultations${query}`, headers: { cookie } })
const patch = (status: string, csrf = 'qa-csrf', cookie = admin) => app.inject({ method: 'PATCH', url: `/api/expert/consultations/${id}/status`, headers: { cookie, origin, 'x-expert-csrf': csrf }, payload: { status } })

before(async () => {
  await pool.query(baseMigrationSql)
  await pool.query(consultationMigrationSql)
  await pool.query(consultationMigrationSql)
  await migrateExpertReview(pool)
  await pool.query('TRUNCATE consultation_submissions')
  for (const role of ['admin', 'expert']) {
    const token = randomBytes(32).toString('hex')
    const account = await pool.query("INSERT INTO expert_accounts(username,display_name,password_hash,role,test_account) VALUES($1,$1,'qa-unused',$2,true) RETURNING id", [`${role}-${randomUUID()}`, role])
    await pool.query("INSERT INTO expert_sessions(token_hash,account_id,csrf_token,expires_at) VALUES($1,$2,'qa-csrf',now()+interval '1 hour')", [tokenHash(token), account.rows[0].id])
    if (role === 'admin') { admin = `${cookieName}=${token}`; privateToken = token } else expert = `${cookieName}=${token}`
  }
  await registerPatientSubmissionRoutes(app)
  await registerConsultationAdminRoutes(app)
  await app.ready()
})
after(async () => { await app.close(); await closePool() })

test('stores all five languages and every care topic, with private no-store responses', async () => {
  const topics = ['dental', 'lung_cancer', 'premium_checkup', 'traditional_medicine', 'general']
  for (const [index, locale] of ['zh', 'en', 'id', 'ms', 'pt'].entries()) {
    const input = payload({ locale, topic: topics[index] })
    const response = await post(input)
    assert.equal(response.statusCode, 201)
    assert.equal(response.headers['cache-control'], 'private, no-store')
    id = response.json().submissionId
    const saved = (await pool.query('SELECT * FROM consultation_submissions WHERE id=$1', [id])).rows[0]
    assert.equal(saved.name, input.name); assert.equal(saved.locale, locale); assert.equal(saved.topic, topics[index])
    assert.equal(saved.flow_mode, 'guided'); assert.equal(saved.handoff_reason, 'appointment')
    assert.match(saved.payload_hash, /^[a-f0-9]{64}$/)
    assert.ok(!JSON.stringify(response.json()).includes(input.contact))
  }
})
test('concurrent repeat requests create one record; changed content conflicts', async () => {
  const input = payload(), responses = await Promise.all(Array.from({ length: 5 }, () => post(input)))
  assert.equal(responses.filter(r => r.statusCode === 201).length, 1)
  assert.ok(responses.every(r => [200, 201].includes(r.statusCode)))
  assert.equal(new Set(responses.map(r => r.json().submissionId)).size, 1)
  assert.equal((await post({ ...input, country: 'SG' })).statusCode, 409)
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM consultation_submissions WHERE request_id=$1', [input.requestId])).rows[0].n, 1)
})
test('invalid input, untrusted origins and oversize requests cannot create records', async () => {
  const count = (await pool.query('SELECT count(*)::int AS n FROM consultation_submissions')).rows[0].n
  for (const invalid of [payload({ contact: '15855159472' }), payload({ contact: '+0123456789' }), payload({ name: '' }), payload({ country: '' }), payload({ topic: 'invented' }), payload({ locale: 'xx' }), payload({ status: 'resolved' }), payload({ handoffReason: 'unknown' })]) assert.equal((await post(invalid)).statusCode, 400)
  assert.equal((await post(payload(), 'https://not-allowed.example')).statusCode, 403)
  assert.equal((await post(payload({ concern: 'x'.repeat(9000) }))).statusCode, 413)
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM consultation_submissions')).rows[0].n, count)
})
test('legacy clients remain compatible and share the private admin queue', async () => {
  const response = await post({ requestId: randomUUID(), name: 'QA legacy', contact: 'legacy@invalid.test', concern: 'QA legacy client' })
  assert.equal(response.statusCode, 201)
  const stored = (await list(`?search=${response.json().submissionId}`)).json()
  assert.equal(stored.total, 1); assert.equal(stored.items[0].country, '')
})
test('only administrators can list or read; public identifiers expose no records', async () => {
  assert.equal((await list('', '')).statusCode, 401)
  assert.equal((await list('', expert)).statusCode, 403)
  const response = await list(`?search=${id}`)
  assert.equal(response.statusCode, 200); assert.equal(response.json().total, 1)
  assert.equal(response.headers['cache-control'], 'private, no-store')
  assert.ok(!JSON.stringify(response.json()).includes(privateToken))
  assert.ok(!JSON.stringify(response.json()).includes('payload_hash'))
  const detail = await app.inject({ method: 'GET', url: `/api/expert/consultations/${id}` })
  assert.equal(detail.statusCode, 401)
})
test('state updates require administrator CSRF and are audited; filtering/pagination work', async () => {
  assert.equal((await patch('in_progress', '')).statusCode, 403)
  assert.equal((await patch('in_progress', 'qa-csrf', expert)).statusCode, 403)
  assert.equal((await patch('invalid')).statusCode, 400)
  for (const state of ['in_progress', 'waiting_user', 'handoff', 'resolved', 'closed']) {
    const response = await patch(state)
    assert.equal(response.statusCode, 200); assert.equal(response.json().item.status, state)
    assert.equal((await list(`?status=${state}&search=${id}`)).json().total, 1)
  }
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM expert_audit WHERE action='consultation_status_updated' AND resource_id=$1", [id])).rows[0].n, 5)
  assert.equal((await list('?limit=1&page=1')).json().items.length, 1)
  assert.deepEqual((await list('?page=10000')).json().items, [])
  assert.equal((await list('?search=%27%20OR%201%3D1--')).json().total, 0)
})
test('rate limiting bounds public submission abuse independently per address', async () => {
  for (let i = 0; i < 15; i++) assert.equal((await post(payload(), origin, '192.0.2.250')).statusCode, 201)
  const limited = await post(payload(), origin, '192.0.2.250')
  assert.equal(limited.statusCode, 429); assert.equal(limited.headers['retry-after'], '60')
  assert.equal((await post(payload(), origin, '192.0.2.251')).statusCode, 201)
})
