import { config } from '../config.js'
import type { ProfessionalReportSubmissionInput } from '../validators/professionalReportSubmission.js'
import { getKnowledgeForProfessionalReport, type DocumentKnowledgeBlock } from './documentKnowledge.js'
import {
  dentalAdvantages,
  dentalComparableRegionFees,
  dentalCostCurrencyNote,
  dentalImplantPriceItems,
  dentalImplantSteps,
  dentalPartner,
  dentalSimulationPlan,
  dentalVeneerPriceItems,
  isFullArchImplantNeed,
  isVeneerNeed,
} from './dentalKnowledge.js'
import { defaultDisease, diseases, regions, type KnowledgeDisease, type KnowledgeRegion } from './knowledgeBase.js'
import type { ReportLayoutSection } from './layoutTypes.js'
import {
  collectMedicalFactBundle,
  summarizeMedicalFactBundle,
  type MedicalFactBundle,
  type MedicalIndicatorFact,
  type MedicalMetastasisSignal,
} from './medicalFactExtractor.js'
import { professionalReportSchema, type ProfessionalReport } from './professionalTypes.js'
import { sanitizeReportText } from './textSanitizer.js'

type ProfessionalContext = {
  submissionNo: string
  dateLabel: string
  input: ProfessionalReportSubmissionInput
  diseaseKey: string
  disease: KnowledgeDisease
  selectedRegions: KnowledgeRegion[]
  dataCompleteness: number
  missingMaterials: string[]
  decisionQuestions: string[]
  redFlags: string[]
  documentKnowledge: DocumentKnowledgeBlock[]
  medicalFacts: MedicalFactBundle
}

type CostRange = { min: number; max: number }

const purposeAliases: Record<string, string> = {
  heart_surgery: 'cardiology_cardiothoracic',
  orthopedic: 'spine_surgery',
  checkup: 'premium_checkup',
}

const getDateLabel = () => {
  const now = new Date()
  const month = `${now.getMonth() + 1}`.padStart(2, '0')
  const day = `${now.getDate()}`.padStart(2, '0')
  return `${now.getFullYear()}年${month}月${day}日`
}

const normalizeText = (text: string) => text.toLowerCase().replace(/\s+/g, '')

const includesAny = (text: string, keywords: string[]) => {
  const normalized = normalizeText(text)
  return keywords.some((keyword) => normalized.includes(normalizeText(keyword)))
}

const unique = (items: string[]) => Array.from(new Set(items.filter(Boolean)))

const getSubmittedEvidenceText = (input: ProfessionalReportSubmissionInput) => [
  input.medical.visitPurpose,
  input.medical.diagnosis,
  input.medical.stage,
  input.medical.chiefComplaint,
  input.medical.pathologySummary,
  input.medical.imagingSummary,
  input.medical.geneticSummary,
  input.medical.treatmentHistory,
  input.medical.medicationHistory,
  input.medical.comorbidities,
  input.medical.allergyHistory,
  ...input.parsedFiles.flatMap((file) => [file.summary, file.text]),
  ...summarizeMedicalFactBundle(collectMedicalFactBundle(input.parsedFiles), 10),
].join(' ')

const getSelectedRegions = (selectedRegions: string[]) => {
  return selectedRegions.flatMap((region) => regions[region] || regions.other)
}

const resolveDisease = (input: ProfessionalReportSubmissionInput) => {
  const requestedKey = purposeAliases[input.medical.visitPurpose] || input.medical.visitPurpose
  if (diseases[requestedKey]) return { key: requestedKey, disease: diseases[requestedKey] }

  const text = getSubmittedEvidenceText(input)

  const matched = Object.entries(diseases)
    .filter(([key]) => key !== 'other')
    .map(([key, disease]) => ({
      key,
      disease,
      hits: disease.keywords.filter((keyword) => normalizeText(text).includes(normalizeText(keyword))).length,
    }))
    .filter((item) => item.hits > 0)
    .sort((left, right) => right.hits - left.hits)[0]

  return matched ? { key: matched.key, disease: matched.disease } : { key: 'other', disease: defaultDisease }
}

const professionalMaterialMap: Record<string, string[]> = {
  dental: ['口腔全景片或CBCT', '疼痛牙位、冷热刺激痛和夜间痛记录', '牙周检查记录', '既往补牙/根管/拔牙/种植记录', '缺牙位置和牙列照片', '药物过敏史'],
  breast_cancer: ['病理报告与免疫组化', '乳腺超声/钼靶/MRI', 'TNM分期资料', 'ER/PR/HER2/Ki-67', '既往治疗记录'],
  lung_cancer: ['胸部CT原始影像', '病理报告', '基因检测与PD-L1', '分期检查', '既往靶向/免疫/放化疗记录'],
  liver_cancer: ['肝脏增强MRI/CT', 'AFP等肿瘤标志物', '肝功能与凝血功能', '乙肝/丙肝病毒学资料', '既往介入/消融/系统治疗记录'],
  nasopharyngeal_cancer: ['鼻咽镜病理', '头颈部MRI', 'EBV DNA', '分期资料', '既往放化疗记录'],
  neurosurgery: ['头颅或脊髓MRI原始影像', '病理报告或影像诊断意见', '神经功能评估', '癫痫/头痛/肢体功能变化记录', '既往手术/放疗资料'],
  spine_surgery: ['脊柱MRI/CT', '肌力和麻木范围记录', '大小便功能情况', '既往保守治疗记录', '疼痛评分和影响生活程度'],
  cardiology_cardiothoracic: ['心电图', '心脏超声', '冠脉CTA或造影', '心功能指标', '当前用药和既往介入/手术记录'],
  cardiovascular_tumor: ['心脏超声', '增强CT/MRI', '肿瘤位置和范围资料', '心功能评估', '既往病理或穿刺结果'],
  endocrinology_metabolism: ['血糖/糖化血红蛋白或相关指标趋势', '甲状腺/激素/代谢检查', '并发症筛查资料', '当前用药和剂量', '体重和生活方式记录'],
  premium_checkup: ['年龄、家族史和既往病史', '既往体检异常结果', '重点关注器官或疾病风险', '用药和过敏史', '是否需要胃肠镜/影像/肿瘤早筛'],
  other: ['既往检查报告', '近期影像或化验资料', '症状出现时间和变化', '既往诊断与治疗记录', '当前最想解决的问题'],
}

const decisionQuestionMap: Record<string, string[]> = {
  dental: ['患牙是否还能保留，还是需要拔除后修复？', '疼痛来自龋坏、牙髓/根尖感染还是牙周问题？', '如需种植，是否属于半口/全口、骨量不足或穿颧穿翼等复杂路径？'],
  breast_cancer: ['病理类型、受体状态和分期是否完整？', '是否适合保乳、全切或先行新辅助治疗？', '术后是否需要化疗、放疗、内分泌或靶向治疗？'],
  lung_cancer: ['是否已取得病理诊断和完整分期？', '是否存在可靶向突变或免疫治疗指征？', '当前更适合手术、放疗、系统治疗还是联合方案？'],
  neurosurgery: ['病灶性质和手术风险是否明确？', '是否需要显微手术、放射外科、药物治疗或观察随访？', '当前症状是否提示急性神经功能风险？'],
  spine_surgery: ['神经压迫程度是否达到手术指征？', '保守治疗、微创手术和开放手术如何排序？', '术后康复和回国复查如何衔接？'],
  cardiology_cardiothoracic: ['是否仅需门诊评估、介入治疗或外科手术？', '心功能和围术期风险等级如何？', '治疗后康复和长期用药如何管理？'],
  premium_checkup: ['筛查项目是否与年龄、家族史和症状匹配？', '异常结果由哪个专科承接？', '是否需要把体检和专科二诊合并安排？'],
  other: ['最优先的主责专科是什么？', '是否存在需要先在当地处理的危险信号？', '来华前还缺哪些资料才能让专家有效预审？'],
}

const getDataCompleteness = (input: ProfessionalReportSubmissionInput) => {
  const hasParsedText = input.parsedFiles.some((file) => file.text.trim().length > 80)
  const medicalFacts = collectMedicalFactBundle(input.parsedFiles)
  const checks = [
    input.patient.fullName,
    input.patient.gender,
    input.patient.phone,
    input.medical.visitPurpose,
    input.medical.chiefComplaint,
    input.medical.diagnosis,
    input.medical.stage,
    input.medical.pathologySummary,
    input.medical.imagingSummary,
    input.medical.geneticSummary,
    input.medical.treatmentHistory,
    input.medical.medicationHistory,
    input.medical.comorbidities,
    input.uploadedFiles.length ? 'files' : '',
    hasParsedText ? 'parsed' : '',
    medicalFacts.hasActionableFacts ? 'medical_facts' : '',
  ]
  return Math.round((checks.filter((item) => String(item || '').trim()).length / checks.length) * 100)
}

const getMissingMaterials = (input: ProfessionalReportSubmissionInput, diseaseKey: string) => {
  const base = professionalMaterialMap[diseaseKey] || professionalMaterialMap.other
  const missing = [...base]
  const evidenceText = getSubmittedEvidenceText(input)

  const removeFirst = (predicate: (item: string) => boolean) => {
    const index = missing.findIndex(predicate)
    if (index >= 0) missing.splice(index, 1)
  }

  if (input.medical.pathologySummary || includesAny(evidenceText, ['病理', '免疫组化', '活检'])) removeFirst((item) => item.includes('病理'))
  if (input.medical.imagingSummary || includesAny(evidenceText, ['影像', 'MRI', 'CT', '超声', 'CBCT', '全景片'])) {
    removeFirst((item) => item.includes('影像') || item.includes('MRI') || item.includes('CT') || item.includes('CBCT') || item.includes('全景片'))
  }
  if (input.medical.geneticSummary || includesAny(evidenceText, ['基因', 'Ki-67', 'HER2', 'PD-L1', 'EGFR', 'ALK', 'IDH', 'MGMT'])) {
    removeFirst((item) => item.includes('基因') || item.includes('Ki-67') || item.includes('HER2') || item.includes('PD-L1'))
  }
  if (input.medical.treatmentHistory || includesAny(evidenceText, ['既往治疗', '手术', '化疗', '放疗', '补牙', '根管', '拔牙', '种植'])) {
    removeFirst((item) => item.includes('既往治疗') || item.includes('治疗记录') || item.includes('补牙') || item.includes('根管') || item.includes('拔牙') || item.includes('种植'))
  }
  if (input.medical.allergyHistory || includesAny(evidenceText, ['过敏', '青霉素', '头孢', '麻药'])) {
    removeFirst((item) => item.includes('过敏'))
  }
  if (includesAny(evidenceText, ['牙周', '牙龈', '牙槽骨'])) removeFirst((item) => item.includes('牙周'))
  if (includesAny(evidenceText, ['疼痛', '牙痛', '牙疼', '冷热', '夜间痛'])) removeFirst((item) => item.includes('疼痛'))

  return missing.filter(Boolean).slice(0, 6)
}

const getRedFlags = (input: ProfessionalReportSubmissionInput, diseaseKey: string) => {
  const text = getSubmittedEvidenceText(input)
  const flags: string[] = []

  if (includesAny(text, ['发热', '脓肿', '张口受限', '吞咽困难', '面部肿胀'])) {
    flags.push('可能存在急性感染或局部扩散风险，跨境就医前应先在当地排除急症。')
  }
  if (includesAny(text, ['胸痛', '呼吸困难', '晕厥', '咯血', '心悸加重'])) {
    flags.push('存在心肺急性风险信号，需先就近急诊或专科评估。')
  }
  if (includesAny(text, ['偏瘫', '意识障碍', '抽搐', '大小便障碍', '肌力下降'])) {
    flags.push('存在神经功能进展风险，应尽快完成影像复核和专科判断。')
  }
  if (diseaseKey === 'dental' && includesAny(text, ['种植']) && includesAny(text, ['牙疼', '牙痛', '蛀牙', '龋齿'])) {
    flags.push('牙痛/蛀牙阶段需先判断患牙能否保留，不能直接跳到种植方案。')
  }

  return flags
}

const parseCostValues = (cost: string, pattern: RegExp, divisor = 1) => {
  const matches = [...cost.replace(/,/g, '').matchAll(pattern)]
  return matches.map((match) => {
    const value = Number(match[1])
    const unit = match[2]
    const normalized = unit === 'k' || unit === 'K' || unit === '千'
      ? value * 1000
      : unit === '万'
        ? value * 10000
        : value
    return normalized / divisor
  }).filter((value) => Number.isFinite(value) && value > 0)
}

const parseUsdRange = (cost: string): CostRange | null => {
  const usdValues = parseCostValues(cost, /\$\s*(\d+(?:\.\d+)?)(?:\s*(k|K|千|万))?/g)
  const values = usdValues.length
    ? usdValues
    : parseCostValues(cost, /(?:¥|￥|人民币|RMB)\s*(\d+(?:\.\d+)?)(?:\s*(k|K|千|万))?/gi, 7.2)
  const fallbackValues = values.length
    ? values
    : parseCostValues(cost, /\$?\s*(\d+(?:\.\d+)?)(?:\s*(k|K|千|万))?/g)

  if (!fallbackValues.length) return null
  return { min: Math.min(...fallbackValues), max: Math.max(...fallbackValues) }
}

const sumRanges = (ranges: Array<CostRange | null>) => {
  const valid = ranges.filter(Boolean) as CostRange[]
  if (!valid.length) return null
  return valid.reduce<CostRange>((acc, item) => ({
    min: acc.min + item.min,
    max: acc.max + item.max,
  }), { min: 0, max: 0 })
}

const formatUsd = (value: number) => `$${new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(value)}`
const formatCny = (value: number) => `¥${new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 }).format(Math.round(value * 7.2))}`

const formatDualRange = (range: CostRange | null, fallback: string) => {
  if (!range) return fallback
  const usd = range.min === range.max ? formatUsd(range.min) : `${formatUsd(range.min)}-${formatUsd(range.max)}`
  const cny = range.min === range.max ? formatCny(range.min) : `${formatCny(range.min)}-${formatCny(range.max)}`
  return `${usd} / ${cny}`
}

const formatCnyFirstRange = (range: CostRange | null, fallback: string) => {
  if (!range) return fallback
  const usd = range.min === range.max ? formatUsd(range.min) : `${formatUsd(range.min)}-${formatUsd(range.max)}`
  const cny = range.min === range.max ? formatCny(range.min) : `${formatCny(range.min)}-${formatCny(range.max)}`
  return `${cny}（约${usd}）`
}

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

