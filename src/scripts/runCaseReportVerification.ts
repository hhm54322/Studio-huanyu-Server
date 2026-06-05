import { writeFile } from 'node:fs/promises'
import { createProfessionalReportSubmission, updateProfessionalReportSubmissionResult } from '../db/professionalReportSubmissions.js'
import { createReportSubmission, updateReportSubmissionResult } from '../db/reportSubmissions.js'
import { generateReport } from '../report/generator.js'
import { generateProfessionalReport } from '../report/professionalGenerator.js'
import { reportSubmissionSchema } from '../validators/reportSubmission.js'
import { professionalReportSubmissionSchema } from '../validators/professionalReportSubmission.js'

const outputJsonPath = '/Users/hhm/Desktop/1024Clients/huanyu/report-generation-case-results.json'
const outputMdPath = '/Users/hhm/Desktop/1024Clients/huanyu/REPORT_GENERATION_CASE_RESULTS.md'
const clientBaseUrl = 'http://localhost:5173'
const forbiddenFeeQualifier = ['同', '口', '径'].join('')
const forbiddenFeeQualifierLabel = '旧费用限定词'

type CaseInput = {
  id: string
  title: string
  patient: {
    fullName: string
    gender: 'male' | 'female' | 'other'
    dateOfBirth: string
    nationality: string
    phone: string
    email: string
    city: string
    preferredLanguage: string
  }
  visitPurpose: string
  diagnosis: string
  stage: string
  chiefComplaint: string
  pathologySummary: string
  imagingSummary: string
  geneticSummary: string
  treatmentHistory: string
  medicationHistory: string
  comorbidities: string
  allergyHistory: string
  selectedRegions: string[]
  budgetRange: string
  insuranceType: string
  desiredCity: string
  urgency: 'routine' | 'priority' | 'urgent'
}

