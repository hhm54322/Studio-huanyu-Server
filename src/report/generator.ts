import type { ReportSubmissionInput } from '../validators/reportSubmission.js'
import { jsonrepair } from 'jsonrepair'
import { withExpertKnowledge } from '../expert/knowledge.js'
import { matchProfile } from '../expert/profile.js'
import { getKnowledgeForFreeReport, type DocumentKnowledgeBlock } from './documentKnowledge.js'
import {
  dentalAdvantages,
  dentalComparableRegionFees,
  dentalImplantPriceItems,
  dentalPartner,
  dentalSimulationPlan,
  dentalVeneerPriceItems,
  isFullArchImplantNeed,
  isVeneerNeed,
} from './dentalKnowledge.js'
import { defaultDisease, diseases, packages, regions, type KnowledgeDisease, type KnowledgeRegion } from './knowledgeBase.js'
import type { ReportLayoutSection } from './layoutTypes.js'
import { collectMedicalFactBundle, summarizeMedicalFactBundle, type MedicalDocumentFact, type MedicalFactBundle } from './medicalFactExtractor.js'
import { requestMedicalChatCompletion, type MedicalLlmMessage } from './medicalLlmProvider.js'
import { getCareNeedLabel, getExpectedTreatmentTimeLabel, getPatientIntentSummary } from './patientIntent.js'
import { sanitizeReportText } from './textSanitizer.js'
import { generatedReportSchema, type GeneratedReport } from './types.js'

type FreeReportPatch = Partial<Pick<
  GeneratedReport,
  | 'disease'
  | 'treatment'
  | 'countries'
  | 'advantages'
  | 'concerns'
  | 'hospitals'
  | 'highlights'
  | 'packages'
  | 'advancedCare'
  | 'paymentAndInsurance'
> & {
  plan?: Partial<GeneratedReport['plan']>
}>

type LlmPatchEnvelope = FreeReportPatch & {
  servicePackages?: unknown
  professionalPackages?: unknown
  professionalServicePackages?: unknown
  evaluationPackages?: unknown
  recommendedHospitals?: unknown
  recommended_hospitals?: unknown
  hospitalRecommendations?: unknown
  hospital_recommendations?: unknown
  topHospitals?: unknown
  top_hospitals?: unknown
  costBreakdown?: unknown
  cost_breakdown?: unknown
  costDetails?: unknown
  cost_breakdown_details?: unknown
  costs?: unknown
  cost?: unknown
  expenses?: unknown
  expenseBreakdown?: unknown
  expense_breakdown?: unknown
  feeBreakdown?: unknown
  fee_breakdown?: unknown
  budget?: unknown
  budgetBreakdown?: unknown
  budget_breakdown?: unknown
  detailedCosts?: unknown
  detailedCostBreakdown?: unknown
  detailed_cost_breakdown?: unknown
  medicalCosts?: unknown
  medical_costs?: unknown
  frontierCare?: unknown
  advancedTherapies?: unknown
  advancedTherapyRecommendations?: unknown
  frontierTherapyRecommendations?: unknown
  drugAndTherapyInsights?: unknown
}

type FreeGenerationOptions = {
  onPhaseDuration?: (phase: string, durationMs: number) => void
}

const sanitizeGenerationError = (error: unknown) => (
  error instanceof Error ? error.message : String(error)
).replace(/sk-[A-Za-z0-9_*.-]+/g, 'sk-***')

const trackGenerationPhase = async <T>(
  phase: string,
  options: FreeGenerationOptions | undefined,
  run: () => Promise<T>,
) => {
  const startedAt = Date.now()
  try {
    return await run()
  } finally {
    options?.onPhaseDuration?.(phase, Date.now() - startedAt)
  }
}

type DiseaseMatch = {
  key: string
  disease: KnowledgeDisease
  requestedKey: string
  requestedDisease: KnowledgeDisease
  mismatch: boolean
  weakMatch?: boolean
  mismatchReason?: string
  possibleDirections?: string[]
  secondaryDirections?: string[]
  selectedEvidence?: string[]
  detectedSignals?: SymptomSignalMatch[]
}

type CasePersonalization = {
  complaint: string
  caseSummary: string
  mismatch: boolean
  weakMatch: boolean
  mismatchReason?: string
  possibleDirections: string[]
  secondaryDirections: string[]
  selectedEvidence: string[]
  detectedSignals: string[]
  reportDiseaseLabel: string
  requestedDepartment: string
  urgentRisk: boolean
  urgencyNote: string
  decisionPoints: string[]
  requiredMaterials: string[]
  planPriorities: string[]
  costGuidance: string
  countryGuidance: string
  specialtyRules: string[]
}

type ReportContext = {
  submissionNo: string
  dateLabel: string
  input: ReportSubmissionInput
  diseaseKey: string
  disease: KnowledgeDisease
  personalization: CasePersonalization
  selectedRegionItems: ReturnType<typeof getRegionItems>
  documentKnowledge: DocumentKnowledgeBlock[]
  medicalFacts: MedicalFactBundle
}

type SymptomSignalGroup = {
  label: string
  keywords: string[]
  inferKeywords?: string[]
  diseaseKey?: string
}

type SymptomSignalMatch = {
  key: string
  label: string
  hits: string[]
  diseaseKey?: string
}

const normalizeText = (text: string) => text.toLowerCase().replace(/\s+/g, '')

const isNegatedOccurrence = (text: string, index: number, keyword: string) => {
  const before = text.slice(Math.max(0, index - 10), index)
  const after = text.slice(index + keyword.length, index + keyword.length + 8)
  const negativeBefore =
    /(?:没有|沒有|没|沒|未见|未发现|未查见|否认|不是|并非|不属于|排除|不考虑)[^，。；、,.!?！？]{0,4}$/.test(before) ||
    /(?:无|無)(?:明显|相关|异常)?$/.test(before)
  const negativeAfter = /^(没有问题|没有异常|沒问题|没问题|沒事|没事|无异常|無异常|不疼|不痛|不肿|正常|阴性|排除)/.test(after)
  return negativeBefore || negativeAfter
}

const getPositiveKeywordHits = (text: string, keywords: string[]) => {
  const normalized = normalizeText(text)
  const hits: string[] = []

  for (const rawKeyword of keywords) {
    const keyword = normalizeText(rawKeyword)
    if (!keyword) continue

    let index = normalized.indexOf(keyword)
    while (index >= 0) {
      if (!isNegatedOccurrence(normalized, index, keyword)) {
        hits.push(rawKeyword)
        break
      }
      index = normalized.indexOf(keyword, index + keyword.length)
    }
  }

  return unique(hits)
}

const includesAny = (text: string, keywords: string[]) => getPositiveKeywordHits(text, keywords).length > 0

const unique = (items: string[]) => Array.from(new Set(items.filter(Boolean)))

const getParsedFileEvidence = (input: ReportSubmissionInput) => input.parsedFiles
  .filter((file) => file.summary.trim() || file.text.trim())
  .map((file) => {
    const medicalFacts = file.metadata?.medicalFacts as MedicalDocumentFact | undefined
    const displayEvidence = medicalFacts?.sourceEvidence?.length
      ? getDisplayClinicalEvidenceItems(medicalFacts.sourceEvidence, 3, 180)
      : []
    const structured = medicalFacts && displayEvidence.length
      ? `结构化识别：${medicalFacts.reportType || '医学资料'}；${medicalFacts.primaryDate || ''}；${displayEvidence.join('；')}`
      : ''
    const fallback = structured ? '' : truncateForPrompt(file.summary || file.text, 260)
    return `${file.originalName}：${[structured, fallback].filter(Boolean).join('；')}`
  })

const getSubmittedComplaint = (input: ReportSubmissionInput) => {
  const complaint = [
    input.basicInfo.chiefComplaint.trim(),
    getPatientIntentSummary(input.basicInfo),
  ].filter(Boolean).join('\n')
  if (!input.uploadedFiles.length && !input.parsedFiles.length) return complaint

  const parsedEvidence = getParsedFileEvidence(input).slice(0, 5)
  const factBundle = collectMedicalFactBundle(input.parsedFiles)
  const medicalFacts = factBundle.hasActionableFacts ? summarizeMedicalFactBundle(factBundle, 6) : []
  if (!parsedEvidence.length && !medicalFacts.length) return complaint
  return [complaint, `上传资料摘要：${[...medicalFacts, ...parsedEvidence].join('；')}`].filter(Boolean).join('\n')
}

const getComplaintForReport = (input: ReportSubmissionInput, fallbackLabel?: string) => {
  const complaint = getSubmittedComplaint(input)
  if (complaint) return complaint
  return `用户暂未填写症状及病史，本次仅基于“${fallbackLabel || input.basicInfo.visitPurpose || '就医目的'}”进行初步可行性预审。`
}

const diseaseSignalLabelMap: Record<string, string> = {
  breast_cancer: '乳腺癌',
  lung_cancer: '肺癌',
  liver_cancer: '肝癌',
  nasopharyngeal_cancer: '鼻咽癌',
  neurosurgery: '神经外科',
  dental: '牙科',
  cardiology_cardiothoracic: '心内科与心胸外科',
}

const parseCostValues = (cost: string, pattern: RegExp, divisor = 1) => {
  const matches = [...cost.replace(/,/g, '').matchAll(pattern)]
  return matches.map((match) => {
    const unit = match[2]
    const value = Number(match[1])
    const normalized = unit === 'k' || unit === 'K' || unit === '千'
      ? value * 1000
      : unit === '万'
        ? value * 10000
        : value
    return normalized / divisor
  }).filter((value) => Number.isFinite(value) && value > 0)
}

const parseUsdRange = (cost: string) => {
  const usdValues = parseCostValues(cost, /\$\s*(\d+(?:\.\d+)?)(?:\s*(k|K|千|万))?/g)
  const values = usdValues.length
    ? usdValues
    : parseCostValues(cost, /(?:¥|￥|人民币|RMB)\s*(\d+(?:\.\d+)?)(?:\s*(k|K|千|万))?/gi, 7.2)
  const fallbackValues = values.length
    ? values
    : parseCostValues(cost, /\$?\s*(\d+(?:\.\d+)?)(?:\s*(k|K|千|万))?/g)

  if (!fallbackValues.length) return null
  return {
    min: Math.min(...fallbackValues),
    max: Math.max(...fallbackValues),
  }
}

const formatUsdRange = ({ min, max }: { min: number; max: number }) => {
  const formatter = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })
  if (min === max) return `$${formatter.format(min)}`
  return `$${formatter.format(min)} - $${formatter.format(max)}`
}

const getBreakdownTotalCost = (breakdown: GeneratedReport['plan']['breakdown']) => {
  const ranges = breakdown.map((item) => parseUsdRange(item.cost))
  if (!ranges.length || ranges.some((range) => !range)) return null

  let min = 0
  let max = 0
  for (const range of ranges) {
    if (!range) return null
    min += range.min
    max += range.max
  }

  return formatUsdRange({ min, max })
}

const normalizeCountryNameForMatch = (value?: string) => (value || '')
  .trim()
  .replace(/¥/g, '￥')
  .replace(/\s+/g, '')
  .replace(/[（）()]/g, '')
  .replace(/（?推荐）?/g, '')
  .toLowerCase()

const countryNameAliases: Record<string, string[]> = {
  australia: ['澳大利亚', '澳洲', 'australia'],
  澳大利亚: ['澳大利亚', '澳洲', 'australia'],
  us: ['美国', '美國', 'unitedstates', 'usa', 'us', 'america', '美国us'],
  usa: ['美国', '美國', 'unitedstates', 'usa', 'us', 'america'],
  unitedstates: ['美国', '美國', 'unitedstates', 'usa', 'us', 'america'],
  america: ['美国', '美國', 'unitedstates', 'usa', 'us', 'america'],
  美国: ['美国', '美國', 'unitedstates', 'usa', 'us', 'america'],
  singapore: ['新加坡', 'singapore'],
  新加坡: ['新加坡', 'singapore'],
  japan: ['日本', 'japan'],
  日本: ['日本', 'japan'],
  korea: ['韩国', '韓國', 'southkorea', 'korea'],
  southkorea: ['韩国', '韓國', 'southkorea', 'korea'],
  韩国: ['韩国', '韓國', 'southkorea', 'korea'],
  uk: ['英国', '英國', 'unitedkingdom', 'uk', 'britain'],
  unitedkingdom: ['英国', '英國', 'unitedkingdom', 'uk', 'britain'],
  britain: ['英国', '英國', 'unitedkingdom', 'uk', 'britain'],
  英国: ['英国', '英國', 'unitedkingdom', 'uk', 'britain'],
  germany: ['德国', '德國', 'germany'],
  德国: ['德国', '德國', 'germany'],
  france: ['法国', '法國', 'france'],
  法国: ['法国', '法國', 'france'],
  canada: ['加拿大', 'canada'],
  加拿大: ['加拿大', 'canada'],
  newzealand: ['新西兰', '紐西蘭', 'newzealand'],
  新西兰: ['新西兰', '紐西蘭', 'newzealand'],
  thailand: ['泰国', '泰國', 'thailand'],
  泰国: ['泰国', '泰國', 'thailand'],
  malaysia: ['马来西亚', '馬來西亞', 'malaysia'],
  马来西亚: ['马来西亚', '馬來西亞', 'malaysia'],
}

const countryNamesMatch = (countryName?: string, referenceName?: string) => {
  const countryKey = normalizeCountryNameForMatch(countryName)
  const referenceKey = normalizeCountryNameForMatch(referenceName)
  if (!countryKey || !referenceKey) return false
  if (countryKey === referenceKey || countryKey.includes(referenceKey) || referenceKey.includes(countryKey)) return true
  const referenceAliases = countryNameAliases[referenceKey] || []
  return referenceAliases
    .map(normalizeCountryNameForMatch)
    .some((alias) => alias && (countryKey === alias || countryKey.includes(alias) || alias.includes(countryKey)))
}

const fillReferenceCountryCost = (countries: GeneratedReport['countries'], costBreakdown?: GeneratedReport['plan']['costBreakdown']) => {
  const referenceCountry = costBreakdown?.summary.referenceCountry
  const referenceCost = costBreakdown?.summary.referenceCost?.trim()
  if (!referenceCountry || !referenceCost || !parseUsdRange(referenceCost)) return countries

  return countries.map((country) => (
    countryNamesMatch(country.name, referenceCountry) && !parseUsdRange(country.fee)
      ? { ...country, fee: referenceCost }
      : country
  ))
}

const normalizeReportCosts = (report: GeneratedReport): GeneratedReport => {
  const detailedChinaTotal = report.plan.costBreakdown?.summary.chinaTotal?.trim()
  if (detailedChinaTotal) {
    return {
      ...report,
      countries: fillReferenceCountryCost(
        report.countries.map((country) => (
          country.recommended || country.name.includes('中国')
            ? { ...country, fee: detailedChinaTotal }
            : country
        )),
        report.plan.costBreakdown,
      ),
      plan: {
        ...report.plan,
        totalCost: detailedChinaTotal,
      },
    }
  }

  const totalCost = getBreakdownTotalCost(report.plan.breakdown)
  if (!totalCost) {
    return {
      ...report,
      countries: fillReferenceCountryCost(report.countries, report.plan.costBreakdown),
    }
  }

  return {
    ...report,
    countries: fillReferenceCountryCost(
      report.countries.map((country) => (
        country.recommended || country.name.includes('中国')
          ? { ...country, fee: totalCost }
          : country
      )),
      report.plan.costBreakdown,
    ),
    plan: {
      ...report.plan,
      totalCost,
    },
  }
}

const getFreeMetastasisSites = (context: ReportContext) => unique(
  context.medicalFacts.documents
    .flatMap((document) => document.metastasisSignals)
    .filter((signal) => signal.status === 'present' || signal.status === 'suspected')
    .map((signal) => signal.site),
)