const cleanEvidenceSnippet = (text: string, maxLength = 220) => {
  const normalized = cleanText(String(text || '')
    .replace(/^医学摘要\s*[:：]\s*/i, '')
    .replace(/\s+/g, ' ')
    .replace(/\.\.\.$/, '')
    .trim())
  if (!normalized) return ''
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}...` : normalized
}

const isDisplayableClinicalEvidence = (text: string) => {
  const value = cleanText(text).trim()
  if (!value) return false
  if (includesAny(value, [
    '医学摘要',
    '报告可见内容',
    '主要结论',
    'Patient Name',
    'Patient ID',
    'Accession No',
    'NO MR',
    'Kementerian',
    '出生日期',
    'DOB',
    'Study Date',
    'portaca',
  ])) return false
  if (/^患者\s*[A-Za-z]/.test(value)) return false
  if (/^[A-Za-z .,'-]+，?(男|女|male|female|perempuan)[，, ]+\d+/.test(value)) return false
  return true
}

const getDisplayClinicalEvidenceItems = (items: string[], limit = 3, maxLength = 180) => {
  const cleaned = unique(items
    .map((item) => cleanEvidenceSnippet(item, maxLength))
    .filter((item) => item && isDisplayableClinicalEvidence(item)))
  return cleaned.slice(0, limit)
}

const getDisplayEvidenceItems = (items: string[], limit = 3, maxLength = 180) => {
  const cleaned = unique(items
    .map((item) => cleanEvidenceSnippet(item, maxLength))
    .filter(Boolean))
  const clinical = cleaned.filter((item) => !includesAny(item, [
    '出生日期',
    'DOB',
    'Patient Name',
    'Patient ID',
    'NO MR',
    'Accession No',
    'Kementerian',
    '地址',
    '电话',
  ]) && isDisplayableClinicalEvidence(item))
  return clinical.slice(0, limit)
}

const summarizeParsedFileForDisplay = (file: ProfessionalReportSubmissionInput['parsedFiles'][number]) => {
  if (file.metadata?.medicalFacts && typeof file.metadata.medicalFacts === 'object' && 'sourceEvidence' in file.metadata.medicalFacts) {
    const facts = file.metadata.medicalFacts as {
      reportType?: string
      primaryDate?: string
      diagnoses?: string[]
      sourceEvidence?: string[]
    }
    const displayEvidence = getDisplayEvidenceItems([
      ...(facts.diagnoses || []),
      ...(facts.sourceEvidence || []),
    ], 3, 200)
    return [
      `结构化识别：${facts.reportType || '医学资料'}${facts.primaryDate ? `；${facts.primaryDate}` : ''}`,
      ...displayEvidence,
    ].join('；') || '未提取到可用正文'
  }

  const displayEvidence = getDisplayEvidenceItems([file.summary || file.error || file.text || ''], 1, 240)
  return displayEvidence[0] || (file.status === 'failed' ? '未提取到可用正文' : '已解析文件，需医生复核原件。')
}

const uniqueSortedDates = (dates: string[]) => unique(dates
  .filter((date) => date && date !== '日期待确认' && isLikelyClinicalReportDate(date)))
  .sort((left, right) => dateValue(left) - dateValue(right))

const formatMonthLabel = (date: string) => {
  const match = date.match(/^(\d{4})-(\d{2})/)
  return match ? `${match[1]}年${Number(match[2])}月` : date
}

const getDentalCaseText = (context: ProfessionalContext) => getSubmittedEvidenceText(context.input)

const getDentalCaseFlags = (context: ProfessionalContext) => {
  const text = getDentalCaseText(context)
  const implant = isFullArchImplantNeed(text) || includesAny(text, ['种植', 'implant', '缺牙', '拔牙后', '植骨', '上颌窦'])
  const veneer = isVeneerNeed(text)
  const basic = includesAny(text, ['牙疼', '牙痛', '蛀牙', '龋齿', '补牙', '根管', '牙髓', '牙神经', '牙周', '牙龈'])
  return { text, implant, fullArch: isFullArchImplantNeed(text), veneer, basic }
}

const buildDentalMedicalCostProfile = (context: ProfessionalContext) => {
  const flags = getDentalCaseFlags(context)
  const baseItems = [
    {
      item: '口腔全景片/CBCT、牙周与咬合评估',
      cost: '需鼎植面诊报价',
      note: '用于判断疼痛来源、牙槽骨条件、神经管位置、咬合关系和种植/修复可行性。',
    },
  ]

  if (flags.implant) {
    return {
      total: flags.fullArch
        ? '¥98,000-¥298,000（约$13,600-$41,400）'
        : '需鼎植结合CBCT正式报价；资料中半口即刻负重参考¥98,000起（约$13,600起）',
      items: [
        ...baseItems,
        ...dentalImplantPriceItems.map((item) => ({
          item: item.item,
          cost: item.cost,
          note: item.note,
        })),
      ],
    }
  }

  if (flags.veneer) {
    return {
      total: '¥2,680-¥85,000（约$400-$11,800）',
      items: [
        ...baseItems,
        ...dentalVeneerPriceItems.map((item) => ({
          item: item.item,
          cost: item.cost,
          note: item.note,
        })),
      ],
    }
  }

  return {
    total: '建议先预留¥2,000-¥15,000（约$300-$2,100）用于检查、止痛、补牙/根管等首阶段处理',
    items: [
      ...baseItems,
      {
        item: '止痛、补牙、根管或牙周首阶段处理',
        cost: '¥2,000-¥15,000（约$300-$2,100）',
        note: '非资料明细中的固定报价，仅作为来华前预算预留；最终以鼎植检查、患牙数量和材料选择为准。',
      },
    ],
  }
}

const buildMetastaticBreastMedicalCostProfile = (context: ProfessionalContext) => {
  const sites = getUniqueMetastasisSites(getMetastasisSignals(context))
  const hasBone = sites.includes('骨骼')
  const hasLiver = sites.includes('肝脏')

  return {
    total: '¥67,000-¥266,000（约$9,300-$37,000）',
    items: [
      {
        item: '病理/IHC复核与受体状态确认',
        cost: '¥5,000-¥18,000（约$700-$2,500）',
        note: '复核ER、PR、HER2、Ki-67和Luminal分型；转移灶可及或治疗选择受影响时，需讨论再活检。',
      },
      {
        item: 'PET/CT原片复核与补充分期检查',
        cost: '¥10,000-¥36,000（约$1,400-$5,000）',
        note: [
          '包含影像会诊、肝脏增强MRI/CT、必要时头颅增强MRI、骨病灶风险评估等。',
          hasLiver ? '肝转移线索需同步评估肝功能和肿瘤负荷。' : '',
        ].filter(Boolean).join(' '),
      },
      {
        item: '可及病灶穿刺活检/再活检及分子检测（如需）',
        cost: '¥10,000-¥43,000（约$1,400-$6,000）',
        note: '用于确认复发/转移性质、复核HER2-low可能性，并可讨论PIK3CA、ESR1、BRCA/PALB2或NGS/ctDNA检测。',
      },
      {
        item: 'CDK4/6抑制剂 + 内分泌治疗首月评估',
        cost: '¥9,000-¥65,000/月（约$1,250-$9,000/月）',
        note: 'HR+/HER2-常见讨论方向包括Palbociclib、Ribociclib、Abemaciclib联合芳香化酶抑制剂或Fulvestrant；国产/进口、既往用药、血象、肝功能和医生判断会显著影响月费用。',
      },
      {
        item: '骨保护与疼痛/骨相关事件管理',
        cost: hasBone ? '¥1,000-¥18,000/月（约$140-$2,500/月）' : '¥2,000-¥8,600（约$300-$1,200）',
        note: '骨转移场景需讨论地舒单抗或唑来膦酸、补钙/维D、牙科风险评估、止痛、局部放疗或骨科会诊。',
      },
      {
        item: '局部放疗、短期住院或支持治疗（如需）',
        cost: '¥18,000-¥86,000（约$2,500-$12,000）',
        note: '适用于疼痛骨转移、承重骨/脊柱风险、肝功能异常、症状控制或治疗前稳定病情。',
      },
    ],
  }
}

const forbiddenFeeQualifier = ['同', '口', '径'].join('')

const cleanText = (text: string) => text
  .replace(new RegExp(forbiddenFeeQualifier, 'g'), '')
  .replace(/\s{2,}/g, ' ')
  .trim()

const cleanReport = (report: ProfessionalReport): ProfessionalReport => JSON.parse(JSON.stringify(report), (_key, value) => (
  typeof value === 'string' ? cleanText(value) : value
)) as ProfessionalReport

const extractIndicatorInterpretations = (input: ProfessionalReportSubmissionInput, diseaseKey: string) => {
  const text = getSubmittedEvidenceText(input)
  const indicators: Array<{ indicator: string; value: string; interpretation: string }> = []
  const addIndicator = (indicator: string, value: string, interpretation: string) => {
    if (!indicators.some((item) => item.indicator === indicator)) indicators.push({ indicator, value, interpretation })
  }

  const whoMatch = text.match(/WHO\s*([1-4ⅠⅡⅢⅣ]+)\s*级?/i)
  if (whoMatch) addIndicator('WHO分级', whoMatch[0], '用于判断肿瘤生物学行为和治疗紧迫性；分级越高，通常越需要尽快完成专科复核和综合治疗评估。')

  const kiMatch = text.match(/Ki[-\s]?67[^0-9]*(\d+(?:\.\d+)?\s*%?(?:\s*[-~至]\s*\d+(?:\.\d+)?\s*%)?)/i)
  if (kiMatch) addIndicator('Ki-67', kiMatch[1], '反映细胞增殖活跃度，是判断进展风险、治疗强度和复查频率的重要参考之一。')

  const idhMatch = text.match(/IDH[^，。；;\n]*(野生型|突变型|wildtype|mutant)/i)
  if (idhMatch) addIndicator('IDH状态', idhMatch[1], '胶质瘤等神经肿瘤场景下，该指标会影响分型、预后判断和后续治疗策略，需要结合病理报告确认。')

  const mgmtMatch = text.match(/MGMT[^，。；;\n]*(甲基化|未甲基化|methylated|unmethylated)/i)
  if (mgmtMatch) addIndicator('MGMT甲基化', mgmtMatch[1], '常用于评估替莫唑胺等治疗的敏感性参考，但不能单独决定治疗方案。')

  const egfrMatch = text.match(/EGFR[^，。；;\n]*(突变|阳性|阴性|野生型|exon\s*19|19外显子|L858R|T790M|positive|negative|wildtype|mutant)/i)
  if (egfrMatch) addIndicator('EGFR', egfrMatch[1], '肺癌场景下EGFR状态会直接影响是否优先考虑EGFR-TKI等靶向治疗，需以正式分子检测报告为准。')

  const alkMatch = text.match(/ALK[^，。；;\n]*(阳性|阴性|融合|重排|positive|negative|fusion|rearrangement)/i)
  if (alkMatch) addIndicator('ALK', alkMatch[1], 'ALK融合/重排是肺癌靶向治疗的重要依据，阳性时治疗排序和药物选择会明显不同。')

  const pdl1Match = text.match(/PD[-\s]?L1[^，。；;\n]*(\d+(?:\.\d+)?\s*%|阳性|阴性|positive|negative)/i)
  if (pdl1Match) addIndicator('PD-L1', pdl1Match[1], 'PD-L1表达可作为免疫治疗适用性和联合方案讨论的重要参考，但需结合驱动基因、分期和体力状态。')

  const afpMatch = text.match(/AFP[^，。；;\n]*(\d+(?:\.\d+)?\s*(?:ng\/mL|IU\/mL|μg\/L|ug\/L)?|升高|阳性|normal|正常)/i)
  if (afpMatch) addIndicator('AFP', afpMatch[1], 'AFP是肝癌诊断和疗效评估的重要指标之一，但需要结合增强影像、肝功能和病毒学资料综合判断。')

  if (diseaseKey === 'dental') {
    if (includesAny(text, ['CBCT'])) addIndicator('CBCT影像', '已提供/已提及', '用于判断根尖、牙槽骨、种植骨量和复杂根管风险，是牙科方案分层的关键依据。')
    if (includesAny(text, ['牙槽骨高度不足', '骨量不足'])) addIndicator('牙槽骨条件', '骨量不足线索', '种植前需评估是否需要植骨、牙周基础治疗或分阶段修复。')
  }

  if (diseaseKey === 'cardiology_cardiothoracic' && includesAny(text, ['射血分数', 'EF'])) {
    addIndicator('心功能指标', '已提及EF/射血分数', '用于判断介入、外科手术和麻醉围术期风险等级。')
  }

  if (!indicators.length) {
    addIndicator('关键指标', '当前资料未见明确数值', '建议补充原始检查、病理、影像或实验室指标，避免仅凭文字主诉决定治疗路径。')
  }

  return indicators.slice(0, 6)
}

const getFactText = (context: ProfessionalContext) => [
  context.medicalFacts.summary,
  ...context.medicalFacts.evidenceHighlights,
  ...context.medicalFacts.documents.flatMap((document) => [
    document.reportType,
    ...document.diagnoses,
    ...document.findings.map((finding) => finding.text),
    ...document.indicators.map((indicator) => `${indicator.name} ${indicator.value}`),
  ]),
].join(' ')

const getFactIndicator = (context: ProfessionalContext, names: string[]) => {
  const normalizedNames = names.map((name) => normalizeText(name))
  return context.medicalFacts.documents
    .flatMap((document) => document.indicators)
    .find((indicator) => normalizedNames.includes(normalizeText(indicator.name)))
}

const formatFactIndicator = (indicator: MedicalIndicatorFact | undefined) => (
  indicator ? `${indicator.name}：${indicator.value}` : ''
)

const getMetastasisSignals = (context: ProfessionalContext, statuses: MedicalMetastasisSignal['status'][] = ['present', 'suspected']) => (
  context.medicalFacts.documents
    .flatMap((document) => document.metastasisSignals)
    .filter((signal) => statuses.includes(signal.status))
)

const getUniqueMetastasisSites = (signals: MedicalMetastasisSignal[]) => unique(signals.map((signal) => signal.site))

const isBreastCancerFactCase = (context: ProfessionalContext) => {
  const text = getFactText(context)
  return context.diseaseKey === 'breast_cancer' || context.medicalFacts.diseaseSignals.includes('breast_cancer') || includesAny(text, ['乳腺', 'breast', 'Luminal', 'carcinoma mamma', 'mammae'])
}

const isMetastaticBreastCancerFactCase = (context: ProfessionalContext) => (
  isBreastCancerFactCase(context) && getUniqueMetastasisSites(getMetastasisSignals(context)).length > 0
)

const isDentalFactCase = (context: ProfessionalContext) => {
  const text = getFactText(context)
  return context.diseaseKey === 'dental' || includesAny(text, ['牙', '口腔', 'CBCT', '龋', '根尖', '牙髓', '磨牙', '种植'])
}

const hasStructuredMedicalFacts = (context: ProfessionalContext) => context.medicalFacts.hasActionableFacts

const getDocumentDatesByKeywords = (context: ProfessionalContext, keywords: string[]) => uniqueSortedDates(
  context.medicalFacts.documents
    .filter((document) => includesAny([
      document.reportType,
      ...document.diagnoses,
      ...document.findings.map((finding) => finding.text),
      ...document.sourceEvidence,
    ].join(' '), keywords))
    .flatMap((document) => [document.primaryDate, ...document.dates])
    .filter(Boolean),
)

const buildMetastaticBreastCaseNarrative = (context: ProfessionalContext) => {
  const signals = getMetastasisSignals(context)
  const metastasisSites = getUniqueMetastasisSites(signals)
  const hasLiver = metastasisSites.includes('肝脏')
  const hasBone = metastasisSites.includes('骨骼')
  const hasNode = metastasisSites.includes('淋巴结')
  const hasLung = metastasisSites.includes('肺部')
  const er = formatFactIndicator(getFactIndicator(context, ['ER']))
  const pr = formatFactIndicator(getFactIndicator(context, ['PR']))
  const her2 = formatFactIndicator(getFactIndicator(context, ['HER2']))
  const ki67 = formatFactIndicator(getFactIndicator(context, ['Ki-67', 'Ki67']))
  const subtype = formatFactIndicator(getFactIndicator(context, ['分子分型']))
  const receptorLine = unique([er, pr, her2, ki67, subtype]).filter(Boolean).join('；')
  const petDates = getDocumentDatesByKeywords(context, ['PET/CT', 'PET CT', 'hypermetabolic', 'FDG'])
  const pathologyDates = getDocumentDatesByKeywords(context, ['病理', '免疫组化', 'Invasive carcinoma', 'Luminal', 'HER2', 'Ki-67'])
  const breastImagingDates = getDocumentDatesByKeywords(context, ['BIRADS', 'BI-RADS', 'mammography', '钼靶', '乳腺'])
  const allDates = uniqueSortedDates([
    ...context.medicalFacts.timeline.map((item) => item.date),
    ...context.medicalFacts.documents.flatMap((document) => [document.primaryDate, ...document.dates]),
  ])
  const firstDate = allDates[0] || ''
  const latestDate = allDates[allDates.length - 1] || ''
  const latestPetDate = petDates[petDates.length - 1] || latestDate || '最新PET/CT'
  const pathologyDate = pathologyDates[pathologyDates.length - 1] || '病理/IHC资料'
  const pathologyLabel = isLikelyClinicalReportDate(pathologyDate) ? `${formatMonthLabel(pathologyDate)}病理/IHC资料` : pathologyDate
  const breastImagingDate = breastImagingDates[0] || firstDate || '早期资料'
  const siteText = metastasisSites.length ? metastasisSites.join('、') : '多部位'
  const evidenceBySite = metastasisSites.map((site) => {
    const signal = signals.find((item) => item.site === site)
    const evidence = signal ? getDisplayClinicalEvidenceItems([signal.evidence], 1, 180)[0] : ''
    return signal && evidence ? `${site}：${evidence}` : ''
  }).filter(Boolean)
  const desiredCity = context.input.preferences.desiredCity.trim()
  const cityLabel = desiredCity || '目标城市/医院'
  const costLine = '费用应按中国医院实际人民币报价拆分：首阶段重点看病理/IHC复核、PET/CT原片复核、补充分期、再活检/分子检测、首月系统治疗、骨保护/放疗和在华服务生活费用；CDK4/6抑制剂和骨保护药通常还需要按月或按年单独测算。'
  const priorityLine = '当前最需要马上确认的不是“是否单纯复查”，而是三件事：PET/CT多部位病灶是否构成转移性复发、转移灶受体状态是否仍为HR+/HER2-、是否存在肝功能受损或骨折/脊髓压迫等需要先处理的风险。'
  const managementGoalLine = '若复核后确认进入转移性乳腺癌阶段，治疗目标通常会从单次局部处理转向长期系统控制：尽快压住肿瘤活性、保护骨骼和肝功能、控制疼痛，并把用药监测和回国续治安排连续起来。'

  return {
    coreConclusion: `从上传资料看，本例不宜再按普通术后复查处理。${latestPetDate} PET/CT 已出现${siteText}等复发/转移或可疑转移线索，结合乳腺癌术后及放化疗后背景，应优先按转移性乳腺癌方向由肿瘤内科/MDT快速复核。`,
    timelineStory: allDates.length >= 2
      ? `资料时间线显示：${breastImagingDate}前后以右乳可疑恶性病灶/确诊资料为主，${pathologyLabel}用于确定分型；到${latestPetDate} PET/CT 再分期时出现多部位高代谢转移线索，提示病情重点已从局部治疗后随访转向系统治疗和并发症风险管理。`
      : `当前资料已形成乳腺癌病理和PET/CT复查线索，但仍需补齐完整日期、手术病理和既往治疗记录，才能判断进展速度和换线治疗依据。`,
    pathologyLine: receptorLine
      ? `病理/IHC重点：${receptorLine}。该组合更符合HR+/HER2-、Luminal B-like方向；ER强阳性支持内分泌治疗基础，PR阴性和Ki-67高表达提示生物学行为更活跃，需要更积极的系统治疗排序。`
      : '病理/IHC是本例治疗排序的核心资料，需复核ER、PR、HER2、Ki-67、分子分型和原始切片；若转移灶可及，还需评估再活检确认受体状态是否变化。',
    imagingLine: `影像重点：${latestPetDate} PET/CT 是当前最关键资料，报告阶段已识别${siteText}等部位异常；正式就医前应提交DICOM原片，由核医学/影像科和乳腺肿瘤团队共同确认病灶性质和治疗前基线。`,
    priorityLine,
    managementGoalLine,
    riskLines: [
      hasLiver ? '肝转移线索会影响治疗紧迫性、药物耐受和是否存在内脏危象；来华前应补充肝功能、胆红素、白蛋白、凝血功能和肝脏增强MRI/CT。' : '',
      hasBone ? '骨转移涉及脊柱、骨盆或承重骨时，需要主动评估疼痛、病理骨折和脊髓压迫风险；骨保护、止痛、局部放疗或骨科会诊应与系统治疗同步考虑。' : '',
      hasNode ? '纵隔、胸肌下或门腔静脉区淋巴结高代谢提示疾病范围已不局限于乳腺局部，需纳入全身治疗决策。' : '',
      hasLung ? '肺部结节或可疑肺部病灶需结合薄层胸部CT和随访变化判断是转移、炎症还是第二原发。' : '',
      '脑部PET未见异常不能完全替代头颅增强MRI；若有头痛、呕吐、视物异常、抽搐、肢体无力或意识改变，应先在当地完成急诊评估。',
    ].filter(Boolean),
    executionLines: [
      `来华路径建议先远程预审，再决定是否出行：把PET/CT DICOM、完整报告、病理切片/IHC、2025年手术病理、放化疗和用药记录整理成${cityLabel}专家可直接阅读的时间线。`,
      '若复核后确认为HR+/HER2-转移性乳腺癌且无明确内脏危象，可重点讨论CDK4/6抑制剂联合内分泌治疗；若肝功能受损、症状进展快或既往治疗耐药，则需要重新评估化疗、再活检、分子检测或临床研究。',
      costLine,
    ],
    evidenceBasis: unique([
      ...evidenceBySite,
      receptorLine ? `病理/IHC：${receptorLine}` : '',
      ...getDisplayClinicalEvidenceItems(context.medicalFacts.evidenceHighlights, 4, 220),
    ]).slice(0, 10),
    costLine,
  }
}

type SpecialtyFactNarrative = {
  coreConclusion: string
  timelineStory: string
  indicatorLine: string
  imagingLine: string
  priorityLine: string
  managementGoalLine: string
  riskLines: string[]
  executionLines: string[]
  evidenceBasis: string[]
}

const isSpecialtyFactCase = (context: ProfessionalContext) => (
  hasStructuredMedicalFacts(context) &&
  ['lung_cancer', 'liver_cancer', 'nasopharyngeal_cancer', 'neurosurgery'].includes(context.diseaseKey)
)

const getIndicatorLine = (context: ProfessionalContext, names: string[]) => {
  const indicators = names
    .map((name) => formatFactIndicator(getFactIndicator(context, [name])))
    .filter(Boolean)
  return indicators.length ? indicators.join('；') : ''
}

const buildSpecialtyFactNarrative = (context: ProfessionalContext): SpecialtyFactNarrative | null => {
  if (!isSpecialtyFactCase(context)) return null

  const diseaseLabel = context.disease.label
  const allDates = uniqueSortedDates([
    ...context.medicalFacts.timeline.map((item) => item.date),
    ...context.medicalFacts.documents.flatMap((document) => [document.primaryDate, ...document.dates]),
  ])
  const firstDate = allDates[0] || '早期资料'
  const latestDate = allDates[allDates.length - 1] || '最新资料'
  const metastasisSites = getUniqueMetastasisSites(getMetastasisSignals(context))
  const metastasisLine = metastasisSites.length
    ? `资料中还出现${metastasisSites.join('、')}等转移/可疑转移线索，需要同步纳入分期和治疗强度判断。`
    : '当前上传资料尚未形成明确远处转移结论，仍需以原始影像和分期检查复核为准。'
  const documentTypes = unique(context.medicalFacts.documents.map((document) => document.reportType)).slice(0, 4)
  const evidence = getDisplayClinicalEvidenceItems(context.medicalFacts.evidenceHighlights, 6, 220)
  const commonTimeline = allDates.length >= 2
    ? `资料时间线从${firstDate}延续到${latestDate}，应按时间顺序核对诊断、影像变化、指标变化和既往治疗反应，避免只看单份报告。`
    : `当前上传资料已形成${documentTypes.join('、') || diseaseLabel}相关线索，但还需要补齐日期、原始影像和既往治疗记录来判断病情阶段。`

  const profiles: Record<string, Omit<SpecialtyFactNarrative, 'timelineStory' | 'evidenceBasis'>> = {
    lung_cancer: {
      coreConclusion: `上传资料提示肺癌/肺部肿瘤方向需要按“病理类型 + TNM分期 + 分子/免疫指标”三条线同步复核，不能只凭肺部结节或单一CT描述决定治疗。${metastasisLine}`,
      indicatorLine: getIndicatorLine(context, ['EGFR', 'ALK', 'PD-L1', 'CEA', 'SUVmax']) || '肺癌资料的关键指标包括病理类型、EGFR/ALK等驱动基因、PD-L1、TNM分期和是否存在脑/骨/肝等转移。',
      imagingLine: '影像重点应放在胸部薄层增强CT/PET-CT、脑增强MRI、骨/肝/肾上腺等远处转移筛查，以及可测量病灶作为疗效评估基线。',
      priorityLine: '当前优先确认三件事：是否已有病理诊断，是否完成驱动基因/PD-L1检测，是否存在脑转移、骨转移或胸腔积液等会改变治疗排序的分期信息。',
      managementGoalLine: '若为早期可切除病灶，目标是评估手术或局部根治路径；若为局部晚期或转移性疾病，目标转为系统治疗排序、症状控制和6-8周疗效评估。',
      riskLines: [
        '如有咯血、明显气促、胸痛、发热或血氧下降，应先在当地急诊/呼吸肿瘤科处理，再安排跨境就医。',
        '若存在脑转移症状，如头痛、呕吐、抽搐、肢体无力或意识改变，头颅增强MRI和当地急诊评估优先级高于跨境排期。',
      ],
      executionLines: [
        '来华前整理病理切片/蜡块、胸部CT DICOM、PET/CT或分期资料、基因检测和既往治疗用药记录。',
        '中国首诊应由胸部肿瘤内科/胸外科/放疗科MDT判断手术、放疗、靶向、免疫、化疗或联合治疗排序。',
      ],
    },
    liver_cancer: {
      coreConclusion: `上传资料提示肝癌/肝脏肿瘤方向需要同时判断肿瘤负荷、肝功能储备和门静脉/远处转移情况，不能只按肿瘤大小直接决定手术或介入。${metastasisLine}`,
      indicatorLine: getIndicatorLine(context, ['AFP', 'CEA', 'SUVmax']) || '肝癌资料的关键指标包括AFP、肝功能、胆红素、白蛋白、凝血功能、乙肝/丙肝状态和Child-Pugh/ALBI等肝储备评估。',
      imagingLine: '影像重点应放在肝脏增强MRI/CT、LI-RADS或影像典型性、肿瘤数量和位置、门静脉癌栓、肝外转移以及是否可切除/消融/介入。',
      priorityLine: '当前优先确认三件事：是否符合肝癌影像或病理诊断，肝功能是否能承受手术/介入/系统治疗，是否存在门静脉癌栓或肝外转移。',
      managementGoalLine: '若为可切除或可消融病灶，目标是根治性局部治疗；若肿瘤负荷高或肝功能受限，目标是TACE/HAIC/放疗/靶免系统治疗和肝功能保护的排序。',
      riskLines: [
        '如出现黄疸、腹水、消化道出血、意识改变、发热或明显乏力，应先在当地处理肝功能失代偿或感染风险。',
        '肝癌治疗费用和方案高度依赖肝功能、肿瘤负荷、是否住院介入和药物方案，需分阶段报价。',
      ],
      executionLines: [
        '来华前补齐肝脏增强MRI/CT DICOM、AFP和肝功能/凝血、乙肝/丙肝病毒学、既往TACE/消融/手术/系统治疗记录。',
        '中国首诊应由肝胆外科、介入科、肿瘤内科和放疗科共同判断手术、消融、TACE/HAIC、放疗或靶免系统治疗排序。',
      ],
    },
    nasopharyngeal_cancer: {
      coreConclusion: `上传资料提示鼻咽癌/头颈肿瘤方向需要按病理、头颈部MRI分期、EBV DNA和远处转移筛查共同判断治疗强度。${metastasisLine}`,
      indicatorLine: getIndicatorLine(context, ['SUVmax', 'CEA']) || '鼻咽癌资料的关键指标包括病理类型、T/N/M分期、EBV DNA、头颈MRI范围和是否存在骨/肺/肝等远处转移。',
      imagingLine: '影像重点应放在鼻咽原发灶范围、颅底/海绵窦/咽旁间隙受侵、颈部淋巴结分区，以及PET/CT或胸腹影像排除远处转移。',
      priorityLine: '当前优先确认三件事：病理是否明确，头颈MRI和EBV DNA是否完整，是否需要诱导化疗、同步放化疗或复发后再程治疗评估。',
      managementGoalLine: '若为初治局部区域病变，目标通常是以精准放疗为核心联合化疗；若为复发/转移，需要重新评估再程放疗、系统治疗、免疫治疗或临床研究。',
      riskLines: [
        '如有鼻出血不止、吞咽困难、颅神经症状、视物异常或严重头痛，应先当地耳鼻喉/急诊处理。',
        '放疗前需评估口腔牙齿、营养、听力、吞咽和颈部功能，避免只看肿瘤分期。',
      ],
      executionLines: [
        '来华前整理鼻咽镜病理、头颈MRI DICOM、EBV DNA、PET/CT或胸腹影像、既往放化疗剂量和毒副反应记录。',
        '中国首诊应由头颈肿瘤放疗科、肿瘤内科、影像科和营养/口腔支持团队共同制定方案。',
      ],
    },
    neurosurgery: {
      coreConclusion: `上传资料提示神经外科/中枢神经系统肿瘤方向需要先明确病灶位置、神经功能风险、病理/分子分型和是否具备最大安全切除条件。${metastasisLine}`,
      indicatorLine: getIndicatorLine(context, ['WHO分级', 'IDH状态', 'MGMT甲基化', 'Ki-67']) || '神经肿瘤资料的关键指标包括WHO分级、IDH、MGMT、Ki-67、病灶部位、是否位于功能区以及神经功能状态。',
      imagingLine: '影像重点应放在头颅/脊髓MRI增强、DWI/灌注/波谱、功能区和传导束关系，必要时结合术前导航或功能影像。',
      priorityLine: '当前优先确认三件事：病灶是否需要手术取样/切除，是否存在颅压增高或神经功能恶化风险，病理和IDH/MGMT等分子指标是否足够决定后续放化疗。',
      managementGoalLine: '若为高级别胶质瘤或疑似恶性肿瘤，目标通常是最大安全切除或病理确诊后尽快衔接放疗、替莫唑胺等综合治疗和康复管理。',
      riskLines: [
        '如出现进行性头痛、喷射性呕吐、抽搐、意识改变、肢体无力或大小便障碍，应先当地神经外科急诊处理。',
        '神经外科方案不能只看肿瘤大小，还要评估功能区、手术入路、术后康复和辅助治疗窗口。',
      ],
      executionLines: [
        '来华前整理MRI DICOM、既往手术/病理、癫痫和神经功能变化记录、激素/抗癫痫药物使用情况。',
        '中国首诊应由神经外科、影像科、病理科、放疗科、肿瘤内科和康复团队共同判断手术和辅助治疗排序。',
      ],
    },
  }

  const profile = profiles[context.diseaseKey]
  if (!profile) return null

  return {
    ...profile,
    timelineStory: commonTimeline,
    evidenceBasis: evidence.length ? evidence : ['上传资料已形成结构化医学事实，但仍需医生复核原始报告和DICOM影像。'],
  }
}

const getReportText = (report: ProfessionalReport) => JSON.stringify(report)

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

const isLlmReportAlignedWithStructuredFacts = (
  report: ProfessionalReport,
  context: ProfessionalContext,
) => {
  const reportText = getReportText(report)

  if (context.input.uploadedFiles.length && !hasStructuredMedicalFacts(context)) {
    const claimsUploadFacts = includesAny(reportText, ['上传资料可识别', '上传资料提示', '已识别上传资料', '已从上传资料', '基于上传资料'])
    const acknowledgesInsufficientRecognition = includesAny(reportText, ['识别不足', '未识别', '不能据此', '无法辨认', '资料不足', '未提取到足够'])
    if (claimsUploadFacts && !acknowledgesInsufficientRecognition) return false
    if (context.diseaseKey === 'other' && includesAny(reportText, ['乳腺癌', '牙科', '口腔CBCT', '深龋', '肝转移', '骨转移', '淋巴结转移'])) return false
  }

  if (!hasStructuredMedicalFacts(context)) return true

  const factText = getFactText(context)
  const hasDentalFacts = includesAny(factText, ['牙', '口腔', 'CBCT', '龋', '根管'])
  const hasBreastFacts = context.medicalFacts.diseaseSignals.includes('breast_cancer') || includesAny(factText, ['乳腺', 'breast', 'Luminal', 'carcinoma mamma', 'mammae'])
  const leaksDental = hasDentalTemplateLeak(reportText, hasDentalFacts)
  const leaksBreast = includesAny(reportText, ['乳腺癌', '乳腺', 'Luminal', 'CDK4/6']) && !hasBreastFacts
  if (leaksDental || leaksBreast) return false

  if (isBreastCancerFactCase(context)) {
    const mustKeepBreastCancer = includesAny(reportText, ['乳腺癌', '乳腺', 'breast'])
    const hasBreastCancerEvidence = includesAny(reportText, ['肝脏', '骨骼', '淋巴结', '肺部', '转移', 'PET', 'ER', 'PR', 'HER2', 'Ki-67', '系统治疗'])
    return mustKeepBreastCancer && hasBreastCancerEvidence && !leaksDental
  }

  if (isDentalFactCase(context)) {
    const mustKeepDental = includesAny(reportText, ['牙', '口腔', 'CBCT', '龋', '根管', '保牙', '种植'])
    const leaksCancer = includesAny(reportText, ['乳腺癌', '肝转移', '骨转移', '淋巴结转移', '化疗', '放疗', '靶向治疗']) && !hasBreastFacts
    return mustKeepDental && !leaksCancer
  }

  if (context.diseaseKey === 'lung_cancer' || context.medicalFacts.diseaseSignals.includes('lung_cancer')) {
    return includesAny(reportText, ['肺癌', '肺腺癌', '肺部', 'EGFR', 'ALK', 'PD-L1', '靶向', '分期'])
  }

  if (context.diseaseKey === 'liver_cancer' || context.medicalFacts.diseaseSignals.includes('liver_cancer')) {
    return includesAny(reportText, ['肝癌', '肝细胞癌', 'HCC', 'AFP', '肝功能', '介入', '消融', '系统治疗'])
  }

  if (context.diseaseKey === 'neurosurgery' || context.medicalFacts.diseaseSignals.includes('neurosurgery')) {
    return includesAny(reportText, ['神经外科', '胶质', '脑', 'WHO', 'IDH', 'MGMT', '放疗', '替莫唑胺'])
  }

  return true
}

const buildBreastCancerIndicatorInterpretations = (context: ProfessionalContext) => {
  const er = getFactIndicator(context, ['ER'])
  const pr = getFactIndicator(context, ['PR'])
  const her2 = getFactIndicator(context, ['HER2'])
  const ki67 = getFactIndicator(context, ['Ki-67', 'Ki67'])
  const suvmax = getFactIndicator(context, ['SUVmax'])
  const subtype = getFactIndicator(context, ['分子分型'])
  const items: Array<{ indicator: string; value: string; interpretation: string }> = []

  if (er) {
    items.push({
      indicator: 'ER',
      value: er.value,
      interpretation: includesAny(er.value, ['阳性', 'positive', 'positif', '%'])
        ? 'ER阳性提示肿瘤可能对内分泌治疗敏感，是后续系统治疗方案排序的重要依据。'
        : 'ER阴性或低表达时，内分泌治疗获益通常有限，需由肿瘤内科结合完整病理确认。',
    })
  }

  if (pr) {
    items.push({
      indicator: 'PR',
      value: pr.value,
      interpretation: includesAny(pr.value, ['阴性', 'negative', 'negatif', '-'])
        ? 'PR阴性常提示生物学行为较ER/PR双阳性更活跃，需结合Ki-67、分期和治疗反应判断强度。'
        : 'PR阳性支持激素受体阳性乳腺癌方向，但仍需结合ER、HER2和Ki-67综合分型。',
    })
  }

  if (her2) {
    items.push({
      indicator: 'HER2',
      value: her2.value,
      interpretation: includesAny(her2.value, ['阴性', 'negative', 'negatif', '-'])
        ? 'HER2阴性意味着常规抗HER2治疗通常不是首选，需重点评估内分泌、CDK4/6抑制剂、化疗或临床研究机会。'
        : 'HER2阳性/可疑时需复核IHC/FISH结果，因为会直接影响抗HER2治疗选择。',
    })
  }

  if (ki67) {
    items.push({
      indicator: 'Ki-67',
      value: ki67.value,
      interpretation: includesAny(ki67.value, ['70', '60', '50', '40', '高'])
        ? 'Ki-67高表达提示肿瘤增殖活跃，治疗紧迫性和系统治疗强度通常需要提高。'
        : 'Ki-67用于评估增殖活跃度，需结合受体状态、分期和既往治疗判断风险。',
    })
  }

  if (subtype) {
    items.push({
      indicator: '分子分型',
      value: subtype.value,
      interpretation: '分子分型用于决定内分泌、化疗、靶向或联合治疗的优先级；报告阶段需以原始病理/IHC为准。',
    })
  }

  if (suvmax) {
    items.push({
      indicator: 'PET/CT代谢活性',
      value: suvmax.value,
      interpretation: 'SUVmax升高代表病灶代谢活跃，是判断复发/转移活性和后续疗效评估基线的重要参考。',
    })
  }

  return items.length ? items.slice(0, 6) : extractIndicatorInterpretations(context.input, context.diseaseKey)
}

const getDentalFactFlags = (context: ProfessionalContext) => {
  const text = getFactText(context)
  return {
    toothLabel: includesAny(text, ['右下第一磨牙', '右下磨牙']) ? '右下第一磨牙/右下磨牙' : '患牙',
    hasCbct: includesAny(text, ['CBCT', '口腔影像', '全景片', '根尖片']),
    hasDeepCaries: includesAny(text, ['大面积龋坏', '深龋', '近髓', '蛀牙', '龋齿']),
    hasPulpOrApex: includesAny(text, ['牙髓', '根尖周炎', '根尖区', '低密度影', '牙神经']),
    hasBoneInfo: includesAny(text, ['牙槽骨', '骨量', '骨高度', '骨宽度']),
    hasBoneInsufficient: includesAny(text, ['骨量不足', '牙槽骨高度不足', '骨高度不足', '植骨']),
    hasImplantRequest: includesAny(text, ['种植', 'implant', '缺牙', '拔除后修复']),
    hasAcuteInfection: includesAny(text, ['脓肿', '面部肿胀', '张口受限', '发热', '吞咽困难']),
  }
}

const buildDentalIndicatorInterpretations = (context: ProfessionalContext) => {
  const flags = getDentalFactFlags(context)
  const items: Array<{ indicator: string; value: string; interpretation: string }> = []

  if (flags.hasCbct) {
    items.push({
      indicator: '口腔影像/CBCT',
      value: '上传资料已识别到CBCT/口腔影像线索',
      interpretation: 'CBCT是判断龋坏深度、根尖病变、牙槽骨条件、下牙槽神经位置和后续种植可行性的核心依据，需由牙体牙髓/种植医生复核原图。',
    })
  }

  if (flags.hasDeepCaries) {
    items.push({
      indicator: '龋坏深度',
      value: '深龋/近髓或大面积龋坏线索',
      interpretation: '提示疼痛可能来自牙髓受累，治疗顺序应先评估保牙价值和牙髓状态，不能直接跳到种植。',
    })
  }

  if (flags.hasPulpOrApex) {
    items.push({
      indicator: '牙髓/根尖周情况',
      value: '牙髓或根尖周病变可能',
      interpretation: '若牙体剩余量和牙周支持允许，通常先考虑根管治疗、感染控制和冠/嵌体修复；若不可保留，再进入拔除和种植/修复评估。',
    })
  }

  if (flags.hasBoneInfo) {
    items.push({
      indicator: '牙槽骨条件',
      value: flags.hasBoneInsufficient ? '存在骨量不足/植骨相关线索' : '已提及牙槽骨条件',
      interpretation: flags.hasBoneInsufficient
        ? '骨量不足会影响种植体长度、角度、是否需要植骨或分阶段治疗，需结合CBCT三维测量确认。'
        : '牙槽骨条件会决定是否适合即刻种植、延期种植、植骨或其他修复方式。',
    })
  }

  if (flags.hasImplantRequest) {
    items.push({
      indicator: '种植诉求',
      value: '用户关注拔除后修复/种植可能',
      interpretation: '种植是患牙不可保留后的修复选项之一；在疼痛和感染未分层前，不应把种植作为唯一方案。',
    })
  }

  return items.length ? items.slice(0, 6) : extractIndicatorInterpretations(context.input, context.diseaseKey)
}

const buildStructuredDiagnosticConclusion = (context: ProfessionalContext) => {
  if (!hasStructuredMedicalFacts(context)) return null

  const metastasisSignals = getMetastasisSignals(context)
  const metastasisSites = getUniqueMetastasisSites(metastasisSignals)
  const evidence = context.medicalFacts.evidenceHighlights.length
    ? context.medicalFacts.evidenceHighlights
    : context.medicalFacts.documents.flatMap((document) => document.sourceEvidence)

  if (isBreastCancerFactCase(context)) {
    const er = formatFactIndicator(getFactIndicator(context, ['ER']))
    const pr = formatFactIndicator(getFactIndicator(context, ['PR']))
    const her2 = formatFactIndicator(getFactIndicator(context, ['HER2']))
    const ki67 = formatFactIndicator(getFactIndicator(context, ['Ki-67', 'Ki67']))
    const receptorLine = [er, pr, her2, ki67].filter(Boolean).join('；')
    const hasPresentMetastasis = metastasisSignals.some((signal) => signal.status === 'present')
    const hasSuspectedMetastasis = metastasisSignals.some((signal) => signal.status === 'suspected')
    const metastaticNarrative = metastasisSites.length ? buildMetastaticBreastCaseNarrative(context) : null

    return {
      finalImpression: metastaticNarrative
        ? metastaticNarrative.coreConclusion
        : '上传资料可识别乳腺癌相关病理/影像线索，当前重点是复核病理分型、受体状态、分期和既往治疗记录后确定综合治疗路径。',
      severityInterpretation: metastaticNarrative
        ? `${hasPresentMetastasis ? '上传报告文字已出现明确转移/高代谢转移灶表达' : hasSuspectedMetastasis ? '上传资料存在可疑转移表达' : '上传资料存在进展线索'}；正式结论需医生核对原片，但就预审优先级而言，应按复发/转移性疾病处理，重点转向系统治疗、骨相关事件预防、症状控制和阶段性疗效评估。`
        : '目前尚未从上传资料中识别到明确远处转移证据；仍需完整影像分期和病理复核后判断治疗强度。',
      indicatorInterpretations: buildBreastCancerIndicatorInterpretations(context),
      evidenceBasis: unique([
        ...(metastaticNarrative ? [
          metastaticNarrative.timelineStory,
          metastaticNarrative.pathologyLine,
          metastaticNarrative.imagingLine,
          metastaticNarrative.priorityLine,
          metastaticNarrative.managementGoalLine,
        ] : []),
        receptorLine ? `免疫组化/分子指标：${receptorLine}` : '',
        ...(metastaticNarrative ? metastaticNarrative.evidenceBasis : getDisplayClinicalEvidenceItems(evidence, 10, 220)),
      ]).filter(Boolean).slice(0, 10),
    }
  }

  if (isDentalFactCase(context)) {
    const flags = getDentalFactFlags(context)
    const mainProblem = [
      flags.hasDeepCaries ? '深龋/近髓或大面积龋坏' : '',
      flags.hasPulpOrApex ? '牙髓或根尖周病变可能' : '',
      flags.hasBoneInfo ? '牙槽骨条件需结合CBCT复核' : '',
    ].filter(Boolean).join('，') || '口腔牙科问题需结合原始影像和面诊确认'

    return {
      finalImpression: `上传资料可识别${flags.toothLabel}相关线索：${mainProblem}。当前核心不是直接决定“种植”，而是先判断${flags.toothLabel}能否保留；若牙体剩余、牙周支持和根尖感染可控，优先评估根管治疗+修复，若不可保留，再进入拔除后种植/修复方案。`,
      severityInterpretation: flags.hasAcuteInfection
        ? '资料或主诉中存在急性感染风险信号，若伴随面部肿胀、发热、张口受限或吞咽困难，应先在当地急诊/口腔急诊控制感染，再安排跨境治疗。'
        : '目前属于需要尽快牙体牙髓/口腔种植专科复核的疼痛与修复决策问题；通常不等同于全身高危疾病，但拖延可能导致急性牙髓炎、根尖感染扩大或最终失去保牙机会。',
      indicatorInterpretations: buildDentalIndicatorInterpretations(context),
      evidenceBasis: getDisplayClinicalEvidenceItems(evidence, 10, 220).length
        ? getDisplayClinicalEvidenceItems(evidence, 10, 220)
        : ['已上传口腔资料形成部分结构化线索，但仍需医生复核原始CBCT/口内照片。'],
    }
  }

  const specialtyNarrative = buildSpecialtyFactNarrative(context)
  if (specialtyNarrative) {
    return {
      finalImpression: specialtyNarrative.coreConclusion,
      severityInterpretation: [
        specialtyNarrative.priorityLine,
        specialtyNarrative.managementGoalLine,
      ].join(' '),
      indicatorInterpretations: extractIndicatorInterpretations(context.input, context.diseaseKey),
      evidenceBasis: unique([
        specialtyNarrative.timelineStory,
        specialtyNarrative.indicatorLine,
        specialtyNarrative.imagingLine,
        ...specialtyNarrative.evidenceBasis,
      ]).filter(Boolean).slice(0, 10),
    }
  }

  return {
    finalImpression: `上传资料已识别出${context.medicalFacts.documents.length}份医学证据，当前应围绕“${context.disease.label}”完成原始资料复核和专科分层。`,
    severityInterpretation: metastasisSites.length
      ? `资料中存在${metastasisSites.join('、')}等复发/转移或进展线索，需优先进行专科复核和治疗窗口判断。`
      : '资料中尚未形成完整严重程度判断，需结合原始报告、影像和既往治疗资料确认。',
    indicatorInterpretations: extractIndicatorInterpretations(context.input, context.diseaseKey),
    evidenceBasis: getDisplayClinicalEvidenceItems(evidence, 10, 220).length
      ? getDisplayClinicalEvidenceItems(evidence, 10, 220)
      : ['已上传资料可形成部分结构化事实，但仍需人工复核原件。'],
  }
}

const buildStructuredClinicalFindings = (context: ProfessionalContext) => {
  if (!hasStructuredMedicalFacts(context)) return []

  const timelineItems = context.medicalFacts.timeline
    .map((event) => `${event.date} ${event.reportType}：${event.description}`)
    .slice(0, 8)
  const indicators = (isDentalFactCase(context)
    ? ['BIRADS', 'ER', 'PR', 'HER2', 'Ki-67', 'SUVmax', '分子分型', '牙槽骨条件', 'CBCT影像']
    : ['ER', 'PR', 'HER2', 'Ki-67', 'SUVmax', '分子分型'])
    .map((name) => formatFactIndicator(getFactIndicator(context, [name])))
    .filter(Boolean)
  const metastasisSignals = getMetastasisSignals(context)
  const metastasisSites = getUniqueMetastasisSites(metastasisSignals)
  const dentalFlags = isDentalFactCase(context) ? getDentalFactFlags(context) : null

  if (isMetastaticBreastCancerFactCase(context)) {
    const narrative = buildMetastaticBreastCaseNarrative(context)
    return unique([
      narrative.timelineStory,
      narrative.pathologyLine,
      narrative.imagingLine,
      narrative.priorityLine,
      narrative.managementGoalLine,
      ...narrative.riskLines,
      ...narrative.executionLines,
      indicators.length ? `关键指标：${indicators.join('；')}。` : '',
    ]).filter(Boolean).slice(0, 14)
  }

  const specialtyNarrative = buildSpecialtyFactNarrative(context)
  if (specialtyNarrative) {
    return unique([
      specialtyNarrative.timelineStory,
      specialtyNarrative.indicatorLine,
      specialtyNarrative.imagingLine,
      specialtyNarrative.priorityLine,
      specialtyNarrative.managementGoalLine,
      ...specialtyNarrative.riskLines,
      ...specialtyNarrative.executionLines,
    ]).filter(Boolean).slice(0, 12)
  }

  return unique([
    metastasisSites.length ? `上传资料识别到复发/转移或可疑转移部位：${metastasisSites.join('、')}。` : '',
    dentalFlags?.hasDeepCaries ? `上传资料识别到${dentalFlags.toothLabel}深龋/近髓或大面积龋坏线索。` : '',
    dentalFlags?.hasPulpOrApex ? `上传资料识别到牙髓或根尖周病变可能，需要先判断保牙、根管或拔除后修复。` : '',
    dentalFlags?.hasBoneInfo ? `资料中提及牙槽骨条件，后续种植可行性需结合CBCT三维测量。` : '',
    indicators.length ? `关键指标：${indicators.join('；')}。` : '',
    ...timelineItems,
  ]).filter(Boolean).slice(0, 10)
}

const buildStructuredRedFlags = (context: ProfessionalContext) => {
  if (isDentalFactCase(context) && hasStructuredMedicalFacts(context)) {
    const flags = getDentalFactFlags(context)
    return [
      flags.hasAcuteInfection ? '资料或主诉提示可能存在急性口腔感染风险，若出现发热、面部肿胀、张口受限或吞咽困难，应先就近急诊处理。' : '',
      flags.hasPulpOrApex ? '根尖周炎/牙髓感染可能会反复疼痛或急性发作，跨境治疗前需确认是否需要先止痛、消炎或开髓/根管急诊处理。' : '',
      flags.hasImplantRequest && flags.hasDeepCaries ? '患者关注种植，但深龋疼痛阶段应先评估患牙保留价值，避免过早拔牙或过早承诺种植。' : '',
    ].filter(Boolean)
  }

  const metastasisSignals = getMetastasisSignals(context)
  const metastasisSites = getUniqueMetastasisSites(metastasisSignals)
  if (!metastasisSites.length) return []

  return [
    metastasisSites.includes('骨骼') ? '资料中出现骨转移/可疑骨转移线索，需评估疼痛、骨折风险、脊髓压迫风险，并考虑骨保护治疗。' : '',
    metastasisSites.includes('肝脏') ? '资料中出现肝转移/可疑肝转移线索，需结合肝功能、肿瘤负荷和系统治疗方案尽快评估。' : '',
    metastasisSites.includes('淋巴结') ? '资料中出现淋巴结转移/高代谢线索，需结合全身分期判断治疗范围。' : '',
    metastasisSites.includes('肺部') ? '资料中出现肺部结节或可疑转移线索，需结合薄层CT和随访变化排除转移或第二原发。' : '',
  ].filter(Boolean)
}

const buildStructuredDecisionQuestions = (context: ProfessionalContext) => {
  if (isDentalFactCase(context) && hasStructuredMedicalFacts(context)) {
    const flags = getDentalFactFlags(context)
    return [
      `${flags.toothLabel}牙体剩余量、牙周支持和根尖病变范围是否仍支持保牙？`,
      flags.hasPulpOrApex ? '是否需要先做根管治疗/感染控制，再评估冠修复或嵌体修复？' : '疼痛来源是龋坏、牙髓问题、牙周问题还是咬合创伤？',
      flags.hasImplantRequest ? '若患牙不可保留，拔除后是即刻种植、延期种植、植骨后种植，还是先做临时修复？' : '',
      flags.hasBoneInfo ? 'CBCT显示的骨高度、骨宽度和神经管位置是否满足种植安全距离？' : '',
      '回国后的复诊、牙周维护、咬合调整和修复体维护如何安排？',
    ].filter(Boolean)
  }

  const specialtyNarrative = buildSpecialtyFactNarrative(context)
  if (specialtyNarrative) {
    return [
      specialtyNarrative.priorityLine,
      ...specialtyNarrative.executionLines,
      '哪些资料缺口会直接影响治疗排序、费用预算和是否适合来华？',
      '首阶段疗效评估应使用哪些影像、实验室指标和复查时间点？',
    ].filter(Boolean).slice(0, 5)
  }

  if (!isBreastCancerFactCase(context) || !hasStructuredMedicalFacts(context)) return []

  const metastasisSites = getUniqueMetastasisSites(getMetastasisSignals(context))
  return [
    '是否需要复核原始病理/IHC，确认ER、PR、HER2、Ki-67及Luminal分型是否准确？',
    metastasisSites.length ? `PET/CT所示${metastasisSites.join('、')}病灶是否已达到转移性乳腺癌诊断依据，是否需要对可及病灶再活检？` : '',
    '既往内分泌、化疗、放疗或靶向治疗用过哪些方案，当前应选择内分泌联合CDK4/6抑制剂、化疗还是其他系统治疗？',
    metastasisSites.includes('骨骼') ? '骨转移是否需要地舒单抗/双膦酸盐、局部放疗、止痛和骨折风险管理？' : '',
    '下一次疗效评估应使用哪些指标和影像，时间点如何安排？',
  ].filter(Boolean)
}

const buildDiagnosticConclusion = (context: ProfessionalContext) => {
  const structured = buildStructuredDiagnosticConclusion(context)
  if (structured) return structured

  const { input, disease, missingMaterials } = context
  const medical = input.medical
  const diagnosis = medical.diagnosis || disease.label
  const evidence = [
    medical.pathologySummary ? `病理/检查摘要：${medical.pathologySummary}` : '',
    medical.imagingSummary ? `影像摘要：${medical.imagingSummary}` : '',
    medical.geneticSummary ? `基因/分子指标：${medical.geneticSummary}` : '',
    medical.treatmentHistory ? `既往治疗：${medical.treatmentHistory}` : '',
    ...input.parsedFiles.filter((file) => file.summary.trim()).map((file) => `上传资料 ${file.originalName}：${file.summary}`),
  ].filter(Boolean)

  return {
    finalImpression: medical.diagnosis
      ? `当前资料支持围绕“${diagnosis}”进行来华就医专业预审，但仍需中国接诊医生复核原始资料后确认。`
      : `当前尚未形成明确诊断，建议先围绕“${disease.label}”方向完成专科分诊和资料复核。`,
    severityInterpretation: medical.stage
      ? `已提供的分期/严重程度信息为“${medical.stage}”。该信息会直接影响治疗窗口、住院安排、费用区间和是否需要MDT会诊。`
      : `当前未提供清晰分期或严重程度；报告先按资料预审处理，重点补充${missingMaterials.slice(0, 3).join('、') || '关键检查资料'}。`,
    indicatorInterpretations: extractIndicatorInterpretations(input, context.diseaseKey),
    evidenceBasis: evidence.length ? evidence.slice(0, 8) : ['当前主要依据用户填写的主诉和就医目的；尚需上传原始报告、影像或既往治疗资料。'],
  }
}

const buildPrognosisComparison = (context: ProfessionalContext) => {
  const { disease, diseaseKey, decisionQuestions } = context
  const metastasisSites = getUniqueMetastasisSites(getMetastasisSignals(context))
  const baseMetrics = isBreastCancerFactCase(context) && metastasisSites.length
    ? [
      { metric: '疾病阶段', currentRisk: `资料提示${metastasisSites.join('、')}等复发/转移或可疑转移线索`, chinaReference: '中国肿瘤中心可通过病理复核、原始片复核和MDT确认转移性乳腺癌治疗路径', note: '报告阶段不替代医生诊断，但该信号应作为最高优先级处理。' },
      { metric: '系统治疗窗口', currentRisk: '若确认为HR+/HER2-转移性乳腺癌，治疗重点通常转向系统治疗和疗效评估', chinaReference: '可评估内分泌联合CDK4/6抑制剂、化疗、骨保护和局部姑息治疗组合', note: '具体方案取决于既往治疗、内脏危象、肝功能和患者体力状态。' },
      { metric: '骨相关事件风险', currentRisk: metastasisSites.includes('骨骼') ? '骨转移线索提示疼痛、骨折或脊髓压迫风险需要主动管理' : '当前资料未突出骨转移，但仍需按影像复核确认', chinaReference: '可同步安排骨保护药物、止痛、放疗或骨科/放疗科会诊评估', note: '尤其关注脊柱、骨盆、髋臼等承重部位。' },
      { metric: '随访基线', currentRisk: 'PET/CT和关键指标需要作为治疗前基线保存', chinaReference: '建议按6-12周评估疗效，并固定同类影像/实验室指标便于比较', note: '不能只凭单次报告决定长期方案。' },
    ]
    : diseaseKey === 'dental'
    ? [
      { metric: '保牙可能性', currentRisk: '取决于牙体缺损、根尖病变、牙周条件和疼痛性质', chinaReference: '可通过口腔影像、牙髓活力和牙周探诊快速分层', note: '先判断能否保留患牙，再决定根管、拔牙或种植。' },
      { metric: '种植复杂度', currentRisk: '牙槽骨不足会增加植骨或分阶段治疗可能', chinaReference: '中国口腔专科可按骨量、咬合和材料品牌拆分方案', note: '不建议在未复核CBCT前承诺一次完成。' },
      { metric: '复诊连续性', currentRisk: '种植和修复通常需要多次复诊', chinaReference: '适合把初诊评估、急性处理和后续修复计划分开安排', note: '需提前确认回国后的维护方式。' },
    ]
    : diseaseKey === 'premium_checkup'
      ? [
        { metric: '筛查精准度', currentRisk: '体检项目若与年龄、家族史和症状不匹配，容易漏查或过度检查', chinaReference: '可按风险分层配置影像、内镜、实验室和专科解读', note: '重点是异常结果承接，而不是堆叠套餐。' },
        { metric: '时间效率', currentRisk: '多项目检查协调不当会拉长停留时间', chinaReference: '中国高端体检可集中完成检查和专家解读', note: '适合3-7天短停留方案。' },
        { metric: '后续管理', currentRisk: '异常结果若无人跟进，会降低体检价值', chinaReference: '可建立复查提醒和远程解读机制', note: '需明确哪些异常进入专科二诊。' },
      ]
      : [
        { metric: '诊断明确度', currentRisk: '资料越不完整，误判治疗强度和费用的风险越高', chinaReference: '可通过病理、影像、基因/实验室复核提高决策确定性', note: `首要问题：${decisionQuestions[0] || '明确主责专科和治疗优先级'}。` },
        { metric: '治疗窗口', currentRisk: '高风险病情若等待过长，可能影响症状控制和治疗选择', chinaReference: '资料完整后通常可更快完成专家预审和首诊安排', note: '急症仍应先在当地处理。' },
        { metric: '综合管理', currentRisk: '单一科室视角可能忽略并发症、康复和随访', chinaReference: '适合通过专科或MDT形成治疗、康复、随访一体化路径', note: '最终以医生面诊和医院正式方案为准。' },
      ]

  return {
    positioning: isBreastCancerFactCase(context) && metastasisSites.length
      ? '本节基于上传资料识别到的乳腺癌复发/转移线索，聚焦疾病阶段、系统治疗窗口、骨相关事件风险和随访基线。'
      : `本节用于把“${disease.label}”相关风险、治疗窗口和中国方案价值进行结构化比较；不作为疗效承诺。`,
    metrics: baseMetrics,
    conclusion: isBreastCancerFactCase(context) && metastasisSites.length
      ? '该类病例的关键不是单纯寻找医院，而是把病理受体状态、影像进展、既往治疗和当前症状整合成可执行的系统治疗决策，并建立跨境随访闭环。'
      : `中国方案的核心价值不是简单替代当地治疗，而是在资料复核、专家预审、治疗路径排序、费用拆分和跨境服务执行上形成更清晰的决策闭环。`,
  }
}

const buildTechnologyAdvantages = (context: ProfessionalContext) => {
  const { diseaseKey } = context
  const map: Record<string, Array<{ technology: string; value: string; applicability: string }>> = {
    breast_cancer: isBreastCancerFactCase(context) && getUniqueMetastasisSites(getMetastasisSignals(context)).length
      ? [
        { technology: '乳腺肿瘤内科与MDT复核', value: '把病理受体状态、PET/CT进展、既往治疗和当前症状放在同一张决策表中排序。', applicability: '适用于术后复发、疑似转移或治疗路径需要换线的乳腺癌患者。' },
        { technology: 'CDK4/6抑制剂联合内分泌治疗评估', value: '围绕Palbociclib、Ribociclib、Abemaciclib联合芳香化酶抑制剂或Fulvestrant进行可行性、禁忌证、费用和监测计划评估。', applicability: '适用于ER阳性、HER2阴性且无明确内脏危象的复发/转移性乳腺癌病例，最终需肿瘤内科确认。' },
        { technology: '再活检与分子检测', value: '评估可及肝脏/淋巴结病灶再活检，复核ER/PR/HER2/Ki-67、HER2-low，并按需讨论PIK3CA、ESR1、BRCA/PALB2、NGS或ctDNA检测。', applicability: '适用于既往治疗后出现新转移、受体状态可能变化或需要精准用药排序的患者。' },
        { technology: '骨转移综合管理', value: '通过地舒单抗或唑来膦酸、补钙/维D、止痛、局部放疗和骨科/放疗科评估降低骨相关事件风险。', applicability: '适用于脊柱、骨盆、肋骨、髋臼等骨转移或可疑骨转移资料。' },
        { technology: '原始片复核与疗效评估基线', value: '保留PET/CT、CT/MRI和关键化验作为治疗前基线，便于6-12周后判断疗效。', applicability: '适用于需要跨国家、跨医院连续管理的肿瘤患者。' },
      ]
      : [
        { technology: '乳腺病理与影像复核', value: '复核病理、受体状态、影像分期和手术可行性。', applicability: '适用于新诊断或资料不完整的乳腺癌患者。' },
        { technology: '乳腺肿瘤MDT', value: '乳腺外科、肿瘤内科、放疗科、影像和病理共同排序治疗路径。', applicability: '适用于分期、保乳/全切、术后辅助治疗选择复杂的患者。' },
        { technology: '综合治疗随访管理', value: '把手术、放疗、化疗、内分泌治疗和复查计划衔接起来。', applicability: '适用于需要跨境治疗和长期随访的乳腺癌患者。' },
      ],
    lung_cancer: [
      { technology: '胸部肿瘤MDT分期复核', value: '把病理类型、胸部CT/PET、脑MRI、远处转移筛查和体力状态放在同一框架中判断治疗窗口。', applicability: '适用于新诊断、疑似局部晚期或转移性肺癌患者。' },
      { technology: '驱动基因与PD-L1联合判读', value: '围绕EGFR、ALK、ROS1、BRAF、MET、RET、NTRK、KRAS及PD-L1结果进行靶向/免疫/化疗排序。', applicability: '适用于非小细胞肺癌或病理提示需做分子检测的病例。' },
      { technology: '脑转移和骨转移风险管理', value: '通过头颅增强MRI、骨转移评估、放疗/药物和症状处理减少急性风险。', applicability: '适用于头痛、神经症状、骨痛或影像提示远处转移的患者。' },
    ],
    liver_cancer: [
      { technology: '肝胆外科-介入-肿瘤内科联合评估', value: '根据肿瘤数量、位置、门静脉侵犯、肝功能和全身情况排序手术、消融、TACE/HAIC、放疗和系统治疗。', applicability: '适用于肝癌/HCC或肝脏肿瘤治疗路径不清晰的病例。' },
      { technology: '肝功能储备与病毒学管理', value: '把Child-Pugh/ALBI、胆红素、白蛋白、凝血和乙肝/丙肝状态纳入治疗可承受性评估。', applicability: '适用于准备手术、介入或靶免系统治疗的患者。' },
      { technology: '增强影像与疗效基线管理', value: '使用肝脏增强MRI/CT和AFP等指标建立治疗前基线，便于后续按mRECIST等思路评估疗效。', applicability: '适用于需要分阶段治疗和跨境随访的肝癌患者。' },
    ],
    nasopharyngeal_cancer: [
      { technology: '头颈MRI与EBV DNA分层', value: '结合鼻咽镜病理、头颈MRI范围、颈部淋巴结和EBV DNA判断分期与治疗强度。', applicability: '适用于初治鼻咽癌或复发风险需要评估的患者。' },
      { technology: '精准放疗计划与综合治疗', value: '以调强放疗/容积旋转放疗为核心，按分期讨论诱导化疗、同步化疗或系统治疗。', applicability: '适用于局部区域鼻咽癌和需要放疗计划复核的病例。' },
      { technology: '放疗前支持管理', value: '提前处理口腔、营养、吞咽、听力和颈部功能问题，降低治疗中断风险。', applicability: '适用于需要完整放化疗疗程的外籍患者。' },
    ],
    neurosurgery: [
      { technology: '显微神经外科与术中神经电生理监测', value: '帮助医生在切除病灶时持续评估神经功能风险。', applicability: '适用于脊髓/脑部肿瘤、功能区病灶等高风险神经外科场景。' },
      { technology: '多模态影像融合与术前规划', value: '把MRI、CT、必要时功能影像用于定位和手术路径规划。', applicability: '适用于需要精确评估病灶范围、神经结构和术后风险的患者。' },
      { technology: 'MDT联合评估', value: '神经外科、放疗、肿瘤内科、康复和影像科共同排序治疗路径。', applicability: '适用于高级别、复发、术后辅助治疗选择复杂的病例。' },
    ],
    dental: [
      { technology: dentalAdvantages[0].label, value: dentalAdvantages[0].value, applicability: '适用于半口/全口缺牙、骨量不足、常规种植受限或需要复杂种植评估的患者。' },
      { technology: dentalAdvantages[1].label, value: dentalAdvantages[1].value, applicability: '适用于拟做种植牙、需要提前理解植体位置/角度/深度和手术路径的患者。' },
      { technology: dentalAdvantages[2].label, value: dentalAdvantages[2].value, applicability: '适用于希望按项目、颗数、材料品牌和复诊阶段核对预算的患者。' },
    ],
    cardiology_cardiothoracic: [
      { technology: '冠脉CTA/造影与心脏超声综合评估', value: '用于判断介入、外科手术或药物治疗优先级。', applicability: '适用于胸痛、冠心病、瓣膜病、心功能异常等场景。' },
      { technology: '心内科-心外科联合决策', value: '避免单纯按某一种技术路径处理复杂心血管问题。', applicability: '适用于介入和外科方案均可能适用的患者。' },
      { technology: '围术期风险管理', value: '系统评估麻醉、心功能、用药和康复风险。', applicability: '适用于需要住院、介入或手术的外籍患者。' },
    ],
  }

  return map[diseaseKey] || [
    { technology: '专科资料复核', value: '由目标专科复核病理、影像、检查和既往治疗，减少信息误差。', applicability: '适用于所有跨境就医预审。' },
    { technology: '多学科会诊/联合评估', value: '把诊断、治疗、康复和并发症管理放在同一决策框架下。', applicability: '适用于疑难、重症、复发或治疗路径不清晰的患者。' },
    { technology: '远程复诊与长期随访', value: '治疗后继续追踪复查结果、用药和康复计划。', applicability: '适用于需要跨国连续管理的患者。' },
  ]
}

const buildCostBreakdown = (context: ProfessionalContext) => {
  const { disease, diseaseKey } = context
  const dentalFlags = diseaseKey === 'dental' ? getDentalCaseFlags(context) : null
  const dentalMedicalProfile = diseaseKey === 'dental' ? buildDentalMedicalCostProfile(context) : null
  const breastMedicalProfile = isMetastaticBreastCancerFactCase(context) ? buildMetastaticBreastMedicalCostProfile(context) : null
  const medicalProfile = dentalMedicalProfile || breastMedicalProfile
  const cnyFirstCost = diseaseKey === 'dental' || Boolean(breastMedicalProfile)
  const medicalItems = medicalProfile?.items || disease.breakdown.filter((item) => !/翻译|陪诊|协调|住宿|生活/.test(item.item)).map((item) => ({
    ...item,
    note: '需由医生结合检查结果和治疗强度确认',
  }))
  const serviceItems = [
    { item: '病历整理、医学翻译与报告解读', cost: '$500-$1,500', note: '根据资料页数、语言和是否需要医学术语校对调整' },
    { item: '专家预审与医院对接', cost: '$800-$2,500', note: '用于匹配科室、整理问题清单和发起专家预审' },
    ...(dentalFlags?.implant ? [{
      item: dentalSimulationPlan.service,
      cost: '按专业版服务包或鼎植设计服务确认',
      note: dentalSimulationPlan.value,
    }] : []),
    { item: '全程陪诊与国际患者协调', cost: '$1,200-$3,000', note: '覆盖首诊、检查、沟通和治疗安排协调' },
    { item: '远程复诊与随访管理', cost: '$500-$1,500', note: '适合回国后复查、用药调整和康复追踪' },
  ]
  const livingItems = [
    { item: '国际往返机票', cost: '$700-$1,800', note: '按出发地、季节和舱位浮动' },
    { item: '医疗签证与邀请函材料', cost: '$150-$500', note: '签证费以使领馆和服务方式为准' },
    { item: '在华住宿', cost: '$1,000-$3,500', note: '按城市、医院距离和住宿标准浮动' },
    { item: '餐饮、交通与日常支持', cost: '$600-$1,800', note: '按停留天数和陪同人数调整' },
  ]

  const medicalTotal = medicalProfile
    ? parseUsdRange(medicalProfile.total)
    : sumRanges(medicalItems.map((item) => parseUsdRange(item.cost)))
  const serviceTotal = sumRanges(serviceItems.map((item) => parseUsdRange(item.cost)))
  const livingTotal = sumRanges(livingItems.map((item) => parseUsdRange(item.cost)))
  const grandTotal = sumRanges([medicalTotal, serviceTotal, livingTotal])

  return {
    currencyNote: diseaseKey === 'dental'
      ? dentalCostCurrencyNote
      : breastMedicalProfile
        ? '费用为转移性/复发性乳腺癌来华预审与首阶段治疗预算；中国医院实际收费通常以人民币为准，报告按 1 USD≈7.2 RMB 同时提供美元参考。CDK4/6抑制剂、内分泌药、骨保护药和是否住院/放疗会显著影响月度与年度费用。'
      : '费用为基于当前资料的预估区间，以美元为主并按 1 USD≈7.2 RMB 提供人民币参考；医院正式报价、药品选择、材料品牌和住院天数会影响最终金额。',
    medical: {
      title: '第一类：核心医疗费用',
      total: medicalProfile?.total
        ? (cnyFirstCost ? formatCnyFirstRange(medicalTotal, medicalProfile.total) : formatDualRange(medicalTotal, medicalProfile.total))
        : formatDualRange(medicalTotal, disease.chinaFee),
      items: medicalItems.length ? medicalItems.map((item) => ({
        item: item.item,
        cost: cnyFirstCost ? formatCnyFirstRange(parseUsdRange(item.cost), item.cost) : formatDualRange(parseUsdRange(item.cost), item.cost),
        note: item.note,
      })) : [{ item: disease.treatment, cost: disease.chinaFee, note: '当前资料不足，先按专科评估和基础治疗区间估算' }],
    },
    services: {
      title: '第二类：专属配套增值服务费用',
      total: cnyFirstCost ? formatCnyFirstRange(serviceTotal, '$3,000-$8,500') : formatDualRange(serviceTotal, '$3,000-$8,500'),
      items: serviceItems.map((item) => ({ ...item, cost: cnyFirstCost ? formatCnyFirstRange(parseUsdRange(item.cost), item.cost) : formatDualRange(parseUsdRange(item.cost), item.cost) })),
    },
    living: {
      title: '第三类：外籍在华生活刚需费用',
      total: cnyFirstCost ? formatCnyFirstRange(livingTotal, '$2,450-$7,600') : formatDualRange(livingTotal, '$2,450-$7,600'),
      items: livingItems.map((item) => ({ ...item, cost: cnyFirstCost ? formatCnyFirstRange(parseUsdRange(item.cost), item.cost) : formatDualRange(parseUsdRange(item.cost), item.cost) })),
    },
    grandTotal: cnyFirstCost ? formatCnyFirstRange(grandTotal, disease.chinaFee) : formatDualRange(grandTotal, disease.chinaFee),
    volatilityNote: breastMedicalProfile
      ? '上述为来华评估与首阶段治疗预估；若按CDK4/6抑制剂、内分泌治疗和骨保护药持续12个月管理，年度药物和复查预算需另行按实际药物品牌、医保/商保和治疗反应测算。'
      : '实际费用通常会因病情分期、检查补充、药物/材料选择、并发症处理和住院天数产生约±15-25%波动；超出预算前应由患者书面确认。',
  }
}

const buildMetastaticBreastTreatmentPhases = (context: ProfessionalContext) => {
  const desiredCity = context.input.preferences.desiredCity.trim()
  const cityLabel = desiredCity || '目标城市/医院'

  return [
    {
      phase: '资料复核与急症风险排查',
      timeline: '出发前1-3个工作日',
      actions: [
        `整理PET/CT DICOM原片、完整PET/CT报告、病理/IHC报告、2025年手术病理、既往放化疗和内分泌/靶向用药清单，形成${cityLabel}专家可直接阅读的病例时间线`,
        '核对是否存在剧烈骨痛、行走困难、下肢无力/麻木、大小便异常、黄疸、气促或发热；这些情况应先在当地急诊或肿瘤急诊处理',
        '补齐疼痛评分、体力状态、血常规、肝肾功能、凝血功能、胆红素/白蛋白和当前止痛/抗肿瘤药物清单',
      ],
      output: '形成乳腺肿瘤内科/MDT可直接使用的时间线、资料缺口和出行风险分层',
    },
    {
      phase: '病理受体复核与再活检决策',
      timeline: '资料完整后3-7个工作日',
      actions: [
        '复核ER、PR、HER2、Ki-67、Luminal B-like分型和原始病理切片，确认是否仍符合HR+/HER2-方向',
        '讨论肝脏、淋巴结或其他可及病灶是否需要再活检，以确认复发/转移性质、受体状态变化和HER2-low可能性',
        '根据医生意见评估PIK3CA、ESR1、BRCA/PALB2、NGS或ctDNA检测，避免在缺少分子信息时盲目决定长期用药',
      ],
      output: '确认HR/HER2状态、HER2-low可能性、精准治疗或临床研究筛选条件',
    },
    {
      phase: '系统治疗方案排序',
      timeline: '首诊后3-10个工作日',
      actions: [
        '若确认为HR+/HER2-且无明确内脏危象，重点讨论CDK4/6抑制剂联合内分泌治疗，如Palbociclib、Ribociclib或Abemaciclib联合芳香化酶抑制剂/Fulvestrant',
        '若肝转移负荷高、肝功能异常、症状进展快或既往内分泌治疗耐药，需由肿瘤内科评估是否优先化疗、换线治疗或参加临床研究',
        '把药物可及性、月费用、血象/肝功能监测、不良反应处理和回国续药方式一并写入首阶段方案',
      ],
      output: '形成首阶段处方讨论框架、监测指标、费用预算和疗效评估基线',
    },
    {
      phase: '骨/肝/肺转移灶并发症管理',
      timeline: '与系统治疗同步启动',
      actions: [
        '骨转移需评估承重骨、脊柱和髋臼风险，讨论地舒单抗或唑来膦酸、补钙/维D、牙科风险评估、止痛和局部放疗',
        '肝转移需结合肝功能、肿瘤负荷和症状判断系统治疗紧迫性，必要时请介入、放疗或支持治疗团队会诊',
        '右肺结节需结合薄层CT和随访变化判断转移、炎症或第二原发可能，避免只凭PET代谢高低下结论',
      ],
      output: '降低骨折、脊髓压迫、疼痛失控、肝功能受损和治疗中断风险',
    },
    {
      phase: '疗效评估与跨境随访',
      timeline: '治疗后6-12周起',
      actions: [
        '固定同类影像和实验室指标复查，评估肝、骨、淋巴结和肺部病灶变化，避免不同检查方式造成误读',
        '监测CDK4/6抑制剂相关中性粒细胞减少、肝功能异常、腹泻、疲劳等不良反应，并提前准备停药/减量/换药规则',
        '建立回国后的远程复诊、药物续方、检查提醒和再次来华窗口，保证系统治疗连续性',
      ],
      output: '形成可跨国家连续执行的疗效评估、用药安全和后续调整计划',
    },
  ]
}

const buildMetastaticBreastNextSteps = (context: ProfessionalContext) => {
  const desiredCity = context.input.preferences.desiredCity.trim()
  const cityLabel = desiredCity || '北京/上海/广州等目标城市'

  return [
    '如有剧烈骨痛、行走困难、下肢无力/麻木、大小便异常、黄疸、呼吸困难或发热，先在当地急诊或肿瘤急诊处理，并携带PET/CT报告说明骨、肝及淋巴结转移风险。',
    '立即整理PET/CT DICOM原片、完整报告、2025年手术病理、2024年病理/IHC、既往放化疗/内分泌/靶向治疗清单、近期血常规/肝肾功能和当前症状用药记录。',
    `发起${cityLabel}乳腺肿瘤内科/MDT远程预审，重点确认是否符合HR+/HER2-转移性乳腺癌、是否需要转移灶再活检及首阶段系统治疗排序。`,
    '请医生同步给出CDK4/6抑制剂联合内分泌治疗、化疗、骨保护药物、局部放疗和临床研究筛选的适用条件、禁忌证、监测计划和月费用。',
    '出行前按人民币预算拆分核心医疗费、平台服务费和在华生活费；若需要长期CDK4/6或骨保护治疗，应另行测算6-12个月药费和回国续药路径。',
  ]
}

const buildSpecialtyNextSteps = (context: ProfessionalContext) => {
  if (!isSpecialtyFactCase(context)) return null

  const cityLabel = context.input.preferences.desiredCity.trim() || '目标城市/医院'
  const map: Record<string, string[]> = {
    lung_cancer: [
      '如有咯血、明显气促、胸痛、发热、血氧下降、头痛抽搐或肢体无力，先在当地急诊/呼吸肿瘤科处理，再安排跨境就医。',
      '立即整理病理切片/蜡块、胸部CT DICOM、PET/CT或分期资料、头颅增强MRI、EGFR/ALK/PD-L1/NGS结果和既往用药记录。',
      `发起${cityLabel}胸部肿瘤内科/胸外科/放疗科MDT远程预审，重点确认TNM分期、是否可手术、是否应优先靶向/免疫/化疗或放疗。`,
      '请医生同步给出首阶段治疗排序、复查时间点、可测量病灶基线、常见不良反应监测和月度/阶段费用。',
    ],
    liver_cancer: [
      '如有黄疸、腹水、呕血黑便、意识改变、发热或明显乏力，先在当地处理肝功能失代偿、感染或出血风险。',
      '立即整理肝脏增强MRI/CT DICOM、AFP趋势、肝功能/凝血、乙肝/丙肝病毒学、既往介入/消融/手术/系统治疗记录。',
      `发起${cityLabel}肝胆外科/介入科/肿瘤内科MDT远程预审，重点确认是否可切除/消融，是否适合TACE/HAIC、放疗或靶免系统治疗。`,
      '请医生同步拆分手术/介入/系统治疗的适用条件、住院周期、肝功能监测、抗病毒管理和分阶段费用。',
    ],
    nasopharyngeal_cancer: [
      '如有鼻出血不止、严重头痛、视物异常、吞咽困难或颅神经症状，先在当地耳鼻喉/急诊处理。',
      '立即整理鼻咽镜病理、头颈MRI DICOM、EBV DNA、PET/CT或胸腹影像、既往放化疗剂量和毒副反应记录。',
      `发起${cityLabel}头颈肿瘤放疗科/肿瘤内科MDT远程预审，重点确认分期、放疗计划、诱导/同步化疗或复发后系统治疗路径。`,
      '请医生同步评估放疗前口腔、营养、听力、吞咽和颈部功能管理，避免治疗中断。',
    ],
    neurosurgery: [
      '如有进行性头痛、喷射性呕吐、抽搐、意识改变、肢体无力、语言障碍或大小便异常，先在当地神经外科急诊处理。',
      '立即整理头颅/脊髓MRI DICOM、既往手术记录、病理和IDH/MGMT/Ki-67结果、癫痫发作记录、当前激素/抗癫痫用药。',
      `发起${cityLabel}神经外科/放疗科/肿瘤内科MDT远程预审，重点确认最大安全切除、病理复核、放疗和替莫唑胺等辅助治疗排序。`,
      '请医生同步给出神经功能风险、术后康复计划、放化疗启动窗口、复查MRI节奏和跨境随访方式。',
    ],
  }

  return map[context.diseaseKey] || null
}

const buildRuleReport = (context: ProfessionalContext): ProfessionalReport => {
  const { input, disease, diseaseKey, selectedRegions, submissionNo, dateLabel, dataCompleteness, missingMaterials, decisionQuestions, redFlags, documentKnowledge, medicalFacts } = context
  const patient = input.patient
  const medical = input.medical
  const factMetastasisSites = getUniqueMetastasisSites(getMetastasisSignals(context))
  const factDiagnosisLabel = isBreastCancerFactCase(context) && factMetastasisSites.length
    ? '乳腺癌术后复发/转移性疾病方向'
    : ''
  const diagnosisLabel = medical.diagnosis || factDiagnosisLabel || disease.label
  const uploadedNames = input.uploadedFiles.map((file) => file.originalName)
  const parsedFileSummaries = input.parsedFiles.map((file) => ({
    file: file.originalName,
    status: file.status,
    summary: summarizeParsedFileForDisplay(file),
  }))
  const parsedEvidence = [
    ...getDisplayClinicalEvidenceItems(medicalFacts.evidenceHighlights, 6, 220),
    ...input.parsedFiles
      .filter((file) => file.summary.trim())
      .map((file) => `${file.originalName}：${file.summary}`)
      .filter((item) => isDisplayableClinicalEvidence(item))
      .map((item) => cleanEvidenceSnippet(item, 220)),
  ].slice(0, 8)
  const isDental = diseaseKey === 'dental'
  const dentalFlags = isDental ? getDentalCaseFlags(context) : null
  const dentalMedicalProfile = isDental ? buildDentalMedicalCostProfile(context) : null
  const chinaCost = dentalMedicalProfile?.total || disease.chinaFee
  const structuredClinicalFindings = buildStructuredClinicalFindings(context)
  const hasUploadedPathologyFacts = medicalFacts.documents.some((document) => (
    document.reportType.includes('病理') ||
    document.findings.some((finding) => finding.category === 'pathology') ||
    document.indicators.some((indicator) => ['ER', 'PR', 'HER2', 'Ki-67', '分子分型', '组织学分级'].includes(indicator.name))
  ))
  const hasUploadedImagingFacts = medicalFacts.documents.some((document) => (
    ['PET', 'CT', 'MRI', '超声', '钼靶', '骨扫描', '影像'].some((term) => document.reportType.includes(term)) ||
    document.findings.some((finding) => finding.category === 'imaging' || finding.category === 'metastasis') ||
    document.metastasisSignals.length > 0
  ))
  const structuredRedFlags = buildStructuredRedFlags(context)
  const structuredDecisionQuestions = buildStructuredDecisionQuestions(context)
  const mergedRedFlags = unique([...structuredRedFlags, ...redFlags])
  const mergedDecisionQuestions = unique([...structuredDecisionQuestions, ...decisionQuestions])
  const metastaticBreastCase = isMetastaticBreastCancerFactCase(context)
  const metastaticBreastNarrative = metastaticBreastCase ? buildMetastaticBreastCaseNarrative(context) : null
  const specialtyNextSteps = buildSpecialtyNextSteps(context)
  const treatmentPhases = metastaticBreastCase
    ? buildMetastaticBreastTreatmentPhases(context)
    : isDental
    ? dentalFlags?.implant
      ? [
        { phase: '资料预审与鼎植评估', timeline: '出发前1-3个工作日', actions: [dentalPartner.preparation, `补充${dentalSimulationPlan.requiredMaterials.slice(0, 3).join('、')}`, '判断是否需要先在当地处理急性疼痛或感染'], output: '种植适应证、资料缺口和是否适合来华初步判断' },
        { phase: '种植牙模拟设计', timeline: '资料完整后3-7个工作日', actions: ['基于CBCT/口腔影像做诊断概览', '输出3D设计概览', '规划种植体位置、型号、角度、深度和手术概要'], output: '专业版种植牙模拟方案和医生问题清单' },
        { phase: '抵华首诊与方案确认', timeline: '抵华后1-5天', actions: ['鼎植口腔建档和面诊', '补充CBCT、牙周/咬合评估', '确认保牙、拔牙、半口/全口或复杂种植路径'], output: '正式治疗方案、材料选择和费用清单' },
        { phase: '种植与修复分阶段执行', timeline: '通常3-6个月以上', actions: dentalImplantSteps.slice(1, 4), output: '一期种植、骨结合、二期修复和阶段性复诊安排' },
        { phase: '复查维护与回国随访', timeline: '每3-6个月', actions: [dentalImplantSteps[4], '远程复诊资料翻译和医生解读', '必要时协调当地牙科维护'], output: '长期维护计划和复查提醒' },
      ]
      : [
        { phase: '资料预审', timeline: '出发前1-3个工作日', actions: [dentalPartner.preparation, '明确疼痛牙位、冷热刺激痛、夜间痛和既往治疗记录', '判断是否存在需要当地先处理的感染风险'], output: '牙体牙髓/牙周/修复方向初步分层' },
        { phase: '鼎植首诊与检查', timeline: '抵华后1-3天', actions: ['完成口腔全景片/CBCT或根尖片', '牙周、咬合和患牙保留价值评估', '确认补牙、根管、拔牙、贴面或后续种植可能性'], output: '正式诊疗路径和费用清单' },
        { phase: '首阶段处理', timeline: '抵华后3-10天', actions: dentalFlags?.veneer ? ['贴面美学设计', '材料品牌和颗数确认', '取模、制作和佩戴周期安排'] : ['止痛和感染控制', '补牙、根管或牙周基础治疗', '必要时拔牙后制定修复/种植计划'], output: '首阶段治疗结果和后续复诊安排' },
        { phase: '回国维护', timeline: '治疗后1/3/6个月', actions: ['复查资料上传', '远程复诊', '咬合、牙周和修复体维护建议'], output: '后续维护档案和复查提醒' },
      ]
    : [
      { phase: '资料预审', timeline: '出发前1-3个工作日', actions: ['整理病理、影像、基因检测和既往治疗资料', '形成专家问题清单', '判断是否适合来华或需先当地处理'], output: '资料完整度评估和专家预审方向' },
      { phase: '医院与专家匹配', timeline: '出发前3-7个工作日', actions: disease.hospitals.map((item) => `对接${item.name}相关科室`).slice(0, 3), output: '目标医院、科室和首诊安排建议' },
      { phase: '抵华首诊与复核', timeline: '抵华后1-5天', actions: ['完成必要检查复核', '专科门诊或MDT评估', '确认治疗路径和费用清单'], output: '正式治疗方案和签字确认费用清单' },
      { phase: '治疗执行', timeline: disease.duration, actions: [disease.treatment, '根据检查结果调整治疗强度', '同步安排翻译、陪诊和生活支持'], output: '阶段性治疗结果和出院/转诊建议' },
      { phase: '回国随访', timeline: '治疗后1/3/6/12个月', actions: ['远程复诊', '复查资料翻译和医生解读', '必要时安排二次来华或当地协作'], output: '长期随访档案和复查提醒' },
    ]
  const hospitalRecommendations = isDental
    ? [{
      city: dentalPartner.city,
      hospital: dentalPartner.name,
      department: dentalPartner.department,
      whyFit: dentalPartner.recommendationReason,
      preparation: dentalPartner.preparation,
      matchScore: Math.max(82, disease.score),
    }]
    : metastaticBreastCase
      ? [
        {
          city: '上海',
          hospital: '复旦大学附属肿瘤医院',
          department: '乳腺肿瘤内科/乳腺中心/MDT',
          whyFit: '适合乳腺癌术后复发、多发转移和HR+/HER2-系统治疗排序病例，可重点完成病理受体复核、PET/CT原片复核、内分泌联合靶向治疗和临床研究机会评估。',
          preparation: '提交PET/CT DICOM、病理/IHC、手术病理、放化疗记录、既往用药和近期血常规/肝肾功能后再发起专家预审。',
          matchScore: 92,
        },
        {
          city: '北京',
          hospital: '中国医学科学院肿瘤医院',
          department: '乳腺肿瘤内科/放疗科/影像病理会诊',
          whyFit: '适合以国家级肿瘤专科平台复核多发转移性乳腺癌方案，尤其是系统治疗、骨转移局部放疗、再活检和分子检测路径。',
          preparation: '先整理原始影像、病理切片、肿瘤标志物和既往治疗时间线，预审时同步提出是否需要再活检和分子检测。',
          matchScore: 90,
        },
        {
          city: '广州',
          hospital: '中山大学肿瘤防治中心',
          department: '乳腺肿瘤内科/综合肿瘤MDT',
          whyFit: '适合华南及东南亚患者就近评估乳腺癌复发转移、系统治疗和跨境复诊衔接，可兼顾影像、病理、放疗和药物治疗资源。',
          preparation: '适合把目标城市、预算、签证时间和回国续药安排一起提交，便于判断首阶段在华停留周期。',
          matchScore: 88,
        },
      ]
    : disease.hospitals.map((item, index) => ({
      city: item.city,
      hospital: item.name,
      department: disease.label,
      whyFit: item.reason,
      preparation: `建议提交${missingMaterials.slice(0, 3).join('、') || '完整病历资料'}后再发起专家预审。`,
      matchScore: Math.max(70, disease.score - index * 3),
    }))
  const itinerary = isDental
    ? [
      { dayRange: 'D-7至D-1', stage: '出发前准备', tasks: ['整理口腔影像和既往治疗记录', '鼎植资料预审', dentalFlags?.implant ? '启动种植牙模拟方案资料准备' : '确认首诊检查项目'] },
      { dayRange: 'D1-D2', stage: '抵达深圳与建档', tasks: ['接机入住', '鼎植口腔建档', '医学翻译陪同确认主诉和病史'] },
      { dayRange: 'D3-D5', stage: '检查与方案确认', tasks: ['完成CBCT/牙周/咬合评估', dentalFlags?.implant ? '复核模拟方案和植体路径' : '确认保牙、根管、贴面或修复路径', '确认材料、费用和复诊周期'] },
      { dayRange: 'D6-D10+', stage: '首阶段治疗', tasks: dentalFlags?.implant ? ['执行一期种植或术前处置', '术后复查和拆线安排', '确认二期修复时间'] : ['止痛、补牙、根管、牙周或贴面首阶段处理', '复诊检查', '确认后续维护计划'] },
      { dayRange: '离境后', stage: '远程随访与维护', tasks: ['上传复查资料', '远程复诊', '必要时协调当地牙科维护或二次来华'] },
    ]
    : metastaticBreastCase
      ? [
        { dayRange: 'D-10至D-3', stage: '远程资料预审', tasks: ['提交PET/CT DICOM、完整报告和病理/IHC', '整理手术、放疗、化疗、内分泌/靶向用药时间线', '医生先判断是否存在需当地急诊处理的骨痛、黄疸或神经症状'] },
        { dayRange: 'D-2至D0', stage: '确认出行与预算', tasks: ['锁定目标医院/城市和首诊时间', '确认首阶段人民币预算、陪同家属、住宿和翻译安排', '准备医疗邀请函、保险预授权或自费支付材料'] },
        { dayRange: 'D1-D5', stage: '抵华建档与复核检查', tasks: ['国际部建档和乳腺肿瘤内科首诊', '完成病理/影像会诊、血常规、肝肾功能、凝血功能和肿瘤标志物', '按需补做肝脏增强MRI/CT、头颅增强MRI和骨风险评估'] },
        { dayRange: 'D6-D14', stage: 'MDT与首阶段方案确认', tasks: ['决定是否再活检及PIK3CA/ESR1/BRCA/PALB2/NGS/ctDNA检测', '排序CDK4/6+内分泌、化疗、骨保护、局部放疗或临床研究', '确认药物品牌、监测频率、不良反应处理和月费用'] },
        { dayRange: 'D15-D21+', stage: '启动治疗或回国衔接', tasks: ['如适合可启动首周期系统治疗、骨保护或疼痛骨转移局部放疗', '整理中文/英文医嘱、用药监测表和回国复查计划', '约定6-12周影像和实验室疗效评估窗口'] },
      ]
    : [
      { dayRange: 'D-7至D-1', stage: '出发前准备', tasks: ['资料翻译和归档', '医院预审', '签证邀请函和行程确认'] },
      { dayRange: 'D1-D3', stage: '抵华与首诊', tasks: ['接机入住', '国际部建档', '完成首诊和基础复查'] },
      { dayRange: 'D4-D10', stage: '检查复核与方案确认', tasks: ['补充影像/实验室检查', '专科或MDT会诊', '确认治疗和费用清单'] },
      { dayRange: 'D11-D21', stage: '治疗或阶段性处理', tasks: ['执行治疗计划', '住院/门诊管理', '同步康复、营养和翻译服务'] },
      { dayRange: '离境后', stage: '远程随访', tasks: ['复查资料上传', '远程复诊', '回国用药和康复计划跟进'] },
    ]
  const servicePlan = [
    { service: '病历整理与医学翻译', value: '把多语言资料整理为医院可读的结构化病历摘要。' },
    ...(isDental && dentalFlags?.implant ? [dentalSimulationPlan] : []),
    { service: '专家预审与医院对接', value: isDental ? `仅对接${dentalPartner.name}，围绕CBCT、牙周、咬合和修复诉求形成预审问题清单。` : '根据资料匹配医院科室，减少盲目出行和无效排队。' },
    { service: '签证邀请函与行程管理', value: '协助准备医疗邀请函、住宿、接送和陪同家属材料。' },
    { service: '全程医学翻译陪诊', value: '覆盖首诊、检查、治疗沟通和出院医嘱解释。' },
    { service: '保险与费用清单协助', value: '协助准备预授权或理赔所需的治疗方案和费用预估。' },
    { service: '远程复诊与康复随访', value: isDental ? '治疗后持续跟踪复查、牙周维护、咬合调整和种植体/修复体状态。' : '治疗后持续跟踪复查、康复和用药调整。' },
  ].slice(0, isDental ? 6 : 6)
  const countryComparison = [
    {
      flag: '🇨🇳',
      country: '中国（推荐）',
      cost: chinaCost,
      waitTime: input.preferences.urgency === 'urgent' ? '资料完整后优先加急预审；急症需先当地处理' : '通常7-21天完成专家预审和首诊安排',
      strengths: isDental ? `${dentalPartner.name}可围绕CBCT、种植/修复设计和费用拆分做牙科专科预审。` : `${disease.label}相关专科资源集中，适合先做资料复核、专家预审和治疗路径排序。`,
      limitations: isDental ? '需提前准备口腔影像、缺牙/患牙位置和既往治疗记录，最终以鼎植面诊和正式报价为准。' : '需提前准备完整英文/中文病历、影像和检查资料，最终方案以医生面诊为准。',
      fitScore: Math.min(95, Math.max(72, disease.score + Math.round(dataCompleteness / 10))),
      recommended: true,
    },
    ...selectedRegions.slice(0, 8).map((region, index) => ({
      flag: region.flag,
      country: region.name,
      cost: isDental ? (dentalComparableRegionFees[region.name] || '需按具体牙科项目评估') : region.fee,
      waitTime: isDental ? '通常需按牙科项目和医生排期确认；急性疼痛需先当地处理' : region.wait,
      strengths: isDental ? '重点比较CBCT、牙周/牙体牙髓处理、种植系统、牙冠/贴面材料和复诊连续性。' : region.tech,
      limitations: isDental ? `${region.service}；种植和修复通常需要阶段性复诊，需提前确认回国后的维护方式。` : `${region.service}；${region.follow}`,
      fitScore: Math.max(55, disease.score - 8 - index * 2),
    })),
  ]

  const dataFlags = [
    dataCompleteness < 60 ? '当前资料完整度偏低，报告应作为预审方向而非最终方案。' : '',
    !uploadedNames.length ? '尚未上传原始文件，建议补充病理、影像或既往治疗资料。' : '',
    uploadedNames.length && !input.parsedFiles.some((file) => file.text.trim()) ? '已上传文件，但暂未提取到可用于生成的正文，建议补充关键文字摘要或人工复核文件。' : '',
    ...medicalFacts.qualityFlags,
    !medical.diagnosis ? '用户未填写明确诊断，需先完成专科方向和诊断确认。' : '',
    ...mergedRedFlags,
  ].filter(Boolean)
  const structuredSummary = hasStructuredMedicalFacts(context)
    ? metastaticBreastNarrative ? [
      metastaticBreastNarrative.coreConclusion,
      metastaticBreastNarrative.timelineStory,
      metastaticBreastNarrative.pathologyLine,
      metastaticBreastNarrative.priorityLine,
      metastaticBreastNarrative.managementGoalLine,
      metastaticBreastNarrative.executionLines[0],
      metastaticBreastNarrative.costLine,
    ] : [
      `已从上传资料中形成医学事实摘要：${medicalFacts.summary}。`,
      isBreastCancerFactCase(context) && getUniqueMetastasisSites(getMetastasisSignals(context)).length
        ? `核心判断：资料中存在${getUniqueMetastasisSites(getMetastasisSignals(context)).join('、')}等复发/转移或可疑转移线索，应优先按转移性乳腺癌方向完成肿瘤内科复核。`
        : '',
      medicalFacts.timeline.length ? `资料时间线覆盖：${uniqueSortedDates(medicalFacts.timeline.map((item) => item.date)).slice(0, 6).join('、')}。` : '',
    ].filter(Boolean)
    : []

  return {
    id: submissionNo,
    date: dateLabel,
    title: `${diagnosisLabel} 来华就医专业评估报告`,
    subtitle: 'Professional China Medical Travel Assessment',
    patientSnapshot: {
      patient: patient.fullName,
      profile: `${patient.gender}；${patient.nationality || '国籍未填写'}；${patient.city || '常住城市未填写'}`,
      primaryNeed: medical.chiefComplaint,
      diagnosisStatus: medical.stage ? `${diagnosisLabel}；${medical.stage}` : diagnosisLabel,
      dataCompleteness,
      uploadedFiles: uploadedNames,
      parsedFiles: parsedFileSummaries,
    },
    executiveSummary: [
      ...structuredSummary,
      `本报告围绕“${medical.chiefComplaint.slice(0, 80)}”进行专业预审，当前最关键的是：${mergedDecisionQuestions[0] || '明确主责专科和治疗优先级'}。`,
      !metastaticBreastNarrative && parsedEvidence.length ? `已纳入上传资料解析摘要：${cleanEvidenceSnippet(parsedEvidence[0], 120)}。` : '',
      documentKnowledge.length ? '已结合平台沉淀的医疗服务、费用、保险和跨境就医流程要点，并按当前病情重新组织。' : '',
      `中国方案的价值在于先完成资料复核、专家预审、费用拆分和行程可执行性评估，再决定是否启动跨境治疗。`,
      dataCompleteness >= 70 ? '当前资料基础较好，可进入医院/专家预审阶段。' : `当前仍建议补充：${missingMaterials.slice(0, 3).join('、')}。`,
    ].filter(Boolean),
    diagnosticConclusion: buildDiagnosticConclusion(context),
    clinicalAssessment: {
      workingDiagnosis: diagnosisLabel,
      severity: structuredRedFlags.length
        ? '上传资料提示存在高优先级复发/转移或并发症风险，需尽快专科复核'
        : input.preferences.urgency === 'urgent' ? '需优先排除急性风险，再安排跨境评估' : '需结合补充资料进一步分层评估',
      keyFindings: [
        ...structuredClinicalFindings,
        medical.stage ? `分期/严重程度信息：${medical.stage}` : '尚未提供明确分期或严重程度信息。',
        medical.pathologySummary ? `病理摘要：${medical.pathologySummary}` : hasUploadedPathologyFacts ? '' : '尚未提供病理摘要。',
        medical.imagingSummary ? `影像摘要：${medical.imagingSummary}` : hasUploadedImagingFacts ? '' : '尚未提供影像摘要。',
        medical.treatmentHistory ? `既往治疗：${medical.treatmentHistory}` : '尚未提供既往治疗记录。',
        ...parsedEvidence.map((item) => `上传资料解析：${item}`),
      ].slice(0, 14),
      redFlags: mergedRedFlags,
      missingMaterials,
      decisionQuestions: mergedDecisionQuestions,
    },
    treatmentPathway: {
      goal: metastaticBreastCase
        ? '围绕上传资料中的HR+/HER2-乳腺癌复发/转移线索，先确认病理受体状态、全身分期和是否存在内脏危象，再落地系统治疗、骨/肝/肺转移管理、费用预算和跨境随访路径。'
        : `围绕${disease.label}方向，先确认诊断证据和治疗优先级，再制定在华评估、治疗和回国随访路径。`,
      phases: treatmentPhases,
    },
    prognosisComparison: buildPrognosisComparison(context),
    technologyAdvantages: buildTechnologyAdvantages(context),
    costBreakdown: buildCostBreakdown(context),
    countryComparison,
    hospitalRecommendations,
    itinerary,
    servicePlan,
    paymentAndInsurance: [
      '支持按医院正式报价、服务项目和在华生活费用分项确认预算，避免把所有费用混成单一大包价。',
      ...(metastaticBreastCase ? ['转移性乳腺癌通常不是一次性治疗费用，需把首阶段评估/治疗费用与6-12个月持续用药、复查、骨保护和回国续药费用分开测算。'] : []),
      ...(isDental ? [dentalCostCurrencyNote] : []),
      input.preferences.insuranceType
        ? `已记录保险/支付信息：${input.preferences.insuranceType}。建议在专家预审后准备诊断证明、治疗方案、费用预估和发票明细，用于预授权或理赔沟通。`
        : '如患者持有国际商业保险，建议先确认是否覆盖中国大陆医院、是否需要预授权、是否接受直付或事后理赔。',
      '跨境支付建议提前确认信用卡额度、银行转账时效、外汇限制和退款规则；医院费用、平台服务费用、住宿交通费用应分别留痕。',
    ],
    risksAndDisclaimers: [
      '本报告是基于用户提交资料生成的来华就医专业预审，不构成诊断、处方或最终治疗承诺。',
      '治疗效果与费用会受病情分期、检查结果、个体差异、药物/材料选择和住院天数影响。',
      ...(isDental ? ['牙科种植、贴面或修复路径需由鼎植口腔结合CBCT、牙周、咬合和材料选择确认；资料价格不等于最终固定报价。'] : []),
      ...(metastaticBreastCase ? ['本例上传资料存在多部位复发/转移线索，若出现骨痛加重、下肢无力/麻木、大小便异常、黄疸、呼吸困难、发热或意识/神经症状，应先在当地就医处理，不能等待跨境排期。'] : []),
      '如存在急性疼痛、感染、神经功能恶化、胸痛、呼吸困难等风险信号，应先在当地就近处理。',
      '最终治疗方案以中国执业医生面诊、医院正式检查结果和患者签字确认文件为准。',
    ],
    nextSteps: metastaticBreastCase
      ? buildMetastaticBreastNextSteps(context)
      : specialtyNextSteps
        ? specialtyNextSteps
      : [
        `补充${missingMaterials.slice(0, 3).join('、') || '完整病历资料'}。`,
        '确认预算、保险预授权要求和期望来华城市。',
        '发起医院/专家预审，锁定首诊时间和资料清单。',
        '根据预审结果决定是否进入签证邀请函、机票住宿和治疗排期。',
      ],
    qualityFlags: dataFlags,
    generatedBy: 'rules',
  }
}

const professionalTabConfigs = [
  { key: 'records', label: '上传资料解读', labelEn: 'Medical Records', icon: 'FileSearch' },
  { key: 'pathology', label: '核心病理诊断', labelEn: 'Core Pathology', icon: 'Microscope' },
  { key: 'assessment', label: '病情综合评估', labelEn: 'Comprehensive Assessment', icon: 'Activity' },
  { key: 'treatment', label: '治疗路径方案', labelEn: 'Treatment Pathway', icon: 'Stethoscope' },
  { key: 'cost', label: '费用明细', labelEn: 'Cost Breakdown', icon: 'DollarSign' },
  { key: 'advanced', label: '前沿新技术新药物', labelEn: 'Advanced Tech & Drugs', icon: 'Atom' },
  { key: 'comparison', label: '8国全维度对比', labelEn: '8-Country Comparison', icon: 'Globe' },
  { key: 'itinerary', label: '21天行程规划', labelEn: '21-Day Itinerary', icon: 'Calendar' },
  { key: 'similarCases', label: '相似患者案例', labelEn: 'Similar Cases', icon: 'Users' },
  { key: 'topDoctors', label: '专家推荐TOP10', labelEn: 'Top 10 Doctors', icon: 'Stethoscope' },
  { key: 'service', label: '专属服务包', labelEn: 'Service Package', icon: 'Headset' },
  { key: 'risk', label: '风险与预后', labelEn: 'Risk & Prognosis', icon: 'ShieldAlert' },
  { key: 'hospitals', label: '推荐医院Top 3', labelEn: 'Top Hospitals', icon: 'Hospital' },
  { key: 'next', label: '就诊流程', labelEn: 'Next Steps', icon: 'Footprints' },
] as const

const tabBase = (key: typeof professionalTabConfigs[number]['key']) => professionalTabConfigs.find((item) => item.key === key)!

const buildProfessionalTabs = (report: ProfessionalReport, context: ProfessionalContext): ReportLayoutSection[] => {
  const { disease, missingMaterials, decisionQuestions, redFlags, documentKnowledge } = context
  const isDental = context.diseaseKey === 'dental'
  const doctorProfiles = Array.from({ length: 10 }).map((_, index) => {
    const hospital = report.hospitalRecommendations[index % Math.max(1, report.hospitalRecommendations.length)]
    const role = [
      '主责首诊专家',
      'MDT牵头专家',
      '手术/介入评估专家',
      '影像复核专家',
      '病理/实验室复核专家',
      '药物治疗专家',
      '康复管理专家',
      '国际医疗协调专家',
      '随访复诊专家',
      '保险材料审核顾问',
    ][index]

    return {
      title: `专家画像 #${index + 1}：${role}`,
      subtitle: hospital ? `${hospital.hospital} · ${hospital.department}` : disease.label,
      value: index < 3 ? '优先匹配' : '备选匹配',
      description: hospital?.whyFit || `围绕${disease.label}方向进行资料复核、风险分层和治疗路径判断。`,
      detail: '正式医生姓名、号源和排班需在患者授权后通过医院/合作平台核验，报告阶段不编造医生身份。',
      tag: index < 3 ? '优先方向' : '备选方向',
      tone: index < 3 ? 'highlight' : 'default',
    }
  })
  const similarCaseCards = [
    {
      title: '相似病例参考原则',
      subtitle: disease.label,
      description: `优先匹配诊断方向、分期/严重程度、既往治疗、关键指标和当前诉求相近的病例；当前报告不展示未经核验的真实患者姓名或疗效承诺。`,
      tone: 'warning',
    },
    {
      title: '可参考的病例维度',
      description: `资料完整度 ${report.patientSnapshot.dataCompleteness}/100；重点比较${decisionQuestions.slice(0, 2).join('、') || '治疗路径和风险分层'}。`,
    },
    {
      title: '进入专业人工复核后',
      description: '可由医疗顾问基于授权资料进一步匹配公开案例、医院病例经验或专家团队经验，并标注来源。',
    },
  ]

  const makeTab = (
    key: typeof professionalTabConfigs[number]['key'],
    summary: string,
    blocks: ReportLayoutSection['blocks'],
  ): ReportLayoutSection => {
    const base = tabBase(key)
    return {
      ...base,
      label: isDental && key === 'hospitals' ? '推荐牙科机构' : base.label,
      labelEn: isDental && key === 'hospitals' ? 'Recommended Dental Provider' : base.labelEn,
      summary,
      blocks,
    }
  }
  const recordTimeline = context.medicalFacts.timeline.length
    ? context.medicalFacts.timeline.map((event) => ({
      time: event.date,
      title: `${event.reportType} · ${event.title}`,
      description: getDisplayClinicalEvidenceItems([event.description], 1, 220)[0] || '该节点已识别到医学资料变化，需医生结合原件复核。',
      items: [
        `来源：${event.fileName}`,
        ...getDisplayClinicalEvidenceItems(event.items, 4, 160),
      ],
    }))
    : []
  const recordEvidenceCards = context.medicalFacts.documents.length
    ? context.medicalFacts.documents.map((document) => ({
      title: document.reportType,
      subtitle: document.primaryDate || document.fileName,
      value: `置信度 ${Math.round(document.confidence * 100)}%`,
      description: getDisplayEvidenceItems(document.sourceEvidence, 3, 180).join('；') || '未识别到明确医学结论，需人工复核原件。',
      detail: `来源文件：${document.fileName}`,
      tone: document.confidence >= 0.65 ? 'highlight' : 'warning',
    }))
    : [{
      title: '暂未形成可用资料解读',
      description: '上传文件未提取到足够医学事实，当前报告主要基于表单信息生成。建议重新上传清晰图片/PDF原文，或在病理、影像、治疗史字段补充文字摘要。',
      tone: 'warning',
    }]
  const metastasisSitesForRecords = getUniqueMetastasisSites(getMetastasisSignals(context))
  const metastaticBreastNarrativeForRecords = isMetastaticBreastCancerFactCase(context)
    ? buildMetastaticBreastCaseNarrative(context)
    : null
  const recordConclusion = context.medicalFacts.hasActionableFacts
    ? report.diagnosticConclusion.finalImpression
      || metastaticBreastNarrativeForRecords?.coreConclusion
      || (isBreastCancerFactCase(context) && metastasisSitesForRecords.length
        ? `上传资料提示乳腺癌术后复发/进展，并出现${metastasisSitesForRecords.join('、')}等转移或可疑转移线索；请以原始片、病理报告和肿瘤内科复核为准。`
        : context.medicalFacts.summary)
    : '上传资料未成功识别出可用于医学判断的核心事实，不能据此推断病理、分期或治疗方案。'
  const recordKeyItems = context.medicalFacts.hasActionableFacts
    ? unique([
      report.diagnosticConclusion.severityInterpretation,
      ...report.clinicalAssessment.keyFindings,
      ...report.nextSteps.slice(0, 2),
    ]).filter(Boolean).slice(0, 7)
    : context.medicalFacts.qualityFlags
  const rawRecordBlocks: ReportLayoutSection['blocks'] = [
    {
      type: 'notice',
      title: '核心资料结论',
      description: recordConclusion,
      items: context.medicalFacts.qualityFlags.length
        ? context.medicalFacts.qualityFlags
        : recordKeyItems.length
          ? recordKeyItems
        : metastaticBreastNarrativeForRecords
          ? [
            metastaticBreastNarrativeForRecords.timelineStory,
            metastaticBreastNarrativeForRecords.pathologyLine,
            metastaticBreastNarrativeForRecords.imagingLine,
            metastaticBreastNarrativeForRecords.priorityLine,
            metastaticBreastNarrativeForRecords.managementGoalLine,
            ...metastaticBreastNarrativeForRecords.riskLines.slice(0, 3),
          ]
          : getDisplayClinicalEvidenceItems(context.medicalFacts.evidenceHighlights, 5, 220),
      tone: context.medicalFacts.hasActionableFacts ? 'highlight' : 'warning',
    },
    {
      type: 'timeline',
      title: '病情时间线',
      description: recordTimeline.length ? '按资料中的日期和报告类型排序，帮助医生快速理解病情变化。' : '未识别到可排序的检查日期或报告结论。',
      timeline: recordTimeline,
    },
    {
      type: 'cards',
      title: '上传资料分项识别',
      cards: recordEvidenceCards,
    },
    {
      type: 'table',
      title: '关键指标与证据',
      table: {
        columns: ['指标/部位', '当前识别', '证据来源'],
        rows: [
          ...context.medicalFacts.documents.flatMap((document) => document.indicators.map((indicator) => ({
            cells: [indicator.name, indicator.value, `${document.fileName}：${getDisplayClinicalEvidenceItems([indicator.evidence], 1, 220)[0] || '来源于上传资料结构化识别，需医生复核原件。'}`],
          }))),
          ...getMetastasisSignals(context).map((signal) => ({
            cells: [signal.site, signal.status === 'present' ? '提示转移/高代谢病灶' : signal.status === 'suspected' ? '可疑或需排除' : '未见明确转移', getDisplayClinicalEvidenceItems([signal.evidence], 1, 240)[0] || '来源于上传影像报告结构化识别，需医生复核原片。'],
            highlight: signal.status !== 'absent',
          })),
        ].slice(0, 16),
      },
    },
  ]
  const recordBlocks: ReportLayoutSection['blocks'] = rawRecordBlocks.filter((block) => (
    block.type !== 'table' || (block.table?.rows.length || 0) > 0
  ))

  return [
    makeTab('records', context.medicalFacts.hasActionableFacts
      ? metastaticBreastNarrativeForRecords
        ? '已基于上传病理、影像和PET/CT资料整理出乳腺癌术后复发/转移方向的核心结论、时间线和下一步复核重点。'
        : '基于上传资料提取日期、报告类型、关键指标和复发/转移线索，形成病例时间线。'
      : '上传资料暂未识别出足够医学事实，报告会明确标注识别限制。', recordBlocks),
    makeTab('pathology', '围绕用户提交的诊断、病理、影像、基因和上传资料做核心医学解读。', [
      {
        type: 'summary',
        title: '最终诊断/工作方向',
        metrics: [
          { label: '诊断/方向', value: report.clinicalAssessment.workingDiagnosis, detail: report.diagnosticConclusion.finalImpression, tone: 'highlight' },
          { label: '严重程度', value: report.clinicalAssessment.severity, detail: report.diagnosticConclusion.severityInterpretation, tone: redFlags.length ? 'warning' : 'default' },
          { label: '资料完整度', value: `${report.patientSnapshot.dataCompleteness}/100`, detail: report.patientSnapshot.uploadedFiles.length ? `已上传 ${report.patientSnapshot.uploadedFiles.length} 个文件` : '尚未上传原始文件' },
        ],
      },
      {
        type: 'table',
        title: '核心指标解读',
        table: {
          columns: ['指标', '当前信息', '专业解读'],
          rows: report.diagnosticConclusion.indicatorInterpretations.map((item) => ({
            cells: [item.indicator, item.value, item.interpretation],
          })),
        },
      },
      {
        type: 'list',
        title: '本报告依据',
        items: report.diagnosticConclusion.evidenceBasis,
      },
    ]),
    makeTab('assessment', '把病情严重程度、短期风险、缺失材料和关键决策问题合并评估。', [
      {
        type: 'cards',
        title: '综合评估',
        cards: [
          { title: '工作诊断', value: report.clinicalAssessment.workingDiagnosis, description: report.diagnosticConclusion.finalImpression },
          { title: '严重程度', value: report.clinicalAssessment.severity, description: report.diagnosticConclusion.severityInterpretation, tone: redFlags.length ? 'warning' : 'default' },
          { title: '治疗窗口', value: report.prognosisComparison.metrics[1]?.currentRisk || '需结合资料确认', description: report.prognosisComparison.positioning },
        ],
      },
      {
        type: 'table',
        title: '预后/决策参考对比',
        table: {
          columns: ['指标', '当前风险', '中国方案参考', '说明'],
          rows: report.prognosisComparison.metrics.map((item) => ({
            cells: [item.metric, item.currentRisk, item.chinaReference, item.note],
          })),
        },
      },
      {
        type: 'cards',
        title: '资料缺口与关键问题',
        cards: [
          { title: '关键发现', description: report.clinicalAssessment.keyFindings.slice(0, 4).join('；') },
          { title: '需补充材料', description: missingMaterials.join('；') || '当前资料基础较好，仍需医生复核原始文件。' },
          { title: '关键决策问题', description: decisionQuestions.join('；') },
          { title: '风险信号', description: redFlags.length ? redFlags.join('；') : '当前资料未显示明确急症信号，仍需医生确认。', tone: redFlags.length ? 'danger' : 'default' },
        ],
      },
    ]),
    makeTab('treatment', '按专业报告路径呈现，强调先复核资料再确认治疗。', [
      {
        type: 'notice',
        title: '治疗总目标',
        description: report.treatmentPathway.goal,
        tone: 'highlight',
      },
      {
        type: 'timeline',
        title: '治疗路径阶段',
        timeline: report.treatmentPathway.phases.map((phase) => ({
          time: phase.timeline,
          title: phase.phase,
          description: `阶段输出：${phase.output}`,
          items: phase.actions,
        })),
      },
    ]),
    makeTab('cost', '拆分核心医疗、配套服务和在华生活费用，形成可核对的三类费用结构。', [
      {
        type: 'notice',
        title: '费用说明',
        description: report.costBreakdown.currencyNote,
        items: [report.costBreakdown.volatilityNote],
        tone: 'warning',
      },
      {
        type: 'table',
        title: report.costBreakdown.medical.title,
        table: {
          columns: ['项目', '费用', '说明'],
          rows: report.costBreakdown.medical.items.map((item) => ({ cells: [item.item, item.cost, item.note] })),
        },
      },
      {
        type: 'table',
        title: report.costBreakdown.services.title,
        table: {
          columns: ['项目', '费用', '说明'],
          rows: report.costBreakdown.services.items.map((item) => ({ cells: [item.item, item.cost, item.note] })),
        },
      },
      {
        type: 'table',
        title: report.costBreakdown.living.title,
        table: {
          columns: ['项目', '费用', '说明'],
          rows: report.costBreakdown.living.items.map((item) => ({ cells: [item.item, item.cost, item.note] })),
        },
      },
      {
        type: 'summary',
        title: '全流程综合总费用',
        metrics: [{ label: '综合预估总费用', value: report.costBreakdown.grandTotal, detail: report.costBreakdown.volatilityNote, tone: 'highlight' }],
      },
    ]),
    makeTab('advanced', '根据病种和资料状态推荐可能相关的中国前沿技术、药物或服务能力。', [
      {
        type: 'cards',
        title: '前沿技术/服务优势',
        cards: report.technologyAdvantages.map((item) => ({
          title: item.technology,
          description: item.value,
          detail: item.applicability,
        })),
      },
      {
        type: 'list',
        title: '相关技术与服务要点',
        items: documentKnowledge
          .filter((item) => ['equipment', 'disease', 'service', 'medical_safety'].includes(item.category))
          .slice(0, 5)
          .map((item) => item.guidance.slice(0, 140)),
      },
    ]),
    makeTab('comparison', '按用户选择地区、病种和资料完整度生成多国家/地区诊疗方案对比。', [
      {
        type: 'table',
        title: '国家诊疗方案对比',
        table: {
          columns: ['国家/地区', '费用', '等待', '优势', '限制', '匹配度'],
          rows: report.countryComparison.map((item) => ({
            cells: [`${item.flag} ${item.country}`, item.cost, item.waitTime, item.strengths, item.limitations, `${item.fitScore}/100`],
            highlight: Boolean(item.recommended),
          })),
        },
      },
    ]),
    makeTab('itinerary', '根据当前病种、紧急程度和治疗周期生成可执行来华时间线。', [
      {
        type: 'timeline',
        title: '来华行程规划',
        timeline: report.itinerary.map((item) => ({
          time: item.dayRange,
          title: item.stage,
          items: item.tasks,
        })),
      },
    ]),
    makeTab('similarCases', '展示可合规解释的相似案例匹配框架，不编造真实患者故事。', [
      {
        type: 'cards',
        title: '相似患者案例匹配',
        description: '正式案例展示需要可核验来源或患者授权；当前阶段展示匹配口径和后续人工复核方式。',
        cards: similarCaseCards,
      },
    ]),
    makeTab('topDoctors', '展示专家匹配画像和核验要求，未接入医生排班前不编造医生身份。', [
      {
        type: 'cards',
        title: '专家推荐 Top10 画像',
        description: '不编造医生姓名。进入正式预审后需由医院/合作平台核验医生、排班、号源和擅长方向。',
        cards: doctorProfiles,
      },
    ]),
    makeTab('service', '展示专业版专属服务包、支付保险协助和跨境执行支持。', [
      {
        type: 'cards',
        title: '专属服务包',
        cards: report.servicePlan.map((item) => ({
          title: item.service,
          description: item.value,
        })),
      },
      {
        type: 'list',
        title: '支付与保险保障',
        items: report.paymentAndInsurance,
      },
    ]),
    makeTab('risk', '用审慎方式表达风险与预后参考，不承诺疗效。', [
      {
        type: 'list',
        title: '诊疗与跨境风险提示',
        items: report.risksAndDisclaimers,
      },
      {
        type: 'notice',
        title: '预后参考结论',
        description: report.prognosisComparison.conclusion,
        tone: 'warning',
      },
    ]),
    makeTab('hospitals', isDental ? `牙科方向仅推荐${dentalPartner.name}，不扩展为其他口腔医院名单。` : '基于当前疾病方向、资料完整度和预审问题推荐医院。', [
      {
        type: 'cards',
        title: isDental ? '推荐牙科品牌/机构' : '推荐医院 Top 3',
        cards: report.hospitalRecommendations.map((item, index) => ({
          title: item.hospital,
          subtitle: `${item.city} · ${item.department}`,
          value: `匹配度 ${item.matchScore}/100`,
          description: item.whyFit,
          detail: item.preparation,
          tag: `#${index + 1}`,
          tone: index === 0 ? 'highlight' : 'default',
        })),
      },
    ]),
    makeTab('next', '把专业报告转化为下一步可执行流程。', [
      {
        type: 'timeline',
        title: '就诊流程',
        timeline: report.nextSteps.map((step, index) => ({
          time: `Step ${index + 1}`,
          title: step,
        })),
      },
      {
        type: 'list',
        title: '质量提示',
        items: report.qualityFlags.length ? report.qualityFlags : ['本报告已通过基础结构校验，仍需医生复核后形成正式治疗方案。'],
      },
    ]),
  ]
}