const cases: CaseInput[] = [
  {
    id: 'case-01-dental',
    title: '牙科：蛀牙牙痛与种植诉求',
    patient: { fullName: 'Maria Santoso', gender: 'female', dateOfBirth: '1990-03-12', nationality: 'Indonesia', phone: '+628123456789', email: 'maria.dental@example.com', city: 'Jakarta', preferredLanguage: '中文' },
    visitPurpose: 'dental',
    diagnosis: '疑似深龋伴牙髓炎/根尖周炎',
    stage: '右下后牙冷热刺激痛、夜间痛',
    chiefComplaint: '右下后牙蛀牙半年，最近冷热刺激痛和夜间痛，想了解是否可以保牙、根管治疗或拔牙后种植。',
    pathologySummary: '暂无病理；当地牙医口检提示右下磨牙大面积龋坏。',
    imagingSummary: '尚未拍摄CBCT，仅有口腔检查记录。',
    geneticSummary: '',
    treatmentHistory: '曾临时补牙一次，近期疼痛加重，未做根管治疗。',
    medicationHistory: '偶尔服用布洛芬止痛。',
    comorbidities: '无特殊基础疾病。',
    allergyHistory: '否认药物过敏。',
    selectedRegions: ['southeast_asia', 'japan_korea', 'north_america'],
    budgetRange: '希望比较保牙、根管、拔牙种植不同费用。',
    insuranceType: '自费',
    desiredCity: '上海/广州',
    urgency: 'priority',
  },
  {
    id: 'case-02-neurosurgery',
    title: '神经外科：脊髓星形细胞瘤WHO4术后',
    patient: { fullName: 'Tan Wei Ming', gender: 'male', dateOfBirth: '1988-01-01', nationality: 'Singapore', phone: '+6561234567', email: 'tan.neuro@example.com', city: 'Singapore', preferredLanguage: '中文' },
    visitPurpose: 'neurosurgery',
    diagnosis: '脊髓星形细胞瘤',
    stage: 'WHO 4级，术后状态',
    chiefComplaint: '已确诊脊髓星形细胞瘤WHO4级，术后仍有下肢麻木和行走困难，想来中国评估后续手术、放疗、化疗和康复方案。',
    pathologySummary: '高级别神经胶质瘤，脊髓星形细胞瘤，WHO 4级。Ki-67 20%-30%。',
    imagingSummary: 'MRI提示脊髓占位术后改变，需复核残留范围、脊髓水肿和压迫情况。',
    geneticSummary: 'IDH-wildtype，MGMT状态未明。',
    treatmentHistory: '已完成一次手术，尚未启动规范放化疗。',
    medicationHistory: '止痛药和营养神经药物。',
    comorbidities: '无特殊。',
    allergyHistory: '否认。',
    selectedRegions: ['north_america', 'europe', 'japan_korea', 'southeast_asia'],
    budgetRange: '希望了解全流程费用。',
    insuranceType: '商业保险',
    desiredCity: '北京/上海',
    urgency: 'urgent',
  },
  {
    id: 'case-03-lung-cancer',
    title: '肺癌：EGFR突变晚期肺腺癌',
    patient: { fullName: 'Anya Petrov', gender: 'female', dateOfBirth: '1975-06-18', nationality: 'Russia', phone: '+79001234567', email: 'anya.lung@example.com', city: 'Moscow', preferredLanguage: '中文/俄语' },
    visitPurpose: 'lung_cancer',
    diagnosis: '肺腺癌',
    stage: 'IV期，EGFR L858R突变',
    chiefComplaint: '确诊右肺腺癌IV期，伴骨转移，EGFR L858R阳性。当地建议靶向治疗，想来中国确认靶向、免疫、放疗和骨转移控制方案。',
    pathologySummary: '肺穿刺病理：腺癌，TTF-1阳性，PD-L1约10%。',
    imagingSummary: '胸部CT示右上肺肿块，PET-CT提示多发骨转移。',
    geneticSummary: 'EGFR L858R阳性，ALK/ROS1阴性。',
    treatmentHistory: '尚未系统治疗，仅完成止痛和基础检查。',
    medicationHistory: '止痛药，钙剂。',
    comorbidities: '轻度高血压。',
    allergyHistory: '否认。',
    selectedRegions: ['europe', 'north_america', 'japan_korea', 'southeast_asia'],
    budgetRange: '$20,000-$60,000',
    insuranceType: '商业保险，需预授权',
    desiredCity: '上海/广州',
    urgency: 'priority',
  },
  {
    id: 'case-04-breast-cancer',
    title: '乳腺癌：ER阳性HER2阴性II期',
    patient: { fullName: 'Siti Rahma', gender: 'female', dateOfBirth: '1982-09-09', nationality: 'Malaysia', phone: '+60123456789', email: 'siti.breast@example.com', city: 'Kuala Lumpur', preferredLanguage: '英文/中文' },
    visitPurpose: 'breast_cancer',
    diagnosis: '浸润性乳腺癌',
    stage: 'II期，ER/PR阳性，HER2阴性，Ki-67 25%',
    chiefComplaint: '左乳肿块穿刺提示浸润性乳腺癌，ER/PR阳性HER2阴性，想比较保乳、全切、新辅助治疗和术后辅助治疗方案。',
    pathologySummary: '穿刺病理：浸润性导管癌，ER 90%，PR 70%，HER2 1+，Ki-67 25%。',
    imagingSummary: '乳腺MRI提示左乳2.8cm病灶，腋窝可疑淋巴结。',
    geneticSummary: 'BRCA未检测。',
    treatmentHistory: '尚未手术或化疗。',
    medicationHistory: '无长期用药。',
    comorbidities: '无特殊。',
    allergyHistory: '青霉素皮疹史。',
    selectedRegions: ['southeast_asia', 'north_america', 'europe'],
    budgetRange: '$15,000-$40,000',
    insuranceType: '国际商业保险',
    desiredCity: '上海/北京',
    urgency: 'priority',
  },
  {
    id: 'case-05-liver-cancer',
    title: '肝癌：乙肝背景肝细胞癌',
    patient: { fullName: 'Batsaikhan Enkh', gender: 'male', dateOfBirth: '1968-11-23', nationality: 'Mongolia', phone: '+97699112233', email: 'enkh.liver@example.com', city: 'Ulaanbaatar', preferredLanguage: '中文/蒙古语' },
    visitPurpose: 'liver_cancer',
    diagnosis: '肝细胞癌',
    stage: '疑似BCLC B-C之间，乙肝背景',
    chiefComplaint: '乙肝多年，近期增强MRI发现肝右叶约5.5cm占位，AFP升高，想评估手术、消融、介入TACE或系统治疗。',
    pathologySummary: '暂未穿刺病理。',
    imagingSummary: '肝脏增强MRI提示动脉期强化、门脉期洗脱，肝右叶5.5cm病灶，需复核是否有门静脉侵犯。',
    geneticSummary: '',
    treatmentHistory: '未接受肝癌治疗。',
    medicationHistory: '恩替卡韦抗病毒治疗。',
    comorbidities: '慢性乙肝，轻度肝硬化。',
    allergyHistory: '否认。',
    selectedRegions: ['japan_korea', 'north_america', 'southeast_asia'],
    budgetRange: '$10,000-$35,000',
    insuranceType: '自费',
    desiredCity: '上海/广州',
    urgency: 'priority',
  },
  {
    id: 'case-06-nasopharyngeal-cancer',
    title: '鼻咽癌：EBV阳性局部晚期',
    patient: { fullName: 'Nguyen Minh', gender: 'male', dateOfBirth: '1979-04-30', nationality: 'Vietnam', phone: '+84901234567', email: 'minh.npc@example.com', city: 'Ho Chi Minh City', preferredLanguage: '中文/英文' },
    visitPurpose: 'nasopharyngeal_cancer',
    diagnosis: '鼻咽癌',
    stage: '局部晚期，颈部淋巴结转移',
    chiefComplaint: '鼻咽镜活检确诊鼻咽癌，EBV DNA升高，颈部淋巴结肿大，想来中国评估精准放疗、同步化疗和副作用管理。',
    pathologySummary: '非角化未分化型鼻咽癌。',
    imagingSummary: '头颈MRI提示鼻咽原发灶及双侧颈部淋巴结转移。',
    geneticSummary: 'EBV DNA升高。',
    treatmentHistory: '尚未开始放化疗。',
    medicationHistory: '无。',
    comorbidities: '无特殊。',
    allergyHistory: '否认。',
    selectedRegions: ['southeast_asia', 'europe', 'north_america'],
    budgetRange: '$18,000-$45,000',
    insuranceType: '商业保险',
    desiredCity: '广州/上海',
    urgency: 'priority',
  },
  {
    id: 'case-07-cardiology',
    title: '心内/心胸：冠心病三支病变评估',
    patient: { fullName: 'Ahmed Al Farsi', gender: 'male', dateOfBirth: '1962-02-14', nationality: 'Oman', phone: '+96891234567', email: 'ahmed.cardio@example.com', city: 'Muscat', preferredLanguage: '英文/中文' },
    visitPurpose: 'cardiology_cardiothoracic',
    diagnosis: '冠心病，疑似三支病变',
    stage: '劳力性胸痛，冠脉CTA提示多支狭窄',
    chiefComplaint: '近3个月活动后胸痛，冠脉CTA提示多支血管狭窄，想来中国评估药物、支架介入或搭桥手术方案。',
    pathologySummary: '',
    imagingSummary: '冠脉CTA提示LAD、LCX、RCA多处中重度狭窄，需冠脉造影确认。心超EF约55%。',
    geneticSummary: '',
    treatmentHistory: '当地开始阿司匹林、他汀和硝酸酯，未做介入。',
    medicationHistory: '阿司匹林、阿托伐他汀、硝酸甘油。',
    comorbidities: '高血压、2型糖尿病。',
    allergyHistory: '否认。',
    selectedRegions: ['middle_east', 'europe', 'north_america', 'southeast_asia'],
    budgetRange: '$12,000-$45,000',
    insuranceType: '雇主商业保险',
    desiredCity: '北京/上海',
    urgency: 'urgent',
  },
  {
    id: 'case-08-spine',
    title: '脊柱外科：腰椎间盘突出伴肌力下降',
    patient: { fullName: 'John Miller', gender: 'male', dateOfBirth: '1985-07-07', nationality: 'USA', phone: '+14155551234', email: 'john.spine@example.com', city: 'San Francisco', preferredLanguage: '英文' },
    visitPurpose: 'spine_surgery',
    diagnosis: '腰椎间盘突出症',
    stage: 'L4/5突出，右下肢放射痛，足背肌力下降',
    chiefComplaint: '腰痛伴右腿放射痛8周，MRI提示L4/5椎间盘突出压迫神经根，最近足背肌力下降，想了解微创手术和康复方案。',
    pathologySummary: '',
    imagingSummary: '腰椎MRI提示L4/5椎间盘突出，右侧神经根受压。',
    geneticSummary: '',
    treatmentHistory: '已做物理治疗、止痛药和一次硬膜外注射，效果有限。',
    medicationHistory: 'NSAIDs，短期肌松药。',
    comorbidities: '无特殊。',
    allergyHistory: '否认。',
    selectedRegions: ['north_america', 'japan_korea', 'southeast_asia'],
    budgetRange: '$8,000-$25,000',
    insuranceType: '自费+部分保险',
    desiredCity: '上海/北京',
    urgency: 'priority',
  },
  {
    id: 'case-09-endocrinology',
    title: '内分泌：2型糖尿病控制差并发症风险',
    patient: { fullName: 'Olga Ivanova', gender: 'female', dateOfBirth: '1970-12-05', nationality: 'Kazakhstan', phone: '+77011234567', email: 'olga.endo@example.com', city: 'Almaty', preferredLanguage: '俄语/中文' },
    visitPurpose: 'endocrinology_metabolism',
    diagnosis: '2型糖尿病',
    stage: 'HbA1c 9.8%，疑似周围神经病变',
    chiefComplaint: '2型糖尿病10年，最近HbA1c 9.8%，双脚麻木，担心肾病和眼底并发症，想来中国做综合评估和用药调整。',
    pathologySummary: '',
    imagingSummary: '暂无影像。',
    geneticSummary: '',
    treatmentHistory: '口服二甲双胍和磺脲类，血糖仍控制不佳。',
    medicationHistory: '二甲双胍、格列美脲。',
    comorbidities: '高血压、超重。',
    allergyHistory: '否认。',
    selectedRegions: ['japan_korea', 'europe', 'southeast_asia'],
    budgetRange: '$3,000-$12,000',
    insuranceType: '自费',
    desiredCity: '北京/上海',
    urgency: 'routine',
  },
  {
    id: 'case-10-premium-checkup',
    title: '高端体检：癌症家族史与肠镜筛查',
    patient: { fullName: 'Lee Joon Ho', gender: 'male', dateOfBirth: '1978-08-21', nationality: 'South Korea', phone: '+821012345678', email: 'lee.checkup@example.com', city: 'Seoul', preferredLanguage: '中文/韩语' },
    visitPurpose: 'premium_checkup',
    diagnosis: '未确诊，家族肿瘤风险筛查',
    stage: '父亲结直肠癌史，近期大便习惯改变',
    chiefComplaint: '父亲曾患结直肠癌，自己最近大便习惯改变，想来中国做高端体检、胃肠镜、肿瘤标志物和心脑血管风险筛查。',
    pathologySummary: '',
    imagingSummary: '暂无。',
    geneticSummary: '未做遗传检测。',
    treatmentHistory: '无治疗史。',
    medicationHistory: '无长期用药。',
    comorbidities: '轻度脂肪肝。',
    allergyHistory: '否认。',
    selectedRegions: ['japan_korea', 'southeast_asia', 'north_america'],
    budgetRange: '$2,000-$10,000',
    insuranceType: '自费',
    desiredCity: '上海/博鳌',
    urgency: 'routine',
  },
]

