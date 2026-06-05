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

const buildDiagnosticConclusion = (context: ProfessionalContext) => {
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
  const baseMetrics = diseaseKey === 'dental'
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
    positioning: `本节用于把“${disease.label}”相关风险、治疗窗口和中国方案价值进行结构化比较；不作为疗效承诺。`,
    metrics: baseMetrics,
    conclusion: `中国方案的核心价值不是简单替代当地治疗，而是在资料复核、专家预审、治疗路径排序、费用拆分和跨境服务执行上形成更清晰的决策闭环。`,
  }
}

const buildTechnologyAdvantages = (context: ProfessionalContext) => {
  const { diseaseKey } = context
  const map: Record<string, Array<{ technology: string; value: string; applicability: string }>> = {
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
  const medicalItems = dentalMedicalProfile?.items || disease.breakdown.filter((item) => !/翻译|陪诊|协调|住宿|生活/.test(item.item)).map((item) => ({
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

  const medicalTotal = dentalMedicalProfile
    ? parseUsdRange(dentalMedicalProfile.total)
    : sumRanges(medicalItems.map((item) => parseUsdRange(item.cost)))
  const serviceTotal = sumRanges(serviceItems.map((item) => parseUsdRange(item.cost)))
  const livingTotal = sumRanges(livingItems.map((item) => parseUsdRange(item.cost)))
  const grandTotal = sumRanges([medicalTotal, serviceTotal, livingTotal])

  return {
    currencyNote: diseaseKey === 'dental'
      ? dentalCostCurrencyNote
      : '费用为基于当前资料的预估区间，以美元为主并按 1 USD≈7.2 RMB 提供人民币参考；医院正式报价、药品选择、材料品牌和住院天数会影响最终金额。',
    medical: {
      title: '第一类：核心医疗费用',
      total: dentalMedicalProfile?.total || formatDualRange(medicalTotal, disease.chinaFee),
      items: medicalItems.length ? medicalItems.map((item) => ({
        item: item.item,
        cost: diseaseKey === 'dental' ? item.cost : formatDualRange(parseUsdRange(item.cost), item.cost),
        note: item.note,
      })) : [{ item: disease.treatment, cost: disease.chinaFee, note: '当前资料不足，先按专科评估和基础治疗区间估算' }],
    },
    services: {
      title: '第二类：专属配套增值服务费用',
      total: formatDualRange(serviceTotal, '$3,000-$8,500'),
      items: serviceItems.map((item) => ({ ...item, cost: formatDualRange(parseUsdRange(item.cost), item.cost) })),
    },
    living: {
      title: '第三类：外籍在华生活刚需费用',
      total: formatDualRange(livingTotal, '$2,450-$7,600'),
      items: livingItems.map((item) => ({ ...item, cost: formatDualRange(parseUsdRange(item.cost), item.cost) })),
    },
    grandTotal: diseaseKey === 'dental' ? formatCnyFirstRange(grandTotal, disease.chinaFee) : formatDualRange(grandTotal, disease.chinaFee),
    volatilityNote: '实际费用通常会因病情分期、检查补充、药物/材料选择、并发症处理和住院天数产生约±15-25%波动；超出预算前应由患者书面确认。',
  }
}

const buildRuleReport = (context: ProfessionalContext): ProfessionalReport => {
  const { input, disease, diseaseKey, selectedRegions, submissionNo, dateLabel, dataCompleteness, missingMaterials, decisionQuestions, redFlags, documentKnowledge } = context
  const patient = input.patient
  const medical = input.medical
  const diagnosisLabel = medical.diagnosis || disease.label
  const uploadedNames = input.uploadedFiles.map((file) => file.originalName)
  const parsedFileSummaries = input.parsedFiles.map((file) => ({
    file: file.originalName,
    status: file.status,
    summary: file.summary || file.error || '未提取到可用正文',
  }))
  const parsedEvidence = input.parsedFiles
    .filter((file) => file.summary.trim())
    .map((file) => `${file.originalName}：${file.summary}`)
    .slice(0, 4)
  const isDental = diseaseKey === 'dental'
  const dentalFlags = isDental ? getDentalCaseFlags(context) : null
  const dentalMedicalProfile = isDental ? buildDentalMedicalCostProfile(context) : null
  const chinaCost = dentalMedicalProfile?.total || disease.chinaFee
  const treatmentPhases = isDental
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
    !medical.diagnosis ? '用户未填写明确诊断，需先完成专科方向和诊断确认。' : '',
    ...redFlags,
  ].filter(Boolean)

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
      `本报告围绕“${medical.chiefComplaint.slice(0, 80)}”进行专业预审，当前最关键的是：${decisionQuestions[0] || '明确主责专科和治疗优先级'}。`,
      parsedEvidence.length ? `已纳入上传资料解析摘要：${parsedEvidence[0].slice(0, 120)}。` : '',
      documentKnowledge.length ? '已结合平台沉淀的医疗服务、费用、保险和跨境就医流程要点，并按当前病情重新组织。' : '',
      `中国方案的价值在于先完成资料复核、专家预审、费用拆分和行程可执行性评估，再决定是否启动跨境治疗。`,
      dataCompleteness >= 70 ? '当前资料基础较好，可进入医院/专家预审阶段。' : `当前仍建议补充：${missingMaterials.slice(0, 3).join('、')}。`,
    ].filter(Boolean),
    diagnosticConclusion: buildDiagnosticConclusion(context),
    clinicalAssessment: {
      workingDiagnosis: diagnosisLabel,
      severity: input.preferences.urgency === 'urgent' ? '需优先排除急性风险，再安排跨境评估' : '需结合补充资料进一步分层评估',
      keyFindings: [
        medical.stage ? `分期/严重程度信息：${medical.stage}` : '尚未提供明确分期或严重程度信息。',
        medical.pathologySummary ? `病理摘要：${medical.pathologySummary}` : '尚未提供病理摘要。',
        medical.imagingSummary ? `影像摘要：${medical.imagingSummary}` : '尚未提供影像摘要。',
        medical.treatmentHistory ? `既往治疗：${medical.treatmentHistory}` : '尚未提供既往治疗记录。',
        ...parsedEvidence.map((item) => `上传资料解析：${item}`),
        ...documentKnowledge.slice(0, 4).map((item) => item.guidance.slice(0, 120)),
      ],
      redFlags,
      missingMaterials,
      decisionQuestions,
    },
    treatmentPathway: {
      goal: `围绕${disease.label}方向，先确认诊断证据和治疗优先级，再制定在华评估、治疗和回国随访路径。`,
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
      '如存在急性疼痛、感染、神经功能恶化、胸痛、呼吸困难等风险信号，应先在当地就近处理。',
      '最终治疗方案以中国执业医生面诊、医院正式检查结果和患者签字确认文件为准。',
    ],
    nextSteps: [
      `补充${missingMaterials.slice(0, 3).join('、') || '完整病历资料'}。`,
      '确认预算、保险预授权要求和期望来华城市。',
      '发起医院/专家预审，锁定首诊时间和资料清单。',
      '根据预审结果决定是否进入签证邀请函、机票住宿和治疗排期。'
    ],
    qualityFlags: dataFlags,
    generatedBy: 'rules',
  }
}

const professionalTabConfigs = [
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

  return [
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
        '可用美元为主，人民币仅作为按汇率估算的参考；最终以医院正式报价为准。',
        '报告必须回应用户填写的具体主诉、诊断、病理、影像、基因和既往治疗内容。',
        '如 uploaded/parsed 文件中有可用正文摘要，必须纳入病情判断和缺失材料判断；若解析失败或内容不足，必须如实说明。',
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
          executiveSummary: '4条以内，必须回应具体主诉、分期/指标、来华价值和资料缺口',
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
    signal: AbortSignal.timeout(config.openaiTimeoutMs),
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
      signal: AbortSignal.timeout(config.openaiTimeoutMs),
    })

    if (!response.ok) {
      const responseBody = await response.text()
      if (attempt === 0 && [408, 429, 500, 502, 503, 504].includes(response.status)) continue
      throw new Error(`LLM patch request failed: ${response.status} ${responseBody.slice(0, 500)}`)
    }

    const content = await readChatCompletionContent(response)
    const parsed = JSON.parse(extractJson(content)) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('LLM patch response was not a JSON object')
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

  const assembledReport = professionalReportSchema.parse(cleanReport({
    ...ruleReport,
    executiveSummary: applyPatchValue('executiveSummary', patch.executiveSummary, ruleReport.executiveSummary, '核心摘要'),
    diagnosticConclusion: applyPatchValue('diagnosticConclusion', patch.diagnosticConclusion, ruleReport.diagnosticConclusion, '诊断解读'),
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
        summary: file.summary || file.error || '未提取到可用正文',
      })),
      dataCompleteness: context.dataCompleteness,
    },
    generatedBy: 'llm',
  })

  if (context.input.uploadedFiles.length === 0 && JSON.stringify(cleaned).includes('已读取上传')) {
    return ruleReport
  }

  if (context.dataCompleteness < 45 && cleaned.clinicalAssessment.missingMaterials.length < 2) {
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
    return sanitizeReportText(withProfessionalTabs(llmPatch ? mergeLlmPatch(llmPatch, context, ruleReport) : ruleReport, context))
  } catch (error) {
    const message = error instanceof Error ? error.message.replace(/sk-[A-Za-z0-9_*.-]+/g, 'sk-***') : String(error)
    console.warn(`Professional report LLM generation failed, using rule fallback: ${message.slice(0, 240)}`)
    return sanitizeReportText(withProfessionalTabs(ruleReport, context))
  }
}
