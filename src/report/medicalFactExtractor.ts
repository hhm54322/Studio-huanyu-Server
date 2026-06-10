export type MedicalIndicatorFact = {
  name: string
  value: string
  evidence: string
  confidence: number
}

export type MedicalFindingFact = {
  category: 'diagnosis' | 'pathology' | 'imaging' | 'treatment' | 'laboratory' | 'metastasis' | 'risk' | 'other'
  text: string
  evidence: string
  confidence: number
}

export type MedicalMetastasisSignal = {
  site: string
  status: 'present' | 'suspected' | 'absent'
  evidence: string
  confidence: number
}

export type MedicalDocumentFact = {
  fileName: string
  parser: string
  documentCategory: 'patient_record' | 'institution_intro' | 'reference_material' | 'unknown'
  reportType: string
  dates: string[]
  primaryDate: string
  diagnoses: string[]
  indicators: MedicalIndicatorFact[]
  findings: MedicalFindingFact[]
  metastasisSignals: MedicalMetastasisSignal[]
  sourceEvidence: string[]
  confidence: number
}

export type MedicalTimelineEvent = {
  date: string
  fileName: string
  reportType: string
  title: string
  description: string
  items: string[]
  confidence: number
}

export type MedicalFactBundle = {
  documents: MedicalDocumentFact[]
  timeline: MedicalTimelineEvent[]
  summary: string
  evidenceHighlights: string[]
  diseaseSignals: string[]
  qualityFlags: string[]
  sourceTextLength: number
  hasActionableFacts: boolean
}

export type ParsedFileLike = {
  originalName: string
  parser: string
  status: string
  text: string
  summary: string
  metadata?: Record<string, unknown>
  error?: string
}

const normalizeText = (value: string) => String(value || '')
  .replace(/\u0000/g, '')
  .replace(/[ \t]+/g, ' ')
  .replace(/\n{3,}/g, '\n\n')
  .trim()

const compact = (value: string, length = 220) => {
  const text = normalizeText(value).replace(/\s+/g, ' ')
  return text.length > length ? `${text.slice(0, length)}...` : text
}

const unique = <T>(items: T[]) => Array.from(new Set(items.filter(Boolean)))

const normalizedForMatch = (text: string) => text.toLowerCase().replace(/\s+/g, '')

const includesAny = (text: string, keywords: string[]) => {
  const normalized = normalizedForMatch(text)
  return keywords.some((keyword) => normalized.includes(normalizedForMatch(keyword)))
}

const diseaseSignalLabels: Record<string, string> = {
  breast_cancer: '乳腺癌',
  lung_cancer: '肺癌',
  liver_cancer: '肝癌',
  nasopharyngeal_cancer: '鼻咽癌',
  neurosurgery: '神经外科/中枢神经系统',
  dental: '口腔/牙科',
  cardiology_cardiothoracic: '心血管/心胸外科',
}