const modeLabel = { free: '简易报告', professional: '专业报告' } as const
const passportFor = (index: number) => `TST${String(index + 100000)}`

const buildFreeInput = (item: CaseInput, index: number) => reportSubmissionSchema.parse({
  locale: 'zh',
  basicInfo: {
    ...item.patient,
    idType: 'passport',
    idNumber: passportFor(index),
    visitPurpose: item.visitPurpose,
    chiefComplaint: item.chiefComplaint,
  },
  selectedRegions: item.selectedRegions,
})

const buildProfessionalInput = (item: CaseInput) => professionalReportSubmissionSchema.parse({
  locale: 'zh',
  patient: item.patient,
  medical: {
    visitPurpose: item.visitPurpose,
    diagnosis: item.diagnosis,
    stage: item.stage,
    chiefComplaint: item.chiefComplaint,
    pathologySummary: item.pathologySummary,
    imagingSummary: item.imagingSummary,
    geneticSummary: item.geneticSummary,
    treatmentHistory: item.treatmentHistory,
    medicationHistory: item.medicationHistory,
    comorbidities: item.comorbidities,
    allergyHistory: item.allergyHistory,
  },
  preferences: {
    selectedRegions: item.selectedRegions,
    budgetRange: item.budgetRange,
    insuranceType: item.insuranceType,
    desiredCity: item.desiredCity,
    urgency: item.urgency,
  },
})

