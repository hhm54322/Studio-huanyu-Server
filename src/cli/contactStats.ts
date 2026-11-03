import { contactStats, closeAnalyticsPool } from '../analytics/store.js'
import { statsQuerySchema } from '../analytics/schema.js'

const allowed = new Set(['from', 'to', 'timezone', 'group-by', 'locale', 'topic', 'page', 'entry', 'country', 'source', 'medium', 'campaign', 'content', 'keyword', 'source-id', 'limit', 'offset', 'format'])
function parseArguments(args: string[]) {
  const query: Record<string, string> = {}
  let format = 'json'
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]?.replace(/^--/, '')
    if (!args[index]?.startsWith('--') || !name || !allowed.has(name) || !args[index + 1] || args[index + 1]!.startsWith('--')) throw new Error('Invalid arguments. See docs/contact-analytics.md.')
    const value = args[index + 1]!
    if (name === 'format') format = value
    else query[name === 'group-by' ? 'groupBy' : name === 'source-id' ? 'sourceId' : name] = value
  }
  if (!['json', 'csv'].includes(format)) throw new Error('Format must be json or csv')
  return { query: statsQuerySchema.parse(query), format }
}
// Neutralize spreadsheet formulas in externally supplied marketing labels.
export const csvCell = (value: unknown) => `"${String(value ?? '').replace(/^[=+\-@\t\r]/, "'$&").replace(/"/g, '""')}"`
try {
  const { query, format } = parseArguments(process.argv.slice(2))
  const result = await contactStats(query)
  if (format === 'json') process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  else {
    const headers = [...query.groupBy, 'clicks', 'uniqueVisitors', 'sessions']
    process.stdout.write(`${headers.map(csvCell).join(',')}\n`)
    for (const row of result.groups) process.stdout.write(`${headers.map(key => csvCell(row[key])).join(',')}\n`)
    process.stderr.write(`WhatsApp clicks only; anonymous browser counts. ${query.from} to ${query.to} (${query.timezone}). Groups ${query.offset + 1}-${Math.min(query.offset + query.limit, result.totalGroups)} of ${result.totalGroups}.\n`)
  }
} catch (error) {
  // Do not expose database connection strings or unvalidated filter values.
  process.stderr.write('Contact statistics query failed. Check arguments, database migration and connectivity.\n')
  process.exitCode = 1
} finally { await closeAnalyticsPool() }
