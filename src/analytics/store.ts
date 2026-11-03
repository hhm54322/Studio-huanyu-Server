import { createHash } from 'node:crypto'
import pg from 'pg'
import { config } from '../config.js'
import type { AnalyticsDimension, ContactEvent, StatsQuery } from './schema.js'

// Analytics must not use up the medical report pool's connections.
export const analyticsPool = new pg.Pool({
  connectionString: config.databaseUrl, max: 2, connectionTimeoutMillis: 2000,
  idleTimeoutMillis: 10_000, statement_timeout: 5000, query_timeout: 6000,
})
analyticsPool.on('error', () => { console.warn('Contact analytics database connection unavailable') })
export const closeAnalyticsPool = () => analyticsPool.end()
const anonymousHash = (value: string) => createHash('sha256').update(`huanyu-contact-v1:${value}`).digest('hex')

export async function insertContactEvent(event: ContactEvent) {
  const result = await analyticsPool.query(`INSERT INTO contact_click_events
    (event_id,event,visitor_hash,session_hash,occurred_at,locale,topic,page,entry,country,utm_source,utm_medium,utm_campaign,utm_content,utm_term,source_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
    ON CONFLICT(event_id) DO NOTHING RETURNING event_id`, [
    event.eventId, event.event, anonymousHash(event.visitorId), anonymousHash(event.sessionId), event.occurredAt,
    event.locale, event.topic, event.page, event.entry, event.country || '',
    event.attribution.utm_source || '', event.attribution.utm_medium || '', event.attribution.utm_campaign || '',
    event.attribution.utm_content || '', event.attribution.utm_term || '', event.attribution.source_id || '',
  ])
  return result.rowCount === 1
}
const columns: Record<Exclude<AnalyticsDimension, 'day'>, string> = {
  locale: 'locale', topic: 'topic', page: 'page', entry: 'entry', country: 'country',
  source: 'utm_source', medium: 'utm_medium', campaign: 'utm_campaign', content: 'utm_content',
  keyword: 'utm_term', sourceId: 'source_id',
}
export async function contactStats(query: StatsQuery) {
  const parameters: unknown[] = [query.from, query.to, query.timezone]
  const where = ["occurred_at >= ($1::date::timestamp AT TIME ZONE $3)", "occurred_at < (($2::date + 1)::timestamp AT TIME ZONE $3)"]
  for (const [dimension, column] of Object.entries(columns)) {
    const value = query[dimension as keyof StatsQuery]
    if (value !== undefined) { parameters.push(value); where.push(`${column} = $${parameters.length}`) }
  }
  const selection = query.groupBy.map(dimension => dimension === 'day'
    ? `to_char(occurred_at AT TIME ZONE $3, 'YYYY-MM-DD') AS "day"`
    : `${columns[dimension]} AS "${dimension}"`).join(', ')
  const groups = query.groupBy.map((_, index) => index + 1).join(', ')
  const groupOrder = query.groupBy.map(dimension => `"${dimension}" ASC`).join(', ')
  const db = await analyticsPool.connect()
  try {
    // Totals and grouped pagination share a snapshot, even during live clicks.
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    const summary = await db.query(`SELECT count(*)::int clicks, count(DISTINCT visitor_hash)::int "uniqueVisitors",
      count(DISTINCT session_hash)::int sessions FROM contact_click_events WHERE ${where.join(' AND ')}`, parameters)
    const count = await db.query(`SELECT count(*)::int total FROM (SELECT ${selection} FROM contact_click_events WHERE ${where.join(' AND ')} GROUP BY ${groups}) grouped`, parameters)
    const rows = await db.query(`SELECT ${selection}, count(*)::int clicks, count(DISTINCT visitor_hash)::int "uniqueVisitors",
      count(DISTINCT session_hash)::int sessions FROM contact_click_events WHERE ${where.join(' AND ')}
      GROUP BY ${groups} ORDER BY ${query.groupBy[0] === 'day' ? groupOrder : `clicks DESC, ${groupOrder}`}
      LIMIT $${parameters.length + 1} OFFSET $${parameters.length + 2}`, [...parameters, query.limit, query.offset])
    await db.query('COMMIT')
    return {
      event: 'whatsapp_click' as const, query, totals: summary.rows[0] as { clicks: number; uniqueVisitors: number; sessions: number },
      groups: rows.rows as (Record<string, string | number> & { clicks: number; uniqueVisitors: number; sessions: number })[],
      totalGroups: count.rows[0].total as number,
      metrics: { uniqueVisitors: 'anonymous_browser_ids', conversations: 'not_measured', timezone: query.timezone },
    }
  } catch (error) {
    await db.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally { db.release() }
}
