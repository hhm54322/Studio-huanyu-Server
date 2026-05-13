import fs from 'node:fs/promises'
import path from 'node:path'
import { closePool } from '../db/pool.js'
import {
  exportReportSubmissions,
  getReportSubmission,
  listReportSubmissions,
  type ReportSubmissionRow,
} from '../db/reportSubmissions.js'

const args = process.argv.slice(2)
const command = args[0]

const getArg = (name: string) => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

const fieldLabels = {
  submissionNo: '提交编号',
  createdAt: '提交时间（原始）',
  createdAtBeijing: '提交时间（北京时间）',
  updatedAt: '更新时间（原始）',
  updatedAtBeijing: '更新时间（北京时间）',
  status: '报告状态',
  fullName: '姓名（拼音/英文）',
  gender: '性别',
  dateOfBirth: '出生日期（当地时间）',
  nationality: '国籍',
  idType: '证件类型',
  idNumber: '证件号码',
  phone: '手机号（含区号）',
  email: '邮箱',
  city: '常住城市',
  preferredLanguage: '首选语言',
  visitPurpose: '就医目的',
  chiefComplaint: '疾病/症状描述',
  selectedRegions: '期望对比国家/地区',
  locale: '页面语言',
} as const

const beijingDateTimeFormatter = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
})

const formatBeijingDateTime = (value: unknown) => {
  if (!value) return ''
  const date = value instanceof Date ? value : new Date(String(value))
  if (Number.isNaN(date.getTime())) return value
  return beijingDateTimeFormatter.format(date).replace(/\//g, '-')
}

const formatLocalDate = (value: unknown) => {
  if (!value) return ''
  const text = String(value)
  const dateOnly = text.match(/^(\d{4}-\d{2}-\d{2})/)
  if (dateOnly) return dateOnly[1]
  const date = value instanceof Date ? value : new Date(text)
  if (Number.isNaN(date.getTime())) return value
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-')
}

const valueLabels: Record<string, Record<string, string>> = {
  status: {
    submitted: '已提交',
    generating: '生成中',
    generated: '已生成',
    failed: '生成失败',
  },
  gender: {
    male: '男',
    female: '女',
    other: '其他',
  },
  idType: {
    passport: '护照',
    id_card: '身份证',
    other: '其他',
  },
  preferredLanguage: {
    zh: '中文',
    en: '英语',
    id: '印尼语',
    ru: '俄语',
    mn: '蒙古语',
    ja: '日语',
    ko: '韩语',
    other: '其他',
  },
  visitPurpose: {
    breast_cancer: '乳腺癌',
    lung_cancer: '肺癌',
    nasopharyngeal_cancer: '鼻咽癌',
    liver_cancer: '肝癌',
    cardiovascular_tumor: '心血管肿瘤',
    neurosurgery: '神经外科',
    spine_surgery: '脊柱外科',
    premium_checkup: '高端体检',
    dental: '牙科',
    cardiology_cardiothoracic: '心内科与心胸外科',
    endocrinology_metabolism: '内分泌与代谢科',
    other: '其他',
  },
  selectedRegions: {
    north_america: '北美（美国/加拿大）',
    europe: '欧洲（英国/德国/法国）',
    southeast_asia: '东南亚（新加坡/泰国/马来西亚）',
    middle_east: '中东（阿联酋/沙特）',
    japan_korea: '日韩',
    australia_new_zealand: '澳新',
    other: '其他',
  },
  locale: {
    zh: '中文',
    en: '英语',
    id: '印尼语',
    ru: '俄语',
    mn: '蒙古语',
  },
}

const labelValue = (field: keyof typeof fieldLabels, value: unknown) => {
  if (field === 'createdAtBeijing' || field === 'updatedAtBeijing') {
    return formatBeijingDateTime(value)
  }
  if (field === 'dateOfBirth') return formatLocalDate(value)
  if (Array.isArray(value)) {
    return value.map((item) => valueLabels[field]?.[String(item)] || String(item)).join('、')
  }
  return valueLabels[field]?.[String(value)] || value
}

const normalizeForOutput = (row: ReportSubmissionRow) => ({
  submissionNo: row.submission_no,
  createdAt: row.created_at,
  createdAtBeijing: row.created_at,
  updatedAt: row.updated_at,
  updatedAtBeijing: row.updated_at,
  status: row.report_status,
  fullName: row.full_name,
  gender: row.gender,
  dateOfBirth: row.date_of_birth,
  nationality: row.nationality,
  idType: row.id_type,
  idNumber: row.id_number,
  phone: row.phone,
  email: row.email,
  city: row.city,
  preferredLanguage: row.preferred_language,
  visitPurpose: row.visit_purpose,
  chiefComplaint: row.chief_complaint,
  selectedRegions: row.selected_regions,
  locale: row.locale,
})

const toChineseOutput = (row: ReturnType<typeof normalizeForOutput>) => {
  const result: Record<string, unknown> = {}
  ;(Object.keys(fieldLabels) as Array<keyof typeof fieldLabels>).forEach((field) => {
    result[fieldLabels[field]] = labelValue(field, row[field])
  })
  return result
}

const escapeCsv = (value: unknown) => {
  const text = Array.isArray(value) ? value.join('|') : String(value ?? '')
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

const toCsv = (rows: ReturnType<typeof normalizeForOutput>[]) => {
  const fields = [
    'submissionNo',
    'createdAt',
    'createdAtBeijing',
    'updatedAt',
    'updatedAtBeijing',
    'status',
    'fullName',
    'gender',
    'dateOfBirth',
    'nationality',
    'idType',
    'idNumber',
    'phone',
    'email',
    'city',
    'preferredLanguage',
    'visitPurpose',
    'chiefComplaint',
    'selectedRegions',
    'locale',
  ] as Array<keyof typeof fieldLabels>
  const headers = fields.map((field) => fieldLabels[field])
  return [
    headers.join(','),
    ...rows.map((row) => fields.map((field) => escapeCsv(labelValue(field, row[field]))).join(',')),
  ].join('\n')
}

try {
  if (command === 'list') {
    const limit = Number(getArg('--limit') || 20)
    const rows = await listReportSubmissions(limit)
    console.table(rows.map((row) => ({
      提交编号: row.submission_no,
      '提交时间（北京时间）': formatBeijingDateTime(row.created_at),
      报告状态: labelValue('status', row.report_status),
      姓名: row.full_name,
      邮箱: row.email,
      就医目的: labelValue('visitPurpose', row.visit_purpose),
    })))
  } else if (command === 'get') {
    const submissionNo = args[1]
    if (!submissionNo) throw new Error('Usage: npm run submissions:get -- <submissionNo>')
    const row = await getReportSubmission(submissionNo)
    if (!row) throw new Error(`Submission not found: ${submissionNo}`)
    console.log(JSON.stringify(toChineseOutput(normalizeForOutput(row)), null, 2))
  } else if (command === 'export') {
    const from = getArg('--from')
    const to = getArg('--to')
    const format = getArg('--format') || 'csv'
    const rows = (await exportReportSubmissions(from, to)).map(normalizeForOutput)
    const exportsDir = path.resolve('exports')
    await fs.mkdir(exportsDir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const file = path.join(exportsDir, `report-submissions-${stamp}.${format}`)
    const content = format === 'json' ? JSON.stringify(rows.map(toChineseOutput), null, 2) : toCsv(rows)
    await fs.writeFile(file, `${content}\n`, 'utf8')
    console.log(`Exported ${rows.length} submissions to ${file}`)
  } else {
    throw new Error('Usage: submissions <list|get|export>')
  }
} finally {
  await closePool()
}