const sentenceSplitPattern = /(?<=[。！？!?；;])\s+|\n+|(?<=\.)\s+(?=[A-Z(])/

const getSentences = (text: string) => normalizeText(text)
  .split(sentenceSplitPattern)
  .map((item) => compact(item, 360))
  .filter((item) => item.length >= 4)

const isNegatedSentence = (sentence: string) => {
  const normalized = normalizedForMatch(sentence)
  if (['不能排除', '不可排除', '不除外', 'cannotexclude', 'cannotruleout', 'notexcluded'].some((keyword) => (
    normalized.includes(normalizedForMatch(keyword))
  ))) return false

  if (/(^|[，,；;、。])无(?!法|需|须)/.test(normalized)) return true

  return [
    '未见',
    '未发现',
    '未查见',
    '没有',
    '无明显',
    '无转移',
    '排除',
    '不考虑',
    'noabnormal',
    'noother',
    'nofdg',
    'nofdgavid',
    'nofdg-avid',
    'notfdg',
    'notfdgavid',
    'noevidence',
    'negativefor',
    'without',
  ].some((keyword) => normalized.includes(normalizedForMatch(keyword)))
}

const datePatterns = [
  /((?:19|20)\d{2})\s*年\s*(1[0-2]|0?[1-9])\s*月\s*(3[01]|[12]\d|0?[1-9])\s*日?/g,
  /\b((?:19|20)\d{2})[-/.](1[0-2]|0?[1-9])[-/.](3[01]|[12]\d|0?[1-9])\b/g,
  /\b(3[01]|[12]\d|0?[1-9])\/(1[0-2]|0?[1-9])\/((?:19|20)\d{2})\b/g,
  /\b(3[01]|[12]\d|0?[1-9])\s*[-.]\s*(1[0-2]|0?[1-9])\s*[-.]\s*((?:19|20)\d{2})\b/g,
  /\b((?:19|20)\d{2})\s*(?:年|[-/.])\s*(1[0-2]|0?[1-9])\s*(?:月)?\b/g,
]

const normalizeDateMatch = (match: RegExpMatchArray) => {
  const raw = match[0]
  const dmy = raw.match(/\b(3[01]|[12]\d|0?[1-9])\D+(1[0-2]|0?[1-9])\D+((?:19|20)\d{2})\b/)
  if (dmy) return `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`
  const ymd = raw.match(/((?:19|20)\d{2})\D+(1[0-2]|0?[1-9])\D+(3[01]|[12]\d|0?[1-9])/)
  if (ymd) return `${ymd[1]}-${ymd[2].padStart(2, '0')}-${ymd[3].padStart(2, '0')}`
  const ym = raw.match(/((?:19|20)\d{2})\D+(1[0-2]|0?[1-9])\b/)
  if (ym) return `${ym[1]}-${ym[2].padStart(2, '0')}`
  return raw
}

const extractDates = (text: string) => {
  const dates: string[] = []
  for (const pattern of datePatterns) {
    for (const match of text.matchAll(pattern)) {
      const index = match.index || 0
      const nearby = text.slice(Math.max(0, index - 36), index + match[0].length + 12)
      if (includesAny(nearby, ['出生', 'date of birth', 'tanggal lahir', 'lahir', 'umur'])) continue
      dates.push(normalizeDateMatch(match))
    }
  }
  const deduped = unique(dates)
  return deduped
    .filter((date) => !deduped.some((other) => other !== date && other.startsWith(date) && other.length > date.length))
    .slice(0, 12)
}

const dateSortValue = (date: string) => {
  const normalized = date.length === 7 ? `${date}-01` : date
  const value = Date.parse(normalized)
  return Number.isFinite(value) ? value : 0
}

const detectReportType = (text: string) => {
  if (detectDocumentCategory(text) === 'institution_intro') return '机构/服务介绍资料'
  if (includesAny(text, ['PET/CT', 'PET CT', 'positron emission', 'hypermetabolic'])) return 'PET/CT全身扫描'
  if (includesAny(text, ['病理', '免疫组化', 'histopathology', 'pathology', 'biopsy', '活检'])) return '病理/免疫组化报告'
  if (includesAny(text, ['bone scan', '骨扫描', '骨显像'])) return '骨扫描/骨显像'
  if (includesAny(text, ['mammography', '钼靶', '乳腺x线'])) return '乳腺钼靶/影像报告'
  if (includesAny(text, ['CBCT', '口腔', '牙', 'implant', '龋'])) return '口腔/牙科资料'
  if (includesAny(text, ['MRI', '磁共振'])) return 'MRI影像报告'
  if (includesAny(text, ['CT', 'computed tomography'])) return 'CT影像报告'
  if (includesAny(text, ['超声', 'ultrasound', 'B超'])) return '超声报告'
  if (includesAny(text, ['基因', 'NGS', 'mutation', '突变', 'PD-L1'])) return '基因/分子检测报告'
  if (includesAny(text, ['血常规', '生化', 'AFP', 'CEA', 'CA15-3', 'CA125'])) return '实验室检查报告'
  if (includesAny(text, ['出院', '手术记录', 'discharge', 'operative'])) return '出院/手术记录'
  return '医学资料'
}

const detectDocumentCategory = (text: string): MedicalDocumentFact['documentCategory'] => {
  const normalized = normalizedForMatch(text)
  const hasPatientRecordMarkers = includesAny(text, [
    'patient name',
    'patient id',
    'study date',
    '检查所见',
    '检查结论',
    '诊断意见',
    '病理诊断',
    '免疫组化',
    '化验结果',
    '报告日期',
    '临床诊断',
  ])
  const hasPromotionalMarkers = includesAny(text, [
    '集团简介',
    '医生集团',
    'future healthcare service',
    '未来医疗服务平台',
    '中美合资企业',
    '连锁管理',
    '机构投资',
    '医学教育',
    '供应链',
    '品牌',
    '使命',
    '专利技术',
    '公司',
  ])
  const explicitNoPatientContent = [
    '未见患者姓名',
    '未见具体医学报告内容',
    '未见检查结果',
    '未见诊断',
    'not contain patient',
    'no patient',
  ].some((keyword) => normalized.includes(normalizedForMatch(keyword)))

  if ((hasPromotionalMarkers || explicitNoPatientContent) && !hasPatientRecordMarkers) return 'institution_intro'
  if (hasPatientRecordMarkers) return 'patient_record'
  if (includesAny(text, ['指南', '共识', '论文', '研究', '价格表', '服务包', '模板', '提示词'])) return 'reference_material'
  return 'unknown'
}

const indicatorSpecs: Array<{ name: string; labels: string[]; interpretationHint?: string }> = [
  { name: 'ER', labels: ['ER', '雌激素受体'] },
  { name: 'PR', labels: ['PR', '孕激素受体'] },
  { name: 'HER2', labels: ['HER2', 'Her-2'] },
  { name: 'Ki-67', labels: ['Ki-67', 'Ki67'] },
  { name: 'SUVmax', labels: ['SUVmax', 'SUV max'] },
  { name: 'BIRADS', labels: ['BI-RADS', 'BIRADS'] },
  { name: 'WHO分级', labels: ['WHO'] },
  { name: '组织学分级', labels: ['组织学分级', 'histological grade', 'grade'] },
  { name: 'PD-L1', labels: ['PD-L1', 'PDL1'] },
  { name: 'EGFR', labels: ['EGFR'] },
  { name: 'ALK', labels: ['ALK'] },
  { name: 'AFP', labels: ['AFP'] },
  { name: 'CEA', labels: ['CEA'] },
  { name: 'CA15-3', labels: ['CA15-3', 'CA153'] },
  { name: 'CA125', labels: ['CA125', 'CA-125'] },
]

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const indicatorValuePattern = /[:：]?\s*([+\-]?\s*(?:阳性|阴性|positive|negative|positif|negatif|强阳性|弱阳性|未扩增|扩增|野生型|突变型|[0-9]+(?:\.[0-9]+)?\s*%?(?:\s*[-~至]\s*[0-9]+(?:\.[0-9]+)?\s*%)?|[ⅠⅡⅢⅣIVX0-4]+\s*级?|[0-9]+(?:\.[0-9]+)?)(?:[，,、\s]*(?:强|弱|中等|strong|weak|moderate|kuat|SUVmax)?)?(?:\s*[（(][^)）]{0,40}[）)])?)/

