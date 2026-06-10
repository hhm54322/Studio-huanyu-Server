import { access, mkdir, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { config } from '../config.js'
import { generateReport } from '../report/generator.js'
import { generateProfessionalReport } from '../report/professionalGenerator.js'
import { parseUploadedFile } from '../report/fileParser.js'
import { collectMedicalFactBundle, extractMedicalFactsFromText, type MedicalDocumentFact } from '../report/medicalFactExtractor.js'
import { reportSubmissionSchema } from '../validators/reportSubmission.js'
import { professionalReportSubmissionSchema, type ProfessionalParsedFile } from '../validators/professionalReportSubmission.js'

const useLlm = process.argv.includes('--with-llm')
const withFileOcr = process.argv.includes('--with-file-ocr')
const originalOpenaiApiKey = config.openaiApiKey
if (!useLlm) config.openaiApiKey = ''

const outputDir = path.resolve(process.cwd(), 'exports')
const outputJsonPath = path.join(outputDir, 'medical-record-report-quality.json')
const outputMdPath = path.join(outputDir, 'medical-record-report-quality.md')

const readRequestBody = async (request: IncomingMessage) => {
  const chunks: Buffer[] = []
  for await (const chunk of request as AsyncIterable<Buffer | string>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString('utf8')
}

const makeBadDentalFreeReport = (baselineRuleReport: Record<string, unknown>) => ({
  ...baselineRuleReport,
  disease: '牙科深龋评估',
  treatment: '基于上传资料提示口腔CBCT深龋，建议先判断保牙，再考虑根管治疗或种植牙修复。',
  concerns: [
    {
      concern: '牙科资料提示深龋',
      solution: '建议复核口腔CBCT、牙周和咬合情况，优先评估保牙和根管治疗。',
    },
  ],
  plan: {
    ...(baselineRuleReport.plan as Record<string, unknown> || {}),
    direction: '口腔CBCT复核 -> 保牙评估 -> 根管治疗 -> 必要时种植牙修复',
    totalCost: '$1,000-$6,000',
    breakdown: [
      { item: '口腔CBCT与基础检查', cost: '$100-$300' },
      { item: '根管治疗/修复或种植评估', cost: '$900-$5,700' },
    ],
  },
  highlights: [
    '上传资料提示口腔CBCT深龋，需要保牙、根管治疗和种植牙方案对比。',
    '建议先由牙科医生复核原片，不宜直接拔牙。',
  ],
  generatedBy: 'llm',
})

const badDentalProfessionalPatch = {
  executiveSummary: [
    '上传资料提示口腔CBCT深龋伴根尖周问题，当前重点是判断能否保牙。',
    '治疗路径应围绕根管治疗、牙冠修复或种植牙修复进行口腔专科评估。',
  ],
  diagnosticConclusion: {
    finalImpression: '上传资料提示右下磨牙深龋伴根尖周炎，需要口腔CBCT复核。',
    severityInterpretation: '目前重点是保牙、根管治疗或种植牙路径选择。',
    indicatorInterpretations: [
      {
        indicator: '口腔CBCT',
        value: '已见深龋',
        interpretation: '用于判断根管治疗可行性、牙槽骨条件和种植牙风险。',
      },
    ],
    evidenceBasis: ['上传资料提示口腔CBCT和深龋。'],
  },
  clinicalAssessment: {
    workingDiagnosis: '牙科深龋伴根尖周炎',
    severity: '中等，需口腔专科评估',
    keyFindings: ['口腔CBCT提示深龋', '需先判断保牙可行性'],
    redFlags: [],
    missingMaterials: ['口腔CBCT原片', '牙周检查', '咬合检查'],
    decisionQuestions: ['能否保牙', '是否需要根管治疗或种植牙'],
  },
  nextSteps: ['补充CBCT原片', '预约口腔专科复核', '确认保牙、根管或种植牙路径'],
}

const startBadDentalMockLlmServer = async () => {
  const server = createServer(async (request, response) => {
    try {
      const body = JSON.parse(await readRequestBody(request)) as {
        messages?: Array<{ role?: string; content?: string }>
      }
      const userPayload = JSON.parse(body.messages?.find((message) => message.role === 'user')?.content || '{}') as {
        task?: string
        baselineRuleReport?: Record<string, unknown>
      }
      const content = userPayload.task?.includes('增强字段')
        ? badDentalProfessionalPatch
        : makeBadDentalFreeReport(userPayload.baselineRuleReport || {})

      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }))
    } catch (error) {
      response.writeHead(500, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
    }
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })

  const address = server.address() as AddressInfo
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    }),
  }
}

