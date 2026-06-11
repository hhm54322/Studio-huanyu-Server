import { closePool } from '../db/pool.js'
import { readReportGenerationEvents, type ReportGenerationEvent, type ReportGenerationMode } from '../report/generationEventLog.js'

const args = process.argv.slice(2)

const getArg = (name: string) => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

const hasFlag = (name: string) => args.includes(name)

const parseDateBoundary = (value: string | undefined, endOfDay = false) => {
  if (!value) return null
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? new Date(`${value}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`)
    : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

const formatPercent = (count: number, total: number) => {
  if (!total) return '0.00%'
  return `${((count / total) * 100).toFixed(2)}%`
}

const percentile = (values: number[], p: number) => {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  return sorted[index]
}

const average = (values: number[]) => (
  values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : 0
)

const groupBy = <T>(items: T[], getKey: (item: T) => string) => items.reduce<Record<string, T[]>>((acc, item) => {
  const key = getKey(item)
  acc[key] = acc[key] || []
  acc[key].push(item)
  return acc
}, {})

const countBy = <T>(items: T[], getKey: (item: T) => string) => {
  const counts = items.reduce<Record<string, number>>((acc, item) => {
    const key = getKey(item)
    acc[key] = (acc[key] || 0) + 1
    return acc
  }, {})
  return Object.entries(counts).sort((a, b) => b[1] - a[1])
}

const summarizeGroup = (mode: ReportGenerationMode | 'all', events: ReportGenerationEvent[]) => {
  const completed = events.filter((event) => event.event === 'generation_completed')
  const generated = completed.filter((event) => event.status === 'generated')
  const failed = completed.filter((event) => event.status === 'failed')
  const durations = completed.map((event) => event.durationMs || 0).filter((value) => value > 0)
  const llmGenerated = generated.filter((event) => event.generatedBy === 'llm')
  const rulesGenerated = generated.filter((event) => event.generatedBy === 'rules')

  return {
    mode,
    total: completed.length,
    generated: generated.length,
    failed: failed.length,
    successRate: formatPercent(generated.length, completed.length),
    failureRate: formatPercent(failed.length, completed.length),
    llmGenerated: llmGenerated.length,
    rulesGenerated: rulesGenerated.length,
    avgDurationMs: average(durations),
    p95DurationMs: percentile(durations, 95),
  }
}

const toCsv = (rows: ReturnType<typeof summarizeGroup>[]) => {
  const headers = ['mode', 'total', 'generated', 'failed', 'successRate', 'failureRate', 'llmGenerated', 'rulesGenerated', 'avgDurationMs', 'p95DurationMs']
  return [
    headers.join(','),
    ...rows.map((row) => headers.map((header) => String(row[header as keyof typeof row] ?? '')).join(',')),
  ].join('\n')
}

try {
  const from = parseDateBoundary(getArg('--from'))
  const to = parseDateBoundary(getArg('--to'), true)
  const mode = getArg('--mode') as ReportGenerationMode | undefined
  const format = getArg('--format') || 'table'
  const recentFailuresLimit = Number(getArg('--recent-failures') || 10)

  let events = await readReportGenerationEvents()
  events = events.filter((event) => {
    const eventDate = new Date(event.timestamp)
    if (from && eventDate < from) return false
    if (to && eventDate > to) return false
    if (mode && event.mode !== mode) return false
    return true
  })

  const completed = events.filter((event) => event.event === 'generation_completed')
  const grouped = groupBy(completed, (event) => event.mode)
  const summaryRows = [
    summarizeGroup('all', completed),
    ...(['free', 'professional'] as const)
      .filter((item) => !mode || item === mode)
      .map((item) => summarizeGroup(item, grouped[item] || [])),
  ]

  const failures = completed
    .filter((event) => event.status === 'failed')
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))

  if (format === 'json') {
    console.log(JSON.stringify({
      filters: {
        from: getArg('--from') || null,
        to: getArg('--to') || null,
        mode: mode || null,
      },
      summary: summaryRows,
      failureReasons: countBy(failures, (event) => event.errorCode || 'UNKNOWN').map(([errorCode, count]) => ({ errorCode, count })),
      failuresByVisitPurpose: countBy(failures, (event) => event.visitPurpose || 'unknown').map(([visitPurpose, count]) => ({ visitPurpose, count })),
      recentFailures: failures.slice(0, recentFailuresLimit),
    }, null, 2))
  } else if (format === 'csv') {
    console.log(toCsv(summaryRows))
  } else {
    console.log('Report generation summary')
    console.table(summaryRows)

    if (failures.length) {
      console.log('\nFailure reasons')
      console.table(countBy(failures, (event) => event.errorCode || 'UNKNOWN').map(([errorCode, count]) => ({
        errorCode,
        count,
        rate: formatPercent(count, completed.length),
      })))

      console.log('\nFailures by visit purpose')
      console.table(countBy(failures, (event) => event.visitPurpose || 'unknown').slice(0, 12).map(([visitPurpose, count]) => ({
        visitPurpose,
        count,
      })))

      if (!hasFlag('--no-recent')) {
        console.log('\nRecent failures')
        console.table(failures.slice(0, recentFailuresLimit).map((event) => ({
          time: event.timestamp,
          mode: event.mode,
          submissionNo: event.submissionNo || '',
          visitPurpose: event.visitPurpose || '',
          durationMs: event.durationMs || 0,
          errorCode: event.errorCode || '',
          message: event.errorMessage || '',
        })))
      }
    }
  }
} finally {
  await closePool()
}
