import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { generateReport } from '../report/generator.js'
import { generateProfessionalReport } from '../report/professionalGenerator.js'
import { parseUploadedFile } from '../report/fileParser.js'
import { collectMedicalFactBundle, type MedicalDocumentFact } from '../report/medicalFactExtractor.js'
import { reportSubmissionSchema } from '../validators/reportSubmission.js'
import { professionalReportSubmissionSchema, type ProfessionalParsedFile, type ProfessionalUploadedFile } from '../validators/professionalReportSubmission.js'

const imageMimeTypes: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
}

const reportDir = path.resolve(process.cwd(), '../报告')
const outputDir = path.resolve(process.cwd(), 'exports')
const outputJsonPath = path.join(outputDir, 'real-upload-report-preview.json')
const outputMdPath = path.join(outputDir, 'real-upload-report-preview.md')
const reuseOcr = process.argv.includes('--reuse-ocr')

const compact = (value: string | undefined, max = 260) => {
  const text = String(value || '').replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max)}...` : text
}

const isPreviewDisplayEvidence = (value: string | undefined) => {
  const text = compact(value, 320)
  const lower = text.toLowerCase()
  if (!text) return false
  if ([
    '医学摘要',
    '报告可见内容',
    '主要结论',
    'patient id',
    'accession no',
    'no mr',
    'study date',
    '出生日期',
    'portaca',
  ].some((token) => lower.includes(token.toLowerCase()))) return false
  if (/^患者\s*[A-Za-z]/.test(text)) return false
  return true
}

const previewEvidence = (items: Array<string | undefined>, limit = 3, max = 180) => {
  const cleaned = Array.from(new Set(items
    .map((item) => compact(item, max))
    .filter(isPreviewDisplayEvidence)))
  return cleaned.slice(0, limit)
}

const getMedicalFacts = (file: ProfessionalParsedFile) => file.metadata?.medicalFacts as MedicalDocumentFact | undefined

const buildUploadedFiles = async () => {
  const names = (await readdir(reportDir)).sort((left, right) => left.localeCompare(right, 'zh-CN', { numeric: true }))
  const files: Array<ProfessionalUploadedFile & { absolutePath: string }> = []

  for (const name of names) {
    const absolutePath = path.join(reportDir, name)
    const fileStat = await stat(absolutePath)
    if (!fileStat.isFile()) continue

    const ext = path.extname(name).toLowerCase()
    const mimeType = imageMimeTypes[ext]
    if (!mimeType) continue

    files.push({
      fieldName: 'files',
      originalName: name,
      storedName: name,
      relativePath: path.relative(process.cwd(), absolutePath),
      absolutePath,
      mimeType,
      size: fileStat.size,
    })
  }

  return files
}

const parseFiles = async (files: Array<ProfessionalUploadedFile & { absolutePath: string }>) => {
  const parsedFiles: ProfessionalParsedFile[] = []

  for (const [index, file] of files.entries()) {
    console.log(`[OCR] ${index + 1}/${files.length} ${file.originalName}`)
    parsedFiles.push(await parseUploadedFile(file))
  }

  return parsedFiles
}

const loadCachedParsedFiles = async (files: Array<ProfessionalUploadedFile & { absolutePath: string }>) => {
  if (!reuseOcr) return null

  try {
    const payload = JSON.parse(await readFile(outputJsonPath, 'utf8')) as { parsedFiles?: ProfessionalParsedFile[] }
    const parsedFiles = payload.parsedFiles || []
    const expectedNames = files.map((file) => file.originalName).join('|')
    const actualNames = parsedFiles.map((file) => file.originalName).join('|')
    if (parsedFiles.length && actualNames === expectedNames) {
      console.log(`[OCR] reusing ${parsedFiles.length} parsed files from ${outputJsonPath}`)
      return parsedFiles
    }
  } catch {
    console.log('[OCR] no cached parsed files found; running OCR')
  }

  return null
}

const basePatient = {
  fullName: 'Real Upload Preview Patient',
  gender: 'female' as const,
  dateOfBirth: '1982-01-01',
  nationality: 'Malaysia',
  phone: '+60123456789',
  email: 'real.upload.preview@example.com',
  city: 'Kuala Lumpur',
  preferredLanguage: '中文',
}

const chiefComplaint = '右侧乳腺癌术后复查，上传病理、PET/CT、骨扫描、影像和检查报告图片，想确认是否存在复发或转移信号，以及下一步来华就医评估和治疗路径。'

const buildFreeInput = () => reportSubmissionSchema.parse({
  locale: 'zh',
  basicInfo: {
    ...basePatient,
    idType: 'passport',
    idNumber: 'P1234567',
    visitPurpose: 'breast_cancer',
    chiefComplaint: '右侧乳腺癌术后复查，想了解来华就医评估、治疗路径、费用和准备材料。',
  },
  selectedRegions: ['north_america', 'europe', 'southeast_asia', 'japan_korea'],
  uploadedFiles: [],
  parsedFiles: [],
})

const buildProfessionalInput = (uploadedFiles: ProfessionalUploadedFile[], parsedFiles: ProfessionalParsedFile[]) => professionalReportSubmissionSchema.parse({
  locale: 'zh',
  patient: basePatient,
  medical: {
    visitPurpose: 'breast_cancer',
    diagnosis: '右侧乳腺癌术后复查，疑似复发/转移需确认',
    stage: '上传资料中包含病理、PET/CT和复查影像，需按原始资料复核分期和转移情况',
    chiefComplaint,
    pathologySummary: '',
    imagingSummary: '',
    geneticSummary: '',
    treatmentHistory: '既往治疗经过以上传图片资料为准，当前预览阶段不额外补写。',
    medicationHistory: '',
    comorbidities: '',
    allergyHistory: '',
  },
  preferences: {
    selectedRegions: ['north_america', 'europe', 'southeast_asia', 'japan_korea'],
    budgetRange: '希望了解中国与其他地区的系统治疗、复查和跨境服务费用区间',
    insuranceType: '自费/商业保险待确认',
    desiredCity: '北京/上海/广州',
    urgency: 'urgent',
  },
  uploadedFiles,
  parsedFiles,
})

const renderBlocks = (blocks: Array<{ title?: string; description?: string; items?: string[] }>, max = 4) => (
  blocks.slice(0, max).flatMap((block) => [
    block.title ? `### ${block.title}` : '',
    block.description || '',
    ...(block.items || []).slice(0, 6).map((item) => `- ${item}`),
    '',
  ]).filter(Boolean)
)