const makeParsedFile = (originalName: string, text: string): ProfessionalParsedFile => {
  const medicalFacts = extractMedicalFactsFromText(text, {
    fileName: originalName,
    parser: 'verification-text',
  })

  return {
    originalName,
    mimeType: 'text/plain',
    parser: 'verification-text',
    status: text.trim().length > 40 ? 'parsed' : 'partial',
    text,
    summary: text.replace(/\s+/g, ' ').slice(0, 900),
    metadata: {
      medicalFacts,
      recognitionQuality: {
        textLength: text.length,
        medicalFactConfidence: medicalFacts.confidence,
        actionableFacts:
          medicalFacts.diagnoses.length +
          medicalFacts.indicators.length +
          medicalFacts.findings.length +
          medicalFacts.metastasisSignals.length,
      },
    },
  }
}

const breastCancerFiles = [
  makeParsedFile('2024-09-06-pathology.txt', [
    '2024年9月6日 病理报告：右乳浸润性癌，非特殊类型 NST，组织学分级2级。',
    '免疫组化：ER 阳性 90%，强；PR 阴性；HER2 阴性；Ki-67 70%。',
    '分子分型倾向 Luminal B 型（HER2阴性）。',
  ].join('\n')),
  makeParsedFile('2026-04-14-petct.txt', [
    '2026年4月14日 PET/CT全身扫描：右侧乳腺术后改变。',
    '肝脏见多个高代谢病灶，SUVmax 6.6，提示多发肝转移。',
    'C3、T12、L4椎体、双侧肋骨、骨盆及左侧髋臼多处高代谢骨转移灶。',
    '右侧胸肌下、纵隔、门腔静脉间隙高代谢淋巴结，考虑淋巴结转移。',
    '右肺上叶结节，代谢不高，但形态可疑，不能排除转移可能。',
  ].join('\n')),
]

const dentalFiles = [
  makeParsedFile('dental-cbct.txt', [
    '2026年5月2日 口腔CBCT检查所见：右下第一磨牙大面积龋坏，近髓。',
    '根尖区可见低密度影，考虑慢性根尖周炎；牙槽骨高度基本可。',
    '诊断意见：右下磨牙深龋伴牙髓/根尖周病变可能，需先判断保牙、根管或拔除后修复。',
  ].join('\n')),
]

const lungCancerFiles = [
  makeParsedFile('lung-pathology-ngs.txt', [
    '2026年3月2日 病理报告：右肺上叶腺癌，非小细胞肺癌。',
    '分子检测：EGFR 19外显子缺失突变阳性；ALK 阴性；PD-L1 TPS 10%。',
    '胸部增强CT：右肺上叶肿块约3.2cm，纵隔淋巴结增大；头颅MRI未见明确脑转移。',
  ].join('\n')),
]

const liverCancerFiles = [
  makeParsedFile('liver-hcc-mri.txt', [
    '2026年2月18日 肝脏增强MRI：肝右叶占位，动脉期强化、门脉期洗脱，考虑肝细胞癌 HCC。',
    'AFP 860 ng/mL，乙肝表面抗原阳性，肝功能 Child-Pugh A。',
    '门静脉右支可疑癌栓，需结合增强影像和MDT评估手术、TACE/HAIC或系统治疗。',
  ].join('\n')),
]