const extractIndicators = (text: string, sentences: string[]) => {
  const indicators: MedicalIndicatorFact[] = []
  const addIndicator = (name: string, value: string, evidence: string, confidence = 0.78) => {
    const cleanValue = compact(
      value
        .replace(/[。；;\n].*$/, '')
        .replace(/^\/?\s*neu\s*[:：]?\s*/i, '')
        .replace(/^[）)\]】\s:：]+/, '')
        .replace(/[）)\]】]+$/, '')
        .replace(/[，,、\s]+$/, ''),
      80,
    )
    if (!cleanValue) return
    const existingIndex = indicators.findIndex((item) => item.name === name && (
      item.value === cleanValue ||
      item.value.includes(cleanValue) ||
      cleanValue.includes(item.value)
    ))
    if (existingIndex >= 0) {
      if (cleanValue.length > indicators[existingIndex].value.length || confidence > indicators[existingIndex].confidence) {
        indicators[existingIndex] = { name, value: cleanValue, evidence: compact(evidence, 240), confidence }
      }
      return
    }
    const sameNameIndex = indicators.findIndex((item) => item.name === name)
    if (sameNameIndex >= 0) {
      const current = indicators[sameNameIndex]
      if (confidence > current.confidence || cleanValue.length > current.value.length + 2) {
        indicators[sameNameIndex] = { name, value: cleanValue, evidence: compact(evidence, 240), confidence }
      }
      return
    }
    indicators.push({ name, value: cleanValue, evidence: compact(evidence, 240), confidence })
  }
  const labelMatcher = (label: string) => (
    /^[A-Za-z0-9-]+$/.test(label)
      ? `(?<![A-Za-z0-9-])${escapeRegExp(label)}(?![A-Za-z0-9-])`
      : escapeRegExp(label)
  )

  const receptorLabelMap: Array<{ name: string; label: string }> = [
    { name: 'ER', label: 'ER' },
    { name: 'ER', label: '雌激素受体' },
    { name: 'PR', label: 'PR' },
    { name: 'PR', label: '孕激素受体' },
    { name: 'HER2', label: 'HER2/neu' },
    { name: 'HER2', label: 'HER2' },
    { name: 'Ki-67', label: 'Ki-67' },
    { name: 'Ki-67', label: 'Ki67' },
  ]
  for (const { name, label } of receptorLabelMap) {
    const pattern = new RegExp(`${labelMatcher(label)}(?:\\s*[（(][^）)]{0,30}[）)])?\\s*[:：]?\\s*([^；;。\\n]+)`, 'ig')
    for (const match of text.matchAll(pattern)) {
      const evidence = sentences.find((sentence) => sentence.includes(match[0].trim())) || match[0]
      const value = match[1]
        .replace(/(?:ER|PR|HER2|Ki[-\s]?67|雌激素受体|孕激素受体).*/i, '')
        .trim()
      addIndicator(name, value, evidence, 0.84)
    }
  }

  for (const spec of indicatorSpecs) {
    for (const label of spec.labels) {
      const pattern = new RegExp(`${labelMatcher(label)}(?:\\s*[（(][^）)]{0,30}[）)])?\\s*${indicatorValuePattern.source}`, 'ig')
      for (const match of text.matchAll(pattern)) {
        const evidence = sentences.find((sentence) => sentence.includes(match[0].trim())) || match[0]
        addIndicator(spec.name, match[1], evidence)
      }
    }
  }

  for (const match of text.matchAll(/SUV\s*max\s*[:：]?\s*([0-9]+(?:\.[0-9]+)?)/ig)) {
    const evidence = sentences.find((sentence) => sentence.toLowerCase().includes(match[0].toLowerCase())) || match[0]
    addIndicator('SUVmax', match[1], evidence, 0.82)
  }

  for (const match of text.matchAll(/EGFR[^。；;\n]*?(19\s*外显子\s*缺失|exon\s*19\s*(?:deletion|del)|L858R|T790M|突变阳性|阳性|阴性|野生型|positive|negative|wildtype|mutant)/ig)) {
    const evidence = sentences.find((sentence) => sentence.toLowerCase().includes(match[0].toLowerCase())) || match[0]
    addIndicator('EGFR', match[1], evidence, 0.88)
  }

  for (const match of text.matchAll(/ALK[^。；;\n]*?(融合|重排|阳性|阴性|positive|negative|fusion|rearrangement)/ig)) {
    const evidence = sentences.find((sentence) => sentence.toLowerCase().includes(match[0].toLowerCase())) || match[0]
    addIndicator('ALK', match[1], evidence, 0.86)
  }

  for (const match of text.matchAll(/PD[-\s]?L1[^。；;\n]*?(?:TPS|CPS)?\s*([0-9]+(?:\.[0-9]+)?\s*%|阳性|阴性|positive|negative)/ig)) {
    const evidence = sentences.find((sentence) => sentence.toLowerCase().includes(match[0].toLowerCase())) || match[0]
    addIndicator('PD-L1', match[1], evidence, 0.86)
  }

  for (const match of text.matchAll(/IDH[^。；;\n]*(野生型|突变型|wildtype|wild-type|mutant|mutation)/ig)) {
    const evidence = sentences.find((sentence) => sentence.toLowerCase().includes(match[0].toLowerCase())) || match[0]
    addIndicator('IDH状态', match[1], evidence, 0.86)
  }

  for (const match of text.matchAll(/MGMT[^。；;\n]*(甲基化|未甲基化|methylated|unmethylated)/ig)) {
    const evidence = sentences.find((sentence) => sentence.toLowerCase().includes(match[0].toLowerCase())) || match[0]
    addIndicator('MGMT甲基化', match[1], evidence, 0.86)
  }

  const luminalSentence = sentences.find((sentence) => includesAny(sentence, ['Luminal A', 'Luminal B', 'luminalb', '分子分型']))
  if (luminalSentence) addIndicator('分子分型', luminalSentence.match(/Luminal\s*[AB]/i)?.[0] || compact(luminalSentence, 80), luminalSentence, 0.76)

  return indicators.slice(0, 18)
}