const cleanEvidenceSnippet = (text: string, maxLength = 220) => {
  const normalized = String(text || '')
    .replace(/^医学摘要\s*[:：]\s*/i, '')
    .replace(/\s+/g, ' ')
    .replace(/\.\.\.$/, '')
    .trim()
  if (!normalized) return ''
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}...` : normalized
}

const isDisplayableClinicalEvidence = (text: string) => {
  const value = String(text || '').trim()
  const lower = value.toLowerCase()
  if (!value) return false
  if ([
    '医学摘要',
    '报告可见内容',
    '主要结论',
    'patient name',
    'patient id',
    'accession no',
    'no mr',
    'kementerian',
    '出生日期',
    'dob',
    'study date',
    'portaca',
  ].some((token) => lower.includes(token.toLowerCase()))) return false
  if (/^患者\s*[A-Za-z]/.test(value)) return false
  return true
}

const getDisplayClinicalEvidenceItems = (items: string[], limit = 3, maxLength = 180) => unique(items
  .map((item) => cleanEvidenceSnippet(item, maxLength))
  .filter((item) => item && isDisplayableClinicalEvidence(item)))
  .slice(0, limit)

const dateValue = (date: string) => {
  const normalized = date.length === 7 ? `${date}-01` : date
  const value = Date.parse(normalized)
  return Number.isFinite(value) ? value : 0
}

const earliestClinicalDateValue = Date.parse('2000-01-01')

const isLikelyClinicalReportDate = (date: string) => {
  const value = dateValue(date)
  return Boolean(value && value >= earliestClinicalDateValue)
}

const uniqueSortedDates = (dates: string[]) => unique(dates
  .filter((date) => date && date !== '日期待确认' && isLikelyClinicalReportDate(date)))
  .sort((left, right) => dateValue(left) - dateValue(right))

const isMetastaticBreastFreeCase = (context: ReportContext) => {
  const factText = [
    context.medicalFacts.summary,
    ...context.medicalFacts.evidenceHighlights,
    ...context.medicalFacts.documents.flatMap((document) => [
      document.reportType,
      ...document.diagnoses,
      ...document.findings.map((finding) => finding.text),
      ...document.indicators.map((indicator) => `${indicator.name} ${indicator.value}`),
    ]),
  ].join(' ')

  return (
    (context.diseaseKey === 'breast_cancer' || context.medicalFacts.diseaseSignals.includes('breast_cancer') || includesAny(factText, ['乳腺', 'breast', 'Luminal', 'carcinoma mamma', 'mammae'])) &&
    getFreeMetastasisSites(context).length > 0
  )
}

const getNeedForReport = (context: ReportContext) => {
  const patientIntent = getPatientIntentSummary(context.input.basicInfo)
  if (isMetastaticBreastFreeCase(context)) {
    const complaint = context.input.basicInfo.chiefComplaint.trim()
    return [complaint || `本次围绕“${context.disease.label}”进行来华就医可行性预审。`, patientIntent].filter(Boolean).join('；')
  }
  return getComplaintForReport(context.input, context.disease.label)
}

const getFreeFactIndicator = (context: ReportContext, names: string[]) => {
  const normalizedNames = names.map((name) => normalizeText(name))
  return context.medicalFacts.documents
    .flatMap((document) => document.indicators)
    .find((indicator) => normalizedNames.includes(normalizeText(indicator.name)))
}

const formatFreeIndicator = (context: ReportContext, names: string[]) => {
  const indicator = getFreeFactIndicator(context, names)
  return indicator ? `${indicator.name} ${indicator.value}` : ''
}

const buildMetastaticBreastFreeRecordSummary = (context: ReportContext) => {
  const sites = getFreeMetastasisSites(context)
  const allDates = uniqueSortedDates([
    ...context.medicalFacts.timeline.map((item) => item.date),
    ...context.medicalFacts.documents.flatMap((document) => [document.primaryDate, ...document.dates]),
  ])
  const latestDate = allDates[allDates.length - 1] || '最新资料'
  const indicators = [
    formatFreeIndicator(context, ['ER']),
    formatFreeIndicator(context, ['PR']),
    formatFreeIndicator(context, ['HER2']),
    formatFreeIndicator(context, ['Ki-67', 'Ki67']),
    formatFreeIndicator(context, ['分子分型']),
  ].filter(Boolean)
  const signals = context.medicalFacts.documents
    .flatMap((document) => document.metastasisSignals)
    .filter((signal) => signal.status === 'present' || signal.status === 'suspected')
  const evidenceBySite = sites.map((site) => {
    const signal = signals.find((item) => item.site === site)
    const evidence = signal ? getDisplayClinicalEvidenceItems([signal.evidence], 1, 180)[0] : ''
    return signal && evidence ? `${site}：${evidence}` : ''
  }).filter(Boolean)

  return {
    summary: `上传资料提示乳腺癌术后复查场景中已出现${sites.join('、')}等复发/转移或可疑转移线索；免费报告只能做方向预审，正式结论需肿瘤内科结合PET/CT原片、病理切片和既往治疗记录确认。`,
    items: [
      allDates.length >= 2 ? `时间线：资料从${allDates[0]}延续到${latestDate}，重点已从初诊/术后资料转向PET/CT再分期和转移风险评估。` : '',
      indicators.length ? `病理/IHC：${indicators.join('；')}，需用于判断HR+/HER2-方向、内分泌治疗基础和治疗强度。` : '',
      evidenceBySite.length ? `影像证据：${evidenceBySite.join('；')}` : '',
      '当前优先确认：PET/CT多部位病灶是否构成转移性复发、转移灶受体状态是否变化、是否存在肝功能受损或骨折/脊髓压迫等需要先处理的风险。',
      '下一步重点：提交PET/CT DICOM、完整报告、手术病理、放化疗和用药清单，评估CDK4/6+内分泌治疗、再活检/分子检测、骨保护和局部放疗是否适用。',
    ].filter(Boolean),
  }
}

const buildMetastaticBreastFreeEnhancement = (context: ReportContext) => {
  const sites = getFreeMetastasisSites(context)
  const hasBone = sites.includes('骨骼')
  const hasLiver = sites.includes('肝脏')

  return {
    treatment: [
      '根据已解析资料，患者属于右乳癌术后及放化疗后复查场景，PET/CT已出现肝脏、骨骼、淋巴结等复发/远处转移信号。',
      '下一步不应按单纯术后局部复查处理，而应由乳腺肿瘤内科/MDT复核原始影像、病理切片、受体状态和既往治疗后，确认是否进入HR+/HER2-转移性乳腺癌系统治疗路径。',
      '若确认进入转移性阶段，现实目标通常是长期系统控制：尽快压低肿瘤活性、保护骨骼和肝功能、控制疼痛，并把用药监测和回国续治安排连续起来。',
      '若确认ER阳性、HER2阴性且无内脏危象，常见讨论方向是CDK4/6抑制剂联合内分泌治疗，如Palbociclib、Ribociclib或Abemaciclib联合芳香化酶抑制剂/Fulvestrant；若肝功能风险高、进展快或既往治疗耐药，则需由医生评估化疗、再活检、分子检测、骨保护、局部放疗或临床研究。',
    ].join(' '),
    plan: {
      direction: [
        '远程提交PET/CT DICOM原片、病理/IHC、2025年手术病理和既往治疗记录',
        '抵华后完成病理受体状态复核、PET/CT原片复核、肝脏增强影像、头颅增强MRI和骨病灶风险评估',
        '讨论肝脏/淋巴结等可及病灶再活检，复核ER/PR/HER2/Ki-67并按需做PIK3CA、ESR1、BRCA/PALB2或NGS/ctDNA',
        'MDT确定CDK4/6+内分泌、化疗、骨保护、局部放疗/止痛或临床研究的优先顺序',
      ].join(' -> '),
      duration: '远程预审约3-7天；来华集中评估通常7-14天；若启动首周期系统治疗、骨转移处理或局部放疗，预计在华停留2-6周，后续按6-12周复查节奏随访。',
      totalCost: '$11,100 - $43,000',
      breakdown: [
        { item: '远程病历整理、医学翻译与专家预审', cost: '$300-$1,000' },
        { item: '病理/IHC复核与受体状态确认', cost: '$800-$2,500' },
        { item: 'PET/CT原片复核及补充分期检查', cost: '$1,500-$5,000' },
        { item: '可及病灶再活检与分子检测（如需）', cost: '$1,500-$6,000' },
        { item: 'CDK4/6抑制剂 + 内分泌治疗首月评估', cost: '$2,500-$9,000' },
        { item: '骨保护、止痛和支持治疗', cost: hasBone ? '$500-$2,500' : '$300-$1,200' },
        { item: '局部放疗、短期住院或介入/支持处理（如需）', cost: '$2,500-$12,000' },
        { item: '翻译陪诊、就医协调、住宿与生活', cost: '$1,500-$5,000' },
      ],
    },
    concerns: [
      {
        concern: 'PET/CT提示多部位高代谢病灶，需尽快复核',
        solution: `建议携带PET/CT DICOM原始影像、完整报告和既往治疗记录，由乳腺肿瘤MDT判断${sites.join('、')}等病灶是否符合转移性复发表现，并评估是否需要再活检。`,
      },
      {
        concern: '系统治疗选择取决于受体状态和既往用药',
        solution: '需复核ER、PR、HER2、Ki-67和Luminal分型；若转移灶可及，建议讨论再活检，确认HER2-low、PIK3CA、ESR1、BRCA/PALB2等是否影响用药排序。',
      },
      ...(hasBone ? [{
        concern: '骨转移涉及承重骨或脊柱时存在骨折/脊髓压迫风险',
        solution: '需评估疼痛、活动能力、脊柱/骨盆/髋臼稳定性，讨论地舒单抗或唑来膦酸、补钙/维D、局部放疗、止痛和骨科/放疗科会诊。',
      }] : []),
      ...(hasLiver ? [{
        concern: '肝转移可能影响系统治疗紧迫性和药物耐受',
        solution: '建议补充肝功能、凝血、肿瘤标志物和肝脏增强MRI/CT；若出现黄疸、明显乏力、腹胀或肝功能异常，应先在当地处理风险。',
      }] : []),
      {
        concern: '脑部PET阴性不能完全排除脑转移',
        solution: 'PET/CT报告已提示脑转移更适合MRI评估；如有头痛、呕吐、视物异常、抽搐或肢体无力，应优先做头颅增强MRI。',
      },
      {
        concern: '费用不应按单一手术包估算',
        solution: '当前更接近转移性乳腺癌复核和系统治疗场景，预算应按检查复核、再活检/分子检测、首月药物、骨保护/局部处理、服务和生活费用分层确认。',
      },
    ],
    highlights: [
      '病理提示右乳浸润性癌NST，Luminal B-like，ER强阳性，PR阴性，HER2阴性/1+，Ki-67约70%。',
      'PET/CT提示肝脏、骨骼、胸小肌下/纵隔/肺门淋巴结等多部位高代谢病灶，需按复发/转移方向快速复核。',
      'HR+/HER2-场景下，CDK4/6抑制剂联合内分泌治疗是常见讨论方向，但需结合既往治疗、肝功能、血象和是否存在内脏危象确认。',
      '骨转移管理需同步纳入地舒单抗/唑来膦酸、补钙/维D、止痛、局部放疗和骨折风险评估。',
      '如果可及病灶适合再活检，可帮助确认受体状态变化、HER2-low可能性和精准治疗/临床研究机会。',
      '本次来华价值不只是找医院，而是把病理、影像、既往治疗、药物费用和跨境随访整理成可执行的MDT方案。',
    ],
  }
}

const isSpecialtyFreeCase = (context: ReportContext) => (
  !context.personalization.mismatch &&
  context.medicalFacts.hasActionableFacts &&
  ['lung_cancer', 'liver_cancer', 'nasopharyngeal_cancer', 'neurosurgery'].includes(context.diseaseKey)
)

const buildSpecialtyFreeEnhancement = (context: ReportContext) => {
  if (!isSpecialtyFreeCase(context)) return null

  const evidence = getDisplayClinicalEvidenceItems(context.medicalFacts.evidenceHighlights, 4, 160)
  const indicator = (names: string[]) => names.map((name) => formatFreeIndicator(context, [name])).filter(Boolean).join('；')
  const profiles: Record<string, {
    treatment: string
    planDirection: string
    concerns: GeneratedReport['concerns']
    highlights: string[]
  }> = {
    lung_cancer: {
      treatment: `上传资料提示肺癌/肺部肿瘤方向，当前核心不是直接决定手术或用药，而是先把病理类型、TNM分期、EGFR/ALK/PD-L1等分子免疫指标和远处转移筛查放在一起复核。${indicator(['EGFR', 'ALK', 'PD-L1']) ? `已识别关键指标：${indicator(['EGFR', 'ALK', 'PD-L1'])}。` : ''}若确认存在可靶向突变，治疗排序会明显不同；若分期提示可切除或局部晚期，则需胸外科、肿瘤内科和放疗科MDT判断手术、放疗、靶向、免疫或化疗的先后。`,
      planDirection: '病理切片/蜡块复核 -> 胸部CT/PET-CT和头颅增强MRI完善分期 -> EGFR/ALK/PD-L1/NGS确认 -> 胸部肿瘤MDT排序手术、靶向、免疫、化疗或放疗 -> 固定可测量病灶并6-8周评估疗效',
      concerns: [
        { concern: '治疗路径取决于病理、分期和分子结果', solution: '需同时提交病理报告/切片、胸部CT DICOM、脑MRI或PET/CT、EGFR/ALK/PD-L1/NGS结果，避免只按肺部肿块大小决定治疗。' },
        { concern: '脑转移或呼吸急症需优先排除', solution: '如有头痛抽搐、肢体无力、咯血、气促、血氧下降或胸痛，应先在当地急诊/呼吸肿瘤科处理。' },
      ],
      highlights: [
        '肺癌资料应优先回答：是否已有病理、TNM分期是否完整、是否存在可靶向突变或免疫治疗指征。',
        'EGFR/ALK/PD-L1结果会直接影响靶向、免疫、化疗和局部治疗的排序。',
        '来华价值在于把胸外科、肿瘤内科、放疗科和影像病理复核放入同一个MDT决策框架。',
      ],
    },
    liver_cancer: {
      treatment: `上传资料提示肝癌/肝脏肿瘤方向，当前要同时判断肿瘤负荷、肝功能储备、门静脉侵犯和肝外转移，不能只按肿瘤大小决定手术或介入。${indicator(['AFP']) ? `已识别关键指标：${indicator(['AFP'])}。` : ''}若肝功能和肿瘤位置允许，可讨论手术或消融；若存在门静脉癌栓、肿瘤负荷较高或不可切除，则需评估TACE/HAIC、放疗、靶免系统治疗和肝功能保护。`,
      planDirection: '肝脏增强MRI/CT原片复核 -> AFP趋势、肝功能/凝血和乙肝/丙肝病毒学评估 -> 判断可切除/可消融/可介入 -> 肝胆外科+介入+肿瘤内科MDT -> 分阶段治疗和肝功能监测',
      concerns: [
        { concern: '肝癌方案高度依赖肝功能储备', solution: '需补齐胆红素、白蛋白、凝血功能、血小板、Child-Pugh/ALBI和乙肝/丙肝资料，再判断手术、介入或系统治疗承受性。' },
        { concern: '门静脉癌栓或肝功能失代偿会改变优先级', solution: '如有黄疸、腹水、呕血黑便、发热或意识改变，应先在当地处理出血、感染或肝功能风险。' },
      ],
      highlights: [
        '肝癌资料应优先回答：是否符合影像/病理诊断、肝功能能否承受治疗、是否存在门静脉癌栓或肝外转移。',
        '手术、消融、TACE/HAIC、放疗和靶免系统治疗需要由肝胆外科、介入科和肿瘤内科联合排序。',
        '费用和停留周期应按检查复核、住院介入/手术、系统药物和后续复查分阶段测算。',
      ],
    },
    nasopharyngeal_cancer: {
      treatment: '上传资料提示鼻咽癌/头颈肿瘤方向，当前重点是复核病理、头颈MRI分期、EBV DNA和远处转移筛查，再判断诱导化疗、同步放化疗、复发后再程放疗或系统治疗路径。',
      planDirection: '鼻咽镜病理复核 -> 头颈MRI和EBV DNA完善分期 -> PET/CT或胸腹影像排除远处转移 -> 头颈肿瘤放疗科MDT -> 精准放疗/化疗/系统治疗排序',
      concerns: [
        { concern: '放疗前支持会影响疗程完成度', solution: '需评估口腔牙齿、营养、听力、吞咽和颈部功能，减少治疗中断风险。' },
        { concern: '颅神经或出血症状需先处理', solution: '如有鼻出血不止、视物异常、严重头痛、吞咽困难或颅神经症状，应先当地耳鼻喉/急诊处理。' },
      ],
      highlights: [
        '鼻咽癌资料应优先回答：病理是否明确、头颈MRI分期是否完整、EBV DNA和远处转移筛查是否齐全。',
        '中国方案价值在于头颈肿瘤放疗经验、精准放疗计划和全疗程支持管理。',
      ],
    },
    neurosurgery: {
      treatment: `上传资料提示神经外科/中枢神经系统肿瘤方向，当前核心是明确病灶位置、神经功能风险、病理/分子分型和是否适合最大安全切除。${indicator(['WHO分级', 'IDH状态', 'MGMT甲基化', 'Ki-67']) ? `已识别关键指标：${indicator(['WHO分级', 'IDH状态', 'MGMT甲基化', 'Ki-67'])}。` : ''}若为高级别胶质瘤或疑似恶性肿瘤，下一步通常不是单纯观察，而是复核MRI原片、病理和分子指标后，排序手术/放疗/替莫唑胺/康复随访。`,
      planDirection: '头颅/脊髓MRI DICOM复核 -> 神经功能和癫痫风险评估 -> 病理/IDH/MGMT/Ki-67复核 -> 神经外科+放疗科+肿瘤内科MDT -> 最大安全切除或辅助放化疗及康复随访',
      concerns: [
        { concern: '神经功能恶化需优先处理', solution: '如出现进行性头痛、喷射性呕吐、抽搐、意识改变、肢体无力、语言障碍或大小便异常，应先当地神经外科急诊处理。' },
        { concern: '手术决策不能只看肿瘤大小', solution: '需结合功能区、传导束、占位效应、病理分子指标和术后辅助治疗窗口综合判断。' },
      ],
      highlights: [
        '神经肿瘤资料应优先回答：病灶是否位于功能区、是否需要手术取样/切除、WHO/IDH/MGMT是否足够指导辅助治疗。',
        '高级别胶质瘤场景需尽快衔接放疗、替莫唑胺和康复随访，避免术后辅助治疗窗口被拖延。',
        '来华价值在于神经外科、影像、病理、放疗、肿瘤内科和康复团队联合排序。',
      ],
    },
  }

  const profile = profiles[context.diseaseKey]
  if (!profile) return null

  return {
    treatment: profile.treatment,
    plan: {
      direction: profile.planDirection,
      duration: context.disease.duration,
      totalCost: context.disease.chinaFee,
      breakdown: context.disease.breakdown,
    },
    concerns: [
      ...profile.concerns,
      ...(evidence.length ? [{ concern: '上传资料已形成核心线索', solution: `已识别：${evidence.join('；')}。正式方案仍需医生复核原件和DICOM影像。` }] : []),
    ],
    highlights: profile.highlights,
  }
}

const harmonizeCountryFees = (report: GeneratedReport, diseaseKey: string): GeneratedReport => {
  if (diseaseKey !== 'dental') return report

  return {
    ...report,
    countries: report.countries.map((country) => {
      if (country.recommended || country.name.includes('中国')) return country
      const fee = dentalComparableRegionFees[country.name]
      return fee ? { ...country, fee } : country
    }),
  }
}

type DentalCostProfile = {
  key: 'basic' | 'mixed' | 'advanced'
  totalCost: string
  duration: string
  breakdown: GeneratedReport['plan']['breakdown']
  regionFees: Record<string, string>
}

const toBreakdownItem = (item: { item: string; cost: string }) => ({ item: item.item, cost: item.cost })

const dentalBrandAdvantage = {
  label: '推荐机构',
  value: `牙科方向仅推荐${dentalPartner.name}。${dentalPartner.brandIntro}`,
}

const dentalSimulationUpgradeText = `如患者进入专业版种植牙评估，可基于CBCT/口腔影像补充${dentalSimulationPlan.service}，覆盖诊断概览、3D设计概览、种植体位置/型号/角度/深度规划和手术概要。`

const getDentalCostProfile = (context: ReportContext): DentalCostProfile => {
  const text = [
    context.personalization.complaint,
    context.input.basicInfo.visitPurpose,
    context.input.basicInfo.chiefComplaint,
  ].join(' ')
  const hasFullArchNeed = isFullArchImplantNeed(text)
  const hasVeneerNeed = isVeneerNeed(text)
  const hasImplantNeed = hasFullArchNeed || includesAny(text, [
    '种植', 'implant', '缺牙', '拔牙后', '全口', '半口', '植骨', '上颌窦',
  ])
  const hasAdvancedNeed = hasImplantNeed || hasVeneerNeed || includesAny(text, [
    '正畸', '矫正', '牙冠', '修复',
  ])
  const hasBasicNeed = includesAny(text, [
    '牙疼', '牙痛', '蛀牙', '龋', '龋齿', '补牙', '根管', '牙髓', '牙神经', 'cavity', 'root canal', 'dental pain',
  ])

  if (hasImplantNeed && hasBasicNeed) {
    return {
      key: 'mixed',
      totalCost: '基础止痛/保牙处理需鼎植面诊报价；若经CBCT确认需资料中的半口即刻负重，参考¥98,000-¥298,000（约$13,600-$41,400）',
      duration: '短期先完成CBCT、疼痛来源判断、补牙/根管/拔牙等急性处理；如最终需要种植修复，通常需一期手术、3-6个月骨结合、二期修复和后续复查。',
      breakdown: [
        { item: '口腔全景片/CBCT、牙周与咬合评估', cost: '需鼎植面诊报价' },
        { item: '止痛、补牙、根管或拔牙初步处理', cost: '按患牙数量和治疗方式面诊确认' },
        ...dentalImplantPriceItems.map(toBreakdownItem),
        { item: '翻译、预约与就医协调', cost: '$300-$1,000' },
        { item: '短期住宿与生活', cost: '$500-$2,000' },
      ],
      regionFees: {
        美国: '$2,500 - $18,000+',
        加拿大: '$2,300 - $16,000+',
        英国: '$2,000 - $15,000+',
        德国: '$2,000 - $15,000+',
        法国: '$1,800 - $14,000+',
        新加坡: '$1,800 - $14,000+',
        泰国: '$1,000 - $8,500+',
        马来西亚: '$900 - $7,500+',
        日本: '$2,000 - $15,000+',
        韩国: '$1,500 - $12,000+',
        澳大利亚: '$2,500 - $17,000+',
        新西兰: '$2,300 - $16,000+',
      },
    }
  }

  if (hasImplantNeed) {
    return {
      key: 'advanced',
      totalCost: hasFullArchNeed
        ? '半口/复杂种植参考¥98,000-¥298,000（约$13,600-$41,400）'
        : '种植方案需先由鼎植结合CBCT报价；资料中半口即刻负重参考¥98,000起（约$13,600起）',
      duration: '在华可先完成口腔影像、牙周/咬合评估和鼎植种植方案确认；完整种植修复通常需一期手术、3-6个月骨结合、二期修复和每3-6个月维护复查。',
      breakdown: [
        { item: '口腔全景片/CBCT、牙周与咬合评估', cost: '需鼎植面诊报价' },
        ...dentalImplantPriceItems.map(toBreakdownItem),
        { item: '翻译、预约与就医协调', cost: '$300-$1,200' },
        { item: '住宿与生活', cost: '$800-$2,600' },
      ],
      regionFees: dentalComparableRegionFees,
    }
  }

  if (hasVeneerNeed || hasAdvancedNeed) {
    return {
      key: 'advanced',
      totalCost: '高端牙贴面参考¥2,680-¥85,000（约$400-$11,800），按单颗/8颗/16颗、材料品牌和美学设计确认',
      duration: '在华可先完成口腔检查、牙周/咬合评估和贴面美学设计；具体取模、制作和佩戴周期需按颗数、材料和医生方案确认。',
      breakdown: [
        { item: '口腔检查、牙周与咬合评估', cost: '需鼎植面诊报价' },
        ...dentalVeneerPriceItems.map(toBreakdownItem),
        { item: '翻译、预约与就医协调', cost: '$300-$1,200' },
        { item: '住宿与生活', cost: '$800-$2,600' },
      ],
      regionFees: dentalComparableRegionFees,
    }
  }

  return {
    key: 'basic',
    totalCost: '基础牙科处理需鼎植面诊报价；建议先预留¥2,000-¥15,000（约$300-$2,100）用于检查、止痛、补牙/根管等首阶段处理',
    duration: '多数牙痛、龋齿、补牙或根管初步处理可在5-10天内完成评估和首阶段治疗；是否需要种植需检查后再判断。',
    breakdown: [
      { item: '口腔检查、根尖片/全景片或基础影像', cost: '需鼎植面诊报价' },
      { item: '补牙、根管或牙周初步处理', cost: '按患牙数量、材料和治疗方式确认' },
      { item: '药物、复诊和材料预留', cost: '按医生处置确认' },
      { item: '翻译、预约与就医协调', cost: '$300-$900' },
      { item: '短期住宿与生活', cost: '$200-$1,000' },
    ],
    regionFees: {
      美国: '$800 - $5,000+',
      加拿大: '$700 - $4,500+',
      英国: '$700 - $4,500+',
      德国: '$700 - $4,500+',
      法国: '$600 - $4,000+',
      新加坡: '$700 - $4,500+',
      泰国: '$300 - $2,000+',
      马来西亚: '$250 - $1,800+',
      日本: '$700 - $4,500+',
      韩国: '$600 - $4,000+',
      澳大利亚: '$800 - $5,000+',
      新西兰: '$800 - $5,000+',
    },
  }
}

const applyDentalCostGuardrails = (report: GeneratedReport, context: ReportContext): GeneratedReport => {
  if (context.diseaseKey !== 'dental' || context.personalization.mismatch) return report

  const existingAdvantages = report.advantages
    .filter((item) => !reportContainsAny({ ...report, advantages: [item] }, ['肿瘤', '化疗', '放疗', '靶向', '免疫治疗']))
  const cleanHighlights = report.highlights
    .filter((item) => !/肿瘤|化疗|放疗|靶向|免疫治疗/.test(item))

  return {
    ...report,
    advantages: existingAdvantages.length ? existingAdvantages : report.advantages,
    highlights: cleanHighlights.length ? cleanHighlights : report.highlights,
  }
}

const finalizeReportCosts = (report: GeneratedReport, context: ReportContext): GeneratedReport => (
  applyDentalCostGuardrails(harmonizeCountryFees(normalizeReportCosts(report), context.diseaseKey), context)
)

const chinaCountry = (disease: KnowledgeDisease, personalization?: CasePersonalization) => ({
  flag: '🇨🇳',
  name: '中国（推荐）',
  fee: personalization?.mismatch ? '$3,000 - $20,000（先按综合分诊与专科预审估算）' : disease.chinaFee,
  wait: personalization?.urgentRisk ? '急性问题建议先就近处理；稳定后7-21天安排评估' : '7-21天',
  tech: personalization?.mismatch
    ? `当前主诉与所选科室不一致，需先围绕“${personalization.caseSummary}”做综合分诊、资料复核和主责专科确认`
    : personalization
    ? `${disease.label}方向需围绕“${personalization.caseSummary}”先做资料复核和专科判断，再决定具体治疗`
    : `${disease.label}相关专科病例量大，检查、会诊和治疗衔接效率较高`,
  service: '国际医疗部、医学翻译和就医管家可提供全流程协助',
  visa: '可协助医疗邀请函、M字签证或陪同家属材料准备',
  follow: personalization?.decisionPoints.length
    ? `围绕${personalization.decisionPoints[0]}建立阶段性随访和复诊提醒`
    : '支持术后/治疗后远程随访和跨境云病房管理',
  recommended: true,
})

const getDateLabel = () => {
  const now = new Date()
  return `${now.getFullYear()}年${now.getMonth() + 1}月`
}

const symptomSignalGroups: Record<string, SymptomSignalGroup> = {
  breast_cancer: {
    label: '乳腺专科/乳腺肿瘤',
    diseaseKey: 'breast_cancer',
    keywords: ['乳腺', '乳房', '左乳', '右乳', '双乳', '乳癌', '乳头', '腋窝', '乳腺肿块', '乳房肿块', '乳肿块', '钼靶', 'bi-rads', 'birads', 'her2', '雌激素', '孕激素', '内分泌治疗', '保乳'],
    inferKeywords: ['乳腺癌', '乳癌', '乳腺肿瘤', '乳房肿瘤', '左乳肿瘤', '右乳肿瘤', '乳腺肿块', '乳房肿块', '乳肿块', 'bi-rads4', 'bi-rads5', 'birads4', 'birads5', 'her2', '保乳'],
  },
  lung_cancer: {
    label: '肺部专科/肺肿瘤',
    diseaseKey: 'lung_cancer',
    keywords: ['肺', '肺部', '咳嗽', '咯血', '咳血', '血痰', '痰中带血', '咳血丝', '气短', '呼吸困难', '胸闷', '胸痛', '消瘦', '体重下降', '食欲差', '胸部ct', '肺结节', '磨玻璃', '肺癌', '靶向', '免疫治疗'],
    inferKeywords: ['肺癌', '肺部肿瘤', '肺肿瘤', '肺结节', '磨玻璃', '胸部ct', '非小细胞', '小细胞肺癌', 'egfr', 'alk', 'pd-l1', '靶向治疗', '免疫治疗'],
  },
  nasopharyngeal_cancer: {
    label: '鼻咽/头颈专科',
    diseaseKey: 'nasopharyngeal_cancer',
    keywords: ['鼻咽', '鼻咽癌', '涕血', '回吸血涕', '颈部淋巴', 'ebv', '头颈肿瘤', '鼻咽镜', '鼻塞', '耳鸣', '听力下降', '流鼻血', '鼻出血'],
    inferKeywords: ['鼻咽癌', '鼻咽肿瘤', '鼻咽镜', 'ebv', '头颈肿瘤', '颈部淋巴'],
  },
  liver_cancer: {
    label: '肝胆专科/肝肿瘤',
    diseaseKey: 'liver_cancer',
    keywords: ['肝', '肝脏', '肝癌', '甲胎', 'afp', '乙肝', '丙肝', '黄疸', '腹水', '肝占位', '肝结节', '肝胆'],
    inferKeywords: ['肝癌', '肝肿瘤', '肝脏肿瘤', '肝占位', '肝结节', '肝细胞癌', '甲胎', 'afp'],
  },
  cardiovascular_tumor: {
    label: '心血管肿瘤方向',
    diseaseKey: 'cardiovascular_tumor',
    keywords: ['心脏肿瘤', '心血管肿瘤', '心包肿瘤', '心肌肿瘤', '心脏占位', '心脏肿块', '心房黏液瘤'],
  },
  neurosurgery: {
    label: '神经外科/脑部问题',
    diseaseKey: 'neurosurgery',
    keywords: ['脑', '颅内', '脊髓', '头痛', '头晕', '癫痫', '抽搐', '偏瘫', '胶质', '胶质瘤', '神经胶质瘤', '星形细胞瘤', '垂体', '动脉瘤', '脑瘤', '脑肿瘤', '脊髓肿瘤', '下肢麻木', '肢体麻木', '行走困难', '神经功能', '神经外科'],
  },
  spine_surgery: {
    label: '脊柱外科/颈腰椎问题',
    diseaseKey: 'spine_surgery',
    keywords: ['脊柱', '腰椎', '颈椎', '背痛', '腰痛', '腿麻', '手麻', '椎间盘', '坐骨神经', '大小便障碍', '颈肩痛'],
  },
  premium_checkup: {
    label: '体检筛查/健康管理',
    diseaseKey: 'premium_checkup',
    keywords: ['体检', '筛查', '早筛', '家族史', '健康管理', '全身检查', '胃肠镜', '癌筛', '肿瘤筛查', '心脑血管筛查'],
  },
  dental: {
    label: '口腔牙科',
    diseaseKey: 'dental',
    keywords: ['牙', '牙齿', '口腔', '蛀牙', '龋', '龋齿', '牙疼', '牙痛', '牙龈', '牙周', '根管', '拔牙', '种植牙', '种植', '牙冠', '智齿', '补牙', '缺牙', '牙髓', '牙神经'],
  },
  cardiology_cardiothoracic: {
    label: '心内科/心胸外科',
    diseaseKey: 'cardiology_cardiothoracic',
    keywords: ['胸痛', '胸闷', '气短', '心悸', '心绞痛', '冠脉', '冠心病', '瓣膜', '搭桥', '心电', '心脏超声', '主动脉', '心衰', '心律失常'],
  },
  endocrinology_metabolism: {
    label: '内分泌代谢',
    diseaseKey: 'endocrinology_metabolism',
    keywords: ['糖尿病', '血糖', '糖化血红蛋白', '甲状腺', '内分泌', '代谢', '肥胖', '血脂', '尿酸', '激素', '胰岛素', '多囊', '痛风'],
  },
  dermatology: {
    label: '皮肤科/毛发问题',
    keywords: ['掉头发', '脱发', '斑秃', '头皮', '皮疹', '瘙痒', '湿疹', '痤疮', '痘痘', '皮肤', '荨麻疹', '银屑病', '白癜风'],
  },
  respiratory: {
    label: '呼吸内科/呼吸症状',
    keywords: ['咳嗽', '咳痰', '气喘', '喘息', '呼吸困难', '肺炎', '支气管', '哮喘', '发热咳嗽'],
  },
  gastroenterology: {
    label: '消化内科/胃肠问题',
    keywords: ['肚子疼', '腹痛', '胃痛', '胃疼', '腹胀', '肚子胀', '胃胀', '腹泻', '便秘', '便血', '反酸', '烧心', '恶心', '呕吐', '胃肠', '肠胃', '胃镜', '肠镜'],
  },
  ent: {
    label: '耳鼻喉科',
    keywords: ['耳鸣', '听力', '耳痛', '咽痛', '喉咙痛', '鼻塞', '流鼻血', '鼻出血', '鼻炎', '鼻窦炎', '声嘶', '声音嘶哑'],
  },
  urology: {
    label: '泌尿外科/肾脏相关问题',
    keywords: ['尿频', '尿急', '尿痛', '血尿', '前列腺', '肾结石', '输尿管结石', '肾积水', '排尿困难', '尿路感染'],
  },
  gynecology: {
    label: '妇科',
    keywords: ['月经', '痛经', '阴道', '卵巢', '子宫', '宫颈', '盆腔', '白带', '备孕', '怀孕', '不孕'],
  },
  orthopedics: {
    label: '骨科/关节问题',
    keywords: ['骨折', '关节痛', '膝盖痛', '髋关节', '肩痛', '韧带', '半月板', '骨质疏松', '骨科'],
  },
  ophthalmology: {
    label: '眼科',
    keywords: ['眼睛', '视力', '视物模糊', '眼痛', '白内障', '青光眼', '近视', '眼底', '飞蚊'],
  },
  hematology: {
    label: '血液科',
    keywords: ['贫血', '白血病', '淋巴瘤', '血小板', '白细胞', '骨髓', '凝血'],
  },
  psychiatry_sleep: {
    label: '精神心理/睡眠问题',
    keywords: ['失眠', '焦虑', '抑郁', '惊恐', '睡眠障碍', '情绪', '心理'],
  },
  infectious: {
    label: '感染科/发热问题',
    keywords: ['发热', '发烧', '感染', '炎症', '咳痰', '脓肿', '红肿热痛'],
  },
}

const selectedDepartmentRequiresSymptomMatch = new Set([
  'breast_cancer',
  'lung_cancer',
  'nasopharyngeal_cancer',
  'liver_cancer',
  'cardiovascular_tumor',
  'neurosurgery',
  'spine_surgery',
  'premium_checkup',
  'dental',
  'cardiology_cardiothoracic',
  'endocrinology_metabolism',
])

const getMatchedSignals = (text: string) => {
  return Object.entries(symptomSignalGroups)
    .map(([key, group]) => ({
      key,
      label: group.label,
      hits: getPositiveKeywordHits(text, group.keywords),
      diseaseKey: group.diseaseKey,
    }))
    .filter((item) => item.hits.length > 0)
    .sort((left, right) => right.hits.length - left.hits.length)
}

const getMatchedSignalLabels = (matches: SymptomSignalMatch[]) => {
  return unique(matches.map((item) => item.label))
}

const compatibleSecondarySignals: Record<string, string[]> = {
  lung_cancer: ['respiratory', 'cardiology_cardiothoracic'],
  nasopharyngeal_cancer: ['ent'],
  liver_cancer: ['gastroenterology'],
  cardiovascular_tumor: ['cardiology_cardiothoracic'],
  cardiology_cardiothoracic: ['respiratory', 'cardiovascular_tumor'],
  spine_surgery: ['orthopedics'],
  endocrinology_metabolism: ['gynecology'],
}

const getSelectedSignalKeys = (selectedKey: string) => {
  if (selectedKey === 'cardiovascular_tumor') return ['cardiovascular_tumor']
  return Object.entries(symptomSignalGroups)
    .filter(([, group]) => group.diseaseKey === selectedKey)
    .map(([key]) => key)
}

const getInferableDiseaseKey = (text: string, matchedSignals: SymptomSignalMatch[]) => {
  for (const match of matchedSignals) {
    const group = symptomSignalGroups[match.key]
    if (!group?.diseaseKey || !diseases[group.diseaseKey]) continue

    const inferKeywords = group.inferKeywords || group.keywords
    if (getPositiveKeywordHits(text, inferKeywords).length > 0) return group.diseaseKey
  }

  return undefined
}

const getOtherSignalMatches = (selectedKey: string, selectedSignalKeys: string[], text: string, matchedSignals: SymptomSignalMatch[]) => {
  const compatibleSignals = compatibleSecondarySignals[selectedKey] || []
  const normalized = normalizeText(text)
  const isCancerWithMetastasisContext =
    ['breast_cancer', 'lung_cancer', 'liver_cancer', 'nasopharyngeal_cancer'].includes(selectedKey) &&
    includesAny(text, ['转移', 'metastasis', 'metastases', '高代谢', 'PET/CT', 'petct', 'pet/ct'])
  const hasExplicitEndocrineDisease = includesAny(text, [
    '糖尿病',
    '血糖',
    '糖化血红蛋白',
    '甲状腺',
    '肥胖',
    '血脂',
    '尿酸',
    '痛风',
    '多囊',
    '胰岛素',
    '代谢综合征',
    '内分泌科',
  ])
  const metastaticSiteSignalKeys = new Set(['liver_cancer', 'lung_cancer', 'orthopedics', 'respiratory'])

  return matchedSignals.filter((item) => {
    if (selectedSignalKeys.includes(item.key) || item.diseaseKey === selectedKey) return false
    if (compatibleSignals.includes(item.key)) return false
    if (isCancerWithMetastasisContext && metastaticSiteSignalKeys.has(item.key)) return false
    if (isCancerWithMetastasisContext && item.diseaseKey && metastaticSiteSignalKeys.has(item.diseaseKey)) return false
    if (
      isCancerWithMetastasisContext &&
      item.key === 'endocrinology_metabolism' &&
      (!hasExplicitEndocrineDisease || normalized.includes(normalizeText('内分泌治疗')) || normalized.includes(normalizeText('雌激素受体')) || normalized.includes(normalizeText('孕激素受体')))
    ) return false

    if (selectedKey === 'other' && item.diseaseKey) {
      const group = symptomSignalGroups[item.key]
      return getPositiveKeywordHits(text, group.inferKeywords || group.keywords).length > 0
    }

    return true
  })
}

const getDiseaseMatch = (input: ReportSubmissionInput): DiseaseMatch => {
  const direct = diseases[input.basicInfo.visitPurpose]
  const requestedKey = direct ? input.basicInfo.visitPurpose : 'other'
  const requestedDisease = direct || defaultDisease
  const complaintText = getSubmittedComplaint(input)
  const matchedSignals = getMatchedSignals(complaintText)

  if (direct) {
    const selectedSignalKeys = getSelectedSignalKeys(input.basicInfo.visitPurpose)
    const selectedSignals = selectedSignalKeys.flatMap((key) => symptomSignalGroups[key]?.keywords || [])
    const selectedEvidence = getPositiveKeywordHits(complaintText, selectedSignals.length ? selectedSignals : direct.keywords)
    const otherSignalMatches = getOtherSignalMatches(input.basicInfo.visitPurpose, selectedSignalKeys, complaintText, matchedSignals)
    const otherSignals = unique([
      ...getMatchedSignalLabels(otherSignalMatches),
    ])

    return {
      key: input.basicInfo.visitPurpose,
      disease: direct,
      requestedKey,
      requestedDisease,
      mismatch: false,
      weakMatch: false,
      possibleDirections: [],
      secondaryDirections: otherSignals,
      selectedEvidence,
      detectedSignals: matchedSignals,
    }
  }

  return {
    key: 'other',
    disease: defaultDisease,
    requestedKey,
    requestedDisease,
    mismatch: false,
    weakMatch: false,
    possibleDirections: [],
    secondaryDirections: getMatchedSignalLabels(matchedSignals),
    selectedEvidence: [],
    detectedSignals: matchedSignals,
  }
}

const getRegionItems = (selectedRegions: string[]) => {
  return selectedRegions.flatMap((region) => regions[region] || regions.other)
}

const personalizeRegionItem = (region: KnowledgeRegion, context: ReportContext): KnowledgeRegion => {
  const { diseaseKey, personalization } = context

  if (personalization.mismatch) {
    return {
      ...region,
      fee: region.name === '其他目的地' ? '需按最终分诊科室和检查项目评估' : '先按资料复核、基础检查和专科预审评估；治疗费用待科室确认后再估算',
      tech: '重点比较综合分诊、资料复核、多学科转诊和危险信号排查能力，不宜按原选择科室直接比治疗方案',
      follow: '需先确认主责专科，再制定远程随访或跨境复诊方式',
    }
  }

  if (diseaseKey === 'dental') {
    return {
      ...region,
      fee: dentalComparableRegionFees[region.name] || '需按补牙、根管、拔牙、种植颗数、材料、预约翻译和停留生活评估',
      wait: region.wait.includes('周') ? region.wait : '通常1-3周，急性疼痛需先就近处理',
      tech: '重点比较CBCT评估、牙周/牙体牙髓处理、种植系统与牙冠材料透明度',
      follow: '种植和修复通常需要阶段性复诊，需提前确认远程随访和当地维护方式',
    }
  }

  if (diseaseKey === 'premium_checkup') {
    return {
      ...region,
      fee: region.name === '其他目的地' ? '需按体检套餐和筛查项目评估' : region.fee.replace(/\$[\d,]+ - \$[\d,]+/, '需按体检套餐评估'),
      tech: '重点比较影像设备、肿瘤早筛项目、胃肠镜质量控制和专家解读深度',
      follow: '体检后需确认异常结果复查、专科转诊和远程健康管理安排',
    }
  }

  if (['endocrinology_metabolism', 'cardiology_cardiothoracic'].includes(diseaseKey)) {
    return {
      ...region,
      fee: region.name === '其他目的地' ? '需按检查、用药和是否介入/手术评估' : `${region.fee}（若仅门诊评估通常低于完整治疗周期）`,
      tech: personalization.countryGuidance,
    }
  }

  return region
}

const getSpecialtyRules = (diseaseKey: string) => {
  const common = [
    '不要把科室标签直接当成诊断；必须说明仍需医生结合检查确认。',
    '治疗建议必须体现“先评估/确认关键问题，再决定治疗”的顺序。',
    '费用、周期和医院推荐必须围绕用户主诉，不要机械复用通用模板。',
  ]

  const rules: Record<string, string[]> = {
    dental: [
      '牙痛/蛀牙场景需先判断龋坏深度、牙髓感染、根尖炎或牙周问题；种植牙只应作为无法保留牙齿或已有缺牙后的修复选项。',
      '如有面部肿胀、发热、张口受限、吞咽困难，应提示先在当地紧急处理感染风险。',
      '费用应按补牙、根管、拔牙、CBCT、单颗/多颗种植、植骨、牙冠材料拆分。',
      '完整种植修复可能需要数月或多次往返；短期在华通常适合完成检查、止痛、补牙/根管/拔牙和方案确认。',
    ],
    breast_cancer: [
      '乳腺肿瘤场景需围绕病理类型、分期、受体状态、HER2、Ki-67、既往治疗和保乳/全切/系统治疗决策。',
      '不要承诺手术或疗效；如果主诉只提到肿块或筛查异常，应以确诊流程和病理复核为主。',
    ],
    lung_cancer: [
      '肺癌或肺结节场景需区分结节评估、确诊分期、基因检测、手术可行性、靶向/免疫/放疗路径。',
      '咯血、呼吸困难、胸痛加重等需提示先就近急诊或专科处理。',
    ],
    liver_cancer: [
      '肝脏肿瘤场景需关注增强影像、AFP、肝功能、乙肝/丙肝、Child-Pugh、是否适合手术/消融/介入/系统治疗。',
    ],
    nasopharyngeal_cancer: [
      '鼻咽癌场景需关注鼻咽镜病理、MRI分期、EBV DNA、放化疗周期、营养和口腔管理。',
    ],
    cardiology_cardiothoracic: [
      '心血管场景需区分慢病评估、冠脉介入、瓣膜/搭桥外科和康复；急性胸痛、呼吸困难、晕厥应先就近急诊。',
      '费用和周期需按“门诊评估/介入/外科手术/康复”分层。',
    ],
    cardiovascular_tumor: [
      '心血管肿瘤需先明确肿瘤位置、良恶性可能、心功能影响和手术风险，不应直接给治疗结论。',
    ],
    neurosurgery: [
      '神经外科场景需关注MRI/CTA、病灶位置、神经功能缺损、癫痫/头痛/意识变化和手术风险；急性偏瘫、意识障碍、抽搐应先急诊。',
    ],
    spine_surgery: [
      '脊柱场景需关注MRI/CT、神经压迫、肌力、麻木范围、大小便功能；出现马尾综合征表现应先急诊。',
      '不要默认手术，需比较保守治疗、微创和开放手术适应证。',
    ],
    endocrinology_metabolism: [
      '内分泌代谢场景需关注指标趋势、用药、并发症筛查、甲状腺/糖尿病/肥胖等具体问题。',
      '如果有酮症、严重低血糖、意识异常等应提示先就近处理。',
    ],
    premium_checkup: [
      '高端体检需根据年龄、性别、家族史、症状和关注点组合项目，不要生成泛泛套餐。',
      '异常结果应明确后续专科复查路径，而不是停留在体检本身。',
    ],
    other: [
      '综合评估场景需先识别最可能的专科方向、危险信号和下一步资料清单，不要假装已明确诊断。',
      '如果存在所选科室与症状描述不一致，必须在报告前部明确提示重新确认科室，不要沿用用户所选科室硬生成治疗方案。',
    ],
  }

  return [...common, ...(rules[diseaseKey] || rules.other)]
}

const buildPersonalization = (input: ReportSubmissionInput, match: DiseaseMatch): CasePersonalization => {
  const complaint = getComplaintForReport(input, match.requestedDisease.label)
  const text = `${match.key} ${match.disease.label} ${complaint}`.toLowerCase()
  const urgentSignals = [
    ['发热', '肿胀', '张口受限', '吞咽困难', '牙疼明显', '剧痛', '脓肿'],
    ['胸痛', '呼吸困难', '晕厥', '咯血', '心悸加重'],
    ['偏瘫', '意识', '抽搐', '大小便障碍', '肌力下降'],
    ['大出血', '持续呕吐', '黄疸加重', '低血糖', '酮症'],
  ].flat()
  const hasUrgentSignal = includesAny(text, urgentSignals)
  const hasPain = includesAny(text, ['疼', '痛', 'pain'])
  const hasSurgery = includesAny(text, ['手术', '切除', '微创', '搭桥', '瓣膜', '拔除', '拔牙'])
  const hasImplant = includesAny(text, ['种植', 'implant'])
  const hasCancer = includesAny(text, ['癌', '肿瘤', '结节', '病理', '化疗', '放疗', '靶向', '免疫'])
  const hasCheckup = includesAny(text, ['体检', '筛查', '早筛', '风险'])
  const careNeedLabel = getCareNeedLabel(input.basicInfo.careNeed, input.basicInfo.careNeedOther)
  const expectedTreatmentTimeLabel = getExpectedTreatmentTimeLabel(input.basicInfo.expectedTreatmentTime)
  const consultOnly = input.basicInfo.expectedTreatmentTime === 'consult_only'
  const specialtyRules = getSpecialtyRules(match.key)
  const detectedSignals = (match.detectedSignals || []).map((item) => `${item.label}：${item.hits.slice(0, 4).join('、')}`)

  const requiredByDisease: Record<string, string[]> = {
    dental: ['口腔全景片或CBCT', '根尖片/牙周检查记录', '明确疼痛牙位、冷热刺激痛和夜间痛情况', '既往补牙/根管/拔牙/种植记录', '药物过敏史和正在使用药物'],
    breast_cancer: ['病理报告和免疫组化', '乳腺超声/钼靶/MRI', '分期检查资料', '既往手术、化疗、放疗和内分泌治疗记录'],
    lung_cancer: ['胸部CT原始影像', '病理报告', '基因检测/PD-L1结果', '分期检查资料', '既往治疗和用药记录'],
    liver_cancer: ['肝脏增强MRI/CT', 'AFP等肿瘤标志物', '肝功能和凝血功能', '乙肝/丙肝病毒学资料', '既往介入/消融/系统治疗记录'],
    nasopharyngeal_cancer: ['鼻咽镜和病理报告', '头颈部MRI', 'EBV DNA', '分期资料', '既往放化疗记录'],
    cardiology_cardiothoracic: ['心电图', '心脏超声', '冠脉CTA或造影', '心功能指标', '当前用药和既往介入/手术记录'],
    cardiovascular_tumor: ['心脏超声', '增强CT/MRI', '肿瘤位置和范围资料', '心功能评估', '既往病理或穿刺结果'],
    neurosurgery: ['头颅/脊髓MRI原始影像', 'CTA/MRA或功能影像', '神经功能评估', '发作频率和症状变化记录', '既往手术/放疗资料'],
    spine_surgery: ['脊柱MRI/CT', '疼痛和麻木范围', '肌力和反射检查', '大小便功能情况', '既往保守治疗和手术记录'],
    endocrinology_metabolism: ['近期血糖/糖化血红蛋白或相关指标趋势', '甲状腺/激素/代谢检查', '并发症筛查资料', '当前用药和剂量', '生活方式和体重变化记录'],
    premium_checkup: ['年龄、家族史和既往病史', '既往体检异常结果', '重点关注器官或疾病风险', '用药和过敏史', '是否需要胃肠镜/影像/肿瘤早筛'],
    other: ['既往检查报告', '近期影像或化验资料', '症状出现时间和变化', '既往诊断与治疗记录', '当前最想解决的问题'],
  }

  const decisionByDisease: Record<string, string[]> = {
    dental: [
      hasImplant ? '先判断患牙是否还能保留，再决定是否进入拔牙后种植路径' : '先明确牙痛来自龋坏、牙髓/根尖感染还是牙周问题',
      '比较补牙、根管治疗、拔牙、临时修复和种植修复的先后顺序',
      '确认种植是否需要植骨、上颌窦提升或牙周基础治疗',
    ],
    premium_checkup: ['根据用户关注点定制筛查项目', '异常结果的专科复查路径', '体检效率、解释质量和后续管理'],
    endocrinology_metabolism: ['明确指标异常的主因和风险等级', '评估用药调整和并发症筛查', '建立可远程追踪的慢病管理方案'],
    cardiology_cardiothoracic: ['判断是否仅需门诊评估、介入治疗或外科手术', '评估心功能和围术期风险', '制定术后/治疗后康复与复诊计划'],
    spine_surgery: ['判断神经压迫程度和是否有手术指征', '比较保守、微创和开放手术路径', '制定术后康复和复查计划'],
    neurosurgery: ['明确病灶性质和手术风险', '评估是否需要显微手术、放射外科或观察随访', '判断症状是否存在急性风险'],
    other: ['识别最优先专科方向', '排除需要急诊处理的危险信号', '形成下一步检查和专家预审路径'],
  }

  const decisionPoints = unique([
    careNeedLabel ? `回应用户就医诉求：${careNeedLabel}` : '',
    expectedTreatmentTimeLabel ? `按期望治疗时间“${expectedTreatmentTimeLabel}”调整预审节奏和出行建议` : '',
    match.mismatch ? '先重新确认就诊科室和主要问题，不建议按原选择科室直接生成治疗方案' : '',
    match.weakMatch ? `用户选择了${match.requestedDisease.label}，但主诉缺少该科室的典型关键词，需先补充诊断、检查或既往医生意见` : '',
    match.secondaryDirections?.length ? `同时排查是否合并${match.secondaryDirections.slice(0, 2).join('、')}相关问题` : '',
    ...(decisionByDisease[match.key] || []),
    hasSurgery ? '判断是否真的需要手术，以及手术前还缺哪些证据' : '',
    hasCancer ? '明确病理、分期和既往治疗后再比较治疗方案' : '',
    hasCheckup ? '把体检项目和用户实际风险点绑定，而不是使用固定套餐' : '',
  ]).slice(0, 5)

  const planPriorities = unique([
    careNeedLabel ? `围绕“${careNeedLabel}”组织诊疗路径和专家预审问题` : '',
    consultOnly ? '用户当前仅咨询方案，报告应以远程资料预审、第二意见和后续决策清单为主，不直接推动赴华排期' : '',
    expectedTreatmentTimeLabel && !consultOnly ? `按“${expectedTreatmentTimeLabel}”倒排资料补全、专家预审和出行准备` : '',
    match.mismatch ? '所选科室与症状描述不一致，先做综合分诊和危险信号排查' : '',
    match.weakMatch ? '主诉与所选科室关联信息不足，先做资料补全和专科预审，再进入治疗比较' : '',
    match.secondaryDirections?.length ? `症状中还出现${match.secondaryDirections.slice(0, 2).join('、')}信号，报告需避免单一科室过度推断` : '',
    hasUrgentSignal ? '如症状提示急性风险，应先在当地急诊或专科就近处理，再安排跨境评估' : '',
    hasPain ? '先处理疼痛来源和短期风险，再讨论长期治疗方案' : '',
    ...decisionPoints,
  ]).slice(0, 5)

  const urgencyNote = hasUrgentSignal
    ? '用户描述中可能包含急性或进展性风险信号，报告需提示先排除急症，不能只给跨境就医安排。'
    : '当前信息未显示明确急症信号，但仍需由医生结合检查确认风险等级。'

  return {
    complaint,
    caseSummary: complaint.length > 80 ? `${complaint.slice(0, 78)}...` : complaint,
    mismatch: match.mismatch,
    weakMatch: Boolean(match.weakMatch),
    mismatchReason: match.mismatchReason,
    possibleDirections: match.possibleDirections || [],
    secondaryDirections: match.secondaryDirections || [],
    selectedEvidence: match.selectedEvidence || [],
    detectedSignals,
    reportDiseaseLabel: match.requestedKey === 'other' && match.key !== 'other' && !match.mismatch ? `${match.disease.label}方向` : match.disease.label,
    requestedDepartment: match.requestedDisease.label,
    urgentRisk: hasUrgentSignal,
    urgencyNote,
    decisionPoints,
    requiredMaterials: unique([...(requiredByDisease[match.key] || requiredByDisease.other)]).slice(0, 6),
    planPriorities,
    costGuidance: '费用必须按用户可能发生的检查、治疗、材料、住院/住宿、翻译陪诊等项目拆分；如无法判断治疗强度，应写成分层区间而不是单一大包价。',
    countryGuidance: '国家对比必须围绕当前主诉和专科需求；若通用地区费用不适合该科室，应改写为按项目评估或给出更审慎的项目型费用描述。',
    specialtyRules: unique([
      ...specialtyRules,
      careNeedLabel ? `报告必须回应用户就医诉求“${careNeedLabel}”，并影响治疗目标、医院/专家匹配、费用拆分和下一步行动。` : '',
      expectedTreatmentTimeLabel ? `报告必须按期望治疗时间“${expectedTreatmentTimeLabel}”调整时间线；如果仅咨询方案，不应写成立即赴华安排。` : '',
    ]),
  }
}

const estimateScore = (disease: typeof defaultDisease, input: ReportSubmissionInput, personalization?: CasePersonalization) => {
  if (personalization?.mismatch) return 58

  let score = disease.score
  if (input.selectedRegions.includes('north_america') || input.selectedRegions.includes('europe')) score += 2
  if (getSubmittedComplaint(input).length > 80) score += 2
  if (input.basicInfo.visitPurpose === 'other') score -= 8
  return Math.max(60, Math.min(92, score))
}

const buildFreeLayoutSections = (report: GeneratedReport, context: ReportContext): ReportLayoutSection[] => {
  const { personalization, medicalFacts } = context
  const metastaticBreastRecordSummary = isMetastaticBreastFreeCase(context)
    ? buildMetastaticBreastFreeRecordSummary(context)
    : null
  const countryRows = report.countries.map((country) => ({
    cells: [
      `${country.flag} ${country.name}`,
      country.fee,
      country.wait,
      country.tech,
      country.service,
      country.follow,
    ],
    highlight: Boolean(country.recommended),
  }))
  const costRows = report.plan.breakdown.map((item) => ({ cells: [item.item, item.cost] }))
  const nextStepItems = [
    `补充资料：${personalization.requiredMaterials.slice(0, 4).join('、') || '近期检查和既往治疗资料'}`,
    `核心医学判断：${personalization.decisionPoints[0] || '明确主责专科和治疗优先级'}`,
    '确认预算、保险预授权要求和希望来华城市。',
    '进入专业版后上传原始资料，由系统生成更完整的专家预审和行程方案。',
  ]
  const paymentAndInsuranceItems = report.paymentAndInsurance?.length
    ? report.paymentAndInsurance
    : [
      '按医院正式报价、平台服务项目、住宿交通和翻译陪诊分项确认预算，避免只看单一治疗包价格。',
      '如持有国际商业保险，建议在出行前向保险公司确认中国医院网络、预授权、直付或事后理赔材料要求。',
      '准备诊断证明、医生治疗计划、费用预估、发票抬头和英文/中文医学翻译件，用于预授权或理赔沟通。',
    ]
  const proUpgradeItems = [
    ...report.highlights.slice(0, 5),
    ...personalization.requiredMaterials.slice(0, 3).map((item) => `补充${item}后，可进一步完善费用区间、治疗先后顺序和出行安排。`),
    `专业版会围绕“${personalization.decisionPoints[0] || '下一步关键诊疗问题'}”进行医生复核前的结构化预审。`,
  ]
  const medicalFactTimeline = medicalFacts.timeline.slice(0, 8).map((event) => ({
    time: event.date,
    title: `${event.reportType} · ${event.title}`,
    description: getDisplayClinicalEvidenceItems([event.description], 1, 220)[0] || '该节点已识别到医学资料变化，需医生结合原件复核。',
    items: getDisplayClinicalEvidenceItems(event.items, 4, 160).length
      ? getDisplayClinicalEvidenceItems(event.items, 4, 160)
      : [`来源：${event.fileName}`],
  }))
  const medicalFactCards = medicalFacts.documents.length
    ? medicalFacts.documents.slice(0, 6).map((document) => ({
      title: document.reportType,
      subtitle: document.primaryDate || document.fileName,
      value: `置信度 ${Math.round(document.confidence * 100)}%`,
      description: getDisplayClinicalEvidenceItems(document.sourceEvidence, 2, 180).join('；') || '未识别到明确医学事实，需人工复核原件。',
      detail: `来源：${document.fileName}`,
      tone: document.confidence >= 0.65 ? 'highlight' : 'warning',
    }))
    : []
  const recordSection: ReportLayoutSection = {
    key: 'records',
    label: '上传资料解读',
    labelEn: 'Uploaded Record Review',
    icon: 'FileSearch',
    summary: medicalFacts.hasActionableFacts
      ? metastaticBreastRecordSummary
        ? '已基于上传病理、影像和PET/CT资料识别出乳腺癌术后复发/转移方向的核心线索。'
        : '系统已从上传资料中提取日期、报告类型、关键指标和病情线索。'
      : '上传资料暂未识别出足够医学事实，当前报告主要基于表单信息。',
    blocks: [
      {
        type: 'notice',
        title: '核心资料结论',
        description: medicalFacts.hasActionableFacts
          ? metastaticBreastRecordSummary?.summary || medicalFacts.summary
          : '未能从上传资料中提取足够可用医学事实，建议上传清晰图片/PDF原文，或在表单中补充病理、影像和既往治疗摘要。',
        items: medicalFacts.qualityFlags.length
          ? medicalFacts.qualityFlags
          : metastaticBreastRecordSummary?.items || getDisplayClinicalEvidenceItems(medicalFacts.evidenceHighlights, 5, 220),
        tone: medicalFacts.hasActionableFacts ? 'highlight' : 'warning',
      },
      ...(medicalFactTimeline.length ? [{
        type: 'timeline' as const,
        title: '病情时间线',
        timeline: medicalFactTimeline,
      }] : []),
      ...(medicalFactCards.length ? [{
        type: 'cards' as const,
        title: '资料分项识别',
        cards: medicalFactCards,
      }] : []),
    ],
  }

  return [
    ...(context.input.uploadedFiles.length || medicalFacts.hasActionableFacts ? [recordSection] : []),
    {
      key: 'cost',
      label: '全球该疾病费用对比',
      labelEn: 'Global Cost Comparison',
      icon: 'Globe',
      summary: '费用为预估区间，需结合病情、检查结果、医院报价和治疗强度复核。',
      blocks: [
        {
          type: 'summary',
          title: '费用节省与预算定位',
          metrics: [
            { label: '中国预估总费用', value: report.plan.totalCost, detail: report.plan.duration, tone: 'highlight' },
            { label: '可行性评分', value: `${report.score}/100`, detail: report.disease },
            { label: '主要诉求', value: report.need.slice(0, 48), detail: report.need.length > 48 ? report.need.slice(48, 120) : undefined },
          ],
        },
        {
          type: 'table',
          title: '国家/地区费用、等待和服务对比',
          table: {
            columns: ['国家/地区', '费用', '等待', '技术重点', '服务', '随访'],
            rows: countryRows,
          },
        },
      ],
    },
    {
      key: 'technology',
      label: '全球治疗价值对比',
      labelEn: 'Global Treatment Value Comparison',
      icon: 'Sparkles',
      summary: '以下对比仅作预审参考，最终以医生面诊、资料复核和医院正式方案为准。',
      blocks: [
        {
          type: 'table',
          title: '全维度价值对比',
          table: {
            columns: ['方案', '技术/能力', '国际患者服务', '后续管理'],
            rows: report.countries.map((country) => ({
              cells: [`${country.flag} ${country.name}`, country.tech, country.service, country.follow],
              highlight: Boolean(country.recommended),
            })),
          },
        },
        {
          type: 'list',
          title: '本例需要重点核对的医疗能力',
          items: personalization.decisionPoints,
        },
      ],
    },
    {
      key: 'outcome',
      label: '我们为什么推荐中国',
      labelEn: 'Why China Is Worth Considering',
      icon: 'TrendingUp',
      summary: '本节仅做风险和决策参考，不承诺治愈率或具体治疗结果。',
      blocks: [
        {
          type: 'cards',
          title: '中国方案的核心优势',
          cards: report.advantages.map((item) => ({
            title: item.label,
            description: item.value,
            tone: item.label.includes('需确认') ? 'warning' : 'default',
          })),
        },
        {
          type: 'notice',
          title: '适用前提与医学审慎提示',
          description: personalization.urgencyNote,
          items: personalization.specialtyRules.slice(0, 4),
          tone: personalization.urgentRisk ? 'danger' : 'warning',
        },
      ],
    },
    {
      key: 'feasibility',
      label: '风险里程碑：同样治疗，价格差异大',
      labelEn: 'Risk Milestones & Cost Difference',
      icon: 'FileText',
      blocks: [
        {
          type: 'summary',
          title: '预算、风险和决策窗口',
          metrics: [
            { label: '中国预估总费用', value: report.plan.totalCost, detail: report.plan.duration, tone: 'highlight' },
            { label: '可行性评分', value: `${report.score}/100`, detail: report.score >= 80 ? '具备较高预审价值' : '需先补充资料或重新分诊', tone: report.score >= 80 ? 'highlight' : 'warning' },
            { label: '匹配方向', value: report.disease, detail: report.treatment.slice(0, 120) },
          ],
        },
        {
          type: 'table',
          title: '费用明细预估',
          table: {
            columns: ['项目', '预估区间'],
            rows: costRows,
          },
        },
        {
          type: 'table',
          title: '主要风险与应对方式',
          table: {
            columns: ['顾虑', '解决方案'],
            rows: report.concerns.map((item) => ({ cells: [item.concern, item.solution] })),
          },
        },
      ],
    },
    {
      key: 'next',
      label: '未来就诊与需要资料',
      labelEn: 'Preparation Materials & Next Steps',
      icon: 'Footprints',
      blocks: [
        {
          type: 'timeline',
          title: '就诊前准备节奏',
          timeline: nextStepItems.map((item, index) => ({
            time: `Step ${index + 1}`,
            title: item,
          })),
        },
        {
          type: 'list',
          title: '建议优先补充的资料',
          items: personalization.requiredMaterials,
        },
      ],
    },
    {
      key: 'payment',
      label: '支付与保险准备',
      labelEn: 'Payment & Insurance Preparation',
      icon: 'Shield',
      summary: '本节为预算和保险沟通清单，不构成保险报销承诺。',
      blocks: [
        {
          type: 'notice',
          title: '支付与保险确认清单',
          description: '来华前建议先确认支付路径、预授权材料和理赔口径，避免抵达后因材料不齐影响预约或结算。',
          items: paymentAndInsuranceItems,
          tone: 'warning',
        },
      ],
    },
    {
      key: 'upgrade',
      label: '获取包含个人病情的专业评估',
      labelEn: 'Upgrade for a Personalized Professional Report',
      icon: 'Sparkles',
      blocks: [
        {
          type: 'cards',
          title: '专业评估服务包',
          cards: report.packages.map((pkg) => ({
            title: pkg.name,
            subtitle: pkg.subtitle,
            value: pkg.price,
            description: (pkg.featureDetails?.length
              ? pkg.featureDetails.map((feature) => feature.label).join('；')
              : pkg.features.join('；')),
            detail: pkg.footnote,
            tag: pkg.badge,
            tone: pkg.highlight ? 'highlight' : 'default',
          })),
        },
        {
          type: 'list',
          title: '升级后重点补强',
          items: proUpgradeItems,
        },
      ],
    },
  ]
}

const withFreeLayoutSections = (report: GeneratedReport, context: ReportContext): GeneratedReport => ({
  ...report,
  layoutSections: buildFreeLayoutSections(report, context),
})

const buildRuleReport = (context: ReportContext): GeneratedReport => {
  const { disease, diseaseKey, input, personalization, selectedRegionItems, submissionNo, dateLabel } = context
  const countries = [chinaCountry(disease, personalization), ...selectedRegionItems.map((item) => personalizeRegionItem(item, context))]
  const score = estimateScore(disease, input, personalization)
  const selectedNames = selectedRegionItems.map((item) => item.name).join('、') || '所选目的地'
  const firstDecision = personalization.decisionPoints[0] || '明确下一步诊疗方向'
  const firstMaterial = personalization.requiredMaterials.slice(0, 3).join('、')
  const direction = [
    ...personalization.planPriorities,
    disease.direction,
  ].slice(0, 4).join(' -> ')
  const matchLabel = personalization.mismatch
    ? '科室选择需确认'
    : personalization.weakMatch
      ? '所选科室信息不足'
      : '当前主诉匹配'
  const matchValue = personalization.mismatch
    ? (personalization.mismatchReason || '所选科室与症状描述不完全一致，建议先重新分诊')
    : personalization.weakMatch
      ? `用户选择了“${personalization.requestedDepartment}”，但主诉中缺少典型相关信息；需结合${firstMaterial || '检查资料'}确认是否适合该科室。`
      : `${disease.label}方向匹配度约${score}/100，但需结合${firstMaterial || '补充资料'}确认`
  const metastaticBreastEnhancement = !personalization.mismatch && isMetastaticBreastFreeCase(context)
    ? buildMetastaticBreastFreeEnhancement(context)
    : null
  const specialtyEnhancement = !metastaticBreastEnhancement ? buildSpecialtyFreeEnhancement(context) : null
  const baseDuration = diseaseKey === 'dental' && personalization.complaint.includes('种植')
    ? '短期可在华完成检查、止痛、补牙/根管/拔牙和种植评估；完整种植修复通常需数月或多次往返'
    : disease.duration

  return finalizeReportCosts({
    id: submissionNo,
    date: dateLabel,
    subtitle: '来华就医可行性预审报告',
    disease: personalization.mismatch ? '综合分诊评估' : personalization.reportDiseaseLabel,
    treatment: personalization.mismatch
      ? `${personalization.mismatchReason} 本次报告先按综合分诊处理，重点识别可能方向、危险信号和下一步资料清单。`
      : metastaticBreastEnhancement?.treatment || specialtyEnhancement?.treatment || `${disease.treatment}（围绕用户主诉先判断：${firstDecision}）`,
    need: getNeedForReport(context),
    countries,
    score,
    advantages: [
      ...(personalization.mismatch
        ? [{ label: '科室选择需确认', value: personalization.mismatchReason || '所选科室与症状描述不完全一致，建议先重新分诊' }]
        : []),
      { label: matchLabel, value: matchValue },
      { label: '下一步关键判断', value: firstDecision },
      { label: '费用与效率', value: `需按实际检查和治疗强度分层估算；中国方案相较${selectedNames}可优先做专家预审和路径确认` },
    ],
    concerns: [
      ...(metastaticBreastEnhancement?.concerns || []),
      ...(specialtyEnhancement?.concerns || []),
      ...(personalization.mismatch
        ? [{ concern: '所选科室与症状不一致', solution: `建议先确认主要问题是否属于${personalization.possibleDirections.join('、') || '其他专科'}，不要直接按“${personalization.requestedDepartment}”安排治疗。` }]
        : []),
      ...(personalization.weakMatch
        ? [{ concern: '主诉与所选科室关联信息不足', solution: `建议补充已确诊名称、异常检查、医生判断或关键症状；报告暂按“${personalization.requestedDepartment}”预审，但不把科室选择等同于诊断。` }]
        : []),
      ...(personalization.secondaryDirections.length
        ? [{ concern: '存在其他科室信号', solution: `症状中还出现${personalization.secondaryDirections.join('、')}相关线索，需确认是否合并问题或是否需要先转对应专科。` }]
        : []),
      { concern: '当前信息仍不足以直接定方案', solution: `建议补充${firstMaterial || '近期检查资料和既往治疗记录'}，由对应专科判断治疗优先级` },
      { concern: '急性风险排除', solution: personalization.urgencyNote },
      { concern: '语言沟通', solution: '建议配置医学翻译和就医管家，减少跨科室沟通误差' },
      { concern: '治疗连续性', solution: `出发前需围绕“${firstDecision}”确认分阶段治疗、回国维护和远程复诊方式` },
      { concern: '资料完整度影响判断', solution: `建议补充${firstMaterial || '关键检查资料'}，由医生复核后再确认费用、医院和治疗顺序。` },
    ],
    hospitals: disease.hospitals,
    plan: {
      direction: metastaticBreastEnhancement?.plan.direction || specialtyEnhancement?.plan.direction || direction,
      duration: metastaticBreastEnhancement?.plan.duration || specialtyEnhancement?.plan.duration || baseDuration,
      totalCost: metastaticBreastEnhancement?.plan.totalCost || specialtyEnhancement?.plan.totalCost || disease.chinaFee,
      breakdown: metastaticBreastEnhancement?.plan.breakdown || specialtyEnhancement?.plan.breakdown || disease.breakdown,
    },
    packages,
    paymentAndInsurance: [
      '建议先按医院正式报价、平台服务项目、翻译陪诊、住宿交通和复诊随访分项确认预算。',
      '如持有国际商业保险，需向保险公司确认中国医院是否在网络内、是否需要预授权、是否支持直付或事后理赔。',
      '建议准备诊断证明、治疗计划、费用预估、发票明细和医学翻译件；实际报销以保险公司书面回复为准。',
    ],
    highlights: [
      ...(metastaticBreastEnhancement?.highlights || []),
      ...(specialtyEnhancement?.highlights || []),
      ...disease.advantages,
      `围绕“${firstDecision}”做专家人工复核`,
      `优先核对${firstMaterial || '关键检查资料'}后再出行`,
      '按检查、治疗、材料和随访阶段拆分费用',
    ],
    disclaimer: '本报告为基于用户提交信息和平台知识库生成的来华就医可行性预审，不构成诊断、处方或最终治疗建议。最终方案需以执业医生面诊、检查结果和医院正式意见为准。',
    generatedBy: 'rules',
  }, context)
}

const truncateForPrompt = (text: string, maxLength: number) => {
  if (text.length <= maxLength) return text
  return `${text.slice(0, maxLength)}...`
}

const compactPatientInputForPrompt = (input: ReportSubmissionInput) => ({
  locale: input.locale,
  basicInfo: {
    ...input.basicInfo,
    careNeedLabel: getCareNeedLabel(input.basicInfo.careNeed, input.basicInfo.careNeedOther),
    expectedTreatmentTimeLabel: getExpectedTreatmentTimeLabel(input.basicInfo.expectedTreatmentTime),
    chiefComplaint: truncateForPrompt(input.basicInfo.chiefComplaint, 700),
  },
  selectedRegions: input.selectedRegions,
  hasUploadedMedicalRecords: input.uploadedFiles.length > 0,
  uploadedFiles: input.uploadedFiles.map((file) => ({
    fieldName: file.fieldName,
    originalName: file.originalName,
    mimeType: file.mimeType,
    size: file.size,
  })),
  parsedFiles: input.parsedFiles.map((file) => ({
    originalName: file.originalName,
    status: file.status,
    summary: truncateForPrompt(file.summary, 220),
    medicalFacts: compactDocumentFactForPrompt(file.metadata?.medicalFacts as MedicalDocumentFact | undefined),
  })),
})

const compactDocumentFactForPrompt = (document?: MedicalDocumentFact) => document ? ({
  reportType: document.reportType,
  primaryDate: document.primaryDate,
  diagnoses: document.diagnoses.slice(0, 3),
  indicators: document.indicators.slice(0, 6),
  metastasisSignals: document.metastasisSignals.slice(0, 6),
  evidence: document.sourceEvidence.slice(0, 4),
  confidence: document.confidence,
}) : undefined

const compactMedicalFactsForPrompt = (bundle: MedicalFactBundle) => ({
  summary: bundle.summary,
  diseaseSignals: bundle.diseaseSignals,
  qualityFlags: bundle.qualityFlags,
  timeline: bundle.timeline.slice(0, 10),
  documents: bundle.documents.map((document) => ({
    fileName: document.fileName,
    reportType: document.reportType,
    primaryDate: document.primaryDate,
    diagnoses: document.diagnoses.slice(0, 4),
    indicators: document.indicators.slice(0, 8),
    metastasisSignals: document.metastasisSignals,
    evidence: document.sourceEvidence.slice(0, 6),
    confidence: document.confidence,
  })).slice(0, 8),
})

const compactDocumentKnowledgeForPrompt = (blocks: DocumentKnowledgeBlock[]) => blocks
  .slice(0, 4)
  .map((block) => ({
    category: block.category,
    diseaseKeys: block.diseaseKeys.slice(0, 6),
    guidance: truncateForPrompt(block.guidance, 420),
    evidenceSummary: truncateForPrompt(block.evidenceSummary, 260),
    keywords: block.keywords.slice(0, 10),
  }))

const compactDiseaseForPrompt = (disease: KnowledgeDisease) => ({
  label: disease.label,
  treatment: disease.treatment,
  direction: disease.direction,
  duration: disease.duration,
  chinaFee: disease.chinaFee,
  score: disease.score,
  advantages: disease.advantages.slice(0, 5),
  hospitals: disease.hospitals.slice(0, 4),
  breakdown: disease.breakdown.slice(0, 8),
  keywords: disease.keywords.slice(0, 10),
})

const compactRuleReportForPrompt = (report: GeneratedReport) => ({
  id: report.id,
  date: report.date,
  subtitle: report.subtitle,
  disease: report.disease,
  treatment: report.treatment,
  need: truncateForPrompt(report.need, 700),
  countries: report.countries.map((country) => ({
    flag: country.flag,
    name: country.name,
    fee: country.fee,
    wait: country.wait,
    tech: truncateForPrompt(country.tech, 120),
    service: truncateForPrompt(country.service, 120),
    visa: country.visa,
    follow: truncateForPrompt(country.follow, 120),
    recommended: country.recommended,
  })),
  score: report.score,
  advantages: report.advantages,
  concerns: report.concerns,
  hospitals: report.hospitals,
  plan: report.plan,
  packages: report.packages,
  highlights: report.highlights,
  disclaimer: report.disclaimer,
  generatedBy: report.generatedBy,
})

const buildPatchPrompt = (
  context: ReportContext,
  ruleReport: GeneratedReport,
  previousError?: string,
): MedicalLlmMessage[] => {
  const { input, disease, diseaseKey, personalization, medicalFacts, documentKnowledge } = context
  const careNeedLabel = getCareNeedLabel(input.basicInfo.careNeed, input.basicInfo.careNeedOther)
  const expectedTreatmentTimeLabel = getExpectedTreatmentTimeLabel(input.basicInfo.expectedTreatmentTime)

  return [
    {
      role: 'system',
      content: [
        '/no_think',
        '你是寰宇云医简易预审报告的医学内容生成助手。',
        '请根据用户全部输入和页面展示字段需求，直接返回简易报告结构化 JSON 数据。',
        '页面需要展示的医学判断、医院推荐、服务包说明和行动建议都应由你生成；后端只做字段兼容、金额格式化、确定性求和和缺项重试。',
        '用户选择的就医方向只是输入信息之一，不要被后端规则模板限制；请结合主诉、诉求、期望时间、地区偏好和资料摘要自行判断表达方式。',
        '如果用户已提供明确诊断、症状、检查线索或治疗诉求，不能把 disease、treatment、advantages、concerns、plan.direction 写成“资料不足”“待医生确认”“暂不生成”。',
        '资料限制应写成需补充资料和医生复核动作，但核心报告必须给出基于现有信息的审慎预审方向。',
        '不得编造检查数值、上传报告内容、确定诊断、医生姓名、疗效承诺或具体处方。',
        '简易报告没有上传医疗报告时，不得出现“上传资料提示、已读取上传、从报告可见”等表达。',
        '不要推理，不要解释，直接输出严格 JSON；不要 Markdown。',
      ].join('\n'),
    },
    {
      role: 'user',
      content: `/no_think\n${JSON.stringify({
        task: '按页面展示需求生成简易报告结构化 JSON',
        previousError: previousError
          ? `上一次输出未通过质量校验：${previousError}。请重新输出完整主报告 JSON，尤其补齐 disease、treatment、advantages、concerns、hospitals、packages、highlights、plan。`
          : '',
        requiredTopLevelKeys: [
          'disease',
          'treatment',
          'countries',
          'advantages',
          'concerns',
          'hospitals',
          'packages',
          'highlights',
          'plan',
          'paymentAndInsurance',
        ],
        requiredPlanKeys: [
          'direction',
          'duration',
          'totalCost',
          'breakdown',
        ],
        allowedPatchFields: [
          'disease',
          'treatment',
          'countries',
          'advantages',
          'concerns',
          'hospitals',
          'packages',
          'highlights',
          'plan.direction',
          'plan.duration',
          'plan.totalCost',
          'plan.breakdown',
          'paymentAndInsurance',
        ],
        outputSchema: {
          disease: '必填，简短方向名称，不超过16个汉字',
          treatment: '必填，建议120-260字，回应用户主诉、当前限制、下一步医学判断并保持医学审慎',
          countries: '必填，沿用 baselineRuleReport.countries 的国家/地区和 flag，可重写 fee/wait/tech/service/visa/follow/recommended',
          advantages: '必填，3-5项，每项 {label,value}，体现中国方案价值、资料限制和下一步判断',
          concerns: '必填，4-7项，每项 {concern,solution}，覆盖资料不足、急症排除、费用波动、治疗连续性等',
          hospitals: [
            '必填，非牙科3项；牙科只允许1项鼎植口腔。',
            '每项至少包含 {city,name,reason}，reason 必须解释为何匹配当前主诉。',
            '必须同时返回用于前端展开详情的字段：',
            '{englishName,department,matchScore,rankLabel,tags,internationalPatients,waitTime,detailItems,preparation}。',
            'matchScore 必须是0-100整数，表达当前病例适配度而不是医院绝对排名。',
            '不要轻易省略匹配数据；能基于病种、主诉、地区和通用专科能力给出审慎区间判断时，matchScore、waitTime、internationalPatients 应尽量返回，并用“约/通常/需预审确认”标注不确定性。',
            '数据要有决策价值，不能过度宽泛；matchScore 要体现医院之间的相对适配差异，waitTime/internationalPatients 能给量级或区间就不要只写“需确认”。',
            'rankLabel/tags 可写专科优势、中心资质、区域优势或能力标签；internationalPatients/waitTime 可给区间、量级或“需预审确认”，不要编造精确数字。',
            'detailItems 用于展开详情，至少4项，必须包含“适配理由、建议科室、预审重点、需准备资料”；不要编造医生姓名、确切手术量、保乳率或号源承诺。',
          ].join(' '),
          packages: [{
            name: '基础评估包 / Basic',
            subtitle: '结合当前病例的短句，非空',
            price: '$xx',
            originalPrice: '￥xx',
            icon: 'FileText',
            highlight: false,
            features: ['恰好3条短摘要', '每条不超过18字', '必须结合病例'],
            featureDetails: [
              { label: '至少6项明细', status: 'included' },
              { label: '治疗路径初步判断', status: 'included' },
              { label: '医院方向建议', status: 'included' },
              { label: '费用区间提示', status: 'included' },
              { label: '不含视频面诊', status: 'excluded' },
              { label: '不含指定专家预约', status: 'excluded' },
            ],
            footnote: '结合当前病例的脚注，非空',
          }, {
            name: '标准面诊包 / Standard',
            subtitle: '结合当前病例的短句，非空',
            price: '$xx',
            originalPrice: '￥xx',
            icon: 'Video',
            highlight: true,
            features: ['恰好3条短摘要', '每条不超过18字', '必须结合病例'],
            featureDetails: [
              { label: '专家视频面诊', status: 'emphasis' },
              { label: '病历资料整理', status: 'included' },
              { label: '医院匹配建议', status: 'included' },
              { label: '费用与时间线复核', status: 'included' },
              { label: '面诊后答疑', status: 'emphasis' },
              { label: '不含MDT多学科会诊', status: 'excluded' },
            ],
            footnote: '结合当前病例的脚注，非空',
          }, {
            name: '深度面诊包 / Premium',
            subtitle: '结合当前病例的短句，非空',
            price: '$xx',
            originalPrice: '￥xx',
            icon: 'MessageSquare',
            highlight: false,
            features: ['恰好3条短摘要', '每条不超过18字', '必须结合病例'],
            featureDetails: [
              { label: 'MDT多学科会诊', status: 'emphasis' },
              { label: '多医院方案比较', status: 'included' },
              { label: '指定专家预约协调', status: 'included' },
              { label: 'VIP号源预留评估', status: 'included' },
              { label: '治疗路径深度分析', status: 'included' },
              { label: '出行前资料清单', status: 'included' },
            ],
            footnote: '结合当前病例的脚注，非空',
          }],
          highlights: '必填，4-7条简短要点',
          plan: {
            direction: '必填，检查/复核/转诊/管理路径，至少4个步骤',
            duration: '必填，在华停留或远程预审周期，需审慎表达',
            totalCost: '必填，中国方案预估总费用，可先给美元或人民币区间；后续费用明细会由医疗大模型单独细化并覆盖总价展示',
            breakdown: '必填，4-8项，每项 {item,cost}，作为医疗大模型后续费用细化的依据；不要输出 plan.costBreakdown',
          },
          paymentAndInsurance: '必填，3-5条，覆盖预算分项、预授权/直付/事后理赔、材料清单和不承诺报销',
        },
        patientInput: {
          locale: input.locale,
          basicInfo: {
            ...input.basicInfo,
            careNeedLabel,
            expectedTreatmentTimeLabel,
            chiefComplaint: truncateForPrompt(input.basicInfo.chiefComplaint, 700),
          },
          selectedRegions: input.selectedRegions,
          hasUploadedMedicalRecords: input.uploadedFiles.length > 0,
        },
        personalization,
        matchedKnowledge: {
          diseaseKey,
          disease: {
            label: disease.label,
            treatment: disease.treatment,
            direction: disease.direction,
            duration: disease.duration,
            advantages: disease.advantages.slice(0, 5),
          },
          documentKnowledge: compactDocumentKnowledgeForPrompt(documentKnowledge).slice(0, 3),
          structuredMedicalFacts: medicalFacts.hasActionableFacts
            ? compactMedicalFactsForPrompt(medicalFacts)
            : null,
        },
        pageFieldReference: {
          countriesShape: ruleReport.countries.map((country) => ({
            flag: country.flag,
            name: country.name,
          })),
          servicePackageTierReference: ruleReport.packages.map((pkg) => ({
            name: pkg.name,
            price: pkg.price,
            originalPrice: pkg.originalPrice,
            icon: pkg.icon,
            highlight: pkg.highlight,
            badge: pkg.badge,
          })),
        },
        qualityRules: [
          '必须回应 chiefComplaint 中至少两个具体信息点。',
          careNeedLabel ? `必须把用户就医诉求“${careNeedLabel}”反映到 treatment、concerns、plan.direction、highlights 和 next-step 表达中。` : '',
          expectedTreatmentTimeLabel ? `必须按期望治疗时间“${expectedTreatmentTimeLabel}”调整预审节奏、出行准备和时间线；如果是仅咨询方案，不能写成已决定赴华治疗。` : '',
          diseaseKey === 'cardiovascular_tumor' ? '心血管肿瘤/心脏占位病例中，disease 必须写“心血管肿瘤/心脏占位评估方向”这类明确短句；treatment 必须回应右心房占位、活动后气短/心悸、心脏MRI复核、心外科手术或介入取栓/肿瘤切除评估，长度至少120字。' : '',
          '没有上传医疗报告时，只能写“基于表单信息/用户自填信息”。',
          '不得把科室方向写成已确诊诊断。',
          '当 chiefComplaint 已给出明确疾病、症状、影像/病理/基因线索或治疗目标时，disease/treatment/advantages/concerns/plan.direction 不能写成整段资料不足或暂不生成；必须给出条件性、审慎但有决策价值的预审内容。',
          '需要补充的影像、病理、检测、既往治疗记录应放在 concerns.solution、plan.direction 或 highlights 中，不能替代核心诊疗判断。',
          '国家对比、医院推荐和费用摘要要围绕当前主诉、就医诉求和期望时间生成，不能照抄通用模板。',
          'hospitals 必须一次性返回可展开详情字段，非牙科3家医院每家必须有 matchScore、department、internationalPatients、waitTime、preparation、detailItems>=4。',
          'packages 必须恰好3项：Basic、Standard、Premium；每档 features 恰好3条，featureDetails 至少6项，且 subtitle/footnote 必须结合当前病例。',
          'Basic 必须有“不含视频面诊”的 excluded 明细；Standard 必须有视频面诊/跟进答疑 emphasis；Premium 必须有 MDT/多学科会诊 emphasis。',
          '本次主 patch 不需要输出 plan.costBreakdown 或 advancedCare；它们会由并行医疗模型补充任务按当前病例生成。',
          diseaseKey === 'dental' ? `牙科方向只允许围绕${dentalPartner.name}和牙科主诉表达，不要新增其他口腔医院。` : '',
        ].filter(Boolean),
      })}`,
    },
  ]
}

const buildCorePatchPrompt = (
  context: ReportContext,
  ruleReport: GeneratedReport,
  previousError?: string,
): MedicalLlmMessage[] => {
  const { input, disease, diseaseKey, personalization, medicalFacts, documentKnowledge } = context
  const careNeedLabel = getCareNeedLabel(input.basicInfo.careNeed, input.basicInfo.careNeedOther)
  const expectedTreatmentTimeLabel = getExpectedTreatmentTimeLabel(input.basicInfo.expectedTreatmentTime)

  return [
    {
      role: 'system',
      content: [
        '/no_think',
        '你是寰宇云医简易预审报告的核心内容修复助手。',
        '只根据用户输入和页面字段需求返回一个严格 JSON 对象，不输出 Markdown，不解释。',
        '本次补齐核心报告字段、推荐医院展开详情和专业评估服务包，不输出 costBreakdown 或 advancedCare。',
        '如果用户已提供明确诊断、症状、检查线索或治疗诉求，不能把核心字段写成“资料不足”“待医生确认”“暂不生成”。',
        '资料限制应写在 concerns、plan.direction、highlights 中，核心段落必须给出基于现有信息的审慎预审方向。',
        '不得编造检查数值、上传报告内容、确定诊断、医生姓名、疗效承诺或具体处方。',
      ].join('\n'),
    },
    {
      role: 'user',
      content: `/no_think\n${JSON.stringify({
        task: '修复简易报告核心 JSON 字段',
        previousError: previousError
          ? `上一次输出未通过校验：${previousError}。请只输出本次要求的 JSON 字段，确保没有尾随逗号、注释、Markdown 或多余文本。`
          : '',
        requiredTopLevelKeys: [
          'disease',
          'treatment',
          'countries',
          'advantages',
          'concerns',
          'hospitals',
          'packages',
          'highlights',
          'plan',
          'paymentAndInsurance',
        ],
        outputSchema: {
          disease: '必填，当前病例就医方向，短句，不写待医生确认',
          treatment: '必填，120-260字，回应主诉、诊疗方向、资料限制和下一步医学判断',
          countries: '必填，2-4项；沿用 countriesShape 的国家/地区和 flag，可重写 fee/wait/tech/service/visa/follow/recommended',
          advantages: '必填，3-5项，每项 {label,value}，体现中国方案价值和当前病例适配点',
          concerns: '必填，4-7项，每项 {concern,solution}，包含资料补充、急症排除、费用波动和治疗连续性',
          hospitals: '必填，非牙科3项；牙科1项。每项包含 city/name/reason/department/matchScore/internationalPatients/waitTime/preparation/detailItems；detailItems至少4项；不编造医生姓名、确切号源或疗效。',
          packages: '必填，恰好3项 Basic/Standard/Premium，每项包含 name/subtitle/price/originalPrice/icon/highlight/features/featureDetails/footnote；features恰好3条，featureDetails至少6项',
          highlights: '必填，4-7条，必须结合当前病例',
          plan: {
            direction: '必填，至少4个步骤，用 -> 串联或一句话描述',
            duration: '必填，远程预审/来华评估/治疗停留周期',
            totalCost: '必填，可给中国方案初步总费用区间；详细费用由另一请求生成',
            breakdown: '必填，4-8项，每项 {item,cost}，不要输出 costBreakdown',
          },
          paymentAndInsurance: '必填，3-5条，覆盖预算分项、预授权/直付/事后理赔、材料清单和不承诺报销',
        },
        patientInput: {
          locale: input.locale,
          basicInfo: {
            ...input.basicInfo,
            careNeedLabel,
            expectedTreatmentTimeLabel,
            chiefComplaint: truncateForPrompt(input.basicInfo.chiefComplaint, 900),
          },
          selectedRegions: input.selectedRegions,
          hasUploadedMedicalRecords: input.uploadedFiles.length > 0,
        },
        personalization,
        matchedKnowledge: {
          diseaseKey,
          disease: compactDiseaseForPrompt(disease),
          documentKnowledge: compactDocumentKnowledgeForPrompt(documentKnowledge).slice(0, 3),
          structuredMedicalFacts: medicalFacts.hasActionableFacts ? compactMedicalFactsForPrompt(medicalFacts) : null,
        },
        pageFieldReference: {
          countriesShape: ruleReport.countries.map((country) => ({
            flag: country.flag,
            name: country.name,
          })),
          servicePackageTierReference: ruleReport.packages.map((pkg) => ({
            name: pkg.name,
            price: pkg.price,
            originalPrice: pkg.originalPrice,
            icon: pkg.icon,
            highlight: pkg.highlight,
            badge: pkg.badge,
          })),
        },
        qualityRules: [
          '必须回应 chiefComplaint 中至少两个具体信息点。',
          careNeedLabel ? `必须体现用户就医诉求“${careNeedLabel}”。` : '',
          expectedTreatmentTimeLabel ? `必须体现期望治疗时间“${expectedTreatmentTimeLabel}”。` : '',
          diseaseKey === 'cardiovascular_tumor' ? '心血管肿瘤/心脏占位病例中，disease 必须写“心血管肿瘤/心脏占位评估方向”这类明确短句；treatment 必须回应右心房占位、活动后气短/心悸、心脏MRI复核、心外科手术或介入取栓/肿瘤切除评估，长度至少120字。' : '',
          '没有上传医疗报告时，只能写“基于表单信息/用户自填信息”。',
          '不得输出 costBreakdown、advancedCare、task、outputSchema、qualityRules 等说明字段。',
          'hospitals 必须一次性返回可展开详情字段；非牙科3家医院每家必须有 matchScore、department、internationalPatients、waitTime、preparation、detailItems>=4。',
          '不得把“需补充资料”作为 disease/treatment/plan.direction 的主体内容；可以在 concerns 和 next-step 中说明需要补充哪些资料。',
          'packages 三档服务包必须按当前病例重写，不能只返回档位名称。',
        ].filter(Boolean),
      })}`,
    },
  ]
}

const buildHospitalDetailsPrompt = (
  context: ReportContext,
  ruleReport: GeneratedReport,
  patch: FreeReportPatch,
): MedicalLlmMessage[] => {
  const { input, disease, diseaseKey, personalization, medicalFacts, documentKnowledge } = context
  const careNeedLabel = getCareNeedLabel(input.basicInfo.careNeed, input.basicInfo.careNeedOther)
  const expectedTreatmentTimeLabel = getExpectedTreatmentTimeLabel(input.basicInfo.expectedTreatmentTime)

  return [
    {
      role: 'system',
      content: [
        '/no_think',
        '你是寰宇云医简易报告的推荐医院详情生成助手。',
        '你只补充推荐医院 Top3 的结构化详情，不输出完整报告，不输出 Markdown。',
        '所有信息必须基于用户基础信息、病种方向、主诉、地区偏好、给定知识摘要和通用医院专科能力做审慎判断。',
        '不得编造医生姓名、确切号源、床位、真实接诊承诺、精确年患者量或治疗效果。',
        '能给区间、量级或需预审确认时不要留空；只有完全无法支撑时才写“需预审确认”。',
      ].join('\n'),
    },
    {
      role: 'user',
      content: `/no_think\n${JSON.stringify({
        task: '只生成推荐医院 Top3 详情 JSON',
        outputSchema: {
          hospitals: [{
            city: '城市',
            name: '医院名',
            reason: '为什么匹配当前主诉和病种',
            englishName: '英文名或常用英文简称；不确定可写需预审确认',
            department: '建议科室/MDT方向',
            matchScore: '0-100整数；体现当前病例相对适配度，三家需要拉开差异',
            rankLabel: '专科优势/区域优势/能力标签',
            tags: ['2-4个短标签'],
            internationalPatients: '国际患者接待能力或患者量量级；不能精确时给“通常具备国际患者协调/需预审确认”等审慎表达',
            waitTime: '预计预审/首诊等待时间；不能精确时给区间或“需预审确认”',
            detailItems: [
              { label: '适配理由', value: '贴合当前病种、主诉和资料状态' },
              { label: '建议科室', value: '科室/MDT方向' },
              { label: '预审重点', value: '医生预审需要先判断的问题' },
              { label: '需准备资料', value: '资料清单' },
            ],
            preparation: '发起预审前准备动作',
          }],
        },
        hardRules: [
          diseaseKey === 'dental'
            ? `牙科只允许输出1项${dentalPartner.name}，不得推荐其他口腔医院。`
            : '非牙科必须输出3项医院。',
          '每项必须包含 matchScore、department、internationalPatients、waitTime、detailItems、preparation。',
          'matchScore 要体现相对适配差异，不能三家都一样；如果无法支撑，matchScore=0 并在 reason/preparation 说明需补充资料。',
          'internationalPatients 和 waitTime 可以是区间、量级或需预审确认，但不能空。',
          'detailItems 至少4项，必须用于前端展开详情；每项 label/value 都非空。',
          '不要输出医生姓名、精确患者量、确定号源、保证入院或治疗承诺。',
        ],
        patientInput: {
          locale: input.locale,
          basicInfo: {
            ...input.basicInfo,
            careNeedLabel,
            expectedTreatmentTimeLabel,
            chiefComplaint: truncateForPrompt(input.basicInfo.chiefComplaint, 700),
          },
          selectedRegions: input.selectedRegions,
          hasUploadedMedicalRecords: input.uploadedFiles.length > 0,
        },
        personalization,
        matchedKnowledge: {
          diseaseKey,
          disease: compactDiseaseForPrompt(disease),
          documentKnowledge: compactDocumentKnowledgeForPrompt(documentKnowledge).slice(0, 3),
          structuredMedicalFacts: medicalFacts.hasActionableFacts ? compactMedicalFactsForPrompt(medicalFacts) : null,
        },
        currentReportContext: {
          disease: patch.disease || ruleReport.disease,
          treatment: patch.treatment || ruleReport.treatment,
          concerns: patch.concerns || ruleReport.concerns,
          hospitals: patch.hospitals || ruleReport.hospitals,
          plan: {
            direction: patch.plan?.direction || ruleReport.plan.direction,
            duration: patch.plan?.duration || ruleReport.plan.duration,
            totalCost: patch.plan?.totalCost || ruleReport.plan.totalCost,
          },
        },
      })}`,
    },
  ]
}

const buildPackagePrompt = (
  context: ReportContext,
  ruleReport: GeneratedReport,
  patch: FreeReportPatch,
  previousError?: string,
): MedicalLlmMessage[] => {
  const { input, disease, diseaseKey, personalization, medicalFacts, documentKnowledge } = context
  const careNeedLabel = getCareNeedLabel(input.basicInfo.careNeed, input.basicInfo.careNeedOther)
  const expectedTreatmentTimeLabel = getExpectedTreatmentTimeLabel(input.basicInfo.expectedTreatmentTime)

  return [
    {
      role: 'system',
      content: [
        '/no_think',
        '你是寰宇云医简易预审报告的专业评估服务包内容生成助手。',
        '你只生成适合当前病例的 packages JSON，不输出 Markdown，不解释。',
        '不要推理，不要解释，直接输出严格 JSON。',
        '所有权益、包含/不包含、脚注和 CTA 都必须根据用户主诉、资料完整度、就医诉求和预期时间生成。',
        '不得承诺治愈、指定专家一定预约成功、VIP号源一定保留或保险一定报销。',
      ].join('\n'),
    },
    {
      role: 'user',
      content: `/no_think\n${JSON.stringify({
        task: '只生成简易报告的专业评估服务包 packages',
        previousError: previousError ? `上一次输出未通过校验：${previousError}。请重新输出完整 packages，保持短句，确保三档各有 features 数组、featureDetails 数组且每档至少6项。` : '',
        outputSchema: {
          packages: {
            description: '必填数组，必须恰好3项，由医疗大模型返回，不由系统补全。',
            itemShape: '{name,subtitle,price,originalPrice?,badge?,cta,icon,highlight,features,featureDetails,footnote}',
            tierRules: [
              '第1项 name 必须是“基础评估包 / Basic”：适合已有资料、先获取书面方向判断；必须有 excluded 项“不含视频面诊”。',
              '第2项 name 必须是“标准面诊包 / Standard”：适合希望与专家视频沟通并获得跟进答疑；必须有 emphasis 项突出专家视频面诊或跟进答疑。',
              '第3项 name 必须是“深度面诊包 / Premium”：适合复杂病情、疑似复发转移或跨科室治疗决策；必须有 emphasis 项突出 MDT/多学科会诊。',
            ],
            detailRules: [
              '每档 features 恰好3条短摘要，每条不超过18个汉字。',
              '每档 featureDetails 至少6项，每项 {label,status}，status 只能是 included/excluded/emphasis；label 不超过28个汉字。',
              '每档 subtitle 和 footnote 必须结合当前病例、资料限制、就医诉求和期望治疗时间，subtitle 不超过40个汉字，footnote 不超过55个汉字。',
              'price、originalPrice、icon、highlight 可参考 servicePackageTierReference。',
            ],
          },
        },
        patientInput: {
          locale: input.locale,
          basicInfo: {
            ...input.basicInfo,
            careNeedLabel,
            expectedTreatmentTimeLabel,
            chiefComplaint: truncateForPrompt(input.basicInfo.chiefComplaint, 700),
          },
          selectedRegions: input.selectedRegions,
          hasUploadedMedicalRecords: input.uploadedFiles.length > 0,
        },
        personalization,
        matchedKnowledge: {
          diseaseKey,
          disease: compactDiseaseForPrompt(disease),
          documentKnowledge: compactDocumentKnowledgeForPrompt(documentKnowledge).slice(0, 3),
          structuredMedicalFacts: medicalFacts.hasActionableFacts
            ? compactMedicalFactsForPrompt(medicalFacts)
            : null,
        },
        generatedReportContext: {
          disease: patch.disease || ruleReport.disease,
          treatment: patch.treatment || ruleReport.treatment,
          concerns: patch.concerns || ruleReport.concerns,
          hospitals: patch.hospitals || ruleReport.hospitals,
          plan: {
            direction: patch.plan?.direction || ruleReport.plan.direction,
            duration: patch.plan?.duration || ruleReport.plan.duration,
            totalCost: patch.plan?.totalCost || ruleReport.plan.totalCost,
          },
        },
        servicePackageTierReference: ruleReport.packages.map((pkg) => ({
          name: pkg.name,
          price: pkg.price,
          originalPrice: pkg.originalPrice,
          icon: pkg.icon,
          highlight: pkg.highlight,
          badge: pkg.badge,
        })),
        qualityRules: [
          '返回 JSON 对象必须包含顶层 packages，不能放在 services、plans 或 highlights 下。',
          '三档服务包的 subtitle、features、featureDetails、footnote 必须按当前病例重写；不得只照抄服务层级参考；所有文字用短句。',
          'Basic 必须包含“不含视频面诊”的 excluded 明细；Standard 必须包含视频面诊/跟进答疑 emphasis；Premium 必须包含 MDT/多学科会诊 emphasis。',
          diseaseKey === 'dental' ? `牙科方向只允许围绕${dentalPartner.name}和牙科主诉表达，不要写肿瘤MDT。` : '',
        ].filter(Boolean),
      })}`,
    },
  ]
}

const getTreatmentExecutionPromptHints = (context: ReportContext) => {
  const { input, disease, diseaseKey } = context
  const careNeedLabel = getCareNeedLabel(input.basicInfo.careNeed, input.basicInfo.careNeedOther)
  const text = [
    input.basicInfo.chiefComplaint,
    careNeedLabel,
    context.personalization.caseSummary,
    disease.treatment,
    context.medicalFacts.summary,
    ...context.medicalFacts.evidenceHighlights,
  ].join(' ')
  const hints: string[] = []
  const add = (pattern: RegExp, label: string) => {
    if (pattern.test(text)) hints.push(label)
  }

  if (diseaseKey === 'cardiovascular_tumor') {
    hints.push(
      '心脏占位/右房肿物切除手术执行费（含麻醉、ICU、住院，按是否手术注明条件）',
      '介入取栓/导管评估或介入活检费用（如影像提示适用）',
      '心脏MRI、经食道超声、凝血和心功能评估费用',
    )
  }
  if (diseaseKey === 'endocrinology_metabolism') {
    hints.push(
      '糖尿病并发症筛查费用（眼底、尿微量白蛋白、周围神经检查等）',
      '动态血糖监测/CGM或强化血糖监测费用',
      '个体化用药调整及慢病药物首月费用（如胰岛素、GLP-1、SGLT2等，需医生确认）',
    )
  }
  if (diseaseKey === 'lung_cancer') {
    hints.push(
      'EGFR-TKI靶向药物首月费用（如奥希替尼/阿美替尼/伏美替尼等，需医生确认具体药物）',
      '骨转移支持治疗费用（骨保护药物、止痛或骨科/放疗支持，按适用性注明）',
      '骨转移局部放疗或镇痛支持治疗费用（如疼痛或承重骨风险适用）',
    )
  }
  if (diseaseKey === 'liver_cancer') {
    hints.push(
      'TACE/HAIC介入治疗执行费（单次或疗程，需按肝功能和门静脉情况确认）',
      '肝癌消融治疗执行费（射频/微波消融，按病灶位置和数量确认）',
      '肝癌系统治疗首月费用（靶向/免疫药物，需医生确认适应证）',
    )
  }

  add(/微创|胸腔镜|机器人|手术|切除|搭桥|CABG/i, '手术执行费（含麻醉、住院、围术期，不写成可行性评估）')
  add(/消融|射频|微波/i, '消融治疗执行费（单次或疗程，不写成消融评估）')
  add(diseaseKey === 'cardiovascular_tumor' ? /TACE|HAIC/i : /TACE|HAIC|介入/i, 'TACE/HAIC/介入治疗执行费（单次或疗程，不写成介入评估）')
  add(/放疗|质子|重离子|伽玛刀|放射外科/i, '放疗/质子重离子/放射外科疗程费用')
  add(/化疗/i, '化疗周期费用')
  add(/靶向|免疫|PD-?1|PD-?L1|EGFR|ALK|ROS1|TKI/i, '靶向/免疫/系统药物治疗首月或单周期费用')
  add(/支架|PCI/i, '冠脉造影+PCI支架介入执行费（含支架材料）')
  add(/根管/i, '根管治疗执行费')
  add(/种植/i, '种植手术及修复费用')
  add(/修复|贴面|牙冠/i, '牙体修复/贴面/牙冠费用')

  if (!hints.length && !['premium_checkup'].includes(diseaseKey)) {
    hints.push('由医疗模型选择的具体治疗执行费，例如手术/介入/消融/放疗/药物/口腔治疗等，不能写成“主要治疗执行费用”或方案评估费')
  }

  return unique(hints).slice(0, 6)
}

const getTreatmentExecutionCostExamples = (context: ReportContext) => {
  const hints = getTreatmentExecutionPromptHints(context)
  const examples = hints.map((hint) => {
    if (/心脏占位|右房肿物|ICU/i.test(hint)) return '心脏占位切除手术及麻醉/ICU/住院费用'
    if (/介入取栓|导管评估|介入活检/i.test(hint)) return '介入取栓/导管评估或介入活检费用'
    if (/心脏MRI|经食道超声|心功能/i.test(hint)) return '心脏MRI/经食道超声/心功能评估费用'
    if (/并发症筛查|眼底|尿微量白蛋白|周围神经/i.test(hint)) return '糖尿病并发症筛查费用'
    if (/动态血糖|CGM|血糖监测/i.test(hint)) return '动态血糖监测/CGM费用'
    if (/用药调整|慢病药物|胰岛素|GLP-?1|SGLT2/i.test(hint)) return '个体化用药调整及慢病药物首月费用'
    if (/EGFR|TKI|奥希替尼|阿美替尼|伏美替尼/i.test(hint)) return 'EGFR-TKI靶向药物首月费用'
    if (/骨转移|骨保护|镇痛/i.test(hint)) return '骨转移支持治疗费用'
    if (/肝癌|TACE|HAIC/i.test(hint)) return 'TACE/HAIC介入治疗费用'
    if (/系统治疗|靶向|免疫/i.test(hint)) return '系统治疗药物首月费用'
    if (/手术|麻醉|住院|围术期|CABG|搭桥|机器人|微创/i.test(hint)) return '手术费及麻醉住院费用'
    if (/消融|射频|微波/i.test(hint)) return '消融治疗执行费用'
    if (/TACE|HAIC|介入/i.test(hint)) return 'TACE/HAIC介入治疗费用'
    if (/放疗|质子|重离子|放射/i.test(hint)) return '放疗/质子重离子疗程费用'
    if (/化疗/i.test(hint)) return '化疗单周期或首疗程费用'
    if (/靶向|免疫|系统药物|药物|PD-?1|PD-?L1|EGFR|ALK|ROS1|TKI/i.test(hint)) return '靶向/免疫/系统药物首月费用'
    if (/PCI|支架/i.test(hint)) return '冠脉造影+PCI支架介入费用'
    if (/根管/i.test(hint)) return '根管治疗执行费用'
    if (/种植/i.test(hint)) return '种植手术及修复费用'
    if (/修复|贴面|牙冠/i.test(hint)) return '牙体修复/贴面/牙冠费用'
    return hint.replace(/（.*?）/g, '').replace(/，.*$/, '').trim()
  }).filter(Boolean)

  return unique(examples).slice(0, 4)
}

const getAdvancedTherapyPromptHints = (context: ReportContext) => {
  const { input, disease, diseaseKey } = context
  if (['dental', 'premium_checkup'].includes(diseaseKey)) return []
  const text = [
    input.basicInfo.chiefComplaint,
    context.personalization.caseSummary,
    disease.treatment,
    context.medicalFacts.summary,
    ...context.medicalFacts.evidenceHighlights,
  ].join(' ')
  const hints: string[] = []
  const add = (pattern: RegExp, label: string) => {
    if (pattern.test(text)) hints.push(label)
  }

  add(/TACE|HAIC|介入/i, 'TACE/HAIC介入治疗')
  add(/消融|射频|微波/i, '射频/微波消融治疗')
  add(/靶向|EGFR|ALK|ROS1|TKI/i, '靶向药物治疗')
  add(/免疫|PD-?1|PD-?L1/i, 'PD-1/PD-L1免疫治疗或联合方案')
  add(/放疗|质子|重离子/i, '精准放疗/质子重离子治疗')
  add(/微创|机器人|胸腔镜|手术/i, '微创/机器人辅助手术')
  add(/ADC/i, 'ADC药物治疗')
  add(/细胞|CAR-?T|TIL/i, '细胞治疗或临床研究方向')

  if (!hints.length && /癌|肿瘤|瘤|cancer|carcinoma/i.test(text)) {
    hints.push('系统药物治疗（靶向/免疫/化疗需结合病理和检测确认）')
  }

  return unique(hints).slice(0, 5)
}

const buildCostBreakdownPrompt = (
  context: ReportContext,
  ruleReport: GeneratedReport,
  patch: FreeReportPatch,
  previousError?: string,
): MedicalLlmMessage[] => {
  const { input, disease, diseaseKey } = context
  const careNeedLabel = getCareNeedLabel(input.basicInfo.careNeed, input.basicInfo.careNeedOther)
  const expectedTreatmentTimeLabel = getExpectedTreatmentTimeLabel(input.basicInfo.expectedTreatmentTime)
  const treatmentExecutionHints = getTreatmentExecutionPromptHints(context)
  const treatmentCostExamples = getTreatmentExecutionCostExamples(context)
  const plan = {
    direction: patch.plan?.direction || ruleReport.plan.direction,
    duration: patch.plan?.duration || ruleReport.plan.duration,
    totalCost: patch.plan?.totalCost || ruleReport.plan.totalCost,
    breakdown: normalizePlanBreakdown(patch.plan?.breakdown || ruleReport.plan.breakdown, context),
  }
  const countries = (patch.countries || ruleReport.countries).map((country) => ({
    name: country.name,
    fee: country.fee,
    wait: country.wait,
    recommended: country.recommended,
  }))
  const caseText = [
    `疾病方向：${patch.disease || ruleReport.disease || disease.label}`,
    `主诉：${truncateForPrompt(input.basicInfo.chiefComplaint, 520)}`,
    `患者国家/城市：${input.basicInfo.nationality || '未填'} / ${input.basicInfo.city || '未填'}`,
    `就医诉求：${careNeedLabel || '未填'}`,
    `期望时间：${expectedTreatmentTimeLabel || '未填'}`,
    `路径：${plan.direction}`,
    `周期：${plan.duration}`,
    `已有费用摘要：${plan.breakdown.map((item) => `${item.item}${item.cost}`).join('；')}`,
    `国家对比：${countries.map((country) => `${country.name}${country.fee}`).join('；')}`,
    `当前病种常见治疗路径参考：${disease.treatment}`,
    treatmentExecutionHints.length ? `需要模型重点估算的治疗执行费用关键词：${treatmentExecutionHints.join('；')}。这些关键词来自用户文本/病种参考，是否适用仍由你结合病例判断。` : '',
    diseaseKey === 'dental' ? `牙科限制：只围绕${dentalPartner.name}和牙科主诉估算，不要写肿瘤治疗费用。` : '',
  ].filter(Boolean).join('\n')
  const errorText = previousError
    ? `\n上一次输出未通过校验：${previousError}。请重新输出完整 costBreakdown；如果失败原因是缺少实际治疗执行费用，coreMedical 必须补充本例治疗执行项目并给可解析金额，例如：${treatmentCostExamples.join('；') || '手术/介入/消融/放疗/药物/口腔治疗等实际执行费用'}。有足够依据的费用用人民币和美元表达，依据不足的项目请写“资料不足，暂不估算/需医生确认”，不要为了通过格式校验编造金额。`
    : ''
  const schemaExample = {
    costBreakdown: {
      currencyNote: '按预审估算汇率约 ￥7.2 = $1 折算，最终以医院报价和付款日汇率为准',
      coreMedical: {
        title: '核心医疗费用',
        subtotal: '￥xx（~$xx）',
        items: [
          { item: treatmentCostExamples[0] || '具体治疗执行费用', cost: '￥xx（~$xx）', note: '说明' },
          { item: treatmentCostExamples[1] || '诊断复核/专家会诊', cost: '￥xx（~$xx）', note: '说明' },
          { item: treatmentCostExamples[2] || '影像/病理/分子检测', cost: '￥xx（~$xx）', note: '说明' },
          { item: treatmentCostExamples[3] || '住院/日间治疗相关费用', cost: '￥xx（~$xx）', note: '说明' },
        ],
        tip: '说明',
      },
      supportServices: { title: '配套服务费用', subtotal: '￥xx（~$xx）', items: [{ item: '项目', cost: '￥xx（~$xx）', note: '说明' }], tip: '说明' },
      living: { title: '生活费用', subtotal: '￥xx（~$xx）', items: [{ item: '项目', cost: '￥xx（~$xx）', note: '说明' }], tip: '说明' },
      summary: { formula: '核心医疗￥xx + 配套服务￥xx + 生活费用￥xx = ￥xx（约$xx）', chinaTotal: '￥xx（约$xx）', referenceCountry: '本国或患者常住地国家/地区', referenceCost: '$xx,xxx', savingsPercent: 0, savingsText: 'vs 本国治疗$xx,xxx = 节省xx%/Save xx%' },
    },
  }

  return [
    {
      role: 'system',
      content: [
        '/no_think',
        '你是寰宇云医简易预审报告的跨境医疗费用拆分助手。',
        '不要推理，不要解释，直接输出严格 JSON。',
        '只输出一个 JSON 对象，顶层字段必须是 costBreakdown。',
        '费用明细、患者本国治疗参考费用和估算依据必须由你根据病例、治疗阶段、停留时间和患者常住地对照生成。',
        '后端会根据你返回的三类费用明细做金额解析、人民币/美元折算、三类小计、总和和节省比例计算；你不需要为了公式而重复计算，但需要给出可解析金额或区间。',
        '资料不足是最后选项；能基于病例方向、治疗阶段、停留时间和地区对照给出审慎费用区间时，必须输出金额并标注“预估/需医生确认”。',
        '只有资料完全不足以支撑某个项目金额时，才在对应费用字段写“资料不足，暂不估算/需医生确认”，不得编造价格。',
        '费用区间要尽量收敛到当前病例可用范围，避免“几千到几十万”这类没有决策意义的超宽区间；如波动大，应拆分项目说明波动原因。',
        '即使用户诉求是第二意见/方案比较，也必须给出被比较治疗路径的执行费用区间，不能只输出咨询、检查、复核或MDT费用。',
        treatmentCostExamples.length ? `本例 coreMedical 必须优先列出这些实际治疗执行费用并给可解析金额：${treatmentCostExamples.join('；')}。检查、会诊、MDT或方案评估不能替代这些治疗费用。` : '',
        '肿瘤、心血管、脊柱、神经外科等治疗型病例必须把治疗执行费用与诊断复核费用分开；诊断复核可以有，但不能替代主要治疗费用。',
        '患者本国治疗参考费用必须与当前中国方案同口径：若中国费用包含手术/住院/系统治疗，本国参考也应按同类治疗总费用估算，不能只填检查费、会诊费或单项药费。',
        '不得承诺最终医院报价、保险报销或固定疗效。',
      ].filter(Boolean).join('\n'),
    },
    {
      role: 'user',
      content: [
        '/no_think',
        '只输出一个 JSON 对象，不要 Markdown，不要解释。',
        '顶层字段必须是 costBreakdown。',
        'coreMedical、supportServices、living 每类 items 至少4项。',
        '能给出审慎区间的 cost/subtotal 使用“￥xxx（~$xxx）”格式；只在完全无法支撑时写“资料不足，暂不估算/需医生确认”。',
        '每个费用项都要尽量给可用粒度的区间或量级，不能为了避免风险而全部写宽泛范围。',
        `coreMedical 必须覆盖当前病例提到或病种常见的治疗执行费用项。若存在多个候选治疗路径，至少2项具体治疗执行费用要带可解析金额；若只有单一路径，至少1项具体治疗执行费用要带可解析金额。主诉提到手术、消融、介入、靶免、根管、种植等时，必须分别给出对应费用区间；不能用“可行性评估/专家会诊/检查复核”替代治疗费用，也不能只给检查、检测和会诊。${careNeedLabel ? `用户就医诉求：${careNeedLabel}。` : ''}`,
        '若是第二意见/方案比较，coreMedical 仍需包含被比较方案的执行费用，例如手术费/麻醉住院、消融治疗、TACE/HAIC介入、放疗疗程、化疗/靶向/免疫药物、支架/搭桥、根管/种植等；“方案评估费”只能作为补充项。',
        '费用项名称不要写成“XX可行性评估”“XX方案评估”“系统治疗评估”或“主要治疗执行费用”；应写实际费用项，如“TACE介入治疗（单次）”“微创手术及麻醉住院”“靶向药物首月费用”。',
        treatmentCostExamples.length ? `本例 coreMedical 必须至少包含这些实际费用项中的1项并给可解析金额，能支撑时尽量分别列出：${treatmentCostExamples.join('；')}。不要合并成“主要治疗执行费用”。` : '',
        'summary.referenceCost 有依据时给出患者本国治疗参考费用，且必须与当前中国方案同口径；后端会基于三类费用明细和 referenceCost 拼装公式与节省比例。',
        errorText,
        `病例：\n${caseText}`,
        `JSON样例字段：${JSON.stringify(schemaExample)}`,
      ].filter(Boolean).join('\n'),
    },
  ]
}

const buildAdvancedCarePrompt = (
  context: ReportContext,
  ruleReport: GeneratedReport,
  patch: FreeReportPatch,
  previousError?: string,
): MedicalLlmMessage[] => {
  const { input, disease, diseaseKey, personalization, medicalFacts, documentKnowledge } = context
  const careNeedLabel = getCareNeedLabel(input.basicInfo.careNeed, input.basicInfo.careNeedOther)
  const expectedTreatmentTimeLabel = getExpectedTreatmentTimeLabel(input.basicInfo.expectedTreatmentTime)
  const diseaseLabel = patch.disease || ruleReport.disease || disease.label
  const treatment = patch.treatment || ruleReport.treatment
  const therapyHints = getAdvancedTherapyPromptHints(context)
  const plan = {
    direction: patch.plan?.direction || ruleReport.plan.direction,
    duration: patch.plan?.duration || ruleReport.plan.duration,
    totalCost: patch.plan?.totalCost || ruleReport.plan.totalCost,
    breakdown: normalizePlanBreakdown(patch.plan?.breakdown || ruleReport.plan.breakdown, context),
  }
  const countries = (patch.countries || ruleReport.countries).map((country) => ({
    name: country.name,
    fee: country.fee,
    wait: country.wait,
    tech: country.tech,
    recommended: country.recommended,
  }))
  const caseText = [
    `疾病方向：${diseaseLabel}`,
    `治疗摘要：${truncateForPrompt(treatment, 520)}`,
    `主诉：${truncateForPrompt(input.basicInfo.chiefComplaint, 700)}`,
    `患者国家/城市：${input.basicInfo.nationality || '未填'} / ${input.basicInfo.city || '未填'}`,
    `就医诉求：${careNeedLabel || '未填'}`,
    `期望时间：${expectedTreatmentTimeLabel || '未填'}`,
    `路径：${plan.direction}`,
    `周期：${plan.duration}`,
    `费用摘要：${plan.breakdown.map((item) => `${item.item}${item.cost}`).join('；')}`,
    `国家对比：${countries.map((country) => `${country.name}${country.fee}`).join('；')}`,
    therapyHints.length ? `前沿疗法候选关键词：${therapyHints.join('；')}。这些关键词来自用户文本/病种参考，是否适用仍由你结合病例判断。` : '',
    diseaseKey === 'dental' ? `牙科限制：如当前病例不适合药品/新药治愈判断，也必须由你在对应字段说明“不适用/暂无药物治愈问题”，不要编造肿瘤药物。` : '',
  ].filter(Boolean).join('\n')
  const errorText = previousError
    ? `\n上一次输出未通过校验：${previousError}。请重新输出完整 advancedCare，三块内容都必须存在，不能空数组，金额尽量使用“￥xxx（~$xxx）”。`
    : ''
  const schemaExample = {
    advancedCare: {
      context: '基于用户信息说明本节适用前提',
      currencyNote: '按预审估算汇率约 ￥7.2 = $1 折算，最终以医院报价和付款日汇率为准',
      therapies: [{
        name: '疗法名称，由模型按当前病例选择；不适用时写审慎评估名称',
        category: '治疗类别',
        recommendationLevel: '优先评估/可讨论/暂不优先/资料不足',
        summary: '一句话价值',
        applicableFor: '适用人群或本例触发条件',
        mechanism: '作用机制或治疗逻辑',
        chinaAccess: '中国可及性、医院/中心能力或需要预审的入口',
        estimatedCost: '￥xx（~$xx）',
        referenceCost: '$xx,xxx 或 ￥xx（~$xx）',
        advantage: '中国方案优势或价格/等待/可及性优势',
        evidence: '证据依据或需要确认的生物标志物/分期前提',
        limitations: '局限与风险，不能承诺疗效',
        nextStep: '下一步应补充的资料或医生复核动作',
        tags: ['可选短标签'],
      }],
      drugCostComparison: {
        title: '药品费用对比 - 同等疗效候选方案',
        basis: '说明同等疗效比较的医学前提，例如同类药、仿制药一致性评价、生物类似药、指南等；不确定时说明需医生确认',
        summary: '概括药费差异和适用限制',
        items: [{
          drugName: '药品/药物类别名称，必须按当前病例选择；无适用药物时写“暂无明确适用药物”',
          drugClass: '药物类别',
          chinaOption: '中国可选原研/仿制/生物类似药/集采方案',
          referenceOption: '患者本国或国际市场对照',
          chinaCost: '￥xx（~$xx）',
          referenceCost: '$xx,xxx',
          efficacyEquivalence: '同等疗效前提和证据限制',
          savingInsight: '节省或价格优势说明',
          eligibility: '需要满足的检测/分期/医生判断',
          note: '可选说明',
        }],
        note: '不替代处方，需医生确认适应证、禁忌证和报销/采购可及性',
      },
      newDrugCureAssessment: {
        headline: '是否有新药可治愈?',
        answer: '必须医学审慎，不能承诺治愈；可写“暂无可承诺治愈的新药，目标是控制/缓解/延长生存”等',
        summary: '结合当前病例说明新药或临床研究的现实目标',
        items: [{
          name: '新药/药物类别/临床研究方向',
          type: '靶向/免疫/ADC/细胞治疗/小分子/不适用等',
          applicableFor: '适用前提',
          evidence: '证据或指南/研究方向概述',
          chinaAvailability: '中国可及性或需预审确认',
          potentialRole: '可能作用：控制、缓解、降低复发风险、姑息等',
          limitations: '不能治愈或证据不足的原因/毒性/耐药',
          nextStep: '检测或医生复核动作',
        }],
        ctaItems: ['建议补充的检测/资料/医生复核事项'],
      },
      disclaimer: '医学审慎声明',
    },
  }

  return [
    {
      role: 'system',
      content: [
        '/no_think',
        '你是寰宇云医简易预审报告的前沿疗法、新药和药品费用分析助手。',
        '不要推理，不要解释，直接输出严格 JSON。',
        '只输出一个 JSON 对象，顶层字段必须是 advancedCare。',
        '具体疗法、药物、费用、同等疗效前提、新药治愈判断必须由你根据当前用户信息生成；系统和前端不会自行补药名、补疗法或补医学判断。',
        '不得照搬示例疾病内容；不得为了凑数编造不适合当前病例的药物或疗法。',
        '不得承诺治愈、固定疗效、临床研究入组成功、药品一定可买到或医院一定接诊。',
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        '/no_think',
        '只输出一个 JSON 对象，不要 Markdown，不要解释。',
        '顶层字段必须是 advancedCare。',
        'advancedCare.therapies 1-2项；必须包含 estimatedCost，金额尽量使用“￥xxx（~$xxx）”；每个文本字段用短句。',
        'estimatedCost 不要混写“￥8,000 - $1,200”这类跨币种范围；请使用“￥8,000-12,000（~$1,100-1,700）”或单一明确金额。',
        'therapies 必须是治疗/药物/技术方向，例如靶向、免疫、ADC、介入、消融、HAIC/TACE、质子重离子、微创/机器人手术或临床研究；不能把检查、检测、病理复核、MDT会诊本身当作前沿疗法。',
        'therapies.name 必须是实际疗法/药物/技术本身，不能写“系统治疗评估”“可行性评估”“治疗路径讨论”“初步评估”“MDT讨论”；这些只能放到 nextStep 或 limitations。',
        therapyHints.length ? `本例优先从这些实际疗法/技术中选择 therapies.name：${therapyHints.join('；')}。不要输出“基因检测”“PD-L1表达分析”“胸腔镜微创手术评估”这类检查或评估名称。` : '',
        'advancedCare.drugCostComparison.items 1-2项；必须说明“同等疗效”的医学前提，如同类药同一适应证、仿制药一致性评价、生物类似药、原研/国产同成分、指南适应证、循证证据限制或需医生确认；每个 item.efficacyEquivalence 必须直接包含这些前提之一。',
        'advancedCare.newDrugCureAssessment.items 1-2项；answer 必须审慎，不能写“可以治愈/保证治愈/根治”；每个文本字段用短句。',
        'answer 不能照抄“必须医学审慎，不能承诺治愈”这类说明文字；必须按当前病例直接回答是否存在可讨论的新药/临床研究方向，以及现实目标。',
        '不要输出样例占位词，例如“疗法名称”“药品/药物类别名称”“新药/药物类别/临床研究方向”“医学审慎声明”。',
        '资料不足不是默认答案；能基于病种方向、主诉、既往治疗和常见证据前提给出可讨论方向时，必须返回审慎的疗法/药物类别，并写清适用前提和需补充检测。',
        '如果当前病例是牙科、体检或确实不适用药物/新药治愈判断，不要编造肿瘤新药；请用字段说明“不适用/暂无足够信息/需补充分型或检测”，但仍返回完整结构。',
        errorText,
        `病例：\n${caseText}`,
        `个性化约束：${JSON.stringify({
          personalization,
          matchedKnowledge: {
            diseaseKey,
            disease: compactDiseaseForPrompt(disease),
            documentKnowledge: compactDocumentKnowledgeForPrompt(documentKnowledge).slice(0, 3),
            structuredMedicalFacts: medicalFacts.hasActionableFacts
              ? compactMedicalFactsForPrompt(medicalFacts)
              : null,
          },
          hasUploadedMedicalRecords: input.uploadedFiles.length > 0,
        })}`,
        `JSON样例字段：${JSON.stringify(schemaExample)}`,
      ].filter(Boolean).join('\n'),
    },
  ]
}

const buildSupplementalPatchPrompt = (
  context: ReportContext,
  ruleReport: GeneratedReport,
): MedicalLlmMessage[] => {
  const { input, disease, diseaseKey, personalization, medicalFacts, documentKnowledge } = context
  const careNeedLabel = getCareNeedLabel(input.basicInfo.careNeed, input.basicInfo.careNeedOther)
  const expectedTreatmentTimeLabel = getExpectedTreatmentTimeLabel(input.basicInfo.expectedTreatmentTime)
  const treatmentExecutionHints = getTreatmentExecutionPromptHints(context)
  const treatmentCostExamples = getTreatmentExecutionCostExamples(context)
  const therapyHints = getAdvancedTherapyPromptHints(context)
  const caseText = [
    `疾病方向：${ruleReport.disease || disease.label}`,
    `治疗摘要：${truncateForPrompt(ruleReport.treatment, 520)}`,
    `主诉：${truncateForPrompt(input.basicInfo.chiefComplaint, 700)}`,
    `患者国家/城市：${input.basicInfo.nationality || '未填'} / ${input.basicInfo.city || '未填'}`,
    `就医诉求：${careNeedLabel || '未填'}`,
    `期望时间：${expectedTreatmentTimeLabel || '未填'}`,
    `路径：${ruleReport.plan.direction}`,
    `周期：${ruleReport.plan.duration}`,
    `已有费用摘要：${ruleReport.plan.breakdown.map((item) => `${item.item}${item.cost}`).join('；')}`,
    `国家对比：${ruleReport.countries.map((country) => `${country.name}${country.fee}`).join('；')}`,
    treatmentExecutionHints.length ? `需要模型重点估算的治疗执行费用关键词：${treatmentExecutionHints.join('；')}。这些关键词来自用户文本/病种参考，是否适用仍由你结合病例判断。` : '',
    therapyHints.length ? `前沿疗法候选关键词：${therapyHints.join('；')}。这些关键词来自用户文本/病种参考，是否适用仍由你结合病例判断。` : '',
    diseaseKey === 'dental' ? `牙科限制：只围绕${dentalPartner.name}和牙科主诉表达，不要写肿瘤治疗、肿瘤MDT或肿瘤药物。` : '',
  ].filter(Boolean).join('\n')

  return [
    {
      role: 'system',
      content: [
        '/no_think',
        '你是寰宇云医简易预审报告的费用、服务包、前沿疗法合并生成助手。',
        '你只生成当前病例的 supplemental JSON，不输出 Markdown，不解释。',
        '所有费用、服务包权益、前沿疗法、药品费用对比、新药治愈判断都必须由你根据当前用户信息生成。',
        '禁止复述或复制用户消息中的 task、requiredTopLevelKeys、outputSchema、hardRules、patientInput、matchedKnowledge、generatedReportBaseline 等字段。',
        '最终 JSON 顶层只能包含 costBreakdown 和 advancedCare；不得把输入说明当作输出。',
        '系统不会自行补药名、补疗法、补医学费用项目或补服务内容；后端只会对你返回的金额做格式化、换算、求和和节省比例计算。',
        '资料不足是最后选项，能审慎估算或给待确认条件时必须由你返回。',
        treatmentCostExamples.length ? `本例 costBreakdown.coreMedical 必须优先列出这些实际治疗执行费用并给可解析金额：${treatmentCostExamples.join('；')}。检查、会诊、MDT或方案评估不能替代这些治疗费用。` : '',
        '拿不准精确数值时，用区间、量级和“需医生确认”表达；只有完全无法支撑时才写资料不足/不适用。',
        '输出要能帮助用户比较选择，不能全部写成泛泛的“需确认”；疗法、药品、费用和适用前提都要尽量具体到当前病例方向。',
        '不得承诺治愈、固定疗效、指定专家一定预约成功、VIP号源一定保留、保险一定报销或临床研究一定入组。',
      ].filter(Boolean).join('\n'),
    },
    {
      role: 'user',
      content: `/no_think\n${JSON.stringify({
        task: '一次性生成简易报告 supplemental JSON',
        requiredTopLevelKeys: ['costBreakdown', 'advancedCare'],
        outputSchema: {
          costBreakdown: {
            currencyNote: '按预审估算汇率约 ￥7.2 = $1 折算，最终以医院报价和付款日汇率为准',
            coreMedical: {
              title: '核心医疗费用',
              subtotal: '￥xx（~$xx）',
              items: [
                { item: '诊断复核/专家会诊', cost: '￥xx（~$xx）', note: '说明' },
                { item: '影像/病理/分子检测', cost: '￥xx（~$xx）', note: '说明' },
                { item: treatmentCostExamples[0] || '具体治疗执行费用', cost: '￥xx（~$xx）', note: '说明' },
                { item: treatmentCostExamples[1] || '住院/日间治疗相关费用', cost: '￥xx（~$xx）', note: '说明' },
              ],
              tip: '说明',
            },
            supportServices: {
              title: '配套服务费用',
              subtotal: '￥xx（~$xx）',
              items: [
                { item: '资料翻译与病历整理', cost: '￥xx（~$xx）', note: '说明' },
                { item: '医院预约与预审协调', cost: '￥xx（~$xx）', note: '说明' },
                { item: '陪诊/口译支持', cost: '￥xx（~$xx）', note: '说明' },
                { item: '远程复诊/随访协调', cost: '￥xx（~$xx）', note: '说明' },
              ],
              tip: '说明',
            },
            living: {
              title: '生活费用',
              subtotal: '￥xx（~$xx）',
              items: [
                { item: '住宿', cost: '￥xx（~$xx）', note: '说明' },
                { item: '市内交通', cost: '￥xx（~$xx）', note: '说明' },
                { item: '餐饮与日常开销', cost: '￥xx（~$xx）', note: '说明' },
                { item: '签证/保险/备用金', cost: '￥xx（~$xx）', note: '说明' },
              ],
              tip: '说明',
            },
            summary: { formula: '核心医疗￥xx + 配套服务￥xx + 生活费用￥xx = ￥xx（约$xx）', chinaTotal: '￥xx（约$xx）', referenceCountry: '本国或患者常住地国家/地区', referenceCost: '$xx,xxx', savingsPercent: 0, savingsText: 'vs 本国治疗$xx,xxx = 节省xx%/Save xx%' },
          },
          advancedCare: {
            context: '基于用户信息说明本节适用前提',
            currencyNote: '汇率和报价说明',
            therapies: [{
              name: '疗法名称；不适用时写审慎评估名称',
              category: '治疗类别',
              recommendationLevel: '优先评估/可讨论/暂不优先/资料不足',
              summary: '一句话价值',
              applicableFor: '适用人群或本例触发条件',
              mechanism: '作用机制或治疗逻辑',
              chinaAccess: '中国可及性或需预审入口',
              estimatedCost: '￥xx（~$xx）',
              referenceCost: '$xx 或资料不足',
              advantage: '中国方案优势或价格/等待/可及性优势',
              evidence: '证据依据或需要确认的前提',
              limitations: '局限与风险，不能承诺疗效',
              nextStep: '下一步补充资料或医生复核动作',
              tags: ['可选短标签'],
            }],
            drugCostComparison: {
              title: '药品费用对比 - 同等疗效候选方案',
              basis: '同等疗效比较医学前提，必须包含同类药同一适应证、仿制药一致性评价、生物类似药、同成分、指南适应证、循证证据限制或需医生确认之一',
              summary: '概括药费差异和适用限制',
              items: [{
                drugName: '药品/药物类别；无适用药物时写“暂无明确适用药物”',
                drugClass: '药物类别',
                chinaOption: '中国可选原研/仿制/生物类似药/集采方案',
                referenceOption: '患者本国或国际市场对照',
                chinaCost: '￥xx（~$xx）或不适用',
                referenceCost: '$xx,xxx 或资料不足',
                efficacyEquivalence: '必须写明同等疗效前提和证据限制，例如同类药同一适应证/仿制药一致性评价/生物类似药/同成分/指南适应证/需医生确认',
                savingInsight: '节省或价格优势说明',
                eligibility: '需要满足的检测/分期/医生判断',
                note: '可选说明',
              }],
              note: '不替代处方，需医生确认适应证、禁忌证和报销/采购可及性',
            },
            newDrugCureAssessment: {
              headline: '是否有新药可治愈?',
              answer: '必须医学审慎，不能承诺治愈',
              summary: '结合当前病例说明新药或临床研究现实目标',
              items: [{
                name: '新药/药物类别/临床研究方向',
                type: '靶向/免疫/ADC/细胞治疗/小分子/不适用等',
                applicableFor: '适用前提',
                evidence: '证据或指南/研究方向概述',
                chinaAvailability: '中国可及性或需预审确认',
                potentialRole: '可能作用：控制、缓解、降低复发风险、姑息等',
                limitations: '不能治愈或证据不足的原因/毒性/耐药',
                nextStep: '检测或医生复核动作',
              }],
              ctaItems: ['建议补充的检测/资料/医生复核事项'],
            },
            disclaimer: '医学审慎声明',
          },
        },
        hardRules: [
          '最终 JSON 顶层只能包含 costBreakdown 和 advancedCare，禁止输出 task、requiredTopLevelKeys、outputSchema、hardRules、patientInput、personalization、matchedKnowledge、generatedReportBaseline、caseText。',
          'costBreakdown 三类 items 均必须输出至少3项，不能把多个项目合并成“其他费用”一项；有依据的 cost 给出可解析金额，可写人民币、美元或两者，例如“约8万人民币”“$11,100”“￥80,000（~$11,100）”。',
          '若用户资料或医学依据不足以支撑精确金额，不要编造精确价格；能给审慎区间时必须给区间并标注需医生确认，完全无法支撑时才写“资料不足，暂不估算/需医生确认”。',
          '费用区间不能过度保守到失去意义；尽量根据项目拆分、治疗强度和停留时间收敛区间。',
          '即使是第二意见/方案比较，coreMedical 也必须给出被比较治疗路径的执行费用区间，不能只输出咨询、检查、复核或MDT费用。',
          'coreMedical 至少1项必须是实际治疗执行费用，例如手术费/麻醉住院、消融、TACE/HAIC介入、放疗疗程、化疗/靶向/免疫药物、支架/搭桥、根管/种植、慢病用药调整、动态血糖监测或并发症筛查等；“可行性评估/方案评估/会诊”只能作为补充项。',
          diseaseKey === 'endocrinology_metabolism' ? '内分泌/糖尿病病例中，coreMedical 应覆盖 HbA1c/血糖趋势复核、并发症筛查（眼底/尿微量白蛋白/周围神经）、CGM/动态血糖监测、个体化用药调整或慢病药物首月费用；不要只写专家咨询。' : '',
          diseaseKey === 'cardiovascular_tumor' ? '心血管肿瘤/心脏占位病例中，coreMedical 应覆盖心脏MRI/经食道超声/心功能评估，以及按条件估算的心脏占位切除手术、介入取栓/导管评估或术后监护费用。' : '',
          diseaseKey === 'lung_cancer' ? '肺癌病例中，coreMedical 应覆盖 EGFR-TKI靶向药物首月/疗程费用、骨转移支持治疗费用，并按症状或承重骨风险写局部放疗/镇痛支持条件性费用；不要只写基因检测、影像、MDT或方案咨询。' : '',
          diseaseKey === 'liver_cancer' ? '肝癌病例中，coreMedical 应覆盖 TACE/HAIC介入、射频/微波消融、系统治疗药物首月或围手术期候选费用，并注明需按肝功能、门静脉侵犯和病灶位置确认；不要只写影像、AFP、肝功能和会诊。' : '',
          treatmentCostExamples.length ? `本例 coreMedical 必须至少包含这些实际费用项中的1项并给可解析金额，能支撑时尽量分别列出：${treatmentCostExamples.join('；')}。不要合并成“主要治疗执行费用”。` : '',
          'summary.referenceCost 有依据时给出患者本国治疗参考费用；summary.formula、chinaTotal、savingsText 可简写，后端会基于你给出的费用数据统一拼装展示公式和节省比例。若依据不足，写“资料不足，暂不计算”。',
          'summary.referenceCost 必须与当前中国方案同口径：若中国费用包含手术/住院/系统治疗，本国参考也应按同类治疗总费用估算，不能只填检查费、会诊费或单项药费。',
          '本次 supplemental 不输出 packages，服务包由并行主报告 patch 生成；不要在本 JSON 中添加 packages 字段。',
          'advancedCare.therapies、drugCostComparison.items、newDrugCureAssessment.items 各1-2项；不适用时也返回完整结构并解释不适用。',
          'advancedCare.therapies.estimatedCost 不要混写“￥8,000 - $1,200”这类跨币种范围；请使用“￥8,000-12,000（~$1,100-1,700）”或单一明确金额。',
          'therapies 必须是治疗/药物/技术方向，不能把检查、检测、病理复核、MDT会诊本身当作前沿疗法。',
          'therapies.name 必须是实际疗法/药物/技术本身，不能写“系统治疗评估”“可行性评估”“治疗路径讨论”“初步评估”“MDT讨论”；这些只能放到 nextStep 或 limitations。',
          therapyHints.length ? `本例优先从这些实际疗法/技术中选择 therapies.name：${therapyHints.join('；')}。不要输出“基因检测”“PD-L1表达分析”“胸腔镜微创手术评估”这类检查或评估名称。` : '',
          'advancedCare 内所有字符串字段都必须是非空字符串；如果无法判断，不要返回空字符串、null 或省略字段，必须写“资料不足，需医生确认”或“当前病例不适用，并说明原因”。',
          'advancedCare 不能输出样例占位词；answer 不能照抄“必须医学审慎，不能承诺治愈”，必须针对当前病例作答。',
          'newDrugCureAssessment.ctaItems 至少1项且每项非空；disclaimer、context、currencyNote、basis、note 都必须非空。',
          '返回前自检：costBreakdown 三类明细数>=4，advancedCare 所有必填字符串非空。',
          'drugCostComparison.basis 和每个 item.efficacyEquivalence 必须说明“同等疗效”的医学前提或资料不足/需医生确认，必须直接包含同类药、同一适应证、同成分、仿制药一致性评价、生物类似药、指南、循证证据、需医生确认等关键词之一；不能只写价格差异。',
          'newDrugCureAssessment.answer 不得写“可以治愈/保证治愈/根治”。',
        ],
        patientInput: {
          locale: input.locale,
          basicInfo: {
            ...input.basicInfo,
            careNeedLabel,
            expectedTreatmentTimeLabel,
            chiefComplaint: truncateForPrompt(input.basicInfo.chiefComplaint, 700),
          },
          selectedRegions: input.selectedRegions,
          hasUploadedMedicalRecords: input.uploadedFiles.length > 0,
        },
        personalization,
        matchedKnowledge: {
          diseaseKey,
          disease: compactDiseaseForPrompt(disease),
          documentKnowledge: compactDocumentKnowledgeForPrompt(documentKnowledge).slice(0, 3),
          structuredMedicalFacts: medicalFacts.hasActionableFacts ? compactMedicalFactsForPrompt(medicalFacts) : null,
        },
        generatedReportBaseline: {
          disease: ruleReport.disease,
          treatment: ruleReport.treatment,
          concerns: ruleReport.concerns,
          hospitals: ruleReport.hospitals,
          plan: ruleReport.plan,
        },
        caseText,
      })}`,
    },
  ]
}

const extractJson = (content: string) => {
  const trimmed = content.trim()
  const start = trimmed.indexOf('{')
  if (start < 0) return trimmed

  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < trimmed.length; index += 1) {
    const char = trimmed[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (char === '\\') {
      escaped = true
      continue
    }
    if (char === '"') {
      inString = !inString
      continue
    }
    if (inString) continue
    if (char === '{') depth += 1
    if (char === '}') {
      depth -= 1
      if (depth === 0) return trimmed.slice(start, index + 1)
    }
  }

  return trimmed.slice(start)
}

const extractJsonObjects = (content: string) => {
  const trimmed = content.trim()
  const objects: string[] = []

  for (let start = 0; start < trimmed.length; start += 1) {
    if (trimmed[start] !== '{') continue

    let depth = 0
    let inString = false
    let escaped = false

    for (let index = start; index < trimmed.length; index += 1) {
      const char = trimmed[index]
      if (escaped) {
        escaped = false
        continue
      }
      if (char === '\\') {
        escaped = true
        continue
      }
      if (char === '"') {
        inString = !inString
        continue
      }
      if (inString) continue
      if (char === '{') depth += 1
      if (char === '}') {
        depth -= 1
        if (depth === 0) {
          objects.push(trimmed.slice(start, index + 1))
          start = index
          break
        }
      }
    }
  }

  return objects
}

const parseJsonText = (jsonText: string) => {
  try {
    return JSON.parse(jsonText) as unknown
  } catch {
    return JSON.parse(jsonrepair(jsonText)) as unknown
  }
}

const asObjectRecord = (value: unknown): Record<string, unknown> | null => (
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
)

const getCostCategoryTitleText = (record: Record<string, unknown> | null) => {
  if (!record) return ''
  const value = record.title ?? record.name ?? record.category ?? record.type ?? record.group ?? record.section ?? record.key ?? record.label ?? record.类别 ?? record.分类 ?? record.分组
  return typeof value === 'string' || typeof value === 'number' ? String(value) : ''
}

const isFlatCostCategoryRecord = (record: Record<string, unknown> | null) => {
  if (!record) return false
  const title = getCostCategoryTitleText(record)
  if (!/核心|医疗|治疗|检查|手术|药物|配套|服务|翻译|陪诊|协调|预约|生活|住宿|交通|餐饮|签证|机票|出行/.test(title)) {
    return false
  }
  const rawItems = record.items ||
    record.details ||
    record.breakdown ||
    record.rows ||
    record.list ||
    record.costItems ||
    record.cost_items ||
    record.费用项 ||
    record.明细 ||
    record.项目
  const hasCategoryCostField = ['subtotal', 'total', 'sum', 'range', 'estimatedTotal', 'estimated_total', 'amount', 'cost', 'fee', 'price', '小计', '总计', '合计', '费用', '价格', '金额']
    .some((key) => record[key] !== undefined)
  const hasItemCostField = Array.isArray(rawItems) && rawItems.some((item) => {
    if (typeof item === 'string') return /[￥¥$]\s*\d|\d+(?:\.\d+)?\s*(?:万|千)?\s*(?:元|人民币|RMB|CNY|USD|美元)/i.test(item)
    const itemRecord = asObjectRecord(item)
    return Boolean(itemRecord && ['cost', 'fee', 'amount', 'price', 'range', 'estimatedCost', 'estimated_cost', '费用', '价格', '金额', '费用区间']
      .some((key) => itemRecord[key] !== undefined))
  })
  return hasCategoryCostField || hasItemCostField
}

const mergeJsonObjects = (items: unknown[]) => (
  items.reduce<Record<string, unknown>>((acc, item) => {
    const record = asObjectRecord(item)
    if (!record) return acc
    if (!isFlatCostCategoryRecord(record)) return { ...acc, ...record }
    const categories = Array.isArray(acc.categories) ? acc.categories : []
    return {
      ...acc,
      categories: [...categories, record],
    }
  }, {})
)

const parseLlmJson = (content: string) => {
  const candidates = extractJsonObjects(content)
  const parsedCandidates = candidates.flatMap((candidate) => {
    try {
      return [parseJsonText(candidate)]
    } catch {
      return []
    }
  })

  if (parsedCandidates.length === 1) return parsedCandidates[0]
  if (parsedCandidates.length > 1) {
    const merged = mergeJsonObjects(parsedCandidates)
    if (Object.keys(merged).length) return merged
    return parsedCandidates[0]
  }

  const jsonText = extractJson(content)
  try {
    return parseJsonText(jsonText)
  } catch (parseError) {
    try {
      const greedyMatch = content.trim().match(/\{[\s\S]*\}/)
      if (!greedyMatch) throw parseError
      return parseJsonText(greedyMatch[0])
    } catch (greedyError) {
      throw new Error(`LLM JSON parse failed: ${sanitizeGenerationError(parseError)}; repair failed: ${sanitizeGenerationError(greedyError)}`)
    }
  }
}

const nonEmptyArray = <T>(value: T[] | undefined) => (Array.isArray(value) && value.length ? value : undefined)

const getLlmPackageItems = (value: LlmPatchEnvelope) => (
  nonEmptyArray(value.packages as GeneratedReport['packages'] | undefined) ||
  nonEmptyArray(value.servicePackages as GeneratedReport['packages'] | undefined) ||
  nonEmptyArray(value.professionalPackages as GeneratedReport['packages'] | undefined) ||
  nonEmptyArray(value.professionalServicePackages as GeneratedReport['packages'] | undefined) ||
  nonEmptyArray(value.evaluationPackages as GeneratedReport['packages'] | undefined)
)

const unwrapLlmEnvelope = (value: LlmPatchEnvelope): LlmPatchEnvelope => {
  const record = asObjectRecord(value)
  if (!record) return value

  const nestedKeys = ['report', 'simpleReport', 'freeReport', 'data', 'result', 'output', '简易报告', '报告']
  for (const key of nestedKeys) {
    const nested = asObjectRecord(record[key])
    if (nested) return { ...value, ...nested } as LlmPatchEnvelope
  }

  return value
}

const getLlmAdvantages = (value: LlmPatchEnvelope) => (
  nonEmptyArray(value.advantages) ||
  nonEmptyArray((value as Record<string, unknown>).strengths as GeneratedReport['advantages'] | undefined) ||
  nonEmptyArray((value as Record<string, unknown>).benefits as GeneratedReport['advantages'] | undefined) ||
  nonEmptyArray((value as Record<string, unknown>).keyAdvantages as GeneratedReport['advantages'] | undefined) ||
  nonEmptyArray((value as Record<string, unknown>).优势 as GeneratedReport['advantages'] | undefined) ||
  nonEmptyArray((value as Record<string, unknown>).中国优势 as GeneratedReport['advantages'] | undefined)
)

const getLlmConcerns = (value: LlmPatchEnvelope) => (
  nonEmptyArray(value.concerns) ||
  nonEmptyArray((value as Record<string, unknown>).risks as GeneratedReport['concerns'] | undefined) ||
  nonEmptyArray((value as Record<string, unknown>).riskManagement as GeneratedReport['concerns'] | undefined) ||
  nonEmptyArray((value as Record<string, unknown>).关注点 as GeneratedReport['concerns'] | undefined) ||
  nonEmptyArray((value as Record<string, unknown>).风险提示 as GeneratedReport['concerns'] | undefined)
)

const getLlmHighlights = (value: LlmPatchEnvelope) => (
  normalizeStringList(value.highlights).length ? normalizeStringList(value.highlights) :
    normalizeStringList((value as Record<string, unknown>).keyPoints).length ? normalizeStringList((value as Record<string, unknown>).keyPoints) :
      normalizeStringList((value as Record<string, unknown>).summaryHighlights).length ? normalizeStringList((value as Record<string, unknown>).summaryHighlights) :
        normalizeStringList((value as Record<string, unknown>).亮点).length ? normalizeStringList((value as Record<string, unknown>).亮点) :
          normalizeStringList((value as Record<string, unknown>).要点)
)

const getLlmPaymentAndInsurance = (value: LlmPatchEnvelope) => {
  const record = asObjectRecord(value)
  const raw = value.paymentAndInsurance ||
    record?.paymentPreparation ||
    record?.paymentAndInsurancePreparation ||
    record?.insurancePreparation ||
    record?.budgetPreparation ||
    record?.支付保险准备 ||
    record?.支付与保险 ||
    record?.保险支付
  const items = normalizeStringList(raw)
  return items.length ? items : undefined
}

const getLlmPlanPatch = (value: LlmPatchEnvelope) => {
  const record = asObjectRecord(value)
  const planRecord = asObjectRecord(value.plan) ||
    asObjectRecord(record?.treatmentPlan) ||
    asObjectRecord(record?.treatmentPathway) ||
    asObjectRecord(record?.carePlan) ||
    asObjectRecord(record?.pathway) ||
    asObjectRecord(record?.治疗路径) ||
    asObjectRecord(record?.就医路径) ||
    asObjectRecord(record?.路径)
  if (!planRecord) return value.plan

  const direction = pickStringValue(planRecord, ['direction', 'pathway', 'steps', 'route', 'recommendation', '治疗路径', '路径', '方向'])
  const duration = pickStringValue(planRecord, ['duration', 'timeline', 'stayDuration', 'period', '周期', '时长', '停留时间'])
  const totalCost = pickStringValue(planRecord, ['totalCost', 'total', 'budget', 'cost', '费用总计', '总费用', '预算'])
  const breakdown = pickUnknown(planRecord, ['breakdown', 'items', 'steps', 'costItems', '费用项', '明细', '步骤'])

  return {
    ...planRecord,
    direction: direction || planRecord.direction,
    duration: duration || planRecord.duration,
    totalCost: totalCost || planRecord.totalCost,
    breakdown: breakdown || planRecord.breakdown,
  } as Partial<GeneratedReport['plan']>
}

const getLlmCostBreakdown = (value: LlmPatchEnvelope): unknown => {
  if (Array.isArray(value)) return value
  const record = asRecord(value)
  const direct = value.plan?.costBreakdown ||
    value.costBreakdown ||
    value.cost_breakdown ||
    value.costDetails ||
    value.cost_breakdown_details ||
    value.costs ||
    value.cost ||
    value.expenses ||
    value.expenseBreakdown ||
    value.expense_breakdown ||
    value.feeBreakdown ||
    value.fee_breakdown ||
    value.budget ||
    value.budgetBreakdown ||
    value.budget_breakdown ||
    value.detailedCosts ||
    value.detailedCostBreakdown ||
    value.detailed_cost_breakdown ||
    value.medicalCosts ||
    value.medical_costs ||
    record?.categories ||
    record?.costCategories ||
    record?.cost_categories ||
    record?.groups ||
    record?.sections ||
    record?.费用类别 ||
    record?.费用分类 ||
    record?.费用分组 ||
    (value as Record<string, unknown>).费用拆分 ||
    (value as Record<string, unknown>).费用明细 ||
    (value as Record<string, unknown>).费用预算
  if (direct) return direct

  if (!record) return undefined
  const nestedKeys = ['report', 'simpleReport', 'freeReport', 'data', 'result', 'output', 'plan', '简易报告', '报告']
  for (const key of nestedKeys) {
    const nested = asRecord(record[key])
    if (!nested) continue
    const nestedCost = getLlmCostBreakdown(nested as LlmPatchEnvelope)
    if (nestedCost) return nestedCost
  }

  const hasCostLikeKeys = [
    'coreMedical',
    'core_medical',
    'medical',
    'services',
    'supportServices',
    'support_services',
    'living',
    'life',
    '核心医疗',
    '核心医疗费用',
    '配套服务',
    '配套服务费用',
    '生活费用',
  ].some((key) => record[key] !== undefined)
  const hasCostLikeKeyPattern = Object.keys(record).some((key) => (
    /核心|医疗|治疗|检查|手术|药物|配套|服务|翻译|陪诊|生活|住宿|交通|餐饮|签证|费用|cost|expense|budget|fee/i.test(key)
  ))
  return hasCostLikeKeys || hasCostLikeKeyPattern ? value : undefined
}

type AdvancedCare = NonNullable<GeneratedReport['advancedCare']>
type DetailedCostBreakdown = NonNullable<GeneratedReport['plan']['costBreakdown']>
type ReportPackage = GeneratedReport['packages'][number]
type ReportCountry = GeneratedReport['countries'][number]
type ReportAdvantage = GeneratedReport['advantages'][number]
type ReportConcern = GeneratedReport['concerns'][number]
type ReportHospital = GeneratedReport['hospitals'][number]
type ReportPlanBreakdownItem = GeneratedReport['plan']['breakdown'][number]

const treatmentExecutionPattern = /手术费|手术|麻醉|住院|围术期|ICU|体外循环|占位切除|肿物切除|取栓|导管治疗|导管评估|介入活检|消融|TACE|HAIC|介入治疗|介入|靶向治疗|靶向|免疫治疗|免疫|放疗|化疗|放化疗|同步放化疗|药物治疗|系统治疗|辅助治疗|新辅助|内分泌治疗|抗肿瘤|用药|药品|药物|首月|周期|疗程|根管治疗|种植手术|种植|修复|支架|搭桥|CABG|PCI|放射外科|伽玛刀|质子|重离子|TKI|EGFR|ALK|ROS1|PD-?1|PD-?L1|CDK4\/6|ADC|奥希替尼|阿美替尼|伏美替尼|替莫唑胺|贝伐珠单抗|帕博利珠单抗|纳武利尤单抗|特瑞普利单抗|胰岛素|GLP-?1|SGLT2|CGM|动态血糖|血糖监测|并发症筛查|眼底|尿微量白蛋白|周围神经|神经传导/i
const assessmentOnlyPattern = /可行性评估|方案评估|治疗评估|系统治疗评估|初步评估|路径评估|路径讨论|方案讨论|MDT|会诊|咨询|复核|检查|检测|影像|病理|诊断复核/i
const advancedTherapyPattern = /免疫|靶向|ADC|CAR-?T|TIL|细胞|放疗|介入|消融|HAIC|TACE|质子|重离子|微创|机器人|临床研究|新药|药物|治疗|手术|支架|搭桥|根管|种植/i
const nonTherapyNamePattern = /^(检查|检测|基因检测|分子检测|NGS|PD-?L1表达|PD-?L1表达分析|会诊|MDT|病理|病理复核|影像|影像复核|诊断复核)/i
const therapyAssessmentNamePattern = /评估|可行性|方案评估|治疗评估|系统治疗评估|治疗路径|路径讨论|方案讨论|初步评估|MDT讨论|会诊|分析/i

const isTreatmentExecutionCostItem = (item: DetailedCostBreakdown['coreMedical']['items'][number]) => {
  const label = normalizeRequiredString(item.item)
  const combined = `${label} ${item.note || ''}`
  if (!hasParsedMoney(item.cost)) return false
  if (!treatmentExecutionPattern.test(combined)) return false
  if (assessmentOnlyPattern.test(label)) return false
  if (/^(主要治疗项目|主要治疗执行费用|治疗执行费用|治疗或用药费用|治疗费用)$/i.test(label)) return false
  if (/住院|围术期/.test(label) && !/手术|介入|PCI|支架|搭桥|CABG|消融|TACE|HAIC|治疗/i.test(label)) return false
  return true
}

const isChronicCareExecutionCostItem = (item: DetailedCostBreakdown['coreMedical']['items'][number]) => {
  const combined = `${item.item} ${item.note || ''}`
  if (!hasParsedMoney(item.cost)) return false
  return /用药|药物|胰岛素|GLP-?1|SGLT2|二甲双胍|CGM|连续血糖|动态血糖|血糖监测|并发症筛查|眼底|尿微量白蛋白|神经传导|周围神经|营养|运动|远程随访|管理方案/i.test(combined)
}

const isActualAdvancedTherapy = (therapy: AdvancedCare['therapies'][number]) => {
  const name = therapy.name.trim()
  if (!name || isSoftPlaceholderText(name)) return false
  const text = `${therapy.name} ${therapy.category} ${therapy.summary}`
  if (!advancedTherapyPattern.test(text)) return false
  if (nonTherapyNamePattern.test(name)) return false
  if (therapyAssessmentNamePattern.test(name)) return false
  return true
}

const hasMixedCurrencyRange = (value?: string) => (
  Boolean(value && /[￥¥][\d,.]+(?:\s*(?:-|~|到|至)\s*)\$[\d,.]+/i.test(value))
)

const isUnavailableAdvancedTherapy = (therapy: AdvancedCare['therapies'][number]) => (
  isSoftPlaceholderText(therapy.name) ||
  isSoftPlaceholderText(therapy.category) ||
  /不适用|暂无|未能|不能判断/.test(`${therapy.name} ${therapy.summary} ${therapy.applicableFor}`)
)

const getLlmAdvancedCare = (value: LlmPatchEnvelope & Partial<AdvancedCare>) => (
  (value.advancedCare as unknown) ||
  value.frontierCare ||
  value.advancedTherapies ||
  value.advancedTherapyRecommendations ||
  value.frontierTherapyRecommendations ||
  value.drugAndTherapyInsights ||
  (value as Record<string, unknown>).advancedCareRecommendations ||
  (value as Record<string, unknown>).frontierTherapies ||
  (value as Record<string, unknown>).frontierTreatment ||
  (value as Record<string, unknown>).前沿疗法 ||
  (value as Record<string, unknown>).前沿治疗 ||
  (value as Record<string, unknown>).药品费用对比 ||
  (Array.isArray(value.therapies) && value.drugCostComparison && value.newDrugCureAssessment
    ? value as AdvancedCare
    : undefined)
)

const asRecord = (value: unknown) => (
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
)

const pickUnknown = (record: Record<string, unknown> | null, keys: string[]) => {
  if (!record) return undefined
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null) return record[key]
  }
  return undefined
}

const pickStringValue = (record: Record<string, unknown> | null, keys: string[]) => {
  const value = pickUnknown(record, keys)
  return normalizeRequiredString(value)
}

const dropNullFields = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(dropNullFields)
  if (!value || typeof value !== 'object') return value

  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entryValue]) => entryValue !== null)
      .map(([key, entryValue]) => [key, dropNullFields(entryValue)]),
  )
}

const summarizeObjectShape = (value: unknown, depth = 0): unknown => {
  if (depth > 1) return Array.isArray(value) ? `array(${value.length})` : typeof value
  if (Array.isArray(value)) {
    return {
      type: 'array',
      length: value.length,
      first: value.length ? summarizeObjectShape(value[0], depth + 1) : undefined,
    }
  }
  const record = asRecord(value)
  if (!record) return typeof value
  return Object.fromEntries(Object.entries(record).slice(0, 20).map(([key, entry]) => {
    const entryRecord = asRecord(entry)
    return [
      key,
      Array.isArray(entry)
        ? `array(${entry.length})`
        : entryRecord
          ? Object.keys(entryRecord).slice(0, 12)
          : typeof entry,
    ]
  }))
}

const normalizePackageFeatureStatus = (value: unknown, label?: unknown) => {
  const labelText = typeof label === 'string' ? label : ''
  const normalized = typeof value === 'string' ? value.toLowerCase() : ''
  if (normalized.includes('excluded')) return 'excluded'
  if (normalized.includes('emphasis')) return 'emphasis'
  if (normalized.includes('included')) return 'included'
  if (/不含|无|未包含|不包括|不安排|no\s+video|without/i.test(labelText) && /视频|面诊|video|consult/i.test(labelText)) return 'excluded'
  if (/视频|面诊|答疑|跟进|MDT|多学科|会诊/i.test(labelText) && /重点|突出|emphasis|优先/i.test(`${normalized} ${labelText}`)) return 'emphasis'
  return undefined
}

const normalizeStringList = (value: unknown) => {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
  if (typeof value === 'string' && value.trim()) return value.split(/[；;、\n]/).map((item) => item.trim()).filter(Boolean)
  return []
}

const normalizeOptionalString = (value: unknown) => {
  if (typeof value === 'string') return value
  if (typeof value === 'number') return String(value)
  return undefined
}

const normalizeOptionalScore = (value: unknown) => {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.min(100, Math.round(value)))
  if (typeof value === 'string') {
    const match = value.match(/\d{1,3}/)
    if (match) return Math.max(0, Math.min(100, Number(match[0])))
  }
  return undefined
}

const normalizeRequiredString = (value: unknown) => {
  const normalized = normalizeOptionalString(value)
  return normalized ? normalized.replace(/¥/g, '￥').trim() : ''
}

const softLlmMissing = (field = '该项') => `${field}需结合资料预审后确认。`

const isSoftPlaceholderText = (value?: string) => /需预审|待确认|暂不|资料不足|未返回/.test(value || '')

const compactCostText = (...values: unknown[]) => values
  .map(normalizeRequiredString)
  .filter(Boolean)
  .join(' / ')

const normalizeMixedCurrencyPairText = (value: unknown) => {
  const text = normalizeRequiredString(value)
  if (!text) return ''
  return text.replace(
    /[￥¥]\s*([\d,.]+(?:万)?)(?:\s*(?:-|~|到|至)\s*)\$\s*([\d,.]+(?:万)?)/gi,
    '￥$1（~$$$2）',
  )
}

const normalizeCurrencyField = (value: unknown, currency: 'cny' | 'usd') => {
  const text = normalizeRequiredString(value)
  if (!text) return ''
  if (/[￥¥$]|人民币|美元|RMB|CNY|USD/i.test(text)) return text
  return currency === 'cny' ? `￥${text}` : `$${text}`
}

const normalizeCurrencyRange = (min: unknown, max: unknown, currency: 'cny' | 'usd') => {
  const minText = normalizeCurrencyField(min, currency)
  const maxText = normalizeCurrencyField(max, currency)
  if (minText && maxText && minText !== maxText) return `${minText}-${maxText}`
  return minText || maxText
}

const normalizeLlmPackageItems = (packageItems?: unknown): GeneratedReport['packages'] | undefined => {
  if (!Array.isArray(packageItems)) return undefined

  const normalized: ReportPackage[] = []
  packageItems.forEach((pkg, index) => {
    const record = asRecord(pkg)
    if (!record && typeof pkg !== 'string') return
    const reference = packages[index] || packages[packages.length - 1]
    const name = typeof pkg === 'string'
      ? pkg
      : pickStringValue(record, ['name', 'tier', 'title', 'packageName', 'package_name', '服务包', '名称'])
    const subtitle = pickStringValue(record, ['subtitle', 'summary', 'description', '适合人群', '说明'])
    const rawFeatures = normalizeStringList(pickUnknown(record, ['features', 'items', 'benefits', 'includes', '权益', '服务内容', 'summaryItems']))
    const rawDetails = pickUnknown(record, ['featureDetails', 'feature_details', 'details', 'detailItems', 'serviceDetails', 'services', '权益明细', '服务明细', 'includes'])
    const rawFeatureDetails: NonNullable<ReportPackage['featureDetails']> = []
    const addFeatureDetail = (feature: unknown, fallbackStatus?: 'included' | 'excluded' | 'emphasis') => {
      if (typeof feature === 'string') {
        rawFeatureDetails.push({
          label: feature.trim(),
          status: (fallbackStatus || normalizePackageFeatureStatus(undefined, feature) || 'included') as 'included' | 'excluded' | 'emphasis',
        })
        return
      }
      const featureRecord = asRecord(feature)
      const label = pickStringValue(featureRecord, ['label', 'name', 'item', 'title', 'service', 'value', 'description', '权益', '项目', '服务'])
      if (!label) return
      rawFeatureDetails.push({
        label,
        status: (fallbackStatus || normalizePackageFeatureStatus(pickUnknown(featureRecord, ['status', 'type', '状态']), label)) as 'included' | 'excluded' | 'emphasis' | undefined,
      })
    }
    const structuredDetailGroups = [
      ['included', 'included'],
      ['includes', 'included'],
      ['包含', 'included'],
      ['已包含', 'included'],
      ['excluded', 'excluded'],
      ['excludes', 'excluded'],
      ['不含', 'excluded'],
      ['不包含', 'excluded'],
      ['emphasis', 'emphasis'],
      ['highlights', 'emphasis'],
      ['重点', 'emphasis'],
      ['强化', 'emphasis'],
    ] as Array<[string, 'included' | 'excluded' | 'emphasis']>
    if (Array.isArray(rawDetails)) {
      rawDetails.forEach((feature) => addFeatureDetail(feature))
    } else {
      const detailRecord = asRecord(rawDetails)
      if (detailRecord) {
        structuredDetailGroups.forEach(([key, status]) => {
          const value = detailRecord[key]
          if (Array.isArray(value)) value.forEach((feature) => addFeatureDetail(feature, status))
          else if (value) addFeatureDetail(value, status)
        })
      }
    }
    structuredDetailGroups.forEach(([key, status]) => {
      const value = record?.[key]
      if (Array.isArray(value)) value.forEach((feature) => addFeatureDetail(feature, status))
      else if (value) addFeatureDetail(value, status)
    })
    const featuresFromDetails = rawFeatureDetails.map((feature) => feature.label).filter(Boolean)
    const features = unique([...rawFeatures, ...featuresFromDetails]).slice(0, Math.max(1, Math.min(3, rawFeatures.length || featuresFromDetails.length || 1)))
    if (!features.length) features.push(softLlmMissing('服务摘要'))
    const promotedFeatureDetails = features
      .map((feature) => ({
        label: feature,
        status: (normalizePackageFeatureStatus(undefined, feature) || 'included') as 'included' | 'excluded' | 'emphasis',
      }))
      .filter((feature) => !rawFeatureDetails.some((detail) => normalizeText(detail.label).includes(normalizeText(feature.label))))
    const featureDetails = [...rawFeatureDetails, ...promotedFeatureDetails]
    if (!featureDetails.length) {
      featureDetails.push({
        label: softLlmMissing('服务明细'),
        status: 'included',
      })
    }

    normalized.push({
      name: name || reference.name,
      subtitle: subtitle || softLlmMissing('服务包说明'),
      price: compactCostText(pickUnknown(record, ['price', 'fee', 'amount', 'usdPrice', '价格', '费用'])) || reference.price || '需预审确认',
      originalPrice: compactCostText(pickUnknown(record, ['originalPrice', 'original_price', 'rmbPrice', '人民币价格', '原价'])) || reference.originalPrice,
      badge: pickStringValue(record, ['badge', 'tag', 'label', '徽标']) || reference.badge,
      cta: pickStringValue(record, ['cta', 'buttonText', 'action', '按钮']) || reference.cta,
      icon: pickStringValue(record, ['icon', 'iconName', '图标']) || reference.icon,
      highlight: typeof pickUnknown(record, ['highlight', 'recommended', 'popular', '推荐']) === 'boolean'
        ? Boolean(pickUnknown(record, ['highlight', 'recommended', 'popular', '推荐']))
        : reference.highlight,
      features,
      featureDetails,
      footnote: pickStringValue(record, ['footnote', 'note', 'remark', '注意事项', '脚注']) || softLlmMissing('服务包注意事项'),
    })
  })

  return normalized.length ? normalized : undefined
}

const COST_EXCHANGE_RATE = 7.2

const formatInteger = (value: number) => Math.max(0, Math.round(value)).toLocaleString('en-US')
const formatCny = (value: number) => `￥${formatInteger(value)}`
const formatUsd = (value: number) => `$${formatInteger(value)}`

type ParsedMoney = {
  cny?: number
  usd?: number
}

const averageRange = (first?: number, second?: number) => {
  if (typeof first !== 'number' || Number.isNaN(first)) return undefined
  if (typeof second !== 'number' || Number.isNaN(second)) return first
  return (first + second) / 2
}

const parsePlainNumber = (value?: string) => {
  if (!value) return undefined
  const normalized = value.replace(/,/g, '')
  const number = Number(normalized)
  return Number.isFinite(number) ? number : undefined
}

const parseMoneyPair = (value?: string): ParsedMoney => {
  const text = (value || '').replace(/¥/g, '￥').replace(/\s+/g, ' ')
  const cnySymbol = text.match(/[￥]\s*([\d,.]+)\s*(万)?(?:\s*(?:-|~|到|至)\s*[￥]?\s*([\d,.]+)\s*(万)?)?/i)
  const cnyText = text.match(/(?:人民币|RMB|CNY)\s*([\d,.]+)\s*(万)?(?:\s*(?:-|~|到|至)\s*([\d,.]+)\s*(万)?)?/i) ||
    text.match(/([\d,.]+)\s*(万)?\s*(?:元人民币|人民币|元|RMB|CNY)/i)
  const usdSymbol = text.match(/\$\s*([\d,.]+)\s*(万)?(?:\s*(?:-|~|到|至)\s*\$?\s*([\d,.]+)\s*(万)?)?/i)
  const usdText = text.match(/(?:USD|美元)\s*([\d,.]+)\s*(万)?(?:\s*(?:-|~|到|至)\s*([\d,.]+)\s*(万)?)?/i) ||
    text.match(/([\d,.]+)\s*(万)?\s*(?:美元|USD)/i)

  const readMatch = (match: RegExpMatchArray | null) => {
    if (!match) return undefined
    const first = parsePlainNumber(match[1])
    const second = parsePlainNumber(match[3])
    const firstUnit = match[2] === '万' ? 10000 : 1
    const secondUnit = match[4] === '万' ? 10000 : firstUnit
    return averageRange(
      typeof first === 'number' ? first * firstUnit : undefined,
      typeof second === 'number' ? second * secondUnit : undefined,
    )
  }

  const cny = readMatch(cnySymbol) ?? readMatch(cnyText)
  const usd = readMatch(usdSymbol) ?? readMatch(usdText)
  if (typeof cny === 'number') {
    return { cny, usd: cny / COST_EXCHANGE_RATE }
  }
  return {
    cny: typeof usd === 'number' ? usd * COST_EXCHANGE_RATE : undefined,
    usd,
  }
}

const hasParsedMoney = (value?: string) => {
  const parsed = parseMoneyPair(value)
  return typeof parsed.cny === 'number' || typeof parsed.usd === 'number'
}

const hasMoneyPair = (value: ParsedMoney): value is ParsedMoney & ({ cny: number } | { usd: number }) => (
  typeof value.cny === 'number' || typeof value.usd === 'number'
)

const formatMoneyPair = (parsed: ParsedMoney, fallback?: string) => {
  const cny = parsed.cny ?? (typeof parsed.usd === 'number' ? parsed.usd * COST_EXCHANGE_RATE : undefined)
  const usd = typeof cny === 'number'
    ? cny / COST_EXCHANGE_RATE
    : parsed.usd
  if (typeof cny !== 'number' || typeof usd !== 'number') return normalizeRequiredString(fallback)
  return `${formatCny(cny)}（~${formatUsd(usd)}）`
}

const sumMoneyPairs = (items: ParsedMoney[]): ParsedMoney => {
  const moneyItems = items.filter(hasMoneyPair)
  if (!moneyItems.length) return {}
  const cny = moneyItems.reduce((sum, item) => sum + (item.cny ?? (typeof item.usd === 'number' ? item.usd * COST_EXCHANGE_RATE : 0)), 0)
  const usd = moneyItems.reduce((sum, item) => sum + (item.usd ?? (typeof item.cny === 'number' ? item.cny / COST_EXCHANGE_RATE : 0)), 0)
  return { cny, usd }
}

const normalizeFreeCostItem = (value: unknown): DetailedCostBreakdown['coreMedical']['items'][number] | null => {
  if (typeof value === 'string' && value.trim()) {
    return {
      item: value.replace(/[￥¥$][\d,.万\s~至到-]+.*/, '').trim() || value,
      cost: value,
      note: value,
    }
  }

  const record = asRecord(value)
  if (!record) return null
  const item = pickStringValue(record, ['item', 'name', 'project', 'title', 'service', 'category', 'phase', 'stage', 'treatment', 'therapy', 'procedure', '费用项目', '项目', '阶段', '治疗项目'])
  const cost = compactCostText(
    pickUnknown(record, ['cost', 'fee', 'amount', 'price', 'range', 'estimatedCost', 'estimated_cost', 'estimatedAmount', 'estimated_amount', '费用', '价格', '金额', '费用区间']),
    normalizeCurrencyField(pickUnknown(record, ['amountRmb', 'rmb', 'cny', 'rmbCost', 'cnyCost', 'RMB', 'CNY', '人民币', '人民币费用']), 'cny'),
    normalizeCurrencyRange(pickUnknown(record, ['minRmb', 'minCny', 'rmbMin', 'cnyMin']), pickUnknown(record, ['maxRmb', 'maxCny', 'rmbMax', 'cnyMax']), 'cny'),
    normalizeCurrencyField(pickUnknown(record, ['amountUsd', 'usd', 'usdCost', 'USD', '美元', '美元费用']), 'usd'),
    normalizeCurrencyRange(pickUnknown(record, ['minUsd', 'usdMin']), pickUnknown(record, ['maxUsd', 'usdMax']), 'usd'),
  )
  const note = pickStringValue(record, ['note', 'description', 'basis', 'remark', 'explanation', '说明', '备注'])

  if (!item && !cost) return null
  return {
    item: item || '费用项目',
    cost: cost || '需医生确认',
    note: note || undefined,
  }
}

const normalizeFreeCostCategory = (
  value: unknown,
  title: string,
): DetailedCostBreakdown['coreMedical'] | null => {
  const record = asRecord(value)
  const rawItems = Array.isArray(value)
    ? value
    : pickUnknown(record, ['items', 'details', 'breakdown', 'rows', 'list', 'lineItems', 'line_items', 'costItems', 'cost_items', '费用项', '明细', '项目', '清单'])
  const items = Array.isArray(rawItems)
    ? rawItems.map(normalizeFreeCostItem).filter((item): item is DetailedCostBreakdown['coreMedical']['items'][number] => Boolean(item))
    : []
  if (!record && !items.length) return null

  const subtotal = compactCostText(
    pickUnknown(record, ['subtotal', 'total', 'sum', 'range', 'estimatedTotal', 'estimated_total', 'amount', 'cost', 'fee', '小计', '总计', '合计']),
    normalizeCurrencyField(pickUnknown(record, ['subtotalRmb', 'totalRmb', 'amountRmb', 'rmb', 'cny', 'RMB', 'CNY', '人民币']), 'cny'),
    normalizeCurrencyRange(pickUnknown(record, ['minRmb', 'minCny', 'rmbMin', 'cnyMin']), pickUnknown(record, ['maxRmb', 'maxCny', 'rmbMax', 'cnyMax']), 'cny'),
    normalizeCurrencyField(pickUnknown(record, ['subtotalUsd', 'totalUsd', 'amountUsd', 'usd', 'USD', '美元']), 'usd'),
    normalizeCurrencyRange(pickUnknown(record, ['minUsd', 'usdMin']), pickUnknown(record, ['maxUsd', 'usdMax']), 'usd'),
  )

  return {
    title: pickStringValue(record, ['title', 'name', 'category', 'type', 'group', 'section', 'key', 'label', '类别', '分类']) || title,
    subtotal,
    items,
    tip: pickStringValue(record, ['tip', 'note', 'remark', '说明']) || undefined,
  }
}

const normalizeFreeCostBreakdownInput = (value?: unknown): GeneratedReport['plan']['costBreakdown'] | undefined => {
  const record = asRecord(value)
  const embeddedCategoryList = pickUnknown(record, [
    'categories',
    'costCategories',
    'cost_categories',
    'groups',
    'sections',
    '费用类别',
    '费用分类',
    '费用分组',
  ])
  const flatItems = pickUnknown(record, ['items', 'details', 'breakdown', 'rows', 'list', 'costItems', 'cost_items', '费用项', '明细', '项目'])
  const categoryList = Array.isArray(value)
    ? value
    : Array.isArray(embeddedCategoryList)
      ? embeddedCategoryList
      : null
  if (!record && !categoryList) return undefined

  const findCategory = (patterns: RegExp[], aliases: string[]) => {
    if (categoryList) {
      const matched = categoryList.find((item) => {
        const itemRecord = asRecord(item)
        const title = pickStringValue(itemRecord, ['title', 'name', 'category', 'type', 'group', 'section', 'key', 'label', '类别', '分类', '分组'])
        return patterns.some((pattern) => pattern.test(title))
      })
      if (matched) return matched
    }
    if (Array.isArray(flatItems)) {
      const matchedItems = flatItems.filter((item) => {
        const itemRecord = asRecord(item)
        const label = pickStringValue(itemRecord, ['category', 'type', 'group', 'section', 'title', 'key', 'label', '类别', '分类', '分组'])
        return patterns.some((pattern) => pattern.test(label))
      })
      if (matchedItems.length) return matchedItems
    }
    const direct = pickUnknown(record, aliases)
    if (direct) return direct
    if (!record) return undefined
    const recordTitle = getCostCategoryTitleText(record)
    if (patterns.some((pattern) => pattern.test(recordTitle))) return record
    const matchedEntry = Object.entries(record).find(([key]) => patterns.some((pattern) => pattern.test(key)))
    return matchedEntry?.[1]
  }

  const coreMedical = normalizeFreeCostCategory(
    findCategory([/核心|医疗|治疗|检查|手术|药物/], ['coreMedical', 'core_medical', 'medical', 'medicalCosts', 'medical_costs', 'coreMedicalCosts', 'treatmentCosts', 'treatment', 'therapyCosts', 'procedureCosts', 'clinicalCosts', '医疗', '核心医疗', '核心医疗费用', '医疗费用', '治疗费用', '临床费用']),
    '核心医疗费用',
  )
  const supportServices = normalizeFreeCostCategory(
    findCategory([/配套|服务|翻译|陪诊|协调|预约/], ['supportServices', 'support_services', 'services', 'serviceCosts', 'supportCosts', 'coordinationCosts', 'translationCosts', 'assistantServices', 'valueAddedServices', '配套服务', '配套服务费用', '服务费用', '协调服务', '翻译陪诊']),
    '配套服务费用',
  )
  const living = normalizeFreeCostCategory(
    findCategory([/生活|住宿|交通|餐饮|签证|机票|出行/], ['living', 'livingCosts', 'living_costs', 'livingExpenses', 'lifeCosts', 'travelCosts', 'accommodationCosts', 'stayCosts', 'dailyCosts', '生活费用', '在华生活费用', '生活开销', '出行生活']),
    '生活费用',
  )
  if (!coreMedical || !supportServices || !living) return undefined

  const summaryRecord = asRecord(pickUnknown(record, ['summary', 'totalSummary', 'costSummary', 'comparison', 'savings', '费用汇总', '汇总'])) || {}
  const summarySource = { ...record, ...summaryRecord }
  return {
    currencyNote: pickStringValue(record, ['currencyNote', 'currency', 'currency_note', 'note', 'exchangeRateNote', '汇率说明', '币种说明']),
    coreMedical,
    supportServices,
    living,
    summary: {
      formula: pickStringValue(summarySource, ['formula', 'calculation', '公式']),
      chinaTotal: pickStringValue(summarySource, ['chinaTotal', 'total', 'china_total', 'grandTotal', 'grand_total', '中国总费用', '总费用']),
      referenceCountry: pickStringValue(summarySource, ['referenceCountry', 'country', 'reference_country', 'homeCountry', 'localCountry', '对照国家', '本国']),
      referenceCost: compactCostText(
        pickUnknown(summarySource, ['referenceCost', 'homeCountryCost', 'localCost', 'comparisonCost', 'comparatorCost', '本国治疗费用', '对照费用', '当地治疗费用']),
        normalizeCurrencyField(pickUnknown(summarySource, ['referenceCostUsd', 'homeCountryCostUsd', 'usd', 'USD', '美元']), 'usd'),
        normalizeCurrencyRange(pickUnknown(summarySource, ['referenceMinUsd', 'homeCountryMinUsd', 'usdMin']), pickUnknown(summarySource, ['referenceMaxUsd', 'homeCountryMaxUsd', 'usdMax']), 'usd'),
        normalizeCurrencyField(pickUnknown(summarySource, ['referenceCostRmb', 'homeCountryCostRmb', 'cny', 'rmb', 'CNY', 'RMB', '人民币']), 'cny'),
        normalizeCurrencyRange(pickUnknown(summarySource, ['referenceMinRmb', 'referenceMinCny', 'rmbMin', 'cnyMin']), pickUnknown(summarySource, ['referenceMaxRmb', 'referenceMaxCny', 'rmbMax', 'cnyMax']), 'cny'),
      ),
      savingsPercent: normalizeOptionalScore(pickUnknown(summarySource, ['savingsPercent', 'savingPercent', 'savingRate', 'savingsRate', 'savings', '节省比例'])) || 0,
      savingsText: pickStringValue(summarySource, ['savingsText', 'savingText', '节省说明']),
    },
  }
}

const normalizeLlmCostBreakdown = (
  rawCostBreakdown?: unknown,
): GeneratedReport['plan']['costBreakdown'] | undefined => {
  const costBreakdown = normalizeFreeCostBreakdownInput(rawCostBreakdown)
  if (!costBreakdown) return undefined

  const normalizeCategory = (category: DetailedCostBreakdown['coreMedical']) => {
    const categoryTitle = normalizeRequiredString(category.title) || '费用项目'
    const normalizedItems = category.items.map((item) => {
      const parsed = parseMoneyPair(item.cost)
      return {
        ...item,
        item: normalizeRequiredString(item.item) || '费用项目',
        cost: formatMoneyPair(parsed, item.cost) || '资料不足，暂不估算',
        note: normalizeOptionalString(item.note)?.trim(),
      }
    })
    while (normalizedItems.length < 3) {
      normalizedItems.push({
        item: `${categoryTitle}明细${normalizedItems.length + 1}`,
        cost: '资料不足，暂不估算',
        note: '需结合资料预审后确认。',
      })
    }
    const itemTotals = normalizedItems.map((item) => parseMoneyPair(item.cost))
    const subtotal = parseMoneyPair(category.subtotal)
    const subtotalFromItems = sumMoneyPairs(itemTotals)
    const normalizedSubtotal = hasMoneyPair(subtotal)
      ? subtotal
      : subtotalFromItems
    return {
      ...category,
      title: categoryTitle,
      subtotal: formatMoneyPair(normalizedSubtotal, category.subtotal) || normalizeRequiredString(category.subtotal) || '暂不估算',
      items: normalizedItems,
      tip: normalizeOptionalString(category.tip)?.trim(),
      subtotalPair: normalizedSubtotal,
    }
  }

  const coreMedical = normalizeCategory(costBreakdown.coreMedical)
  const supportServices = normalizeCategory(costBreakdown.supportServices)
  const living = normalizeCategory(costBreakdown.living)
  const total = sumMoneyPairs([coreMedical.subtotalPair, supportServices.subtotalPair, living.subtotalPair])
  const referenceMoney = parseMoneyPair(costBreakdown.summary.referenceCost || costBreakdown.summary.savingsText)
  const totalHasMoney = hasMoneyPair(total)
  const referenceHasMoney = hasMoneyPair(referenceMoney)
  const chinaUsd = total.usd ?? (typeof total.cny === 'number' ? total.cny / COST_EXCHANGE_RATE : undefined)
  const savingsPercent = referenceHasMoney && typeof referenceMoney.usd === 'number' && typeof chinaUsd === 'number' && referenceMoney.usd > chinaUsd
    ? Math.max(0, Math.min(99, Math.round((1 - chinaUsd / referenceMoney.usd) * 100)))
    : typeof costBreakdown.summary.savingsPercent === 'number'
      ? costBreakdown.summary.savingsPercent
      : 0

  return {
    currencyNote: normalizeRequiredString(costBreakdown.currencyNote) || `按预审估算汇率约 ￥${COST_EXCHANGE_RATE} = $1 折算，最终以医院报价和付款日汇率为准`,
    coreMedical: {
      title: coreMedical.title,
      subtotal: coreMedical.subtotal,
      items: coreMedical.items,
      tip: coreMedical.tip,
    },
    supportServices: {
      title: supportServices.title,
      subtotal: supportServices.subtotal,
      items: supportServices.items,
      tip: supportServices.tip,
    },
    living: {
      title: living.title,
      subtotal: living.subtotal,
      items: living.items,
      tip: living.tip,
    },
    summary: {
      formula: totalHasMoney
        ? `核心医疗${formatCny(coreMedical.subtotalPair.cny || 0)} + 配套服务${formatCny(supportServices.subtotalPair.cny || 0)} + 生活费用${formatCny(living.subtotalPair.cny || 0)} = ${formatCny(total.cny || 0)}（约${formatUsd(total.usd || 0)}）`
        : normalizeRequiredString(costBreakdown.summary.formula) || '核心医疗、配套服务和生活费用需预审后计算总和',
      chinaTotal: totalHasMoney
        ? `${formatCny(total.cny || 0)}（约${formatUsd(total.usd || 0)}）`
        : normalizeRequiredString(costBreakdown.summary.chinaTotal) || '暂不估算',
      referenceCountry: normalizeRequiredString(costBreakdown.summary.referenceCountry) || '本国或患者常住地国家/地区',
      referenceCost: referenceHasMoney && typeof referenceMoney.usd === 'number'
        ? formatUsd(referenceMoney.usd)
        : normalizeRequiredString(costBreakdown.summary.referenceCost) || '资料不足，暂不计算',
      savingsPercent,
      savingsText: referenceHasMoney && typeof referenceMoney.usd === 'number' && totalHasMoney
        ? `vs 本国治疗${formatUsd(referenceMoney.usd)} = 节省${savingsPercent}%/Save ${savingsPercent}%`
        : normalizeRequiredString(costBreakdown.summary.savingsText) || '资料不足，暂不计算节省比例/Save 暂不计算',
    },
  }
}

const normalizeCountries = (
  value: unknown,
  fallback: GeneratedReport['countries'],
  context: ReportContext,
): GeneratedReport['countries'] => {
  const unavailable = unavailableFreeSection('countries', context)
  if (!Array.isArray(value)) return unavailable

  const normalized: ReportCountry[] = []
  value.forEach((country, index) => {
    const record = asRecord(country)
    if (!record && typeof country !== 'string') return
    const reference = fallback[index] || fallback.find((item) => item.name.includes('中国')) || fallback[0] || unavailable[0]
    const name = typeof country === 'string'
      ? country
      : pickStringValue(record, ['name', 'country', 'region', 'destination', '国家', '地区'])
    const recommendedValue = pickUnknown(record, ['recommended', 'isRecommended', 'recommend', '推荐'])
    normalized.push({
      flag: pickStringValue(record, ['flag', 'emoji', 'icon', '国旗']) || reference.flag,
      name: name || reference.name,
      fee: compactCostText(pickUnknown(record, ['fee', 'cost', 'price', 'medicalCost', '费用', '价格'])) || softLlmMissing('费用对比'),
      wait: pickStringValue(record, ['wait', 'waitTime', 'waitingTime', '等待时间', '排期']) || softLlmMissing('等待时间'),
      tech: pickStringValue(record, ['tech', 'technology', 'medicalCapability', 'advantage', '医疗能力', '技术']) || softLlmMissing('医疗能力说明'),
      service: pickStringValue(record, ['service', 'support', 'internationalService', '服务']) || softLlmMissing('服务说明'),
      visa: pickStringValue(record, ['visa', 'travel', '签证', '出行']) || softLlmMissing('签证与出行说明'),
      follow: pickStringValue(record, ['follow', 'followUp', 'follow_up', '随访']) || softLlmMissing('随访说明'),
      recommended: typeof recommendedValue === 'boolean'
        ? recommendedValue
        : reference.recommended,
    })
  })

  const hasChina = normalized.some((country) => country.recommended || country.name.includes('中国'))
  const completed = hasChina ? normalized : [unavailable[0], ...normalized]
  return completed.length ? completed : unavailable
}

const normalizeAdvantages = (
  value: unknown,
  context: ReportContext,
): GeneratedReport['advantages'] => {
  const unavailable = unavailableFreeSection('advantages', context)
  if (!Array.isArray(value)) return unavailable
  const normalized = value.map((item, index) => {
    if (typeof item === 'string' && item.trim()) {
      return {
        label: `要点${index + 1}`,
        value: item.trim(),
      }
    }
    const record = asRecord(item)
    const label = pickStringValue(record, ['label', 'title', 'name', 'point', '优势', '标题'])
    const detail = pickStringValue(record, ['value', 'detail', 'description', 'summary', 'reason', '说明', '内容'])
    if (!label && !detail) return null
    return {
      label: label || `要点${index + 1}`,
      value: detail || softLlmMissing('优势说明'),
    }
  }).filter((item): item is ReportAdvantage => Boolean(item))
  return normalized.length ? normalized : unavailable
}

const normalizeConcerns = (
  value: unknown,
  context: ReportContext,
): GeneratedReport['concerns'] => {
  const unavailable = unavailableFreeSection('concerns', context)
  if (!Array.isArray(value)) return unavailable
  const normalized = value.map((item, index) => {
    if (typeof item === 'string' && item.trim()) {
      return {
        concern: `关注点${index + 1}`,
        solution: item.trim(),
      }
    }
    const record = asRecord(item)
    const concern = pickStringValue(record, ['concern', 'risk', 'issue', 'title', 'name', '风险', '关注点', '问题'])
    const solution = pickStringValue(record, ['solution', 'mitigation', 'advice', 'suggestion', 'description', '建议', '解决方案', '说明'])
    if (!concern && !solution) return null
    return {
      concern: concern || `关注点${index + 1}`,
      solution: solution || softLlmMissing('处理建议'),
    }
  }).filter((item): item is ReportConcern => Boolean(item))
  return normalized.length ? normalized : unavailable
}

const normalizePlanBreakdown = (
  value: unknown,
  context: ReportContext,
): GeneratedReport['plan']['breakdown'] => {
  const unavailablePlan = unavailableFreeSection('plan', context)
  const record = asRecord(value)
  const rawItems = Array.isArray(value)
    ? value
    : pickUnknown(record, ['items', 'details', 'breakdown', 'rows', 'list', 'costItems', '费用项', '明细', '项目', '清单'])
  if (!Array.isArray(rawItems)) return unavailablePlan.breakdown
  const normalized = rawItems.map((item, index) => {
    if (typeof item === 'string' && item.trim()) {
      return {
        item: item.replace(/[￥¥$][\d,.万\s~至到-]+.*/, '').trim() || `路径项目${index + 1}`,
        cost: compactCostText(item) || softLlmMissing('费用'),
      }
    }
    const record = asRecord(item)
    const label = pickStringValue(record, ['item', 'name', 'title', 'stage', 'step', '项目', '阶段'])
    const cost = compactCostText(
      pickUnknown(record, ['cost', 'fee', 'amount', 'price', 'range', '费用', '价格']),
      pickUnknown(record, ['rmb', 'cny', 'RMB', 'CNY', '人民币']),
      pickUnknown(record, ['usd', 'USD', '美元']),
    )
    if (!label && !cost) return null
    return {
      item: label || `路径项目${index + 1}`,
      cost: cost || softLlmMissing('费用'),
    }
  }).filter((item): item is ReportPlanBreakdownItem => Boolean(item))
  return normalized.length ? normalized : unavailablePlan.breakdown
}

const normalizeAdvancedCare = (advancedCare?: unknown, context?: ReportContext): AdvancedCare | undefined => {
  if (!advancedCare) return undefined
  const rawCare = advancedCare as AdvancedCare & {
    therapies?: unknown
    drugCostComparison?: unknown
    newDrugCureAssessment?: unknown
    ctaItems?: unknown
  }
  const rawCareRecord = asRecord(advancedCare)
  const rawTherapies = rawCare.therapies ||
    rawCareRecord?.therapyRecommendations ||
    rawCareRecord?.frontierTherapies ||
    rawCareRecord?.advancedTherapy ||
    rawCareRecord?.treatments ||
    rawCareRecord?.items ||
    rawCareRecord?.疗法推荐 ||
    rawCareRecord?.前沿疗法 ||
    rawCareRecord?.治疗推荐
  const rawDrugComparison = rawCare.drugCostComparison ||
    rawCareRecord?.drugComparison ||
    rawCareRecord?.drugCost ||
    rawCareRecord?.drugCosts ||
    rawCareRecord?.medicationCostComparison ||
    rawCareRecord?.medicineCostComparison ||
    rawCareRecord?.药品费用对比 ||
    rawCareRecord?.药物费用对比
  const rawNewDrugAssessment = rawCare.newDrugCureAssessment ||
    rawCareRecord?.newDrugAssessment ||
    rawCareRecord?.newDrugCure ||
    rawCareRecord?.cureAssessment ||
    rawCareRecord?.newMedicineAssessment ||
    rawCareRecord?.新药治愈判断 ||
    rawCareRecord?.新药可治愈判断 ||
    rawCareRecord?.是否有新药可治愈
  const drugCostComparison = rawDrugComparison as AdvancedCare['drugCostComparison'] & { items?: unknown } | undefined
  const newDrugCureAssessment = rawNewDrugAssessment as AdvancedCare['newDrugCureAssessment'] & { items?: unknown; ctaItems?: unknown } | undefined
  const unavailable = context ? unavailableFreeAdvancedCare(context) : undefined
  const fill = (value: unknown, field: string, fallback?: string) => normalizeRequiredString(value) || fallback || softLlmMissing(field)
  const shouldUseUnavailableAdvancedCare = Boolean(context && !shouldRequireFreeAdvancedCareRecovery(context))
  const therapies = Array.isArray(rawTherapies)
    ? rawTherapies.map((therapy) => {
      const rawTherapy = therapy as AdvancedCare['therapies'][number] & { tags?: unknown }
      const therapyRecord = asRecord(therapy)
      return {
        name: fill(pickUnknown(therapyRecord, ['name', 'therapyName', 'treatmentName', 'title', 'drugName', 'technology', '疗法名称', '治疗名称', '名称']), '疗法名称', unavailable?.therapies[0]?.name),
        category: fill(pickUnknown(therapyRecord, ['category', 'type', 'class', 'therapyType', 'treatmentType', '类别', '类型']), '疗法类别', unavailable?.therapies[0]?.category),
        recommendationLevel: fill(pickUnknown(therapyRecord, ['recommendationLevel', 'level', 'priority', 'recommendation', '推荐级别', '优先级']), '推荐级别', unavailable?.therapies[0]?.recommendationLevel),
        summary: fill(pickUnknown(therapyRecord, ['summary', 'value', 'description', 'benefit', 'recommendationReason', '摘要', '价值', '说明']), '疗法摘要', unavailable?.therapies[0]?.summary),
        applicableFor: fill(pickUnknown(therapyRecord, ['applicableFor', 'eligibility', 'indication', 'fit', 'candidate', '适用前提', '适应证', '适用人群']), '适用前提', unavailable?.therapies[0]?.applicableFor),
        mechanism: fill(pickUnknown(therapyRecord, ['mechanism', 'principle', 'rationale', 'logic', '作用机制', '治疗逻辑']), '作用机制', unavailable?.therapies[0]?.mechanism),
        chinaAccess: fill(pickUnknown(therapyRecord, ['chinaAccess', 'chinaAvailability', 'availability', 'access', 'accessInChina', '中国可及性', '可及性']), '中国可及性', unavailable?.therapies[0]?.chinaAccess),
        estimatedCost: normalizeMixedCurrencyPairText(pickUnknown(therapyRecord, ['estimatedCost', 'cost', 'price', 'fee', 'chinaCost', '费用', '价格'])) ||
          fill(pickUnknown(therapyRecord, ['estimatedCost', 'cost', 'price', 'fee', 'chinaCost', '费用', '价格']), '疗法费用', unavailable?.therapies[0]?.estimatedCost),
        referenceCost: normalizeMixedCurrencyPairText(pickUnknown(therapyRecord, ['referenceCost', 'overseasCost', 'homeCost', 'internationalCost', '对照费用', '本国费用'])) ||
          normalizeOptionalString(pickUnknown(therapyRecord, ['referenceCost', 'overseasCost', 'homeCost', 'internationalCost', '对照费用', '本国费用']))?.trim() ||
          unavailable?.therapies[0]?.referenceCost,
        advantage: fill(pickUnknown(therapyRecord, ['advantage', 'savingInsight', 'valueAdvantage', 'benefit', '优势', '价格优势']), '疗法优势', unavailable?.therapies[0]?.advantage),
        evidence: fill(pickUnknown(therapyRecord, ['evidence', 'basis', 'evidenceBasis', 'guideline', '依据', '证据']), '证据依据', unavailable?.therapies[0]?.evidence),
        limitations: fill(pickUnknown(therapyRecord, ['limitations', 'risks', 'contraindications', 'caution', '局限性', '风险']), '局限性', unavailable?.therapies[0]?.limitations),
        nextStep: fill(pickUnknown(therapyRecord, ['nextStep', 'nextSteps', 'action', 'preparation', '下一步', '建议']), '下一步', unavailable?.therapies[0]?.nextStep),
        tags: normalizeStringList(rawTherapy.tags || therapyRecord?.labels || therapyRecord?.标签),
      }
    }).filter((therapy) => isActualAdvancedTherapy(therapy) || (shouldUseUnavailableAdvancedCare && isUnavailableAdvancedTherapy(therapy)))
    : []
  const drugItems = Array.isArray(drugCostComparison?.items)
    ? drugCostComparison.items.map((item) => {
      const rawItem = item as AdvancedCare['drugCostComparison']['items'][number]
      const itemRecord = asRecord(item)
      const fallback = unavailable?.drugCostComparison.items[0]
      return {
        drugName: fill(pickUnknown(itemRecord, ['drugName', 'name', 'medicineName', 'medication', 'drug', 'title', '药品名称', '药物名称']), '药品名称', fallback?.drugName),
        drugClass: fill(pickUnknown(itemRecord, ['drugClass', 'class', 'category', 'type', '类别', '类型']), '药物类别', fallback?.drugClass),
        chinaOption: fill(pickUnknown(itemRecord, ['chinaOption', 'china', 'chinaPlan', 'chinaAvailability', '中国方案', '中国选择']), '中国可选方案', fallback?.chinaOption),
        referenceOption: fill(pickUnknown(itemRecord, ['referenceOption', 'reference', 'homeOption', 'overseasOption', '对照方案', '本国方案']), '对照方案', fallback?.referenceOption),
        chinaCost: fill(pickUnknown(itemRecord, ['chinaCost', 'cost', 'price', 'fee', '中国费用', '中国价格']), '中国药品费用', fallback?.chinaCost),
        referenceCost: fill(pickUnknown(itemRecord, ['referenceCost', 'homeCost', 'overseasCost', 'internationalCost', '对照费用', '本国费用']), '对照药品费用', fallback?.referenceCost),
        efficacyEquivalence: fill(pickUnknown(itemRecord, [
          'efficacyEquivalence',
          'equivalence',
          'basis',
          'efficacyBasis',
          'equivalenceBasis',
          'equivalenceEvidence',
          'clinicalEquivalence',
          'evidenceLimitations',
          'sameEfficacy',
          'sameEffect',
          'comparableEfficacy',
          '同等疗效',
          '等效依据',
          '等效证据',
          '疗效等同性',
          '证据限制',
        ]), '同等疗效前提', fallback?.efficacyEquivalence),
        savingInsight: fill(pickUnknown(itemRecord, ['savingInsight', 'saving', 'savings', 'advantage', 'priceAdvantage', '节省说明', '价格优势']), '药费节省说明', fallback?.savingInsight),
        eligibility: fill(pickUnknown(itemRecord, ['eligibility', 'applicableFor', 'indication', 'condition', '适用条件', '适应证']), '适用条件', fallback?.eligibility),
        note: normalizeOptionalString(rawItem.note)?.trim(),
      }
    })
    : []
  const fallbackNewDrugItem = (() => {
    if (!newDrugCureAssessment || !normalizeRequiredString(newDrugCureAssessment.answer || newDrugCureAssessment.summary)) return null
    return {
      name: normalizeRequiredString((newDrugCureAssessment as Record<string, unknown>).name) || '新药或临床研究方向需医生确认',
      type: normalizeRequiredString((newDrugCureAssessment as Record<string, unknown>).type) || '审慎评估',
      applicableFor: normalizeRequiredString((newDrugCureAssessment as Record<string, unknown>).applicableFor) || normalizeRequiredString(newDrugCureAssessment.summary) || '需结合当前病例资料确认适用前提。',
      evidence: normalizeRequiredString((newDrugCureAssessment as Record<string, unknown>).evidence) || '依据当前模型判断，需医生结合指南、检查和既往治疗记录复核。',
      chinaAvailability: normalizeRequiredString((newDrugCureAssessment as Record<string, unknown>).chinaAvailability) || '中国可及性需预审确认。',
      potentialRole: normalizeRequiredString((newDrugCureAssessment as Record<string, unknown>).potentialRole) || normalizeRequiredString(newDrugCureAssessment.answer) || '用于控制症状或辅助决策，不承诺治愈。',
      limitations: normalizeRequiredString((newDrugCureAssessment as Record<string, unknown>).limitations) || '不能替代医生面诊和完整资料复核，不能承诺治愈。',
      nextStep: normalizeStringList(newDrugCureAssessment.ctaItems)[0] || '补充关键资料后由医生复核。',
    }
  })()
  const newDrugItems = Array.isArray(newDrugCureAssessment?.items)
    ? newDrugCureAssessment.items.map((item) => {
      const rawItem = item as AdvancedCare['newDrugCureAssessment']['items'][number]
      const itemRecord = asRecord(item)
      const fallback = unavailable?.newDrugCureAssessment.items[0]
      return {
        name: fill(pickUnknown(itemRecord, ['name', 'drugName', 'therapyName', 'title', 'direction', '名称', '新药名称', '方向']), '新药或研究方向', fallback?.name),
        type: fill(pickUnknown(itemRecord, ['type', 'category', 'class', '类别', '类型']), '新药类别', fallback?.type),
        applicableFor: fill(pickUnknown(itemRecord, ['applicableFor', 'eligibility', 'indication', 'condition', '适用前提', '适应证']), '适用前提', fallback?.applicableFor),
        evidence: fill(pickUnknown(itemRecord, ['evidence', 'basis', 'guideline', 'study', '证据', '依据']), '证据依据', fallback?.evidence),
        chinaAvailability: fill(pickUnknown(itemRecord, ['chinaAvailability', 'availability', 'access', 'chinaAccess', '中国可及性', '可及性']), '中国可及性', fallback?.chinaAvailability),
        potentialRole: fill(pickUnknown(itemRecord, ['potentialRole', 'role', 'value', 'goal', '作用', '可能作用']), '可能作用', fallback?.potentialRole),
        limitations: fill(pickUnknown(itemRecord, ['limitations', 'risks', 'caution', '局限性', '风险']), '局限性', fallback?.limitations),
        nextStep: fill(pickUnknown(itemRecord, ['nextStep', 'nextSteps', 'action', 'preparation', '下一步', '建议']), '下一步', fallback?.nextStep),
      }
    })
    : (fallbackNewDrugItem ? [fallbackNewDrugItem] : [])

  return {
    context: fill(rawCare.context || rawCareRecord?.summary || rawCareRecord?.contextSummary || rawCareRecord?.上下文, '前沿疗法上下文', unavailable?.context),
    currencyNote: fill(rawCare.currencyNote || rawCareRecord?.currency || rawCareRecord?.costNote || rawCareRecord?.费用说明, '费用说明', unavailable?.currencyNote),
    therapies: therapies.length ? therapies : (shouldUseUnavailableAdvancedCare ? (unavailable?.therapies || []) : []),
    drugCostComparison: {
      title: fill(drugCostComparison?.title || (drugCostComparison as Record<string, unknown> | undefined)?.heading, '药品费用对比标题', unavailable?.drugCostComparison.title),
      basis: fill(
        drugCostComparison?.basis ||
          (drugCostComparison as Record<string, unknown> | undefined)?.equivalenceBasis ||
          (drugCostComparison as Record<string, unknown> | undefined)?.equivalenceEvidence ||
          (drugCostComparison as Record<string, unknown> | undefined)?.clinicalEquivalence ||
          (drugCostComparison as Record<string, unknown> | undefined)?.evidenceLimitations ||
          (drugCostComparison as Record<string, unknown> | undefined)?.同等疗效依据 ||
          (drugCostComparison as Record<string, unknown> | undefined)?.等效证据,
        '同等疗效依据',
        unavailable?.drugCostComparison.basis,
      ),
      summary: fill(drugCostComparison?.summary || (drugCostComparison as Record<string, unknown> | undefined)?.description || (drugCostComparison as Record<string, unknown> | undefined)?.说明, '药品费用对比摘要', unavailable?.drugCostComparison.summary),
      items: drugItems.length ? drugItems : (shouldUseUnavailableAdvancedCare ? (unavailable?.drugCostComparison.items || []) : []),
      note: fill(drugCostComparison?.note || (drugCostComparison as Record<string, unknown> | undefined)?.remark || (drugCostComparison as Record<string, unknown> | undefined)?.备注, '药品费用对比说明', unavailable?.drugCostComparison.note),
    },
    newDrugCureAssessment: {
      headline: fill(newDrugCureAssessment?.headline || (newDrugCureAssessment as Record<string, unknown> | undefined)?.title, '新药治愈判断标题', unavailable?.newDrugCureAssessment.headline),
      answer: fill(newDrugCureAssessment?.answer || (newDrugCureAssessment as Record<string, unknown> | undefined)?.conclusion || (newDrugCureAssessment as Record<string, unknown> | undefined)?.判断, '新药治愈判断', unavailable?.newDrugCureAssessment.answer),
      summary: fill(newDrugCureAssessment?.summary || (newDrugCureAssessment as Record<string, unknown> | undefined)?.description || (newDrugCureAssessment as Record<string, unknown> | undefined)?.说明, '新药治愈判断摘要', unavailable?.newDrugCureAssessment.summary),
      items: newDrugItems.length ? newDrugItems : (shouldUseUnavailableAdvancedCare ? (unavailable?.newDrugCureAssessment.items || []) : []),
      ctaItems: normalizeStringList(newDrugCureAssessment?.ctaItems).length
        ? normalizeStringList(newDrugCureAssessment?.ctaItems)
        : (unavailable?.newDrugCureAssessment.ctaItems || [softLlmMissing('下一步资料清单')]),
    },
    disclaimer: fill(rawCare.disclaimer, '医学声明', unavailable?.disclaimer),
  }
}

const normalizeLlmHospitals = (hospitals?: GeneratedReport['hospitals']) => hospitals?.map((hospital) => {
  const rawHospital = hospital as GeneratedReport['hospitals'][number] & {
    tags?: unknown
    detailItems?: unknown
    matchScore?: unknown
  }
  const detailItems = Array.isArray(rawHospital.detailItems)
    ? rawHospital.detailItems
      .map((item) => {
        if (!item || typeof item !== 'object') return null
        const rawItem = item as { label?: unknown; title?: unknown; name?: unknown; value?: unknown; description?: unknown; detail?: unknown }
        const label = normalizeOptionalString(rawItem.label) || normalizeOptionalString(rawItem.title) || normalizeOptionalString(rawItem.name)
        const value = normalizeOptionalString(rawItem.value) || normalizeOptionalString(rawItem.description) || normalizeOptionalString(rawItem.detail)
        return label && value ? { label, value } : null
      })
      .filter((item): item is { label: string; value: string } => Boolean(item))
    : undefined
  const rawRecord = rawHospital as unknown as Record<string, unknown>
  const department = normalizeOptionalString(
    hospital.department ||
    rawRecord.specialty ||
    rawRecord.departmentName ||
    rawRecord.department_name ||
    rawRecord.dept ||
    rawRecord.serviceLine ||
    rawRecord.service_line ||
    rawRecord.mdt ||
    rawRecord.MDT ||
    rawRecord.科室 ||
    rawRecord.专科 ||
    rawRecord.MDT方向,
  )
  const internationalPatients = normalizeOptionalString(
    hospital.internationalPatients ||
    rawRecord.patientVolume ||
    rawRecord.patient_volume ||
    rawRecord.patientCount ||
    rawRecord.patient_count ||
    rawRecord.caseVolume ||
    rawRecord.case_volume ||
    rawRecord.volume ||
    rawRecord.international_patients ||
    rawRecord.internationalPatientVolume ||
    rawRecord.internationalPatientCount ||
    rawRecord.患者量 ||
    rawRecord.病例量 ||
    rawRecord.接待能力 ||
    rawRecord.国际患者接待,
  )
  const waitTime = normalizeOptionalString(
    hospital.waitTime ||
    rawRecord.waitingTime ||
    rawRecord.waiting_time ||
    rawRecord.wait ||
    rawRecord.wait_time ||
    rawRecord.appointmentWait ||
    rawRecord.appointment_wait ||
    rawRecord.appointmentTime ||
    rawRecord.appointment_time ||
    rawRecord.queueTime ||
    rawRecord.等待时间 ||
    rawRecord.排期 ||
    rawRecord.预约时间 ||
    rawRecord.首诊等待,
  )
  const preparation = normalizeOptionalString(
    hospital.preparation ||
    rawRecord.nextStep ||
    rawRecord.next_step ||
    rawRecord.nextSteps ||
    rawRecord.preparationNote ||
    rawRecord.requirements ||
    rawRecord.materials ||
    rawRecord.documentRequirements ||
    rawRecord.document_requirements ||
    rawRecord.准备事项 ||
    rawRecord.资料准备 ||
    rawRecord.所需资料 ||
    rawRecord.预审材料,
  )

  return {
    ...hospital,
    city: normalizeRequiredString(rawRecord.city || rawRecord.location || rawRecord.region || rawRecord.area || rawRecord.城市 || rawRecord.地区) || hospital.city || '',
    name: normalizeRequiredString(rawRecord.name || rawRecord.hospital || rawRecord.hospitalName || rawRecord.hospital_name || rawRecord.institution || rawRecord.provider || rawRecord.医院 || rawRecord.机构) || hospital.name || '',
    reason: normalizeRequiredString(rawRecord.reason || rawRecord.whyFit || rawRecord.why_fit || rawRecord.fitReason || rawRecord.recommendationReason || rawRecord.推荐理由 || rawRecord.匹配理由) || hospital.reason || '',
    englishName: normalizeOptionalString(hospital.englishName || rawRecord.englishName || rawRecord.english_name || rawRecord.enName),
    department,
    rankLabel: normalizeOptionalString(hospital.rankLabel || rawRecord.rank || rawRecord.rank_label || rawRecord.rankLabel || rawRecord.优势标签 || rawRecord.排名标签),
    internationalPatients,
    waitTime,
    preparation,
    matchScore: normalizeOptionalScore(rawHospital.matchScore || rawRecord.matchingScore || rawRecord.matching_score || rawRecord.fitScore || rawRecord.fit_score || rawRecord.score || rawRecord.匹配度),
    tags: normalizeStringList(rawHospital.tags || rawRecord.labels || rawRecord.标签),
    detailItems,
  }
})

const normalizeHospitals = (
  hospitals: unknown,
  context: ReportContext,
): GeneratedReport['hospitals'] => {
  const unavailable = unavailableFreeSection('hospitals', context)
  const normalized = normalizeLlmHospitals(Array.isArray(hospitals) ? hospitals as GeneratedReport['hospitals'] : undefined)
  if (!normalized?.length) return unavailable

  const usableHospitals = normalized.filter((hospital) => (
    hospital.name?.trim() &&
    !isSoftPlaceholderText(hospital.name)
  ))
  const sourceHospitals = context.diseaseKey === 'dental'
    ? usableHospitals.slice(0, 1)
    : usableHospitals
  if (!sourceHospitals.length) return unavailable

  const completed = sourceHospitals.map((hospital, index) => {
    const completedHospital = {
      city: hospital.city?.trim() || '待确认',
      name: hospital.name?.trim() || `推荐医院${index + 1}`,
      reason: hospital.reason?.trim() || softLlmMissing('医院推荐理由'),
      englishName: hospital.englishName?.trim(),
      department: hospital.department?.trim() || softLlmMissing('建议科室'),
      matchScore: hospital.matchScore,
      rankLabel: hospital.rankLabel?.trim(),
      tags: hospital.tags?.length ? hospital.tags : undefined,
      internationalPatients: hospital.internationalPatients?.trim() || softLlmMissing('国际患者量/接待能力'),
      waitTime: hospital.waitTime?.trim() || softLlmMissing('等待时间'),
      preparation: hospital.preparation?.trim() || softLlmMissing('预审准备事项'),
    }
    const detailItems = [...(hospital.detailItems || [])]
    const pushDetail = (label: string, value?: string) => {
      const normalizedValue = normalizeRequiredString(value)
      if (normalizedValue && !detailItems.some((item) => item.label === label)) {
        detailItems.push({ label, value: normalizedValue })
      }
    }
    pushDetail('适配理由', completedHospital.reason)
    pushDetail('建议科室', completedHospital.department)
    pushDetail('匹配度', typeof completedHospital.matchScore === 'number' ? `${completedHospital.matchScore}/100` : softLlmMissing('匹配度'))
    pushDetail('患者量/接待能力', completedHospital.internationalPatients)
    pushDetail('预计等待时间', completedHospital.waitTime)
    pushDetail('准备事项', completedHospital.preparation)

    return {
      ...completedHospital,
      detailItems: detailItems.length ? detailItems : [{ label: '补充说明', value: softLlmMissing('医院详情') }],
    }
  })

  return completed.length ? completed : unavailable
}

const getLlmHospitals = (value: LlmPatchEnvelope | unknown): unknown[] | undefined => {
  if (Array.isArray(value)) return value.length ? value : undefined
  const record = asRecord(value)
  if (!record) return undefined
  const direct = nonEmptyArray(record.hospitals as unknown[] | undefined) ||
    nonEmptyArray(record.recommendedHospitals as unknown[] | undefined) ||
    nonEmptyArray(record.recommended_hospitals as unknown[] | undefined) ||
    nonEmptyArray(record.hospitalRecommendations as unknown[] | undefined) ||
    nonEmptyArray(record.hospital_recommendations as unknown[] | undefined) ||
    nonEmptyArray(record.topHospitals as unknown[] | undefined) ||
    nonEmptyArray(record.top_hospitals as unknown[] | undefined) ||
    nonEmptyArray(record.推荐医院 as unknown[] | undefined) ||
    nonEmptyArray(record.医院推荐 as unknown[] | undefined)
  if (direct) return direct

  for (const key of ['report', 'data', 'result', 'output', 'simpleReport', 'freeReport', '简易报告', '报告']) {
    const nested = getLlmHospitals(record[key])
    if (nested) return nested
  }

  return undefined
}

const hasUsefulFreeHospitalDetails = (context: ReportContext, hospitals?: GeneratedReport['hospitals']) => {
  const requiredCount = context.diseaseKey === 'dental' ? 1 : 3
  const hospitalItems = hospitals?.slice(0, requiredCount) || []
  return hospitalItems.length >= requiredCount && hospitalItems.every((hospital) => (
    Boolean(hospital.name?.trim()) &&
    !isSoftPlaceholderText(hospital.name) &&
    Boolean(hospital.reason?.trim()) &&
    (context.diseaseKey === 'dental' || typeof hospital.matchScore === 'number') &&
    Boolean(hospital.department?.trim()) &&
    Boolean(hospital.internationalPatients?.trim()) &&
    !isSoftPlaceholderText(hospital.internationalPatients) &&
    Boolean(hospital.waitTime?.trim()) &&
    !isSoftPlaceholderText(hospital.waitTime) &&
    Boolean(hospital.detailItems?.length && hospital.detailItems.length >= 4)
  ))
}

const getFreeHospitalDetailsFailure = (context: ReportContext, hospitals?: GeneratedReport['hospitals']) => {
  const requiredCount = context.diseaseKey === 'dental' ? 1 : 3
  const hospitalItems = hospitals?.slice(0, requiredCount) || []
  if (hospitalItems.length < requiredCount) return `医院推荐少于${requiredCount}项。`
  const failures: string[] = []
  hospitalItems.forEach((hospital, index) => {
    const prefix = `医院${index + 1}`
    if (!hospital.name?.trim() || isSoftPlaceholderText(hospital.name)) failures.push(`${prefix}名称缺失`)
    if (!hospital.reason?.trim()) failures.push(`${prefix}适配理由缺失`)
    if (context.diseaseKey !== 'dental' && typeof hospital.matchScore !== 'number') failures.push(`${prefix}匹配度缺失`)
    if (!hospital.department?.trim()) failures.push(`${prefix}科室缺失`)
    if (!hospital.internationalPatients?.trim() || isSoftPlaceholderText(hospital.internationalPatients)) failures.push(`${prefix}患者量/接待能力缺失`)
    if (!hospital.waitTime?.trim() || isSoftPlaceholderText(hospital.waitTime)) failures.push(`${prefix}等待时间缺失`)
    if (!hospital.detailItems?.length || hospital.detailItems.length < 4) failures.push(`${prefix}展开详情少于4项`)
  })
  return failures.join('；') || null
}

const unavailableCoreTextPattern = /待医生确认的就医方向|当前资料不足以生成可靠内容|资料不足以生成可靠结论|资料不足，暂不生成|暂不推荐具体医院|医院匹配暂不生成|费用节省暂不计算|暂不建议直接安排行程|不使用通用费用模板替代医疗模型估算/
const promptInstructionLeakPattern = /必须医学审慎，不能承诺治愈|疗法名称，由模型|药品\/药物类别名称|新药\/药物类别\/临床研究方向|医学审慎声明/

const getFreeMainPatchFailure = (patch: FreeReportPatch | null | undefined, context: ReportContext) => {
  if (!patch) return '主报告 patch 缺失。'
  const coreText = JSON.stringify({
    disease: patch.disease,
    treatment: patch.treatment,
    advantages: patch.advantages,
    concerns: patch.concerns,
    highlights: patch.highlights,
    plan: patch.plan,
  })
  if (unavailableCoreTextPattern.test(coreText)) return '主诊疗内容仍包含资料不足或暂不生成模板。'
  if (!normalizeRequiredString(patch.disease)) return 'disease 缺失。'
  if (!normalizeRequiredString(patch.treatment) || normalizeRequiredString(patch.treatment).length < 80) return 'treatment 过短或缺失。'
  if (!Array.isArray(patch.advantages) || patch.advantages.length < 3) return 'advantages 不足3项。'
  if (!Array.isArray(patch.concerns) || patch.concerns.length < 4) return 'concerns 不足4项。'
  if (!normalizeRequiredString(patch.plan?.direction) || normalizeRequiredString(patch.plan?.direction).length < 24) return 'plan.direction 缺失或过短。'
  if (!Array.isArray(patch.plan?.breakdown) || patch.plan.breakdown.length < 4) return 'plan.breakdown 不足4项。'
  if (!Array.isArray(patch.highlights) || normalizeStringList(patch.highlights).length < 4) return 'highlights 不足4项。'
  return null
}

const hasUsefulFreeCostBreakdown = (
  context: ReportContext,
  costBreakdown?: GeneratedReport['plan']['costBreakdown'],
) => {
  if (getFreeCostBreakdownFailure(context, costBreakdown)) return false
  return true
}

const getFreeCostBreakdownFailure = (
  context: ReportContext,
  costBreakdown?: GeneratedReport['plan']['costBreakdown'],
) => {
  if (!costBreakdown) return '费用拆分缺失。'
  const categories = [costBreakdown.coreMedical, costBreakdown.supportServices, costBreakdown.living]
  const hasEnoughItems = categories.every((category) => category.items.length >= 3)
  const itemCosts = categories.flatMap((category) => category.items.map((item) => item.cost))
  const hasAnyMoney = itemCosts.some(hasParsedMoney) || categories.some((category) => hasParsedMoney(category.subtotal))
  const careNeedLabel = getCareNeedLabel(context.input.basicInfo.careNeed, context.input.basicInfo.careNeedOther)
  const caseTreatmentText = `${careNeedLabel} ${context.input.basicInfo.chiefComplaint} ${context.disease.treatment}`
  const shouldRequireTreatmentExecution = !['other', 'premium_checkup'].includes(context.diseaseKey)
  const wantsTreatment = shouldRequireTreatmentExecution && (treatmentExecutionPattern.test(caseTreatmentText) || /手术|治疗|住院|放疗|化疗|靶向|免疫|介入|消融|种植|修复/i.test(caseTreatmentText))
  const expectedExecutionItemCount = wantsTreatment ? 1 : 0
  const treatmentCostItems = costBreakdown.coreMedical.items.filter((item) => (
    isTreatmentExecutionCostItem(item) ||
    (context.diseaseKey === 'endocrinology_metabolism' && isChronicCareExecutionCostItem(item))
  ))
  if (!hasEnoughItems) return '费用拆分三类明细不足，每类至少需要3项。'
  if (!hasAnyMoney) return '费用拆分缺少可解析金额或金额区间。'
  if (wantsTreatment && treatmentCostItems.length < expectedExecutionItemCount) {
    return `coreMedical 缺少具体的实际治疗执行费用。请至少返回1项手术费/麻醉住院、消融、TACE/HAIC介入、放疗疗程、化疗/靶向/免疫药物、支架/搭桥、根管/种植、慢病药物等执行费用；不要用“主要治疗执行费用”这类泛称，也不要用可行性评估、方案评估、MDT、会诊、检查、检测、影像或病理复核替代。`
  }
  return null
}

const hasUsefulFreeAdvancedCare = (advancedCare?: GeneratedReport['advancedCare']) => {
  if (getFreeAdvancedCareFailure(advancedCare)) return false
  return true
}

const hasDrugEquivalenceBasis = (drugComparison: AdvancedCare['drugCostComparison']) => {
  const equivalenceText = `${drugComparison.basis} ${drugComparison.summary} ${drugComparison.items.map((item) => `${item.drugName} ${item.drugClass} ${item.efficacyEquivalence} ${item.eligibility} ${item.note || ''}`).join(' ')}`
  return includesAny(equivalenceText, [
    '同等',
    '同等疗效',
    '疗效相当',
    '相当',
    '等效',
    '临床等效',
    '一致性',
    '一致性评价',
    '生物类似',
    '同类',
    '同类药',
    '同一适应证',
    '适应证',
    '指南',
    '循证',
    '证据',
    '需医生确认',
    '资料不足',
    '不适用',
    '非药物',
    '无适用药物',
  ])
}

const getFreeAdvancedCareFailure = (advancedCare?: GeneratedReport['advancedCare']) => {
  if (!advancedCare) return '前沿疗法内容缺失。'
  const text = JSON.stringify(advancedCare)
  if (/疗法名称，由模型|药品\/药物类别名称|新药\/药物类别\/临床研究方向/.test(text)) {
    return '前沿疗法仍包含样例占位词或说明文字。'
  }
  if (/暂不推荐具体前沿疗法|暂不指定药品|当前资料不足，不能判断是否存在可治愈的新药方案/.test(text)) {
    return '前沿疗法缺少医疗模型生成的具体疗法/药品/新药判断。'
  }
  const hasTherapyDirection = advancedCare.therapies.some((therapy) => (
    isActualAdvancedTherapy(therapy)
  ))
  if (advancedCare.therapies.length < 1) return '前沿疗法 therapies 为空。'
  if (!hasTherapyDirection) return 'therapies.name 缺少实际疗法/药物/技术名称。请用 TACE/HAIC介入治疗、消融治疗、靶向药物治疗、PD-1/PD-L1免疫治疗、精准放疗、微创/机器人手术等实际治疗名称；不要用检查、检测、基因分析、可行性评估、方案评估、MDT或会诊作为疗法名。'
  if (!advancedCare.therapies.some((therapy) => therapy.summary.trim() && therapy.estimatedCost.trim())) return '前沿疗法缺少摘要或费用。'
  if (advancedCare.therapies.some((therapy) => hasMixedCurrencyRange(therapy.estimatedCost))) return '前沿疗法 estimatedCost 金额格式不合格。请使用“￥8,000-12,000（~$1,100-1,700）”这类同口径人民币+美元格式，不要写“￥8,000 - $1,200”。'
  if (advancedCare.drugCostComparison.items.length < 1) return '药品费用对比缺少明细。'
  if (!advancedCare.drugCostComparison.items.some((item) => item.drugName.trim() && item.efficacyEquivalence.trim())) return '药品费用对比缺少药品名称或同等疗效前提。'
  if (!hasDrugEquivalenceBasis(advancedCare.drugCostComparison)) return '药品费用对比缺少同等疗效依据。'
  if (!advancedCare.newDrugCureAssessment.answer.trim()) return '新药治愈判断缺少 answer。'
  if (advancedCare.newDrugCureAssessment.items.length < 1) return '新药治愈判断缺少明细。'
  return null
}

const shouldRequireFreeAdvancedCareRecovery = (context: ReportContext) => (
  !['dental', 'premium_checkup', 'other'].includes(context.diseaseKey)
)

const callLlmPatch = async (
  context: ReportContext,
  ruleReport: GeneratedReport,
  previousError?: string,
  coreOnly = false,
): Promise<FreeReportPatch | null> => {
  try {
    for (let attempt = 0; attempt < 1; attempt += 1) {
      const content = await requestMedicalChatCompletion({
        messages: coreOnly
          ? buildCorePatchPrompt(context, ruleReport, previousError)
          : buildPatchPrompt(context, ruleReport, previousError),
        expertKnowledgeModules: ['assessment','pathology','treatment','risk','cost','hospitals','comparison','itinerary','next'],
        temperature: 0.2,
        stream: false,
        responseFormat: 'json_object',
        maxTokens: 12000,
        maxAttempts: 2,
      })

      if (!content) return null

      try {
        const parsed = dropNullFields(parseLlmJson(content))
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('LLM patch response was not a JSON object')
        }
        const envelope = unwrapLlmEnvelope(parsed as LlmPatchEnvelope)
        const envelopeRecord = asRecord(envelope)
        const packageItems = normalizeLlmPackageItems(getLlmPackageItems(envelope))
        const normalizedPlan = getLlmPlanPatch(envelope)
        return {
          ...envelope,
          disease: normalizeRequiredString(envelope.disease) ||
            pickStringValue(envelopeRecord, ['diagnosis', 'diseaseDirection', 'medicalDirection', 'visitDirection', '疾病方向', '病种方向', '就医方向']),
          treatment: normalizeRequiredString(envelope.treatment) ||
            pickStringValue(envelopeRecord, ['treatmentSummary', 'recommendation', 'clinicalSummary', 'medicalOpinion', '预审结论', '治疗建议', '治疗路径摘要']),
          countries: nonEmptyArray(envelope.countries) ||
            nonEmptyArray(pickUnknown(envelopeRecord, ['countryComparison', 'countriesComparison', 'destinations', '国家对比', '地区对比']) as GeneratedReport['countries'] | undefined),
          advantages: getLlmAdvantages(envelope),
          concerns: getLlmConcerns(envelope),
          hospitals: normalizeLlmHospitals(getLlmHospitals(envelope) as GeneratedReport['hospitals'] | undefined),
          plan: {
            ...(normalizedPlan || {}),
            costBreakdown: normalizeLlmCostBreakdown(getLlmCostBreakdown(envelope)),
          },
          packages: packageItems,
          advancedCare: normalizeAdvancedCare(getLlmAdvancedCare(envelope), context),
          highlights: getLlmHighlights(envelope),
          paymentAndInsurance: getLlmPaymentAndInsurance(envelope),
        }
      } catch (error) {
        throw error
      }
    }

    return null
  } catch (error) {
    throw new Error(`LLM_STAGE_MAIN_PATCH: ${sanitizeGenerationError(error)}`)
  }
}

const callLlmPatchWithFeedback = async (
  context: ReportContext,
  ruleReport: GeneratedReport,
): Promise<FreeReportPatch | null> => {
  let previousError: string | undefined
  let lastError: unknown

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const patch = await callLlmPatch(context, ruleReport, previousError, attempt > 1)
      const patchFailure = getFreeMainPatchFailure(patch, context)
      if (!patchFailure) return patch
      previousError = patchFailure
      lastError = new Error(patchFailure)
      if (attempt < 2) {
        console.warn(`LLM_STAGE_MAIN_PATCH returned incomplete core content, retrying once: ${patchFailure}`)
      }
    } catch (error) {
      lastError = error
      previousError = sanitizeGenerationError(error).replace(/^LLM_STAGE_MAIN_PATCH:\s*/, '')
      if (attempt < 2) {
        console.warn(`LLM_STAGE_MAIN_PATCH failed, retrying once: ${previousError.slice(0, 1000)}`)
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError || 'LLM_STAGE_MAIN_PATCH failed'))
}

const callLlmCorePatchFallback = async (
  context: ReportContext,
  ruleReport: GeneratedReport,
  previousError?: string,
): Promise<FreeReportPatch | null> => {
  const patch = await callLlmPatch(context, ruleReport, previousError, true)
  const patchFailure = getFreeMainPatchFailure(patch, context)
  if (patchFailure) {
    throw new Error(`LLM_STAGE_CORE_MAIN_FALLBACK: ${patchFailure}`)
  }
  return patch
}

const callLlmHospitalDetailsPatch = async (
  context: ReportContext,
  ruleReport: GeneratedReport,
  patch: FreeReportPatch,
): Promise<GeneratedReport['hospitals'] | null> => {
  try {
    const content = await requestMedicalChatCompletion({
      messages: buildHospitalDetailsPrompt(context, ruleReport, patch),
      expertKnowledgeModules: ['hospitals','topDoctors'],
      temperature: 0.15,
      stream: false,
      responseFormat: 'json_object',
      maxTokens: 7000,
      maxAttempts: 2,
    })

    if (!content) return null

    const parsed = dropNullFields(parseLlmJson(content))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('LLM hospital details recovery response was not a JSON object')
    }

    const hospitals = normalizeLlmHospitals(getLlmHospitals(parsed as LlmPatchEnvelope) as GeneratedReport['hospitals'] | undefined)
    if (!hospitals?.length) throw new Error('LLM hospital details recovery response did not include hospitals')
    if (!hasUsefulFreeHospitalDetails(context, hospitals)) {
      if (process.env.DEBUG_REPORT_LLM === '1') {
        console.warn(`[Free report hospital details recovery] ${JSON.stringify(hospitals).slice(0, 2200)}`)
      }
      throw new Error('recovered hospital details are incomplete')
    }

    return hospitals
  } catch (error) {
    throw new Error(`LLM_STAGE_HOSPITAL_DETAILS_RECOVERY: ${sanitizeGenerationError(error)}`)
  }
}

const callLlmPackagePatch = async (
  context: ReportContext,
  ruleReport: GeneratedReport,
  patch: FreeReportPatch,
  previousError?: string,
): Promise<GeneratedReport['packages'] | null> => {
  try {
    const content = await requestMedicalChatCompletion({
      messages: buildPackagePrompt(context, ruleReport, patch, previousError),
      expertKnowledgeModules: ['service'],
      temperature: 0.12,
      stream: false,
      responseFormat: 'json_object',
      maxTokens: 7000,
      maxAttempts: 2,
    })

    if (!content) return null

    const parsed = dropNullFields(parseLlmJson(content))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('LLM packages recovery response was not a JSON object')
    }

    const envelope = unwrapLlmEnvelope(parsed as LlmPatchEnvelope)
    const packagesPatch = normalizeLlmPackageItems(getLlmPackageItems(envelope))
    if (!packagesPatch?.length) throw new Error('LLM packages recovery response did not include packages')

    const basicPackage = packagesPatch.find((pkg) => /Basic|基础/.test(pkg.name))
    const standardPackage = packagesPatch.find((pkg) => /Standard|标准/.test(pkg.name))
    const premiumPackage = packagesPatch.find((pkg) => /Premium|深度|MDT|多学科/.test(pkg.name))
    const everyPackageDetailed = packagesPatch.every((pkg) => (
      Boolean(pkg.name.trim()) &&
      Boolean(pkg.price.trim()) &&
      (pkg.features.length >= 3 || Boolean(pkg.featureDetails?.length && pkg.featureDetails.length >= 6))
    ))
    if (!basicPackage || !standardPackage || !premiumPackage) {
      throw new Error('professional service package tiers are missing Basic, Standard or Premium')
    }
    if (!everyPackageDetailed) {
      throw new Error('professional service package features are too coarse')
    }

    return packagesPatch
  } catch (error) {
    throw new Error(`LLM_STAGE_PACKAGES_RECOVERY: ${sanitizeGenerationError(error)}`)
  }
}

const callLlmPackagePatchWithFeedback = async (
  context: ReportContext,
  ruleReport: GeneratedReport,
  patch: FreeReportPatch,
): Promise<GeneratedReport['packages'] | null> => {
  let previousError: string | undefined
  let lastError: unknown
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      return await callLlmPackagePatch(context, ruleReport, patch, previousError)
    } catch (error) {
      lastError = error
      previousError = sanitizeGenerationError(error).replace(/^LLM_STAGE_PACKAGES_RECOVERY:\s*/, '')
      if (attempt < 2) {
        console.warn(`LLM_STAGE_PACKAGES_RECOVERY failed, retrying once: ${previousError.slice(0, 1000)}`)
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError || 'LLM_STAGE_PACKAGES_RECOVERY failed'))
}

const callLlmSupplementalPatch = async (
  context: ReportContext,
  ruleReport: GeneratedReport,
): Promise<FreeReportPatch | null> => {
  try {
    const content = await requestMedicalChatCompletion({
      messages: buildSupplementalPatchPrompt(context, ruleReport),
      expertKnowledgeModules: ['treatment','risk','assessment','comparison','itinerary','service','next'],
      temperature: 0.1,
      stream: false,
      responseFormat: 'json_object',
      maxTokens: 14000,
      maxAttempts: 2,
    })

    if (!content) return null

    const parsed = dropNullFields(parseLlmJson(content))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('LLM supplemental response was not a JSON object')
    }

    const envelope = parsed as LlmPatchEnvelope
    let costBreakdown = normalizeLlmCostBreakdown(getLlmCostBreakdown(envelope))
    let advancedCare = normalizeAdvancedCare(getLlmAdvancedCare(envelope), context)
    if (!costBreakdown) {
      console.warn(`Free report supplemental costBreakdown not parsed; response shape: ${JSON.stringify(summarizeObjectShape(parsed)).slice(0, 1200)}`)
    }

    if (costBreakdown) {
      const costFailure = getFreeCostBreakdownFailure(context, costBreakdown)
      if (costFailure) {
        console.warn(`Free report supplemental costBreakdown not usable: ${costFailure}`)
        if (process.env.DEBUG_REPORT_LLM === '1') {
          console.warn(`[Free report supplemental costBreakdown] ${JSON.stringify(costBreakdown).slice(0, 2200)}`)
        }
        costBreakdown = undefined
      }
    }

    if (advancedCare) {
      const advancedCareFailure = getFreeAdvancedCareFailure(advancedCare)
      if (shouldRequireFreeAdvancedCareRecovery(context) && advancedCareFailure) {
        console.warn(`Free report supplemental advancedCare not usable: ${advancedCareFailure}`)
        advancedCare = undefined
      }
    }

    if (!costBreakdown && !advancedCare) {
      throw new Error('LLM supplemental response did not include usable costBreakdown or advancedCare')
    }

    return {
      plan: { costBreakdown },
      advancedCare,
    }
  } catch (error) {
    throw new Error(`LLM_STAGE_SUPPLEMENTAL_PATCH: ${sanitizeGenerationError(error)}`)
  }
}

const callLlmCostBreakdownPatch = async (
  context: ReportContext,
  ruleReport: GeneratedReport,
  patch: FreeReportPatch,
  previousError?: string,
): Promise<GeneratedReport['plan']['costBreakdown'] | null> => {
  try {
    const content = await requestMedicalChatCompletion({
      messages: buildCostBreakdownPrompt(context, ruleReport, patch, previousError),
      expertKnowledgeModules: ['cost'],
      temperature: 0.1,
      stream: false,
      responseFormat: 'json_object',
      maxTokens: 9000,
      maxAttempts: 2,
    })

    if (!content) return null

    const parsed = dropNullFields(parseLlmJson(content))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('LLM costBreakdown recovery response was not a JSON object')
    }

    const costBreakdown = normalizeLlmCostBreakdown(getLlmCostBreakdown(parsed as LlmPatchEnvelope))
    if (!costBreakdown) {
      console.warn(`Free report cost recovery costBreakdown not parsed; response shape: ${JSON.stringify(summarizeObjectShape(parsed)).slice(0, 1200)}`)
      throw new Error('LLM costBreakdown recovery response did not include costBreakdown')
    }

    const costFailure = getFreeCostBreakdownFailure(context, costBreakdown)
    if (costFailure) {
      if (process.env.DEBUG_REPORT_LLM === '1') {
        console.warn(`[Free report cost recovery costBreakdown] ${JSON.stringify(costBreakdown).slice(0, 2200)}`)
      }
      throw new Error(`LLM costBreakdown recovery response did not include usable cost items: ${costFailure}`)
    }

    return costBreakdown
  } catch (error) {
    throw new Error(`LLM_STAGE_COST_BREAKDOWN_RECOVERY: ${sanitizeGenerationError(error)}`)
  }
}

const callLlmCostBreakdownPatchWithFeedback = async (
  context: ReportContext,
  ruleReport: GeneratedReport,
  patch: FreeReportPatch,
): Promise<GeneratedReport['plan']['costBreakdown'] | null> => {
  let previousError: string | undefined
  let lastError: unknown
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      return await callLlmCostBreakdownPatch(context, ruleReport, patch, previousError)
    } catch (error) {
      lastError = error
      previousError = sanitizeGenerationError(error).replace(/^LLM_STAGE_COST_BREAKDOWN_RECOVERY:\s*/, '')
      if (attempt < 2) {
        console.warn(`LLM_STAGE_COST_BREAKDOWN_RECOVERY failed, retrying once: ${previousError.slice(0, 1000)}`)
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError || 'LLM_STAGE_COST_BREAKDOWN_RECOVERY failed'))
}

const callLlmAdvancedCarePatch = async (
  context: ReportContext,
  ruleReport: GeneratedReport,
  patch: FreeReportPatch,
  previousError?: string,
): Promise<GeneratedReport['advancedCare'] | null> => {
  try {
    const content = await requestMedicalChatCompletion({
      messages: buildAdvancedCarePrompt(context, ruleReport, patch, previousError),
      expertKnowledgeModules: ['advanced'],
      temperature: 0.1,
      stream: false,
      responseFormat: 'json_object',
      maxTokens: 9000,
      maxAttempts: 2,
    })

    if (!content) return null

    const parsed = dropNullFields(parseLlmJson(content))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('LLM advancedCare recovery response was not a JSON object')
    }

    const advancedCare = normalizeAdvancedCare(getLlmAdvancedCare(parsed as LlmPatchEnvelope), context)
    if (!advancedCare) throw new Error('LLM advancedCare recovery response did not include advancedCare')

    if (!hasUsefulFreeAdvancedCare(advancedCare)) throw new Error('LLM advancedCare recovery response did not include usable content')

    return advancedCare
  } catch (error) {
    throw new Error(`LLM_STAGE_ADVANCED_CARE_RECOVERY: ${sanitizeGenerationError(error)}`)
  }
}

const callLlmAdvancedCarePatchWithFeedback = async (
  context: ReportContext,
  ruleReport: GeneratedReport,
  patch: FreeReportPatch,
): Promise<GeneratedReport['advancedCare'] | null> => {
  let previousError: string | undefined
  let lastError: unknown
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      return await callLlmAdvancedCarePatch(context, ruleReport, patch, previousError)
    } catch (error) {
      lastError = error
      previousError = sanitizeGenerationError(error).replace(/^LLM_STAGE_ADVANCED_CARE_RECOVERY:\s*/, '')
      if (attempt < 2) {
        console.warn(`LLM_STAGE_ADVANCED_CARE_RECOVERY failed, retrying once: ${previousError.slice(0, 1000)}`)
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError || 'LLM_STAGE_ADVANCED_CARE_RECOVERY failed'))
}

const callReportStageWithRetry = async <T>(
  label: string,
  task: () => Promise<T | null>,
): Promise<T> => {
  let lastError: unknown
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const result = await task()
      if (result) return result
      throw new Error(`${label} returned empty`)
    } catch (error) {
      lastError = error
      if (attempt < 2) {
        console.warn(`${label} failed, retrying once: ${sanitizeGenerationError(error).slice(0, 1000)}`)
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError || `${label} failed`))
}

const normalizePackageText = (value?: string) => (value || '').replace(/\s+/g, ' ').trim()

const packageContentSignature = (packageItems: GeneratedReport['packages']) => JSON.stringify(packageItems.map((pkg) => ({
  name: normalizePackageText(pkg.name),
  subtitle: normalizePackageText(pkg.subtitle),
  features: pkg.features.map(normalizePackageText),
  featureDetails: (pkg.featureDetails || []).map((feature) => ({
    label: normalizePackageText(feature.label),
    status: feature.status || 'included',
  })),
  footnote: normalizePackageText(pkg.footnote),
})))

const freeInsufficientMessage = (section: string, context: ReportContext) => {
  const material = context.personalization.requiredMaterials.slice(0, 3).join('、') || '关键医学资料'
  return `${section}需要结合${material}由医疗模型进一步确认；当前资料不足以生成可靠内容，建议补充资料后重新评估。`
}

const unavailableFreeCostBreakdown = (context: ReportContext): NonNullable<GeneratedReport['plan']['costBreakdown']> => ({
  currencyNote: '当前资料不足以生成可靠费用估算；为避免误导，暂不展示通用费用模板。',
  coreMedical: {
    title: '核心医疗费用',
    subtotal: '暂不估算',
    items: [
      { item: '诊断复核与检查', cost: '暂不估算', note: '需医生确认检查项目后再估算。' },
      { item: '治疗或用药费用', cost: '暂不估算', note: '需明确治疗方案后再估算。' },
      { item: '住院或日间治疗', cost: '暂不估算', note: '需确认治疗强度和周期后再估算。' },
    ],
    tip: freeInsufficientMessage('核心医疗费用', context),
  },
  supportServices: {
    title: '配套服务费用',
    subtotal: '暂不估算',
    items: [
      { item: '病历整理与翻译', cost: '暂不估算', note: '需确认资料量和语言后再估算。' },
      { item: '专家预审和医院对接', cost: '暂不估算', note: '需确认医院方向后再估算。' },
      { item: '陪诊和远程随访', cost: '暂不估算', note: '需确认服务深度后再估算。' },
    ],
    tip: '服务费用需在资料预审后确认。',
  },
  living: {
    title: '生活费用',
    subtotal: '暂不估算',
    items: [
      { item: '住宿', cost: '暂不估算', note: '需确认城市和停留天数。' },
      { item: '交通与餐饮', cost: '暂不估算', note: '需确认出行计划和陪同人数。' },
      { item: '签证、保险和备用金', cost: '暂不估算', note: '需确认行程后再估算。' },
    ],
    tip: '生活费用暂不使用通用模板估算。',
  },
  summary: {
    formula: '核心医疗暂不估算 + 配套服务暂不估算 + 生活费用暂不估算 = 暂不估算',
    chinaTotal: '暂不估算',
    referenceCountry: context.input.basicInfo.nationality || '本国或常住地',
    referenceCost: '暂不估算',
    savingsPercent: 0,
    savingsText: '资料不足，暂不计算节省比例/Save 暂不计算',
  },
})

const unavailableFreeAdvancedCare = (context: ReportContext): NonNullable<GeneratedReport['advancedCare']> => ({
  context: freeInsufficientMessage('前沿疗法推荐', context),
  currencyNote: '资料不足时不展示药品费用对比或新药治愈判断。',
  therapies: [{
    name: '暂不推荐具体前沿疗法',
    category: '资料不足',
    recommendationLevel: '资料不足',
    summary: '当前资料不足以判断是否适合前沿疗法、临床研究或特定药物。',
    applicableFor: '需补充诊断、分期、病理、分子检测和既往治疗记录。',
    mechanism: '需医生复核后确认。',
    chinaAccess: '暂不判断。',
    estimatedCost: '暂不估算',
    referenceCost: '暂不估算',
    advantage: '暂不判断优势。',
    evidence: '当前证据不足。',
    limitations: '资料不足时不应据此选择治疗。',
    nextStep: '补齐资料后重新生成前沿疗法建议。',
    tags: ['资料不足'],
  }],
  drugCostComparison: {
    title: '药品费用对比暂不生成',
    basis: '资料不足，需医生确认同等疗效、适应证和证据前提。',
    summary: '当前不展示药品费用对比，避免误导用药选择。',
    items: [{
      drugName: '暂不指定药品',
      drugClass: '资料不足',
      chinaOption: '暂不判断',
      referenceOption: '暂不判断',
      chinaCost: '暂不估算',
      referenceCost: '暂不估算',
      efficacyEquivalence: '资料不足，需医生确认是否存在同等疗效前提。',
      savingInsight: '暂不计算节省。',
      eligibility: '需补充关键检测和治疗史。',
    }],
    note: '药物选择必须由执业医生结合完整资料确认。',
  },
  newDrugCureAssessment: {
    headline: '是否有新药可治愈：暂不判断',
    answer: '当前资料不足，不能判断是否存在可治愈的新药方案。',
    summary: '补充分期、病理、基因检测和既往治疗后，再评估新药或临床研究价值。',
    items: [{
      name: '暂不指定新药',
      type: '资料不足',
      applicableFor: '需医生复核后确认。',
      evidence: '当前证据不足。',
      chinaAvailability: '暂不判断。',
      potentialRole: '暂不判断治疗作用。',
      limitations: '不能承诺治愈或疗效。',
      nextStep: '补齐资料后重新评估。',
    }],
    ctaItems: ['补充关键医学资料', '完成医生预审', '重新生成前沿疗法建议'],
  },
  disclaimer: '本节未使用通用模板替代医疗模型判断，最终方案需以医生意见为准。',
})

const unavailableFreeSection = <K extends keyof GeneratedReport>(
  key: K,
  context: ReportContext,
): GeneratedReport[K] => {
  const message = freeInsufficientMessage('本节内容', context)
  const sections: Partial<Record<keyof GeneratedReport, unknown>> = {
    disease: '待医生确认的就医方向',
    treatment: freeInsufficientMessage('治疗路径', context),
    countries: [
      { flag: '🇨🇳', name: '中国', fee: '暂不估算', wait: '需预审确认', tech: '补齐资料后再评估医院和治疗路径。', service: '可先进行资料整理和医生预审。', visa: '暂不建议直接安排行程。', follow: '补齐资料后再确认随访方式。', recommended: false },
      { flag: '🌐', name: '本国或其他地区', fee: '暂不估算', wait: '需自行确认', tech: '建议先完成当地补充检查。', service: '暂不比较服务差异。', visa: '不适用', follow: '可先保留当地医生随访。' },
    ],
    advantages: [
      { label: '资料完整度待提升', value: message },
      { label: '医院匹配暂不生成', value: '补齐关键资料后再生成医院和专家方向。' },
      { label: '费用节省暂不计算', value: '缺少可靠治疗路径时，不展示节省比例。' },
    ],
    concerns: [
      { concern: '资料不足', solution: message },
      { concern: '治疗路径未确认', solution: '需医生复核后再确认检查、治疗和用药。' },
      { concern: '费用暂不可靠', solution: '不使用通用费用模板替代医疗模型估算。' },
      { concern: '出行安排暂缓', solution: '建议先完成资料预审，再规划赴华行程。' },
    ],
    hospitals: [{
      city: '待确认',
      name: '暂不推荐具体医院',
      reason: freeInsufficientMessage('医院推荐', context),
      department: '需补充资料后匹配',
      matchScore: 0,
      waitTime: '需预审确认',
      preparation: '补齐资料后再生成匹配度、等待时间和准备清单。',
    }],
    highlights: [
      '当前资料不足，暂不展示具体医院推荐。',
      '当前不使用通用费用模板替代医疗模型估算。',
      '建议先补充关键医学资料并完成医生预审。',
      '如出现急性变化，请优先在当地就医。',
    ],
    packages: [
      { name: '基础评估包 / Basic', subtitle: '资料补充后再细化', price: '暂不报价', originalPrice: '暂不报价', icon: 'FileText', highlight: false, features: ['资料清单整理', '基础预审准备', '暂不含治疗结论'], featureDetails: [{ label: '资料清单整理', status: 'included' }, { label: '基础预审准备', status: 'included' }, { label: '具体医院和费用需补充资料后生成', status: 'excluded' }], footnote: '当前资料不足，暂不生成个性化服务包报价。' },
      { name: '标准面诊包 / Standard', subtitle: '医生预审后确认', price: '暂不报价', originalPrice: '暂不报价', icon: 'Video', highlight: true, features: ['医生预审后确认', '面诊条件待评估', '费用暂不估算'], featureDetails: [{ label: '医生预审后确认', status: 'emphasis' }, { label: '面诊条件待评估', status: 'included' }, { label: '暂不承诺预约或费用', status: 'excluded' }], footnote: '补齐资料后再确认是否适合视频面诊。' },
      { name: '深度面诊包 / Premium', subtitle: '暂不生成深度方案', price: '暂不报价', originalPrice: '暂不报价', icon: 'MessageSquare', highlight: false, features: ['MDT条件待评估', '专家匹配待确认', 'VIP号源暂不承诺'], featureDetails: [{ label: 'MDT条件待评估', status: 'included' }, { label: '专家匹配待确认', status: 'included' }, { label: '暂不承诺VIP号源', status: 'excluded' }], footnote: '深度方案需在资料齐备后生成。' },
    ],
    advancedCare: unavailableFreeAdvancedCare(context),
    paymentAndInsurance: [
      '当前资料不足以生成可靠预算或保险建议，建议先完成资料预审。',
      '补齐资料后再确认费用项目、预授权、直付或理赔材料。',
    ],
    plan: {
      direction: freeInsufficientMessage('治疗路径', context),
      duration: '暂不建议直接安排行程',
      totalCost: '暂不估算',
      breakdown: [
        { item: '资料补充', cost: '暂不估算' },
        { item: '医生预审', cost: '暂不估算' },
        { item: '检查或治疗路径确认', cost: '暂不估算' },
        { item: '出行和服务安排', cost: '暂不估算' },
      ],
      costBreakdown: unavailableFreeCostBreakdown(context),
    },
  }

  return sections[key] as GeneratedReport[K]
}

const isUnavailableFreeSection = (value: unknown) => /暂不|资料不足|需补充资料/.test(JSON.stringify(value))

const buildUnavailableFreeReport = (
  context: ReportContext,
  ruleReport: GeneratedReport,
): GeneratedReport => {
  const plan = unavailableFreeSection('plan', context)
  return generatedReportSchema.parse({
    ...ruleReport,
    disease: unavailableFreeSection('disease', context),
    treatment: unavailableFreeSection('treatment', context),
    countries: unavailableFreeSection('countries', context),
    advantages: unavailableFreeSection('advantages', context),
    concerns: unavailableFreeSection('concerns', context),
    hospitals: unavailableFreeSection('hospitals', context),
    plan,
    packages: unavailableFreeSection('packages', context),
    advancedCare: unavailableFreeSection('advancedCare', context),
    highlights: unavailableFreeSection('highlights', context),
    paymentAndInsurance: unavailableFreeSection('paymentAndInsurance', context),
    score: 0,
    id: context.submissionNo,
    date: context.dateLabel,
    need: getNeedForReport(context),
    generatedBy: 'rules',
  })
}

const mergeLlmPatch = (
  patch: FreeReportPatch,
  context: ReportContext,
  ruleReport: GeneratedReport,
) => {
  const patchPackages = normalizeLlmPackageItems(patch.packages)
  const servicePackages = patchPackages && packageContentSignature(patchPackages) !== packageContentSignature(ruleReport.packages)
    ? patchPackages
    : unavailableFreeSection('packages', context)
  const planPatch = patch.plan || {}
  const unavailablePlan = unavailableFreeSection('plan', context)
  const normalizedCostBreakdown = normalizeLlmCostBreakdown(planPatch.costBreakdown)
  const planBreakdown = normalizePlanBreakdown(planPatch.breakdown, context)

  const patchedReport = generatedReportSchema.parse({
    ...ruleReport,
    disease: typeof patch.disease === 'string' && patch.disease.trim()
      ? patch.disease.trim().slice(0, 24)
      : unavailableFreeSection('disease', context),
    treatment: typeof patch.treatment === 'string' && patch.treatment.trim()
      ? patch.treatment.trim()
      : unavailableFreeSection('treatment', context),
    countries: normalizeCountries(patch.countries, ruleReport.countries, context),
    advantages: normalizeAdvantages(patch.advantages, context),
    concerns: normalizeConcerns(patch.concerns, context),
    hospitals: normalizeHospitals(patch.hospitals, context),
    highlights: normalizeStringList(patch.highlights).length
      ? normalizeStringList(patch.highlights)
      : unavailableFreeSection('highlights', context),
    packages: servicePackages,
    advancedCare: normalizeAdvancedCare(patch.advancedCare, context) || unavailableFreeSection('advancedCare', context),
    paymentAndInsurance: normalizeStringList(patch.paymentAndInsurance).length >= 2
      ? normalizeStringList(patch.paymentAndInsurance)
      : [
        softLlmMissing('支付方式、预授权或理赔材料'),
        softLlmMissing('医院预付款、直付或事后理赔路径'),
      ],
    plan: {
      ...unavailablePlan,
      direction: typeof planPatch.direction === 'string' && planPatch.direction.trim()
        ? planPatch.direction.trim()
        : unavailablePlan.direction,
      duration: typeof planPatch.duration === 'string' && planPatch.duration.trim()
        ? planPatch.duration.trim()
        : unavailablePlan.duration,
      totalCost: typeof planPatch.totalCost === 'string' && planPatch.totalCost.trim()
        ? planPatch.totalCost.trim()
        : unavailablePlan.totalCost,
      breakdown: planBreakdown,
      costBreakdown: normalizedCostBreakdown || unavailablePlan.costBreakdown,
    },
    id: context.submissionNo,
    date: context.dateLabel,
    need: getNeedForReport(context),
    generatedBy: 'llm',
  })

  return finalizeReportCosts(patchedReport, context)
}

const reportContainsAny = (report: GeneratedReport, terms: string[]) => {
  const text = JSON.stringify(report)
  return terms.some((term) => text.includes(term))
}

const hasRmbUsdCostFormat = (value?: string) => (
  Boolean(value && (/[￥¥]\s*[\d,]+/.test(value) || hasParsedMoney(value)) && (/\$\s*[\d,]+/.test(value) || hasParsedMoney(value)))
)

const hasDetailedCostFormat = (report: GeneratedReport) => {
  const breakdown = report.plan.costBreakdown
  if (!breakdown) return false

  const categories = [breakdown.coreMedical, breakdown.supportServices, breakdown.living]
  const allSubtotalsFormatted = categories.every((category) => Boolean(category.subtotal.trim()))
  const allItemsFormatted = categories.every((category) => (
    category.items.length >= 3 && category.items.every((item) => Boolean(item.item.trim()) && Boolean(item.cost.trim()))
  ))
  const summaryFormatted = [
    Boolean(breakdown.summary.formula.trim()),
    Boolean(breakdown.summary.chinaTotal.trim()),
    Boolean(breakdown.summary.referenceCost.trim()),
    Boolean(breakdown.summary.savingsText.trim()),
  ].every(Boolean)

  return allSubtotalsFormatted && allItemsFormatted && summaryFormatted
}

const hasAdvancedCareCostFormat = (value?: string) => (
  Boolean(value && (/暂无|待|未|不适用|N\/A/i.test(value) || hasRmbUsdCostFormat(value) || /\$\s*[\d,]+/.test(value)))
)

const getAdvancedCareFailure = (report: GeneratedReport) => {
  const advancedCare = report.advancedCare
  if (!advancedCare) return 'advanced care insights are missing'

  const therapiesDetailed = advancedCare.therapies.length >= 1 && advancedCare.therapies.every((therapy) => (
    Boolean(therapy.name.trim()) &&
    Boolean(therapy.summary.trim()) &&
    Boolean(therapy.limitations.trim()) &&
    Boolean(therapy.nextStep.trim())
  ))
  if (!therapiesDetailed) return 'advanced therapy recommendations are incomplete'

  const drugComparison = advancedCare.drugCostComparison
  const drugComparisonDetailed = Boolean(
    drugComparison.title.trim() &&
    drugComparison.basis.trim() &&
    drugComparison.summary.trim() &&
    drugComparison.items.length >= 1 &&
    drugComparison.items.every((item) => (
      Boolean(item.drugName.trim()) &&
      Boolean(item.efficacyEquivalence.trim())
    )),
  )
  if (!drugComparisonDetailed) return 'drug cost comparison is incomplete'

  if (!hasDrugEquivalenceBasis(drugComparison)) return 'drug cost comparison does not state efficacy equivalence basis'

  const cureAssessment = advancedCare.newDrugCureAssessment
  const cureAssessmentDetailed = Boolean(
    cureAssessment.headline.trim() &&
    cureAssessment.answer.trim() &&
    cureAssessment.summary.trim() &&
    cureAssessment.items.length >= 1 &&
    cureAssessment.items.every((item) => (
      Boolean(item.name.trim()) &&
      Boolean(item.potentialRole.trim()) &&
      Boolean(item.limitations.trim())
    )),
  )
  if (!cureAssessmentDetailed) return 'new drug cure assessment is incomplete'

  const cureText = `${cureAssessment.answer} ${cureAssessment.summary} ${cureAssessment.items.map((item) => `${item.potentialRole} ${item.limitations}`).join(' ')}`
  const positiveCurePromisePattern = /(?:保证|一定|可承诺|可以|能够|有望|实现|达到|百分百|100%)[^。；.!?]{0,12}(?:治愈|根治|痊愈)/
  const negatedCurePattern = /(?:没有|没|无|不能|无法|不可|不应|不能承诺|暂无|尚无|不保证|无法保证|不等于|不是|通常不能|不适用|并非|不能保证)[^。；.!?]{0,48}(?:治愈|根治|痊愈)/
  const overpromisesCure = positiveCurePromisePattern.test(cureText) && !negatedCurePattern.test(cureText)
  if (overpromisesCure) return 'new drug cure assessment overpromises cure'

  const referencesPatientContext = includesAny(JSON.stringify(advancedCare), [
    report.disease,
    '主诉',
    '病例',
    '病情',
    '资料',
    '影像',
    '病理',
    '检测',
    '分期',
    '治疗',
    '用药',
    '不适用',
    '资料不足',
  ])
  if (!referencesPatientContext) return 'advanced care insights do not reference patient context'

  if (!advancedCare.context.trim() || !advancedCare.disclaimer.trim()) {
    return 'advanced care context or disclaimer is incomplete'
  }

  return null
}

const getDetailedLlmPackagesFailure = (report: GeneratedReport) => {
  if (report.packages.length < 3) return 'professional service packages must include three tiers'

  const basicPackage = report.packages.find((pkg) => /Basic|基础/.test(pkg.name))
  const standardPackage = report.packages.find((pkg) => /Standard|标准/.test(pkg.name))
  const premiumPackage = report.packages.find((pkg) => /Premium|深度|MDT|多学科/.test(pkg.name))
  const everyPackageDetailed = report.packages.every((pkg) => (
    Boolean(pkg.name.trim()) &&
    Boolean(pkg.price.trim()) &&
    (pkg.features.length >= 3 || Boolean(pkg.featureDetails?.length && pkg.featureDetails.length >= 3))
  ))
  if (!basicPackage || !standardPackage || !premiumPackage) return 'professional service package tiers are missing Basic, Standard or Premium'
  if (!everyPackageDetailed) return 'professional service package features are too coarse'

  return null
}

const ensureFreeReportCompleteness = (report: GeneratedReport, context: ReportContext) => {
  const reportText = JSON.stringify(report)
  const packageFailure = getDetailedLlmPackagesFailure(report)
  const advancedCareFailure = getAdvancedCareFailure(report)
  const requiredChecks: Array<[boolean, string]> = [
    [report.generatedBy === 'llm', 'report was not generated by medical LLM'],
    [report.countries.length >= 2, 'country comparison is incomplete'],
    [report.countries.some((country) => country.recommended || country.name.includes('中国')), 'China recommendation is missing'],
    [context.diseaseKey === 'dental' || isUnavailableFreeSection(report.hospitals) ? report.hospitals.length >= 1 : report.hospitals.length >= 3, 'hospital recommendations are incomplete'],
    [report.advantages.length >= 3, 'advantage analysis is incomplete'],
    [report.concerns.length >= 4, 'risk and concern analysis is incomplete'],
    [report.plan.breakdown.length >= 4, 'cost breakdown is incomplete'],
    [Boolean(report.plan.costBreakdown), 'detailed cost breakdown is missing'],
    [Boolean(report.plan.costBreakdown?.coreMedical.items.length && report.plan.costBreakdown.coreMedical.items.length >= 3), 'core medical cost details are incomplete'],
    [Boolean(report.plan.costBreakdown?.supportServices.items.length && report.plan.costBreakdown.supportServices.items.length >= 3), 'support service cost details are incomplete'],
    [Boolean(report.plan.costBreakdown?.living.items.length && report.plan.costBreakdown.living.items.length >= 3), 'living cost details are incomplete'],
    [Boolean(report.plan.costBreakdown?.summary.formula && report.plan.costBreakdown.summary.chinaTotal && report.plan.costBreakdown.summary.referenceCost && report.plan.costBreakdown.summary.savingsText), 'cost savings summary is incomplete'],
    [hasDetailedCostFormat(report), 'detailed cost breakdown format is incomplete'],
    [!packageFailure, packageFailure || 'professional service package details are incomplete'],
    [!advancedCareFailure, advancedCareFailure || 'advanced care insights are incomplete'],
    [report.highlights.length >= 4, 'key highlights are incomplete'],
    [Boolean(report.paymentAndInsurance?.length && report.paymentAndInsurance.length >= 2), 'payment and insurance preparation is missing'],
  ]
  const failed = requiredChecks.find(([passed]) => !passed)
  if (failed) throw new Error(`MEDICAL_LLM_INCOMPLETE_REPORT: ${failed[1]}`)

  if (!context.input.uploadedFiles.length && includesAny(reportText, [
    '上传资料提示',
    '已读取上传',
    '从上传资料',
    '已从上传资料',
    'OCR',
  ])) {
    throw new Error('MEDICAL_LLM_FACT_MISMATCH: free report claimed uploaded medical records')
  }
}

const hasDentalTemplateLeak = (reportText: string, hasDentalFacts: boolean) => {
  if (hasDentalFacts) return false

  const dentalTemplateTerms = ['口腔CBCT', '深龋', '根管治疗', '保牙', '种植牙']
  if (includesAny(reportText, dentalTemplateTerms)) return true

  const mentionsDental = includesAny(reportText, ['牙科', '口腔'])
  if (!mentionsDental) return false

  const legitimateOncologyDentalSafety = includesAny(reportText, [
    '牙科风险评估',
    '口腔风险评估',
    '地舒单抗',
    '唑来膦酸',
    '双膦酸盐',
    '骨保护',
    '颌骨坏死',
  ])

  return !legitimateOncologyDentalSafety
}

const isLlmReportAlignedWithStructuredFacts = (report: GeneratedReport, context: ReportContext) => {
  const reportText = JSON.stringify(report)

  if (context.input.uploadedFiles.length && !context.medicalFacts.hasActionableFacts) {
    const claimsUploadFacts = includesAny(reportText, ['上传资料可识别', '上传资料提示', '已识别上传资料', '已从上传资料', '基于上传资料'])
    const acknowledgesInsufficientRecognition = includesAny(reportText, ['识别不足', '未识别', '不能据此', '无法辨认', '资料不足', '未提取到足够'])
    if (claimsUploadFacts && !acknowledgesInsufficientRecognition) return false
    if (context.diseaseKey === 'other' && includesAny(reportText, ['乳腺癌', '牙科', '口腔CBCT', '深龋', '肝转移', '骨转移', '淋巴结转移'])) return false
  }

  if (!context.medicalFacts.hasActionableFacts) return true

  const factText = [
    context.medicalFacts.summary,
    ...context.medicalFacts.evidenceHighlights,
    ...context.medicalFacts.documents.flatMap((document) => [
      document.reportType,
      ...document.diagnoses,
      ...document.findings.map((finding) => finding.text),
      ...document.indicators.map((indicator) => `${indicator.name} ${indicator.value}`),
    ]),
  ].join(' ')
  const hasBreastFacts = context.medicalFacts.diseaseSignals.includes('breast_cancer') || includesAny(factText, ['乳腺', 'breast', 'Luminal', 'carcinoma mamma', 'mammae'])
  const hasDentalFacts = context.medicalFacts.diseaseSignals.includes('dental') || includesAny(factText, ['牙', '口腔', 'CBCT', '龋', '根管'])
  const hasLungFacts = context.medicalFacts.diseaseSignals.includes('lung_cancer') || includesAny(factText, ['肺癌', '肺腺癌', 'lung', 'EGFR', 'ALK', 'PD-L1'])
  const hasLiverFacts = context.medicalFacts.diseaseSignals.includes('liver_cancer') || includesAny(factText, ['肝癌', 'HCC', 'AFP', '肝细胞癌'])
  const hasNeuroFacts = context.medicalFacts.diseaseSignals.includes('neurosurgery') || includesAny(factText, ['胶质', '脑肿瘤', 'WHO', 'IDH', 'MGMT'])
  const leaksDental = hasDentalTemplateLeak(reportText, hasDentalFacts)
  const leaksBreast = includesAny(reportText, ['乳腺癌', '乳腺', 'Luminal', 'CDK4/6']) && !hasBreastFacts
  if (leaksDental || leaksBreast) return false

  if (hasBreastFacts) {
    const keepsBreastCancer = includesAny(reportText, ['乳腺癌', '乳腺', 'breast'])
    const keepsEvidence = includesAny(reportText, ['肝脏', '骨骼', '淋巴结', '肺部', '转移', 'PET', 'ER', 'PR', 'HER2', 'Ki-67', '系统治疗'])
    return keepsBreastCancer && keepsEvidence && !leaksDental
  }

  if (hasDentalFacts) {
    const keepsDental = includesAny(reportText, ['牙', '口腔', 'CBCT', '龋', '根管', '保牙', '种植'])
    const leaksCancer = includesAny(reportText, ['乳腺癌', '肝转移', '骨转移', '淋巴结转移', '化疗', '放疗', '靶向治疗']) && !hasBreastFacts
    return keepsDental && !leaksCancer
  }

  if (hasLungFacts) {
    return includesAny(reportText, ['肺癌', '肺腺癌', '肺部', 'EGFR', 'ALK', 'PD-L1', '靶向', '分期'])
  }

  if (hasLiverFacts) {
    return includesAny(reportText, ['肝癌', '肝细胞癌', 'HCC', 'AFP', '肝功能', '介入', '消融', '系统治疗'])
  }

  if (hasNeuroFacts) {
    return includesAny(reportText, ['神经外科', '胶质', '脑', 'WHO', 'IDH', 'MGMT', '放疗', '替莫唑胺'])
  }

  return true
}

const enforceReportGuardrails = (report: GeneratedReport, context: ReportContext, ruleReport: GeneratedReport) => {
  const { personalization, diseaseKey } = context

  if (personalization.mismatch) {
    const requestedTerms = [
      personalization.requestedDepartment,
      context.disease.label,
      ...context.disease.keywords,
    ].filter((term) => term && term !== '综合医学评估' && term !== '其他')
    const allowedMismatchText = `${report.disease} ${report.treatment} ${report.concerns.map((item) => `${item.concern}${item.solution}`).join(' ')}`
    const acknowledgesMismatch = allowedMismatchText.includes('综合分诊') || allowedMismatchText.includes('科室选择') || allowedMismatchText.includes('不一致') || allowedMismatchText.includes('重新确认')
    const leaksRequestedSpecialty = requestedTerms.some((term) => report.disease.includes(term) || report.plan.direction.includes(term))

    if (!acknowledgesMismatch || leaksRequestedSpecialty) {
      console.warn('Free report medical LLM did not acknowledge department mismatch; returning insufficient-data report')
      return buildUnavailableFreeReport(context, ruleReport)
    }
  }

  if (context.input.basicInfo.visitPurpose === 'other' && !personalization.mismatch && report.disease === context.disease.label) {
    report.disease = personalization.reportDiseaseLabel
  }

  if (diseaseKey === 'dental' && reportContainsAny(report, ['肿瘤MDT', '放疗', '化疗', '靶向', '免疫治疗']) && !report.need.includes('肿瘤')) {
    console.warn('Free report medical LLM leaked oncology template into dental case; returning insufficient-data report')
    return buildUnavailableFreeReport(context, ruleReport)
  }

  if (diseaseKey === 'premium_checkup' && reportContainsAny(report, ['手术及住院', '放疗', '化疗']) && !report.need.includes('已确诊')) {
    console.warn('Free report medical LLM leaked treatment template into checkup case; returning insufficient-data report')
    return buildUnavailableFreeReport(context, ruleReport)
  }

  if (!isLlmReportAlignedWithStructuredFacts(report, context)) {
    console.warn('Free report medical LLM was not aligned with submitted facts; returning insufficient-data report')
    return buildUnavailableFreeReport(context, ruleReport)
  }

  const finalizedReport = finalizeReportCosts({
    ...report,
    id: context.submissionNo,
    date: context.dateLabel,
    need: getNeedForReport(context),
    generatedBy: 'llm' as const,
  }, context)

  ensureFreeReportCompleteness(finalizedReport, context)
  return finalizedReport
}

const generateLlmFreeReport = async (
  context: ReportContext,
  ruleReport: GeneratedReport,
  options?: FreeGenerationOptions,
) => {
  const [mainPatchResult, supplementalPatchResult] = await Promise.allSettled([
    trackGenerationPhase('mainPatch', options, () => (
      callLlmPatchWithFeedback(context, ruleReport)
    )),
    trackGenerationPhase('supplementalPatch', options, () => (
      callReportStageWithRetry('LLM_STAGE_SUPPLEMENTAL_PATCH', () => callLlmSupplementalPatch(context, ruleReport))
    )),
  ])

  let llmPatch = mainPatchResult.status === 'fulfilled' ? mainPatchResult.value : null
  const supplementalPatch = supplementalPatchResult.status === 'fulfilled' ? supplementalPatchResult.value : null
  if (mainPatchResult.status === 'rejected') {
    console.warn(`Free report main medical LLM patch unavailable: ${sanitizeGenerationError(mainPatchResult.reason).slice(0, 500)}`)
    try {
      llmPatch = await trackGenerationPhase('mainPatchFallback', options, () => (
        callLlmCorePatchFallback(context, ruleReport, sanitizeGenerationError(mainPatchResult.reason).replace(/^LLM_STAGE_MAIN_PATCH:\s*/, ''))
      ))
    } catch (error) {
      console.warn(`Free report compact main medical LLM patch unavailable: ${sanitizeGenerationError(error).slice(0, 500)}`)
    }
  }
  if (supplementalPatchResult.status === 'rejected') {
    console.warn(`Free report supplemental medical LLM patch unavailable: ${sanitizeGenerationError(supplementalPatchResult.reason).slice(0, 500)}`)
  }
  if (!llmPatch && !supplementalPatch) {
    console.warn('Free report medical LLM did not return main or supplemental content; returning section-level insufficient report')
    return buildUnavailableFreeReport(context, ruleReport)
  }
  if (!llmPatch) {
    console.warn('Free report medical LLM did not return usable main content; returning section-level insufficient report')
    return buildUnavailableFreeReport(context, ruleReport)
  }

  let costBreakdown = supplementalPatch?.plan?.costBreakdown ||
    normalizeLlmCostBreakdown(llmPatch?.plan?.costBreakdown)
  if (!hasUsefulFreeCostBreakdown(context, costBreakdown)) {
    try {
      costBreakdown = await trackGenerationPhase('costBreakdownRecovery', options, () => (
        callLlmCostBreakdownPatchWithFeedback(context, ruleReport, llmPatch || {})
      )) || undefined
    } catch (error) {
      console.warn(`Free report cost breakdown unavailable after medical LLM recovery: ${sanitizeGenerationError(error).slice(0, 500)}`)
      costBreakdown = unavailableFreeCostBreakdown(context)
    }
  }

  let advancedCare = supplementalPatch?.advancedCare || llmPatch?.advancedCare
  if (shouldRequireFreeAdvancedCareRecovery(context) && !hasUsefulFreeAdvancedCare(advancedCare)) {
    try {
      advancedCare = await trackGenerationPhase('advancedCareRecovery', options, () => (
        callLlmAdvancedCarePatchWithFeedback(context, ruleReport, llmPatch || {})
      )) || undefined
    } catch (error) {
      console.warn(`Free report advanced care unavailable after medical LLM recovery: ${sanitizeGenerationError(error).slice(0, 500)}`)
      advancedCare = unavailableFreeAdvancedCare(context)
    }
  }
  if (!shouldRequireFreeAdvancedCareRecovery(context) && !advancedCare) {
    advancedCare = unavailableFreeAdvancedCare(context)
  }

  let hospitals = normalizeHospitals(llmPatch?.hospitals, context)
  if (!hasUsefulFreeHospitalDetails(context, hospitals)) {
    const hospitalFailure = getFreeHospitalDetailsFailure(context, hospitals)
    if (process.env.DEBUG_REPORT_LLM === '1') {
      console.warn(`Free report hospital details not usable before recovery: ${hospitalFailure || 'unknown'}`)
      console.warn(`[Free report normalized hospitals before recovery] ${JSON.stringify(hospitals).slice(0, 2200)}`)
    }
    try {
      hospitals = await trackGenerationPhase('hospitalDetailsRecovery', options, () => (
        callReportStageWithRetry('LLM_STAGE_HOSPITAL_DETAILS_RECOVERY', () => (
          callLlmHospitalDetailsPatch(context, ruleReport, llmPatch || {})
        ))
      )) || hospitals
    } catch (error) {
      console.warn(`Free report hospital details unavailable after medical LLM recovery: ${sanitizeGenerationError(error).slice(0, 500)}`)
    }
  }

  let packageItems = normalizeLlmPackageItems(llmPatch?.packages)
  if (!packageItems?.length || packageItems.some((pkg) => !pkg.featureDetails?.length || pkg.featureDetails.length < 6)) {
    try {
      packageItems = await trackGenerationPhase('packagesRecovery', options, () => (
        callLlmPackagePatchWithFeedback(context, ruleReport, {
          ...llmPatch,
          hospitals,
          plan: {
            ...llmPatch.plan,
            costBreakdown,
          },
          advancedCare,
        })
      )) || packageItems
    } catch (error) {
      console.warn(`Free report packages unavailable after medical LLM recovery: ${sanitizeGenerationError(error).slice(0, 500)}`)
    }
  }

  const mergedPatch: FreeReportPatch = {
    ...(llmPatch || {}),
  }
  if (hospitals) mergedPatch.hospitals = hospitals
  if (packageItems) mergedPatch.packages = packageItems
  mergedPatch.plan = {
    ...mergedPatch.plan,
    costBreakdown,
  }
  mergedPatch.advancedCare = advancedCare
  const hasAnyModelContent = Boolean(
    llmPatch ||
    supplementalPatch ||
    costBreakdown ||
    advancedCare ||
    hospitals,
  )
  if (!hasAnyModelContent) {
    return buildUnavailableFreeReport(context, ruleReport)
  }

  return enforceReportGuardrails(mergeLlmPatch(mergedPatch, context, ruleReport), context, ruleReport)
}

export const generateReport = async (
  input: ReportSubmissionInput,
  submissionNo: string,
  options?: FreeGenerationOptions,
): Promise<GeneratedReport> => {
  const match = getDiseaseMatch(input)
  const medicalFacts = collectMedicalFactBundle(input.parsedFiles)
  const context: ReportContext = {
    submissionNo,
    dateLabel: getDateLabel(),
    input,
    diseaseKey: match.key,
    disease: match.disease,
    personalization: buildPersonalization(input, match),
    selectedRegionItems: getRegionItems(input.selectedRegions),
    documentKnowledge: getKnowledgeForFreeReport(input, match.key),
    medicalFacts,
  }
  const profile = matchProfile({ chiefComplaint: input.basicInfo.chiefComplaint, careNeed: input.basicInfo.careNeed, careNeedOther: input.basicInfo.careNeedOther, summaries: input.parsedFiles.map(f => f.summary) }, medicalFacts,
    [input.basicInfo.fullName, input.basicInfo.phone, input.basicInfo.email, input.basicInfo.dateOfBirth])
  return withExpertKnowledge('free', submissionNo, match.key, profile, async () => {
  const ruleReport = buildRuleReport(context)
  try {
    const llmReport = await generateLlmFreeReport(context, ruleReport, options)
    return sanitizeReportText(withFreeLayoutSections(llmReport, context))
  } catch (error) {
    console.warn(`Report LLM generation failed after section retries; returning section-level insufficient report: ${sanitizeGenerationError(error).slice(0, 1000)}`)
    return sanitizeReportText(withFreeLayoutSections(buildUnavailableFreeReport(context, ruleReport), context))
  }
  })
}