const neuroOncologyFiles = [
  makeParsedFile('brain-glioma-pathology.txt', [
    '2026年1月20日 头颅MRI：左额叶占位，增强不均，周围水肿，占位效应明显。',
    '术后病理：弥漫性星形细胞瘤，WHO 4级。IDH 野生型；MGMT 启动子甲基化；Ki-67 35%。',
    '目前偶有癫痫发作，需评估最大安全切除后放疗、替莫唑胺和康复随访。',
  ].join('\n')),
]

const unreadableFiles = [
  makeParsedFile('blurred-photo.txt', 'IMG_0012  ....  低清图片，文字无法辨认。'),
]

const cases = [
  {
    key: 'breast-cancer-metastatic',
    title: '乳腺癌术后复发/转移资料',
    visitPurpose: 'breast_cancer',
    diagnosis: '右乳浸润性癌术后',
    stage: 'PET/CT提示肝、骨、淋巴结转移，肺部可疑',
    chiefComplaint: '右乳癌术后复查，上传病理和PET/CT资料，想解读是否复发转移以及下一步来华治疗路径。',
    pathologySummary: '',
    imagingSummary: '',
    treatmentHistory: '2024年已完成右乳手术，后续治疗记录待补充。',
    parsedFiles: breastCancerFiles,
    freeRequiredText: ['上传资料解读', '乳腺癌', '肝脏', '骨骼', '淋巴结'],
    professionalRequiredText: ['上传资料解读', '乳腺癌', '肝脏', '骨骼', '淋巴结', 'HER2', 'Ki-67', '系统治疗'],
    requiredText: ['上传资料解读', '乳腺癌', '肝脏', '骨骼', '淋巴结', 'HER2', 'Ki-67', '系统治疗'],
  },
  {
    key: 'dental-caries-cbct',
    title: '牙科深龋/根尖周炎资料',
    visitPurpose: 'dental',
    diagnosis: '深龋伴牙髓炎/根尖周炎可能',
    stage: '右下第一磨牙疼痛',
    chiefComplaint: '右下后牙蛀牙疼痛，冷热刺激痛，上传CBCT文字报告，想判断能否保牙、根管或拔牙后种植。',
    pathologySummary: '',
    imagingSummary: '',
    treatmentHistory: '曾临时补牙，近期疼痛加重。',
    parsedFiles: dentalFiles,
    freeRequiredText: ['上传资料解读', '口腔', 'CBCT', '深龋'],
    professionalRequiredText: ['上传资料解读', '口腔', 'CBCT', '深龋', '根管', '保牙'],
    requiredText: ['上传资料解读', '口腔', 'CBCT', '深龋', '根管', '保牙'],
  },
  {
    key: 'lung-cancer-ngs',
    title: '肺癌病理/分子检测资料',
    visitPurpose: 'lung_cancer',
    diagnosis: '右肺上叶腺癌',
    stage: '纵隔淋巴结增大，需完善TNM分期',
    chiefComplaint: '右肺上叶腺癌，上传病理、CT和分子检测资料，想确认靶向/免疫/手术或放化疗下一步。',
    pathologySummary: '',
    imagingSummary: '',
    treatmentHistory: '尚未开始系统治疗。',
    parsedFiles: lungCancerFiles,
    freeRequiredText: ['上传资料解读', '肺癌', 'EGFR'],
    professionalRequiredText: ['上传资料解读', '肺癌', 'EGFR', 'PD-L1', '分期', '靶向'],
    requiredText: ['上传资料解读', '肺癌', 'EGFR', 'PD-L1', '靶向'],
  },
  {
    key: 'liver-cancer-hcc',
    title: '肝癌增强MRI/AFP资料',
    visitPurpose: 'liver_cancer',
    diagnosis: '肝细胞癌疑似/待确认',
    stage: '门静脉右支可疑癌栓',
    chiefComplaint: '上传肝脏增强MRI和AFP资料，想判断是否适合手术、介入、消融或系统治疗。',
    pathologySummary: '',
    imagingSummary: '',
    treatmentHistory: '既往乙肝，尚未治疗。',
    parsedFiles: liverCancerFiles,
    freeRequiredText: ['上传资料解读', '肝癌', 'AFP'],
    professionalRequiredText: ['上传资料解读', '肝癌', 'AFP', '肝功能', '介入'],
    requiredText: ['上传资料解读', '肝癌', 'AFP', '肝功能'],
  },
  {
    key: 'neuro-oncology-glioma',
    title: '神经肿瘤病理/MRI资料',
    visitPurpose: 'neurosurgery',
    diagnosis: '弥漫性星形细胞瘤 WHO 4级',
    stage: '高级别胶质瘤，术后辅助治疗评估',
    chiefComplaint: '上传头颅MRI和病理分子结果，想评估高级别胶质瘤下一步放疗、替莫唑胺和来华复核路径。',
    pathologySummary: '',
    imagingSummary: '',
    treatmentHistory: '已手术，术后辅助治疗待安排。',
    parsedFiles: neuroOncologyFiles,
    freeRequiredText: ['上传资料解读', '神经外科', 'WHO'],
    professionalRequiredText: ['上传资料解读', '神经外科', 'WHO', 'IDH', 'MGMT', '替莫唑胺'],
    requiredText: ['上传资料解读', '神经外科', 'WHO', 'IDH', 'MGMT'],
  },
  {
    key: 'unreadable-upload',
    title: '上传资料不可辨认',
    visitPurpose: 'other',
    diagnosis: '',
    stage: '',
    chiefComplaint: '上传了一张检查报告照片，但目前不确定是什么病，想先做综合分诊。',
    pathologySummary: '',
    imagingSummary: '',
    treatmentHistory: '',
    parsedFiles: unreadableFiles,
    freeRequiredText: ['识别不足', '未提取到足够', '不能据此'],
    professionalRequiredText: ['识别不足', '未提取到足够', '不能据此'],
    requiredText: ['识别不足', '未提取到足够', '不能据此'],
  },
]