const withProfessionalTabs = (report: ProfessionalReport, context: ProfessionalContext): ProfessionalReport => professionalReportSchema.parse(cleanReport({
  ...report,
  tabs: buildProfessionalTabs(report, context),
}))

const buildContext = (input: ProfessionalReportSubmissionInput, submissionNo: string): ProfessionalContext => {
  const match = resolveDisease(input)
  const missingMaterials = getMissingMaterials(input, match.key)
  const decisionQuestions = decisionQuestionMap[match.key] || decisionQuestionMap.other
  const redFlags = getRedFlags(input, match.key)
  const medicalFacts = collectMedicalFactBundle(input.parsedFiles)

  return {
    submissionNo,
    dateLabel: getDateLabel(),
    input,
    diseaseKey: match.key,
    disease: match.disease,
    selectedRegions: getSelectedRegions(input.preferences.selectedRegions),
    dataCompleteness: getDataCompleteness(input),
    missingMaterials,
    decisionQuestions,
    redFlags,
    documentKnowledge: getKnowledgeForProfessionalReport(input, match.key),
    medicalFacts,
  }
}

const limitText = (value: string | undefined, maxLength = 360) => {
  const text = String(value || '').replace(/\s+/g, ' ').trim()
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text
}

const compactRuleReportForPrompt = (report: ProfessionalReport) => ({
  title: report.title,
  patientSnapshot: {
    primaryNeed: limitText(report.patientSnapshot.primaryNeed, 260),
    diagnosisStatus: report.patientSnapshot.diagnosisStatus,
    dataCompleteness: report.patientSnapshot.dataCompleteness,
  },
  executiveSummary: report.executiveSummary.map((item) => limitText(item, 240)).slice(0, 4),
  diagnosticConclusion: {
    finalImpression: limitText(report.diagnosticConclusion.finalImpression, 260),
    severityInterpretation: limitText(report.diagnosticConclusion.severityInterpretation, 260),
    indicatorInterpretations: report.diagnosticConclusion.indicatorInterpretations.slice(0, 5),
  },
  clinicalAssessment: {
    workingDiagnosis: report.clinicalAssessment.workingDiagnosis,
    severity: report.clinicalAssessment.severity,
    keyFindings: report.clinicalAssessment.keyFindings.map((item) => limitText(item, 220)).slice(0, 6),
    redFlags: report.clinicalAssessment.redFlags,
    missingMaterials: report.clinicalAssessment.missingMaterials,
    decisionQuestions: report.clinicalAssessment.decisionQuestions,
  },
  treatmentPathway: {
    goal: limitText(report.treatmentPathway.goal, 260),
    phases: report.treatmentPathway.phases.map((phase) => ({
      phase: phase.phase,
      timeline: phase.timeline,
      actions: phase.actions.map((item) => limitText(item, 120)).slice(0, 3),
      output: limitText(phase.output, 140),
    })),
  },
  costBreakdown: report.costBreakdown,
  countryComparison: report.countryComparison.slice(0, 6),
  hospitalRecommendations: report.hospitalRecommendations,
  itinerary: report.itinerary,
  servicePlan: report.servicePlan,
})