const pickSentences = (sentences: string[], keywords: string[], limit = 8) => sentences
  .filter((sentence) => includesAny(sentence, keywords) && !isNonClinicalMetaSentence(sentence))
  .slice(0, limit)

const isNonClinicalMetaSentence = (sentence: string) => {
  const normalized = normalizedForMatch(sentence)
  return [
    '未见患者姓名',
    '未见具体医学报告内容',
    '未见检查结果',
    '未见诊断',
    '页面未见',
    '封面/宣传页',
    '主题与口腔种植牙相关',
    'kementeriankesehatan',
    'kemenkes',
    'dokterpengirim',
    'dokterahu',
    'namapasie',
    'namapasien',
    'nomormr',
    'nomr',
    'alamat',
    'jaminan',
    'telephone',
    'gol.darah',
    'unitprosedur',
    'unitpengirim',
    'poliklinik',
    'tanggallahir',
    'tanggalorder',
    'tanggalmasuk',
    'studydate',
    'patientid',
    'accessionno',
    '出生日期',
    '患者ruhani',
    'nyakhabibah',
    '报告可见内容',
    '主要结论',
    'portaca',
    'no.lab',
    'catatanhasilini',
    'hasilpemeriksaanradiologi',
    'temansejawat',
    'rskdharmais',
    'ecotyright',
    'not contain patient',
    'no patient',
  ].some((keyword) => normalized.includes(normalizedForMatch(keyword)))
}