const basePatient = {
  fullName: 'Quality Check Patient',
  gender: 'female' as const,
  dateOfBirth: '1982-01-01',
  nationality: 'Malaysia',
  phone: '+60123456789',
  email: 'quality.check@example.com',
  city: 'Kuala Lumpur',
  preferredLanguage: '中文',
}

const buildFreeInput = (item: typeof cases[number]) => reportSubmissionSchema.parse({
  locale: 'zh',
  basicInfo: {
    ...basePatient,
    idType: 'passport',
    idNumber: 'QC123456',
    visitPurpose: item.visitPurpose,
    chiefComplaint: item.chiefComplaint,
  },
  selectedRegions: ['north_america', 'europe', 'southeast_asia', 'japan_korea'],
  uploadedFiles: item.parsedFiles.map((file) => ({
    fieldName: 'files',
    originalName: file.originalName,
    storedName: file.originalName,
    relativePath: `verification/${file.originalName}`,
    mimeType: file.mimeType,
    size: file.text.length,
  })),
  parsedFiles: item.parsedFiles,
})

const buildProfessionalInput = (item: typeof cases[number]) => professionalReportSubmissionSchema.parse({
  locale: 'zh',
  patient: basePatient,
  medical: {
    visitPurpose: item.visitPurpose,
    diagnosis: item.diagnosis,
    stage: item.stage,
    chiefComplaint: item.chiefComplaint,
    pathologySummary: item.pathologySummary,
    imagingSummary: item.imagingSummary,
    geneticSummary: '',
    treatmentHistory: item.treatmentHistory,
    medicationHistory: '',
    comorbidities: '',
    allergyHistory: '',
  },
  preferences: {
    selectedRegions: ['north_america', 'europe', 'southeast_asia', 'japan_korea'],
    budgetRange: '',
    insuranceType: '自费/商业保险待确认',
    desiredCity: '北京/上海',
    urgency: item.key === 'breast-cancer-metastatic' ? 'urgent' : 'priority',
  },
  uploadedFiles: item.parsedFiles.map((file) => ({
    fieldName: 'files',
    originalName: file.originalName,
    storedName: file.originalName,
    relativePath: `verification/${file.originalName}`,
    mimeType: file.mimeType,
    size: file.text.length,
  })),
  parsedFiles: item.parsedFiles,
})