const compactInputForPrompt = (input: ProfessionalReportSubmissionInput) => ({
  locale: input.locale,
  patient: input.patient,
  medical: {
    ...input.medical,
    chiefComplaint: limitText(input.medical.chiefComplaint, 800),
    pathologySummary: limitText(input.medical.pathologySummary, 900),
    imagingSummary: limitText(input.medical.imagingSummary, 900),
    geneticSummary: limitText(input.medical.geneticSummary, 700),
    treatmentHistory: limitText(input.medical.treatmentHistory, 700),
    medicationHistory: limitText(input.medical.medicationHistory, 360),
    comorbidities: limitText(input.medical.comorbidities, 360),
    allergyHistory: limitText(input.medical.allergyHistory, 240),
  },
  preferences: input.preferences,
  uploadedFiles: input.uploadedFiles.map((file) => ({
    originalName: file.originalName,
    mimeType: file.mimeType,
    size: file.size,
  })),
  parsedFiles: input.parsedFiles.map((file) => ({
    originalName: file.originalName,
    status: file.status,
    parser: file.parser,
    summary: limitText(file.summary || file.error, 420),
    textExcerpt: limitText(file.text, 900),
    metadata: file.metadata,
  })),
})

const buildPrompt = (context: ProfessionalContext, ruleReport: ProfessionalReport) => {
  const { input, disease, diseaseKey, selectedRegions, dataCompleteness, missingMaterials, decisionQuestions, redFlags, submissionNo, dateLabel, documentKnowledge } = context

  return [
    {
      role: 'system',
      content: [
        '你是寰宇云医的专业版来华就医报告生成助手，服务对象是外籍患者和家属。',
        '你必须生成专业、审慎、可执行的中文结构化报告，不要口语化安抚，不要营销夸大。',
        '严格基于用户资料、上传文件清单、规则基线和给定知识摘要；缺资料就列为缺失材料，不得编造病理、影像、基因检测、医生姓名、案例或疗效数据。',
        '不要把科室标签等同于诊断；未确诊时使用“工作方向/需确认”。',
        '费用必须拆为三类：核心医疗费用、专属配套增值服务费用、外籍在华生活刚需费用，并说明波动原因。',
        '费用币种、总价和三类费用结构必须沿用规则基线；不要擅自把人民币改成美元或把美元改成人民币。',
        '报告必须回应用户填写的具体主诉、诊断、病理、影像、基因和既往治疗内容。',
        '如 uploaded/parsed 文件中有可用正文摘要，必须纳入病情判断和缺失材料判断；若解析失败或内容不足，必须如实说明。',
        '不要把 OCR 调试文本、患者姓名/ID、出生日期、Study Date、Accession No 或截断半句写入正式报告。',
        '内容要像医学资料解读：先说核心结论，再解释依据，再给可执行的下一步；不要只堆砌模板。',
        '如果存在急症风险，先提示当地处理，再谈跨境就医。',
        '输出必须是严格 JSON，不要 Markdown，不要解释。',
      ].join('\n'),
    },
    {
      role: 'user',
      content: JSON.stringify({
        task: '生成专业版来华就医评估报告 JSON',
        fixedFields: { id: submissionNo, date: dateLabel, generatedBy: 'llm' },
        referenceRulesFromProvidedDocs: [
          '报告动线：患者概况 -> 病情诊断/判断 -> 关键决策问题 -> 中国治疗路径 -> 三级费用 -> 全球国家对比 -> 医院推荐 -> 来华行程 -> 服务包 -> 风险披露 -> 下一步行动。',
          '专业版必须比免费版更像医生/国际医疗顾问给出的资料预审，不要泛泛而谈。',
          '费用需透明说明波动，不能承诺固定价格，不能隐藏服务费。',
          '医院推荐要说明为何匹配当前病情和资料状态。',
          diseaseKey === 'dental' ? `牙科方向只推荐${dentalPartner.name}；种植患者可加入${dentalSimulationPlan.service}，但必须说明需CBCT/口腔影像和医生面诊确认。` : '',
          '用户上传资料解析成功时，可以使用 parsedFiles 摘要和正文片段；解析失败、格式不支持或内容不足时，只能说明需要人工复核，不能假装读到内容。',
        ].filter(Boolean),
        outputSchemaDescription: {
          id: 'string',
          date: 'string',
          title: 'string',
          subtitle: 'string',
          patientSnapshot: 'patient/profile/primaryNeed/diagnosisStatus/dataCompleteness/uploadedFiles/parsedFiles',
          executiveSummary: ['string'],
          diagnosticConclusion: 'finalImpression/severityInterpretation/indicatorInterpretations/evidenceBasis',
          clinicalAssessment: 'workingDiagnosis/severity/keyFindings/redFlags/missingMaterials/decisionQuestions',
          treatmentPathway: 'goal + phases[]',
          prognosisComparison: 'positioning + metrics[] + conclusion',
          technologyAdvantages: ['technology/value/applicability'],
          costBreakdown: 'currencyNote + medical/services/living/grandTotal/volatilityNote',
          countryComparison: ['flag/country/cost/waitTime/strengths/limitations/fitScore/recommended'],
          hospitalRecommendations: ['city/hospital/department/whyFit/preparation/matchScore'],
          itinerary: ['dayRange/stage/tasks'],
          servicePlan: ['service/value'],
          paymentAndInsurance: ['string'],
          risksAndDisclaimers: ['string'],
          nextSteps: ['string'],
          qualityFlags: ['string'],
          generatedBy: '"llm"',
        },
        patientInput: compactInputForPrompt(input),
        matchedKnowledge: {
          diseaseKey,
          disease,
          selectedRegions,
          dataCompleteness,
          missingMaterials,
          decisionQuestions,
          redFlags,
          dentalPartner: diseaseKey === 'dental' ? dentalPartner : undefined,
          dentalSimulationPlan: diseaseKey === 'dental' ? dentalSimulationPlan : undefined,
          parsedFiles: input.parsedFiles.map((file) => ({
            file: file.originalName,
            status: file.status,
            parser: file.parser,
            summary: file.summary,
            textExcerpt: limitText(file.text, 900),
            metadata: file.metadata,
            error: file.error,
          })),
          structuredMedicalFacts: {
            summary: context.medicalFacts.summary,
            diseaseSignals: context.medicalFacts.diseaseSignals,
            qualityFlags: context.medicalFacts.qualityFlags,
            timeline: context.medicalFacts.timeline.slice(0, 12),
            documents: context.medicalFacts.documents.map((document) => ({
              fileName: document.fileName,
              reportType: document.reportType,
              primaryDate: document.primaryDate,
              diagnoses: document.diagnoses.slice(0, 4),
              indicators: document.indicators.slice(0, 8),
              metastasisSignals: document.metastasisSignals,
              evidence: document.sourceEvidence.slice(0, 6),
              confidence: document.confidence,
            })).slice(0, 10),
          },
          documentKnowledge: documentKnowledge.map((block) => ({
            category: block.category,
            diseaseKeys: block.diseaseKeys,
            guidance: limitText(block.guidance, 260),
            evidenceSummary: limitText(block.evidenceSummary, 260),
            keywords: block.keywords.slice(0, 10),
          })).slice(0, 6),
        },
        documentKnowledgeUsageRules: [
          'documentKnowledge 是从用户提供资料整理后的专业要点，只能作为依据和质量约束。',
          '不得逐句复制 evidenceSummary 或把示例病例套到当前患者身上。',
          '仅使用与当前 diseaseKey、主诉、上传资料匹配的知识块。',
          '涉及费用、医院、保险、预后和设备时必须保持“参考/预估/需确认”，不得承诺疗效或报销。',
        ],
        baselineRuleReport: compactRuleReportForPrompt(ruleReport),
        qualityChecklist: [
          '至少回应用户主诉中的两个具体点。',
          '明确资料完整度和缺失材料。',
          '治疗路径必须先评估再治疗。',
          '上传资料解读必须说明：当前最关键结论、证据依据、需要马上确认的问题和下一步动作。',
          '报告排版内容应达到专业完整版标准：核心诊断解读、病情评估、中国治疗路径、费用、技术优势、国家对比、行程服务、风险和下一步都要完整。',
          '费用三分类完整。',
          diseaseKey === 'dental' ? `牙科不得推荐${['北大口腔', '上海九院', '中大口腔'].join('、')}等其他机构；不得把半口种植价格相加成总价。` : '',
          `不得出现“${forbiddenFeeQualifier}”。`,
          '不得生成未提供依据的治愈率或具体医生承诺。',
        ].filter(Boolean),
      }),
    },
  ]
}