const extractDiagnoses = (sentences: string[]) => {
  const diagnosisSentences = pickSentences(sentences, [
    '诊断',
    '诊断意见',
    '临床诊断',
    '检查结论',
    '检查印象',
    '影像印象',
    'impression',
    'diagnosis',
    'conclusion',
    '确诊',
    '浸润性',
    '癌',
    'carcinoma',
    'cancer',
    'NST',
    'Luminal',
    'WHO 1',
    'WHO 2',
    'WHO 3',
    'WHO 4',
    'WHO I',
    'WHO II',
    'WHO III',
    'WHO IV',
    'glioma',
    '肿瘤',
    '龋',
    '牙髓炎',
    '根尖周炎',
    '冠心病',
    '糖尿病',
    '椎间盘',
    '狭窄',
    '占位',
  ], 8)

  return unique(diagnosisSentences.map((sentence) => compact(sentence, 160))).slice(0, 8)
}

const findingRules: Array<{ category: MedicalFindingFact['category']; keywords: string[]; confidence: number }> = [
  { category: 'diagnosis', keywords: ['诊断', '诊断意见', '临床诊断', '检查结论', '检查印象', '影像印象', 'impression', 'diagnosis', 'conclusion'], confidence: 0.74 },
  { category: 'metastasis', keywords: ['转移', 'metastasis', 'metastases', '复发', 'progression', '进展'], confidence: 0.86 },
  { category: 'imaging', keywords: ['PET/CT', 'CBCT', 'CT', 'CTA', 'MRI', 'X线', 'DR', '超声', '钼靶', 'BIRADS', '高代谢', 'hypermetabolic', '结节', '肿块', '占位', '骨扫描', '检查所见'], confidence: 0.75 },
  { category: 'pathology', keywords: ['病理', '免疫组化', '活检', 'HER2', 'Ki-67', '浸润性', 'NST', 'grade', 'Luminal'], confidence: 0.78 },
  { category: 'treatment', keywords: ['手术', '术后', '化疗', '放疗', '内分泌', '靶向', '免疫治疗', 'CDK4/6', '根管', '补牙', '拔牙', '种植', '支架', '搭桥'], confidence: 0.72 },
  { category: 'laboratory', keywords: ['AFP', 'CEA', 'CA15-3', 'CA125', '血常规', '生化', '肝功能', 'HbA1c', '糖化血红蛋白', '血糖', '肌酐', 'ALT', 'AST', '胆红素'], confidence: 0.68 },
  { category: 'risk', keywords: ['SUVmax', '高代谢', '骨折', '脊髓压迫', '疼痛', '发热', '呼吸困难', '肌力下降', '麻木', '狭窄', '压迫'], confidence: 0.7 },
]

const extractFindings = (sentences: string[]) => {
  const findings: MedicalFindingFact[] = []
  for (const rule of findingRules) {
    for (const sentence of pickSentences(sentences, rule.keywords, 8)) {
      if (findings.some((item) => item.evidence === sentence)) continue
      findings.push({
        category: rule.category,
        text: compact(sentence, 180),
        evidence: sentence,
        confidence: isNegatedSentence(sentence) ? Math.max(0.45, rule.confidence - 0.18) : rule.confidence,
      })
    }
  }
  return findings.slice(0, 20)
}

const metastasisSites = [
  { site: '肝脏', keywords: ['肝', 'liver', 'hepatic'] },
  { site: '骨骼', keywords: ['骨', '椎体', '肋骨', '骨盆', '髋臼', 'C3', 'T12', 'L4', 'bone', 'skeletal'] },
  { site: '淋巴结', keywords: ['淋巴', '纵隔', '门腔静脉', '胸肌下', 'lymph', 'node', 'mediastinal'] },
  { site: '肺部', keywords: ['肺', 'lung', 'pulmonary'] },
  { site: '脑/中枢神经', keywords: ['脑', '颅内', 'brain', 'CNS'] },
  { site: '腹膜/腹腔', keywords: ['腹膜', '腹腔', 'peritoneal'] },
]

const findingKeywords = ['转移', 'metastasis', 'metastases', '高代谢', 'hypermetabolic', '病灶', '结节', '可疑', '不能排除', '不可排除', '不除外', '未见', '未发现']
const uncertaintyContinuationKeywords = ['不能排除', '不可排除', '不除外', '可疑', 'cannot exclude', 'cannot rule out', 'suspicious']