const summarizeFree = (report: Awaited<ReturnType<typeof generateReport>>) => ({
  generatedBy: report.generatedBy,
  disease: report.disease,
  treatment: report.treatment,
  need: report.need,
  score: report.score,
  advantages: report.advantages,
  concerns: report.concerns,
  hospitals: report.hospitals,
  plan: report.plan,
  highlights: report.highlights,
})

const summarizeProfessional = (report: Awaited<ReturnType<typeof generateProfessionalReport>>) => ({
  generatedBy: report.generatedBy,
  title: report.title,
  patientSnapshot: report.patientSnapshot,
  executiveSummary: report.executiveSummary,
  diagnosticConclusion: report.diagnosticConclusion,
  clinicalAssessment: report.clinicalAssessment,
  treatmentGoal: report.treatmentPathway.goal,
  prognosisComparison: report.prognosisComparison,
  technologyAdvantages: report.technologyAdvantages,
  costBreakdown: report.costBreakdown,
  hospitalRecommendations: report.hospitalRecommendations,
  nextSteps: report.nextSteps,
  qualityFlags: report.qualityFlags,
})

type Mode = 'free' | 'professional'

const buildTask = (item: CaseInput, index: number, mode: Mode) => async () => {
  const started = Date.now()
  console.log(`[start] ${modeLabel[mode]} ${item.id}`)
  let submissionNo = ''

  try {
    if (mode === 'free') {
      const input = buildFreeInput(item, index)
      const created = await createReportSubmission(input, { userAgent: 'case-report-verification-script', ip: '127.0.0.1' })
      submissionNo = created.submission_no
      await updateReportSubmissionResult(submissionNo, 'generating', null)
      const report = await generateReport(input, submissionNo)
      await updateReportSubmissionResult(submissionNo, 'generated', report)
      const elapsedMs = Date.now() - started
      console.log(`[done] ${modeLabel[mode]} ${item.id} ${elapsedMs}ms ${report.generatedBy}`)
      return {
        caseId: item.id,
        title: item.title,
        mode,
        submissionNo,
        reportUrl: `${clientBaseUrl}/report?submissionNo=${encodeURIComponent(submissionNo)}`,
        elapsedMs,
        input,
        report,
        summary: summarizeFree(report),
        generatedBy: report.generatedBy,
        hasForbiddenText: JSON.stringify(report).includes(forbiddenFeeQualifier),
      }
    }

    const input = buildProfessionalInput(item)
    const created = await createProfessionalReportSubmission(input, { userAgent: 'case-report-verification-script', ip: '127.0.0.1' })
    submissionNo = created.submission_no
    await updateProfessionalReportSubmissionResult(submissionNo, 'generating', null)
    const report = await generateProfessionalReport(input, submissionNo)
    await updateProfessionalReportSubmissionResult(submissionNo, 'generated', report)
    const elapsedMs = Date.now() - started
    console.log(`[done] ${modeLabel[mode]} ${item.id} ${elapsedMs}ms ${report.generatedBy}`)
    return {
      caseId: item.id,
      title: item.title,
      mode,
      submissionNo,
      reportUrl: `${clientBaseUrl}/professional-report?submissionNo=${encodeURIComponent(submissionNo)}`,
      elapsedMs,
      input,
      report,
      summary: summarizeProfessional(report),
      generatedBy: report.generatedBy,
      hasForbiddenText: JSON.stringify(report).includes(forbiddenFeeQualifier),
    }
  } catch (error) {
    const elapsedMs = Date.now() - started
    const message = error instanceof Error ? error.message : String(error)
    console.log(`[error] ${modeLabel[mode]} ${item.id} ${elapsedMs}ms ${message}`)
    if (submissionNo) {
      if (mode === 'free') {
        await updateReportSubmissionResult(submissionNo, 'failed', { error: message }).catch(() => null)
      } else {
        await updateProfessionalReportSubmissionResult(submissionNo, 'failed', { error: message }).catch(() => null)
      }
    }
    return {
      caseId: item.id,
      title: item.title,
      mode,
      submissionNo,
      reportUrl: submissionNo
        ? `${clientBaseUrl}/${mode === 'free' ? 'report' : 'professional-report'}?submissionNo=${encodeURIComponent(submissionNo)}`
        : '',
      elapsedMs,
      input: mode === 'free' ? buildFreeInput(item, index) : buildProfessionalInput(item),
      error: message,
    }
  }
}