const runBadLlmGuardrailChecks = async () => {
  const previousOpenaiApiKey = config.openaiApiKey
  const previousOpenaiBaseUrl = config.openaiBaseUrl
  const mockServer = await startBadDentalMockLlmServer()

  try {
    config.openaiApiKey = 'mock-medical-record-guardrail-key'
    config.openaiBaseUrl = mockServer.baseUrl

    const guardrailResults = []

    for (const item of cases) {
      const expectedGeneratedBy = item.key === 'dental-caries-cbct' ? 'llm' : 'rules'
      const freeReport = await generateReport(buildFreeInput(item), `VERIFY-BAD-LLM-FREE-${item.key}`)
      const professionalReport = await generateProfessionalReport(buildProfessionalInput(item), `VERIFY-BAD-LLM-PRO-${item.key}`)
      const freeText = JSON.stringify(freeReport)
      const professionalText = JSON.stringify(professionalReport)

      if (freeReport.generatedBy !== expectedGeneratedBy) {
        throw new Error(`${item.key} free bad-LLM guardrail expected ${expectedGeneratedBy}, got ${freeReport.generatedBy}`)
      }
      if (professionalReport.generatedBy !== expectedGeneratedBy) {
        throw new Error(`${item.key} professional bad-LLM guardrail expected ${expectedGeneratedBy}, got ${professionalReport.generatedBy}`)
      }

      if (item.key !== 'dental-caries-cbct') {
        const leakedDental = ['口腔CBCT深龋', '种植牙修复', '保牙、根管'].some((term) => freeText.includes(term) || professionalText.includes(term))
        if (leakedDental) throw new Error(`${item.key} leaked dental content after bad-LLM guardrail fallback`)
      }

      if (item.key === 'dental-caries-cbct') {
        assertIncludes(item.key, 'bad-llm dental free', freeText, ['口腔', '深龋'])
        assertIncludes(item.key, 'bad-llm dental professional', professionalText, ['口腔', '深龋'])
      }

      guardrailResults.push({
        key: item.key,
        expectedGeneratedBy,
        actualGeneratedBy: {
          free: freeReport.generatedBy,
          professional: professionalReport.generatedBy,
        },
      })
    }

    return guardrailResults
  } finally {
    config.openaiApiKey = previousOpenaiApiKey
    config.openaiBaseUrl = previousOpenaiBaseUrl
    await mockServer.close()
  }
}

const assertIncludes = (caseKey: string, mode: string, haystack: string, needles: string[]) => {
  const missing = needles.filter((needle) => !haystack.includes(needle))
  if (missing.length) {
    throw new Error(`${caseKey} ${mode} missing expected text: ${missing.join('、')}`)
  }
}

const assertNoForbiddenDisplayText = (caseKey: string, mode: string, report: unknown) => {
  const text = JSON.stringify(report)
  const forbidden = [
    '医学摘要',
    '报告可见内容',
    'Patient ID',
    'Accession No',
    'NO MR',
    'Study Date',
    'portaca',
  ]
  const hits = forbidden.filter((item) => text.includes(item))
  if (hits.length) {
    throw new Error(`${caseKey} ${mode} contains OCR/debug display text: ${hits.join('、')}`)
  }
}