const run = async () => {
  await mkdir(outputDir, { recursive: true })
  const uploadedWithPaths = await buildUploadedFiles()
  if (!uploadedWithPaths.length) throw new Error(`No image files found in ${reportDir}`)

  const parsedFiles = await loadCachedParsedFiles(uploadedWithPaths) || await parseFiles(uploadedWithPaths)
  const uploadedFiles = uploadedWithPaths.map(({ absolutePath: _absolutePath, ...file }) => file)
  const medicalFacts = collectMedicalFactBundle(parsedFiles)
  console.log('[Report] generating free report')
  const freeReport = await generateReport(buildFreeInput(), 'REAL-UPLOAD-FREE-PREVIEW')
  console.log('[Report] generating professional report')
  const professionalReport = await generateProfessionalReport(buildProfessionalInput(uploadedFiles, parsedFiles), 'REAL-UPLOAD-PRO-PREVIEW')
  const recordsSection = freeReport.layoutSections?.find((section) => section.key === 'records')
  const recordsTab = professionalReport.tabs?.find((tab) => tab.key === 'records')

  const payload = {
    generatedAt: new Date().toISOString(),
    sourceDirectory: reportDir,
    uploadedFiles,
    parsedFiles,
    medicalFacts,
    freeReport,
    professionalReport,
  }

  await writeFile(outputJsonPath, JSON.stringify(payload, null, 2), 'utf8')

  const lines = [
    '# 真实上传图片报告生成预览',
    '',
    `生成时间：${payload.generatedAt}`,
    `图片目录：${reportDir}`,
    `上传图片数：${uploadedFiles.length}`,
    `简易报告生成来源：${freeReport.generatedBy}`,
    `专业报告生成来源：${professionalReport.generatedBy}`,
    '',
    '## 模拟用户输入',
    '',
    `- 科室/目的：乳腺癌`,
    `- 简易报告主诉：右侧乳腺癌术后复查，想了解来华就医评估、治疗路径、费用和准备材料。`,
    `- 专业报告主诉：${chiefComplaint}`,
    `- 简易报告上传文件：无`,
    `- 专业报告上传文件：${uploadedFiles.map((file) => file.originalName).join('、')}`,
    '',
    '## OCR 与结构化识别',
    '',
    `- 医学事实摘要：${medicalFacts.summary}`,
    `- 质量提示：${medicalFacts.qualityFlags.length ? medicalFacts.qualityFlags.join('；') : '暂无明显质量提示'}`,
    `- 识别到的时间线数量：${medicalFacts.timeline.length}`,
    '',
  ]

  for (const file of parsedFiles) {
    const facts = getMedicalFacts(file)
    lines.push(`### ${file.originalName}`)
    lines.push(`- 解析器：${file.parser}`)
    lines.push(`- 状态：${file.status}`)
    lines.push(`- OCR文本长度：${file.text.length}`)
    lines.push(`- 报告类型：${facts?.reportType || '未识别'}`)
    lines.push(`- 文件类别：${facts?.documentCategory || '未识别'}`)
    lines.push(`- 日期：${facts?.dates?.join('、') || '未识别'}`)
    lines.push(`- 诊断/结论：${previewEvidence(facts?.diagnoses || [], 3, 180).join('；') || '未识别'}`)
    lines.push(`- 关键指标：${facts?.indicators?.slice(0, 6).map((item) => `${item.name} ${item.value}`).join('；') || '未识别'}`)
    lines.push(`- 转移线索：${facts?.metastasisSignals?.slice(0, 8).map((item) => `${item.site} ${item.status}`).join('；') || '未识别'}`)
    lines.push(`- 证据摘录：${previewEvidence(facts?.sourceEvidence || [file.summary], 3, 180).join('；') || '未识别'}`)
    lines.push('')
  }

  lines.push('## 简易报告效果')
  lines.push('')
  lines.push(`- 疾病方向：${freeReport.disease}`)
  lines.push(`- 治疗方向：${freeReport.treatment}`)
  lines.push(`- 评分：${freeReport.score}/100`)
  lines.push(`- 总费用：${freeReport.plan.totalCost}`)
  lines.push(`- 路径：${freeReport.plan.direction}`)
  lines.push('')
  if (recordsSection) {
    lines.push('### 上传资料解读')
    lines.push('- 异常：简易报告不应包含上传资料解读，请检查 free report 输入或生成器边界。')
    lines.push(`- ${recordsSection.summary || ''}`)
    lines.push(...renderBlocks(recordsSection.blocks as Array<{ title?: string; description?: string; items?: string[] }>))
  }
  lines.push('### 主要顾虑与解决')
  for (const item of freeReport.concerns.slice(0, 6)) {
    lines.push(`- ${item.concern}：${item.solution}`)
  }
  lines.push('')
  lines.push('### 亮点')
  for (const item of freeReport.highlights.slice(0, 8)) {
    lines.push(`- ${item}`)
  }
  lines.push('')

  lines.push('## 专业报告效果')
  lines.push('')
  lines.push(`- 标题：${professionalReport.title}`)
  lines.push(`- 资料完整度：${professionalReport.patientSnapshot.dataCompleteness}/100`)
  lines.push(`- 首个 Tab：${professionalReport.tabs?.[0]?.label || '未生成'}`)
  lines.push('')
  lines.push('### 核心摘要')
  for (const item of professionalReport.executiveSummary.slice(0, 6)) {
    lines.push(`- ${item}`)
  }
  lines.push('')
  lines.push('### 诊断/病情结论')
  lines.push(`- 最终印象：${professionalReport.diagnosticConclusion.finalImpression}`)
  lines.push(`- 严重程度：${professionalReport.diagnosticConclusion.severityInterpretation}`)
  lines.push('- 指标解释：')
  for (const item of professionalReport.diagnosticConclusion.indicatorInterpretations.slice(0, 8)) {
    lines.push(`  - ${item.indicator} ${item.value}：${item.interpretation}`)
  }
  lines.push('')
  lines.push('### 关键发现')
  for (const item of professionalReport.clinicalAssessment.keyFindings.slice(0, 12)) {
    lines.push(`- ${item}`)
  }
  lines.push('')
  lines.push('### 中国治疗路径')
  lines.push(`目标：${professionalReport.treatmentPathway.goal}`)
  for (const phase of professionalReport.treatmentPathway.phases.slice(0, 6)) {
    lines.push(`- ${phase.phase}（${phase.timeline}）：${phase.actions.slice(0, 3).join('；')} -> ${phase.output}`)
  }
  lines.push('')
  if (recordsTab) {
    lines.push('### 专业报告上传资料 Tab 摘要')
    lines.push(`- ${recordsTab.summary || ''}`)
    lines.push(...renderBlocks(recordsTab.blocks as Array<{ title?: string; description?: string; items?: string[] }>, 3))
  }
  lines.push('### 下一步')
  for (const item of professionalReport.nextSteps.slice(0, 6)) {
    lines.push(`- ${item}`)
  }
  lines.push('')
  lines.push(`完整 JSON：${outputJsonPath}`)

  await writeFile(outputMdPath, lines.join('\n'), 'utf8')
  console.log(JSON.stringify({
    ok: true,
    uploadedImages: uploadedFiles.length,
    parsed: parsedFiles.map((file) => ({
      file: file.originalName,
      parser: file.parser,
      status: file.status,
      textLength: file.text.length,
      reportType: getMedicalFacts(file)?.reportType,
    })),
    freeGeneratedBy: freeReport.generatedBy,
    freeUploadedImages: 0,
    professionalGeneratedBy: professionalReport.generatedBy,
    outputJsonPath,
    outputMdPath,
  }, null, 2))
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