type ProfessionalReportPatch = Partial<Record<keyof ProfessionalReport, unknown>>

const buildPatchPrompt = (context: ProfessionalContext, ruleReport: ProfessionalReport) => {
  const { input, disease, diseaseKey, selectedRegions, dataCompleteness, missingMaterials, decisionQuestions, redFlags, submissionNo, dateLabel, documentKnowledge } = context

  return [
    {
      role: 'system',
      content: [
        '你是寰宇云医专业版报告的医学内容增强助手。',
        '系统已经有一份完整规则基线报告；你只需要输出用于增强专业性的 JSON patch，不要输出完整报告。',
        '必须严格贴合患者科室、诊断、主诉、病理、影像、基因和既往治疗资料。',
        '不得编造未提交的检查结果、医生姓名、疗效承诺、治愈率或保险报销结论。',
        '缺资料要明确列为缺失材料；急症风险要先建议当地处理。',
        '不要输出 OCR 调试文本、患者姓名/ID、出生日期、Study Date、Accession No 或截断半句。',
        '增强方向是医学解读和可执行下一步：核心结论、证据依据、治疗目标、资料缺口、风险优先级。',
        '输出必须是严格 JSON，不要 Markdown，不要解释。',
      ].join('\n'),
    },
    {
      role: 'user',
      content: JSON.stringify({
        task: '生成专业版报告增强字段 JSON patch',
        fixedFields: { id: submissionNo, date: dateLabel, generatedBy: 'llm' },
        allowedPatchFields: [
          'executiveSummary',
          'diagnosticConclusion',
          'clinicalAssessment',
          'nextSteps',
        ],
        outputRequirements: {
          executiveSummary: '5条以内，必须回应具体主诉、分期/指标、来华价值、治疗目标和资料缺口',
          diagnosticConclusion: 'finalImpression/severityInterpretation/indicatorInterpretations/evidenceBasis；指标解释不超过4项',
          clinicalAssessment: 'workingDiagnosis/severity/keyFindings/redFlags/missingMaterials/decisionQuestions；每个数组最多5项',
          nextSteps: '4-5条可执行动作，按优先级排序',
        },
        patientInput: compactInputForPrompt(input),
        matchedKnowledge: {
          diseaseKey,
          disease: {
            label: disease.label,
            treatment: disease.treatment,
            direction: disease.direction,
            duration: disease.duration,
            advantages: disease.advantages,
          },
          selectedRegions,
          dataCompleteness,
          missingMaterials,
          decisionQuestions,
          redFlags,
          dentalPartner: diseaseKey === 'dental' ? dentalPartner : undefined,
          documentKnowledge: documentKnowledge.map((block) => ({
            category: block.category,
            guidance: limitText(block.guidance, 160),
            keywords: block.keywords.slice(0, 6),
          })).slice(0, 3),
          structuredMedicalFacts: {
            summary: context.medicalFacts.summary,
            diseaseSignals: context.medicalFacts.diseaseSignals,
            qualityFlags: context.medicalFacts.qualityFlags,
            timeline: context.medicalFacts.timeline.slice(0, 10),
            documents: context.medicalFacts.documents.map((document) => ({
              fileName: document.fileName,
              reportType: document.reportType,
              primaryDate: document.primaryDate,
              diagnoses: document.diagnoses.slice(0, 4),
              indicators: document.indicators.slice(0, 8),
              metastasisSignals: document.metastasisSignals,
              evidence: document.sourceEvidence.slice(0, 6),
              confidence: document.confidence,
            })).slice(0, 8),
          },
        },
        baselineRuleReport: {
          patientSnapshot: compactRuleReportForPrompt(ruleReport).patientSnapshot,
          diagnosticConclusion: compactRuleReportForPrompt(ruleReport).diagnosticConclusion,
          clinicalAssessment: compactRuleReportForPrompt(ruleReport).clinicalAssessment,
          executiveSummary: compactRuleReportForPrompt(ruleReport).executiveSummary,
          nextSteps: ruleReport.nextSteps.slice(0, 5),
        },
        qualityRules: [
          '只使用当前患者事实和专业资料要点，不复制模板段落。',
          '科室和症状不一致时必须指出需要重新分诊；不能强行套用科室。',
          '正式报告证据只能保留临床结论、指标、影像部位、检查日期和治疗史，不要保留患者身份或识别器摘要。',
          '费用字段已有规则基线，本 patch 不需要改费用。',
          '医院和国家对比字段已有规则基线，本 patch 不需要改医院和国家对比。',
          diseaseKey === 'dental' ? `牙科仅围绕${dentalPartner.name}和患者口腔资料增强诊断/下一步，不要新增其他口腔医院。` : '',
          `不得出现“${forbiddenFeeQualifier}”。`,
        ].filter(Boolean),
      }),
    },
  ]
}