const getSiteEvidenceClauses = (sentence: string, keywords: string[]) => {
  const clauses = sentence
    .split(/[，,；;。]/)
    .map((item) => item.trim())
    .filter(Boolean)
  const matched = clauses.filter((clause) => includesAny(clause, keywords))
  if (!matched.length) return [sentence]

  const evidences = matched.map((clause) => {
    const index = clauses.indexOf(clause)
    const next = clauses[index + 1] || ''
    const hasDirectFinding = includesAny(clause, findingKeywords)
    const needsNext = next &&
      includesAny(next, uncertaintyContinuationKeywords) &&
      !includesAny(clause, ['转移', 'metastasis', 'metastases'])
    if (!hasDirectFinding && !needsNext) return ''

    return [
      clause,
      needsNext ? next : '',
    ].filter(Boolean).join('，')
  }).filter(Boolean)

  return evidences.length ? evidences : [sentence]
}

const getMetastasisStatus = (evidence: string): MedicalMetastasisSignal['status'] => {
  if (isNegatedSentence(evidence)) return 'absent'
  if (includesAny(evidence, ['可疑', '不能排除', '不可排除', '不除外', 'suspicious', '代谢不高'])) return 'suspected'
  return 'present'
}

const extractMetastasisSignals = (sentences: string[]) => {
  const signals: MedicalMetastasisSignal[] = []

  for (const sentence of sentences) {
    const hasMetastasisWord = includesAny(sentence, ['转移', 'metastasis', 'metastases', '高代谢', 'hypermetabolic', '可疑', '不能排除', 'suspicious'])
    if (!hasMetastasisWord) continue

    for (const site of metastasisSites) {
      if (!includesAny(sentence, site.keywords)) continue
      for (const evidence of getSiteEvidenceClauses(sentence, site.keywords)) {
        const status = getMetastasisStatus(evidence)
        const confidence = status === 'present' ? 0.88 : status === 'suspected' ? 0.72 : 0.58
        if (!signals.some((item) => item.site === site.site && item.status === status && item.evidence === evidence)) {
          signals.push({ site: site.site, status, evidence, confidence })
        }
      }
    }
  }

  const preferredSignals: MedicalMetastasisSignal[] = []
  for (const signal of signals) {
    const index = preferredSignals.findIndex((item) => item.site === signal.site && item.status === signal.status)
    if (index < 0) {
      preferredSignals.push(signal)
      continue
    }

    const current = preferredSignals[index]
    const currentHasMetastasis = includesAny(current.evidence, ['转移', 'metastasis', 'metastases'])
    const nextHasMetastasis = includesAny(signal.evidence, ['转移', 'metastasis', 'metastases'])
    if ((!currentHasMetastasis && nextHasMetastasis) || signal.evidence.length > current.evidence.length + 20) {
      preferredSignals[index] = signal
    }
  }

  return preferredSignals.slice(0, 12)
}

const inferDiseaseSignals = (documents: MedicalDocumentFact[]) => {
  const evidenceItems = documents.flatMap((doc) => [
    doc.reportType,
    ...doc.diagnoses,
    ...doc.findings.map((item) => item.text),
    ...doc.indicators.map((item) => `${item.name}${item.value}`),
  ])
  const text = evidenceItems.join(' ')
  const hasPositiveEvidence = (keywords: string[]) => evidenceItems.some((item) => (
    includesAny(item, keywords) && !isNegatedSentence(item)
  ))
  const hasIndicator = (names: string[]) => documents.some((doc) => (
    doc.indicators.some((indicator) => names.some((name) => indicator.name.toLowerCase() === name.toLowerCase()))
  ))

  const signals: string[] = []
  if (
    includesAny(text, ['乳腺', 'breast', 'HER2', 'Luminal', '雌激素受体', '孕激素受体']) ||
    (hasIndicator(['ER', 'PR', 'HER2', '分子分型']) && includesAny(text, ['乳腺', 'breast', 'carcinoma mamma', 'mammae', 'Luminal', '雌激素受体', '孕激素受体']))
  ) signals.push('breast_cancer')
  if (includesAny(text, ['肺癌', '肺腺癌', '肺鳞癌', 'lung cancer']) || (hasIndicator(['EGFR', 'ALK', 'PD-L1']) && includesAny(text, ['肺', 'lung', '腺癌']))) signals.push('lung_cancer')
  if (includesAny(text, ['肝癌', 'HCC', 'AFP', 'liver cancer'])) signals.push('liver_cancer')
  if (hasPositiveEvidence(['鼻咽癌', '鼻咽肿瘤', 'nasopharyngeal carcinoma', 'nasopharyngeal cancer', 'EBV DNA'])) signals.push('nasopharyngeal_cancer')
  if (
    includesAny(text, ['胶质', '脑肿瘤', '脊髓', 'IDH', 'MGMT']) ||
    /\bWHO\s*(?:[1-4]|I{1,3}|IV)\b/i.test(text)
  ) signals.push('neurosurgery')
  if (includesAny(text, ['牙', '口腔', 'CBCT', '种植', '龋'])) signals.push('dental')
  if (includesAny(text, ['冠脉', '冠心病', '心绞痛', '心衰', '瓣膜', '心电图', '心脏超声', '射血分数', 'ejection fraction'])) signals.push('cardiology_cardiothoracic')
  return unique(signals)
}