const pathExists = async (filePath: string) => {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

const getMedicalFacts = (value: unknown) => value as MedicalDocumentFact

const runUploadParsingChecks = async () => {
  if (!withFileOcr) return []

  const previousOpenaiApiKey = config.openaiApiKey
  if (originalOpenaiApiKey) config.openaiApiKey = originalOpenaiApiKey

  try {
    const checks = [
      {
        key: 'breast-petct-image',
        absolutePath: path.resolve(process.cwd(), '../报告/3.jpg'),
        originalName: '乳腺癌PETCT-20260414.jpg',
        mimeType: 'image/jpeg',
        expects: {
          category: 'patient_record',
          reportType: 'PET/CT全身扫描',
          presentSites: ['肝脏', '骨骼', '淋巴结'],
          suspectedSites: ['肺部'],
          dates: ['2026-04-14'],
        },
      },
      {
        key: 'dental-intro-pdf',
        absolutePath: path.resolve(process.cwd(), '../资料/深圳鼎植口腔介绍PPT-20260509.pdf'),
        originalName: '深圳鼎植口腔介绍PPT-20260509.pdf',
        mimeType: 'application/pdf',
        expects: {
          category: 'institution_intro',
          reportType: '机构/服务介绍资料',
        },
      },
    ]

    const results = []
    for (const check of checks) {
      if (!await pathExists(check.absolutePath)) {
        results.push({ key: check.key, skipped: true, reason: `file not found: ${check.absolutePath}` })
        continue
      }

      const parsed = await parseUploadedFile({
        fieldName: 'files',
        originalName: check.originalName,
        storedName: check.originalName,
        relativePath: check.absolutePath,
        absolutePath: check.absolutePath,
        mimeType: check.mimeType,
        size: 0,
      })
      const facts = getMedicalFacts(parsed.metadata.medicalFacts)
      const bundle = collectMedicalFactBundle([parsed])

      if (facts.documentCategory !== check.expects.category) {
        throw new Error(`${check.key} documentCategory expected ${check.expects.category}, got ${facts.documentCategory}`)
      }
      if (facts.reportType !== check.expects.reportType) {
        throw new Error(`${check.key} reportType expected ${check.expects.reportType}, got ${facts.reportType}`)
      }
      if (check.expects.dates?.some((date) => !facts.dates.includes(date))) {
        throw new Error(`${check.key} missing expected date: ${check.expects.dates.join('、')}`)
      }

      const sitesByStatus = (status: 'present' | 'suspected' | 'absent') => facts.metastasisSignals
        .filter((signal) => signal.status === status)
        .map((signal) => signal.site)
      const presentSites = sitesByStatus('present')
      const suspectedSites = sitesByStatus('suspected')
      if (check.expects.presentSites?.some((site) => !presentSites.includes(site))) {
        throw new Error(`${check.key} missing present metastasis site: ${check.expects.presentSites.join('、')}`)
      }
      if (check.expects.suspectedSites?.some((site) => !suspectedSites.includes(site))) {
        throw new Error(`${check.key} missing suspected metastasis site: ${check.expects.suspectedSites.join('、')}`)
      }
      if (check.key === 'dental-intro-pdf' && bundle.documents.length !== 0) {
        throw new Error(`${check.key} should not be treated as patient medical evidence`)
      }
      if (check.key === 'breast-petct-image' && presentSites.includes('脑/中枢神经')) {
        throw new Error(`${check.key} incorrectly marked negated brain finding as present metastasis`)
      }

      results.push({
        key: check.key,
        parser: parsed.parser,
        status: parsed.status,
        textLength: parsed.text.length,
        reportType: facts.reportType,
        documentCategory: facts.documentCategory,
        dates: facts.dates,
        metastasisSignals: facts.metastasisSignals,
        bundleSummary: bundle.summary,
        bundleQualityFlags: bundle.qualityFlags,
      })
    }

    return results
  } finally {
    config.openaiApiKey = previousOpenaiApiKey
  }
}

const run = async () => {
  await mkdir(outputDir, { recursive: true })
  const startedAt = new Date().toISOString()
  const results = []
  const uploadParsingChecks = await runUploadParsingChecks()
  const badLlmGuardrailChecks = await runBadLlmGuardrailChecks()

  for (const item of cases) {
    const freeInput = buildFreeInput(item)
    const professionalInput = buildProfessionalInput(item)
    const freeReport = await generateReport(freeInput, `VERIFY-FREE-${item.key}`)
    const professionalReport = await generateProfessionalReport(professionalInput, `VERIFY-PRO-${item.key}`)
    const freeText = JSON.stringify(freeReport)
    const professionalText = JSON.stringify(professionalReport)
    const allText = `${freeText}\n${professionalText}`

    assertIncludes(item.key, 'combined', allText, item.requiredText)
    assertIncludes(item.key, 'free', freeText, item.freeRequiredText)
    assertIncludes(item.key, 'professional', professionalText, item.professionalRequiredText)
    assertNoForbiddenDisplayText(item.key, 'free report', freeReport)
    assertNoForbiddenDisplayText(item.key, 'professional report', professionalReport)
    if (freeReport.layoutSections?.[0]?.key !== 'records') {
      throw new Error(`${item.key} free report first layout section is not records`)
    }
    if (professionalReport.tabs?.[0]?.key !== 'records') {
      throw new Error(`${item.key} professional report first tab is not records`)
    }

    results.push({
      key: item.key,
      title: item.title,
      generatedBy: {
        free: freeReport.generatedBy,
        professional: professionalReport.generatedBy,
      },
      parsedFacts: item.parsedFiles.map((file) => file.metadata.medicalFacts),
      reports: {
        free: freeReport,
        professional: professionalReport,
      },
      freeSummary: {
        disease: freeReport.disease,
        firstSection: freeReport.layoutSections?.[0],
        concerns: freeReport.concerns,
        highlights: freeReport.highlights.slice(0, 8),
      },
      professionalSummary: {
        title: professionalReport.title,
        firstTab: professionalReport.tabs?.[0],
        executiveSummary: professionalReport.executiveSummary,
        diagnosticConclusion: professionalReport.diagnosticConclusion,
        clinicalAssessment: professionalReport.clinicalAssessment,
        treatmentGoal: professionalReport.treatmentPathway.goal,
        qualityFlags: professionalReport.qualityFlags,
      },
    })
  }

  const payload = {
    startedAt,
    completedAt: new Date().toISOString(),
    mode: useLlm ? 'with-llm' : 'rules-only',
    uploadParsingChecks,
    badLlmGuardrailChecks,
    results,
  }
  await writeFile(outputJsonPath, JSON.stringify(payload, null, 2), 'utf8')

  const lines = [
    '# 医学资料识别报告质量验证',
    '',
    `运行模式：${payload.mode}`,
    `完成时间：${payload.completedAt}`,
    uploadParsingChecks.length ? `真实上传解析检查：${uploadParsingChecks.length}项` : '',
    `坏模型守护压测：${badLlmGuardrailChecks.length}项`,
    '',
  ].filter((line) => line !== '')
  if (badLlmGuardrailChecks.length) {
    lines.push('## 坏模型守护压测')
    lines.push('')
    for (const check of badLlmGuardrailChecks) {
      lines.push(`- ${check.key}：期望 ${check.expectedGeneratedBy}，简易 ${check.actualGeneratedBy.free}，专业 ${check.actualGeneratedBy.professional}`)
    }
    lines.push('')
  }
  for (const result of results) {
    lines.push(`## ${result.title}`)
    lines.push('')
    lines.push(`- 简易报告生成来源：${result.generatedBy.free}`)
    lines.push(`- 专业报告生成来源：${result.generatedBy.professional}`)
    lines.push(`- 简易报告首段：${result.freeSummary.firstSection?.label || '无'}`)
    lines.push(`- 专业报告首个 Tab：${result.professionalSummary.firstTab?.label || '无'}`)
    lines.push(`- 专业核心结论：${result.professionalSummary.diagnosticConclusion.finalImpression}`)
    lines.push(`- 专业严重程度：${result.professionalSummary.diagnosticConclusion.severityInterpretation}`)
    lines.push('')
  }
  lines.push(`完整 JSON：${outputJsonPath}`)
  await writeFile(outputMdPath, lines.join('\n'), 'utf8')

  console.log(JSON.stringify({
    ok: true,
    mode: payload.mode,
    cases: results.length,
    outputJsonPath,
    outputMdPath,
  }, null, 2))
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