const tasks = cases.flatMap((item, index) => [buildTask(item, index, 'free'), buildTask(item, index, 'professional')])
const results: Array<Awaited<ReturnType<ReturnType<typeof buildTask>>>> = []
const concurrency = 2
let cursor = 0

const worker = async () => {
  while (cursor < tasks.length) {
    const taskIndex = cursor
    cursor += 1
    results[taskIndex] = await tasks[taskIndex]()
  }
}

await Promise.all(Array.from({ length: concurrency }, () => worker()))

const completedAt = new Date().toISOString()
const modeStats = (mode: Mode) => {
  const items = results.filter((item) => item.mode === mode)
  return {
    total: items.length,
    llm: items.filter((item) => item.generatedBy === 'llm').length,
    rules: items.filter((item) => item.generatedBy === 'rules').length,
    forbiddenText: items.filter((item) => item.hasForbiddenText).length,
    avgElapsedMs: Math.round(items.reduce((sum, item) => sum + (item.elapsedMs || 0), 0) / Math.max(1, items.length)),
  }
}

const aggregate = {
  completedAt,
  total: results.length,
  errors: results.filter((item) => item.error).length,
  byMode: {
    free: modeStats('free'),
    professional: modeStats('professional'),
  },
}

await writeFile(outputJsonPath, JSON.stringify({ aggregate, cases, results }, null, 2), 'utf8')