const buildTimelineTitle = (document: MedicalDocumentFact, finding: MedicalFindingFact) => {
  if (finding.category === 'diagnosis') return '诊断/检查结论'
  if (finding.category === 'metastasis') return '复发/转移或进展线索'
  if (finding.category === 'pathology') return '病理与分子指标'
  if (finding.category === 'imaging') return '影像检查发现'
  if (finding.category === 'treatment') return '既往治疗记录'
  return document.reportType
}

const buildTimeline = (documents: MedicalDocumentFact[]) => {
  const events = documents.flatMap((document) => {
    const date = document.primaryDate || document.dates[0] || '日期待确认'
    const highValueFindings = document.findings
      .filter((finding) => ['diagnosis', 'metastasis', 'pathology', 'imaging', 'treatment'].includes(finding.category))
      .slice(0, 4)
    const sourceFindings = highValueFindings.length ? highValueFindings : document.sourceEvidence.slice(0, 2).map((evidence) => ({
      category: 'other' as const,
      text: evidence,
      evidence,
      confidence: document.confidence,
    }))

    return sourceFindings.map((finding) => ({
      date,
      fileName: document.fileName,
      reportType: document.reportType,
      title: buildTimelineTitle(document, finding),
      description: compact(finding.text, 220),
      items: [
        ...document.metastasisSignals
          .filter((signal) => finding.evidence.includes(signal.evidence) || signal.evidence.includes(finding.evidence))
          .map((signal) => `${signal.site}：${signal.status === 'present' ? '提示转移' : signal.status === 'suspected' ? '可疑/需排除' : '未见明确转移'}`),
        ...document.indicators
          .filter((indicator) => finding.evidence.includes(indicator.name) || finding.evidence.includes(indicator.value))
          .slice(0, 3)
          .map((indicator) => `${indicator.name}：${indicator.value}`),
      ],
      confidence: Math.min(document.confidence, finding.confidence),
    }))
  })

  return events
    .sort((left, right) => dateSortValue(left.date) - dateSortValue(right.date))
    .slice(0, 18)
}

const rankEvidence = (evidence: string) => {
  let score = 0
  if (includesAny(evidence, ['metastases', 'metastasis', '转移', 'hypermetabolic liver', 'bone metastases', 'lymph nodes'])) score += 90
  if (includesAny(evidence, ['Right breast carcinoma', 'Invasive carcinoma', 'Luminal', 'NST', 'carcinoma mamma'])) score += 80
  if (includesAny(evidence, ['HER2', 'Ki67', 'Ki-67', 'ER ', 'PR ', 'Reseptor estrogen', 'Reseptor progesteron'])) score += 70
  if (includesAny(evidence, ['SUVmax', 'PET/CT', 'FDG'])) score += 60
  if (includesAny(evidence, ['BIRADS', 'BI-RADS', 'suspek maligna', 'Lesi solid'])) score += 45
  if (isNonClinicalMetaSentence(evidence)) score -= 200
  if (evidence.length < 10 || /^[A-Z\s|=~_.-]{4,}$/.test(evidence)) score -= 60
  return score
}