const extractJson = (content: string) => {
  const trimmed = content.trim()
  if (trimmed.startsWith('{')) return trimmed
  const match = trimmed.match(/\{[\s\S]*\}/)
  return match ? match[0] : trimmed
}

const readChatCompletionContent = async (response: Response) => {
  const contentType = response.headers.get('content-type') || ''

  if (contentType.includes('application/json')) {
    const json = await response.json() as { choices?: Array<{ message?: { content?: string } }> }
    const content = json.choices?.[0]?.message?.content
    if (!content) throw new Error('LLM response did not include content')
    return content
  }

  if (!response.body) throw new Error('LLM response did not include a readable body')

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let content = ''

  for (;;) {
    const { done, value } = await reader.read()
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done })
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() || ''

    for (const rawLine of lines) {
      const line = rawLine.trim()
      if (!line || !line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (!data || data === '[DONE]') continue

      try {
        const chunk = JSON.parse(data) as {
          choices?: Array<{
            delta?: { content?: string }
            message?: { content?: string }
          }>
        }
        content += chunk.choices?.[0]?.delta?.content || chunk.choices?.[0]?.message?.content || ''
      } catch {
        // Ignore non-JSON stream keepalive frames from compatible gateways.
      }
    }

    if (done) break
  }

  if (!content.trim()) throw new Error('LLM stream did not include content')
  return content
}