const lines: string[] = []
lines.push('# 报告生成案例验证结果')
lines.push('')
lines.push(`生成时间：${completedAt}`)
lines.push('')
lines.push('## 汇总')
lines.push('')
lines.push(`- 总报告数：${aggregate.total}`)
lines.push(`- 错误数：${aggregate.errors}`)
lines.push(`- 简易报告：${aggregate.byMode.free.total} 份；LLM ${aggregate.byMode.free.llm}；规则兜底 ${aggregate.byMode.free.rules}；${forbiddenFeeQualifierLabel}命中 ${aggregate.byMode.free.forbiddenText}；平均耗时 ${aggregate.byMode.free.avgElapsedMs}ms`)
lines.push(`- 专业报告：${aggregate.byMode.professional.total} 份；LLM ${aggregate.byMode.professional.llm}；规则兜底 ${aggregate.byMode.professional.rules}；${forbiddenFeeQualifierLabel}命中 ${aggregate.byMode.professional.forbiddenText}；平均耗时 ${aggregate.byMode.professional.avgElapsedMs}ms`)
lines.push('')
lines.push(`完整 JSON：${outputJsonPath}`)
lines.push('')

for (const item of cases) {
  lines.push(`## ${item.id}｜${item.title}`)
  lines.push('')
  lines.push('### 输入内容')
  lines.push('')
  lines.push('```json')
  lines.push(JSON.stringify({
    visitPurpose: item.visitPurpose,
    diagnosis: item.diagnosis,
    stage: item.stage,
    chiefComplaint: item.chiefComplaint,
    pathologySummary: item.pathologySummary,
    imagingSummary: item.imagingSummary,
    geneticSummary: item.geneticSummary,
    treatmentHistory: item.treatmentHistory,
    selectedRegions: item.selectedRegions,
    budgetRange: item.budgetRange,
    urgency: item.urgency,
  }, null, 2))
  lines.push('```')
  lines.push('')

  for (const mode of ['free', 'professional'] as const) {
    const result = results.find((entry) => entry.caseId === item.id && entry.mode === mode)
    lines.push(`### ${modeLabel[mode]}`)
    lines.push('')
    if (!result || result.error) {
      lines.push(`生成失败：${result?.error || '未生成'}`)
      lines.push('')
      continue
    }

    lines.push(`- generatedBy：${result.generatedBy}`)
    lines.push(`- 报告编号：${result.submissionNo}`)
    lines.push(`- 正式页面：${result.reportUrl}`)
    lines.push(`- 耗时：${result.elapsedMs}ms`)
    lines.push(`- ${forbiddenFeeQualifierLabel}命中：${result.hasForbiddenText ? '是' : '否'}`)
    lines.push('')
    lines.push('```json')
    lines.push(JSON.stringify(result.summary, null, 2))
    lines.push('```')
    lines.push('')
  }
}

await writeFile(outputMdPath, lines.join('\n'), 'utf8')

console.log(JSON.stringify({ aggregate, outputJsonPath, outputMdPath }, null, 2))