export const extractMedicalFactsFromText = (
  text: string,
  options: { fileName?: string; parser?: string } = {},
): MedicalDocumentFact => {
  const normalized = normalizeText(text)
  const documentCategory = detectDocumentCategory(normalized)
  const sentences = getSentences(normalized)
  const dates = extractDates(normalized)
  const indicators = extractIndicators(normalized, sentences)
  const diagnoses = extractDiagnoses(sentences)
  const findings = extractFindings(sentences)
  const metastasisSignals = extractMetastasisSignals(sentences)
  const sourceEvidence = unique([
    ...diagnoses,
    ...metastasisSignals.map((item) => item.evidence),
    ...findings.map((item) => item.evidence),
    ...indicators.map((item) => item.evidence),
  ])
    .filter((item) => !isNonClinicalMetaSentence(item))
    .map((item) => compact(item, 260))
    .sort((left, right) => rankEvidence(right) - rankEvidence(left))
    .slice(0, 18)
  const confidenceParts = [
    normalized.length > 120 ? 0.2 : 0,
    dates.length ? 0.12 : 0,
    indicators.length ? 0.2 : 0,
    diagnoses.length ? 0.18 : 0,
    findings.length ? 0.18 : 0,
    metastasisSignals.length ? 0.12 : 0,
  ]
  const confidence = Math.min(0.96, confidenceParts.reduce((sum, value) => sum + value, 0.18))

  return {
    fileName: options.fileName || 'medical-file',
    parser: options.parser || 'text',
    documentCategory,
    reportType: detectReportType(normalized),
    dates,
    primaryDate: dates.slice().sort((left, right) => dateSortValue(right) - dateSortValue(left))[0] || '',
    diagnoses,
    indicators,
    findings,
    metastasisSignals,
    sourceEvidence,
    confidence,
  }
}

const isMedicalDocumentFact = (value: unknown): value is MedicalDocumentFact => Boolean(
  value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  typeof (value as MedicalDocumentFact).reportType === 'string' &&
  Array.isArray((value as MedicalDocumentFact).findings),
)

export const getMedicalFactsFromParsedFile = (file: ParsedFileLike): MedicalDocumentFact => {
  const existing = file.metadata?.medicalFacts
  if (isMedicalDocumentFact(existing)) return existing
  return extractMedicalFactsFromText([file.text, file.summary].filter(Boolean).join('\n'), {
    fileName: file.originalName,
    parser: file.parser,
  })
}

export const collectMedicalFactBundle = (files: ParsedFileLike[]): MedicalFactBundle => {
  const allDocuments = files
    .filter((file) => file.status !== 'unsupported' && file.status !== 'failed')
    .map((file) => getMedicalFactsFromParsedFile(file))
  const documents = allDocuments.filter((document) => !['institution_intro', 'reference_material'].includes(document.documentCategory))
  const sourceTextLength = files.reduce((sum, file) => sum + normalizeText(file.text || file.summary || '').length, 0)
  const timeline = buildTimeline(documents)
  const evidenceHighlights = unique(documents.flatMap((document) => document.sourceEvidence))
    .sort((left, right) => rankEvidence(right) - rankEvidence(left))
    .slice(0, 12)
  const diseaseSignals = inferDiseaseSignals(documents)
  const actionableCount = documents.reduce((sum, document) => (
    sum + document.diagnoses.length + document.indicators.length + document.findings.length + document.metastasisSignals.length
  ), 0)
  const qualityFlags = [
    files.length && sourceTextLength < 80 ? '上传资料未提取到足够正文，报告只能部分参考表单信息，建议重新上传清晰图片/PDF原文或补充文字摘要。' : '',
    files.some((file) => file.status === 'partial') ? '部分上传资料仅完成部分解析，关键结论需人工复核原图/原PDF。' : '',
    files.some((file) => file.status === 'failed') ? '部分上传资料解析失败，未被用于医学事实判断。' : '',
    allDocuments.some((document) => document.documentCategory === 'institution_intro') ? '部分上传文件被识别为机构/服务介绍资料，未作为患者病情证据使用。' : '',
    allDocuments.some((document) => document.documentCategory === 'reference_material') ? '部分上传文件被识别为模板、指南、价格表或参考资料，未作为患者病情证据使用。' : '',
    files.length && !actionableCount ? '上传资料识别不足：暂未识别出可用医学事实，不能据此得出病理、影像或治疗结论。' : '',
  ].filter(Boolean)
  const summaryPieces = [
    documents.length ? `已解析${documents.length}份医学资料` : '',
    diseaseSignals.length ? `识别病种线索：${diseaseSignals.map((key) => diseaseSignalLabels[key] || key).join('、')}` : '',
    timeline.length ? `形成${timeline.length}条病情时间线` : '',
    evidenceHighlights[0] ? `关键证据：${evidenceHighlights[0]}` : '',
  ].filter(Boolean)

  return {
    documents,
    timeline,
    summary: summaryPieces.join('；') || '暂未形成可用医学事实摘要',
    evidenceHighlights,
    diseaseSignals,
    qualityFlags,
    sourceTextLength,
    hasActionableFacts: actionableCount > 0,
  }
}

export const summarizeMedicalFactBundle = (bundle: MedicalFactBundle, maxItems = 6) => [
  bundle.summary,
  ...bundle.evidenceHighlights.slice(0, maxItems),
].filter(Boolean)