const callLlm = async (context: ProfessionalContext, ruleReport: ProfessionalReport) => {
  if (!config.openaiApiKey) return null

  const response = await fetch(`${config.openaiBaseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.openaiApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: config.openaiModel,
      messages: buildPrompt(context, ruleReport),
      temperature: 0.25,
      reasoning_effort: 'low',
      response_format: { type: 'json_object' },
      stream: true,
    }),
    signal: AbortSignal.timeout(config.openaiReportTimeoutMs),
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`LLM request failed: ${response.status} ${body.slice(0, 500)}`)
  }

  const content = await readChatCompletionContent(response)
  return professionalReportSchema.parse(JSON.parse(extractJson(content)))
}

const callLlmPatch = async (context: ProfessionalContext, ruleReport: ProfessionalReport): Promise<ProfessionalReportPatch | null> => {
  if (!config.openaiApiKey) return null

  const body = JSON.stringify({
    model: config.openaiModel,
    messages: buildPatchPrompt(context, ruleReport),
    temperature: 0.2,
    reasoning_effort: 'low',
    response_format: { type: 'json_object' },
    stream: true,
  })

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await fetch(`${config.openaiBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.openaiApiKey}`,
        'Content-Type': 'application/json',
      },
      body,
      signal: AbortSignal.timeout(Math.min(config.openaiReportTimeoutMs, 120000)),
    })

    if (!response.ok) {
      const responseBody = await response.text()
      if (attempt === 0 && [408, 429, 500, 502, 503, 504].includes(response.status)) continue
      throw new Error(`LLM patch request failed: ${response.status} ${responseBody.slice(0, 500)}`)
    }

    let parsed: unknown
    try {
      const content = await readChatCompletionContent(response)
      parsed = JSON.parse(extractJson(content)) as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('LLM patch response was not a JSON object')
      }
    } catch (error) {
      if (attempt === 0) continue
      throw error
    }

    if (process.env.DEBUG_REPORT_LLM === '1') {
      console.warn(`[Professional report LLM patch] ${JSON.stringify(parsed).slice(0, 2000)}`)
    }

    return parsed as ProfessionalReportPatch
  }

  return null
}

const nonEmptyArray = <T>(value: T[] | undefined) => (Array.isArray(value) && value.length ? value : undefined)

const getValidPatchValue = <K extends keyof ProfessionalReport>(
  key: K,
  value: unknown,
  fallback: ProfessionalReport[K],
): ProfessionalReport[K] => {
  if (value === undefined) return fallback

  const schema = professionalReportSchema.shape[key]
  const result = schema.safeParse(value)
  return result.success ? result.data as ProfessionalReport[K] : fallback
}

const getValidatedPatchValue = <K extends keyof ProfessionalReport>(
  key: K,
  value: unknown,
  fallback: ProfessionalReport[K],
) => {
  if (value === undefined) return { value: fallback, applied: false, invalid: false }

  const schema = professionalReportSchema.shape[key]
  const result = schema.safeParse(value)
  return result.success
    ? { value: result.data as ProfessionalReport[K], applied: true, invalid: false }
    : { value: fallback, applied: false, invalid: true }
}

const asObject = (value: unknown) => (
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
)

const mergeLlmPatch = (
  patch: ProfessionalReportPatch,
  context: ProfessionalContext,
  ruleReport: ProfessionalReport,
) => {
  const appliedSections: string[] = []
  const invalidSections: string[] = []

  const applyPatchValue = <K extends keyof ProfessionalReport>(
    key: K,
    value: unknown,
    fallback: ProfessionalReport[K],
    label: string,
  ) => {
    const result = getValidatedPatchValue(key, value, fallback)
    if (result.applied) appliedSections.push(label)
    if (result.invalid) invalidSections.push(label)
    return result.value
  }

  const clinicalPatch = asObject(patch.clinicalAssessment)
  const clinicalAssessmentDraft = clinicalPatch ? {
    ...ruleReport.clinicalAssessment,
    ...clinicalPatch,
    keyFindings: nonEmptyArray(clinicalPatch.keyFindings as string[] | undefined) || ruleReport.clinicalAssessment.keyFindings,
    redFlags: (clinicalPatch.redFlags as string[] | undefined) || ruleReport.clinicalAssessment.redFlags,
    missingMaterials: nonEmptyArray(clinicalPatch.missingMaterials as string[] | undefined) || ruleReport.clinicalAssessment.missingMaterials,
    decisionQuestions: nonEmptyArray(clinicalPatch.decisionQuestions as string[] | undefined) || ruleReport.clinicalAssessment.decisionQuestions,
  } : ruleReport.clinicalAssessment
  const clinicalAssessment = applyPatchValue('clinicalAssessment', clinicalPatch ? clinicalAssessmentDraft : undefined, ruleReport.clinicalAssessment, '病情评估')

  const diagnosticPatch = asObject(patch.diagnosticConclusion)
  const diagnosticConclusionDraft = diagnosticPatch ? {
    ...ruleReport.diagnosticConclusion,
    ...diagnosticPatch,
    indicatorInterpretations: nonEmptyArray(diagnosticPatch.indicatorInterpretations as ProfessionalReport['diagnosticConclusion']['indicatorInterpretations'] | undefined) || ruleReport.diagnosticConclusion.indicatorInterpretations,
    evidenceBasis: nonEmptyArray(diagnosticPatch.evidenceBasis as string[] | undefined) || ruleReport.diagnosticConclusion.evidenceBasis,
  } : ruleReport.diagnosticConclusion
  const diagnosticConclusion = applyPatchValue('diagnosticConclusion', diagnosticPatch ? diagnosticConclusionDraft : undefined, ruleReport.diagnosticConclusion, '诊断解读')

  const assembledReport = professionalReportSchema.parse(cleanReport({
    ...ruleReport,
    executiveSummary: applyPatchValue('executiveSummary', patch.executiveSummary, ruleReport.executiveSummary, '核心摘要'),
    diagnosticConclusion,
    clinicalAssessment,
    treatmentPathway: applyPatchValue('treatmentPathway', patch.treatmentPathway, ruleReport.treatmentPathway, '治疗路径'),
    prognosisComparison: applyPatchValue('prognosisComparison', patch.prognosisComparison, ruleReport.prognosisComparison, '预后对比'),
    technologyAdvantages: applyPatchValue('technologyAdvantages', patch.technologyAdvantages, ruleReport.technologyAdvantages, '技术优势'),
    paymentAndInsurance: applyPatchValue('paymentAndInsurance', patch.paymentAndInsurance, ruleReport.paymentAndInsurance, '支付保险'),
    risksAndDisclaimers: applyPatchValue('risksAndDisclaimers', patch.risksAndDisclaimers, ruleReport.risksAndDisclaimers, '风险提示'),
    nextSteps: applyPatchValue('nextSteps', patch.nextSteps, ruleReport.nextSteps, '下一步'),
    id: context.submissionNo,
    date: context.dateLabel,
    patientSnapshot: ruleReport.patientSnapshot,
    costBreakdown: ruleReport.costBreakdown,
    countryComparison: ruleReport.countryComparison,
    hospitalRecommendations: ruleReport.hospitalRecommendations,
    itinerary: ruleReport.itinerary,
    servicePlan: ruleReport.servicePlan,
    qualityFlags: [
      ...ruleReport.qualityFlags,
      invalidSections.length ? `部分AI增强内容未通过结构校验，相关章节已保留安全基线：${invalidSections.join('、')}。` : '',
    ].filter(Boolean),
    generatedBy: appliedSections.length ? 'llm' : 'rules',
  }))

  return enforceGuardrails(assembledReport, context, ruleReport)
}

const enforceGuardrails = (report: ProfessionalReport, context: ProfessionalContext, ruleReport: ProfessionalReport) => {
  const baseReport = context.diseaseKey === 'dental'
    ? {
      ...report,
      costBreakdown: ruleReport.costBreakdown,
      countryComparison: ruleReport.countryComparison,
      hospitalRecommendations: ruleReport.hospitalRecommendations,
      itinerary: ruleReport.itinerary,
      servicePlan: ruleReport.servicePlan,
      treatmentPathway: {
        ...report.treatmentPathway,
        phases: ruleReport.treatmentPathway.phases,
      },
      technologyAdvantages: ruleReport.technologyAdvantages,
      paymentAndInsurance: unique([
        ...report.paymentAndInsurance,
        dentalCostCurrencyNote,
      ]),
      risksAndDisclaimers: unique([
        ...report.risksAndDisclaimers,
        '牙科种植、贴面或修复路径需由鼎植口腔结合CBCT、牙周、咬合和材料选择确认；资料价格不等于最终固定报价。',
      ]),
    }
    : report

  const cleaned = cleanReport({
    ...baseReport,
    id: context.submissionNo,
    date: context.dateLabel,
    patientSnapshot: {
      ...report.patientSnapshot,
      uploadedFiles: context.input.uploadedFiles.map((file) => file.originalName),
      parsedFiles: context.input.parsedFiles.map((file) => ({
        file: file.originalName,
        status: file.status,
        summary: summarizeParsedFileForDisplay(file),
      })),
      dataCompleteness: context.dataCompleteness,
    },
    generatedBy: baseReport.generatedBy,
  })

  if (context.input.uploadedFiles.length === 0 && JSON.stringify(cleaned).includes('已读取上传')) {
    return ruleReport
  }

  if (context.dataCompleteness < 45 && cleaned.clinicalAssessment.missingMaterials.length < 2) {
    return ruleReport
  }

  if (!isLlmReportAlignedWithStructuredFacts(cleaned, context)) {
    return ruleReport
  }

  return cleaned
}

export const generateProfessionalReport = async (
  input: ProfessionalReportSubmissionInput,
  submissionNo: string,
): Promise<ProfessionalReport> => {
  const context = buildContext(input, submissionNo)
  const ruleReport = cleanReport(buildRuleReport(context))

  try {
    const llmPatch = await callLlmPatch(context, ruleReport)
    const patchedReport = llmPatch ? mergeLlmPatch(llmPatch, context, ruleReport) : ruleReport
    if (patchedReport.generatedBy === 'llm') {
      return sanitizeReportText(withProfessionalTabs(patchedReport, context))
    }
    return sanitizeReportText(withProfessionalTabs(ruleReport, context))
  } catch (error) {
    const message = error instanceof Error ? error.message.replace(/sk-[A-Za-z0-9_*.-]+/g, 'sk-***') : String(error)
    console.warn(`Professional report LLM generation failed, using rule fallback: ${message.slice(0, 240)}`)
    return sanitizeReportText(withProfessionalTabs(ruleReport, context))
  }
}
