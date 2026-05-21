import { config } from '../config.js'
import type { ReportSubmissionInput } from '../validators/reportSubmission.js'
import { defaultDisease, diseases, packages, regions, type KnowledgeDisease, type KnowledgeRegion } from './knowledgeBase.js'
import { generatedReportSchema, type GeneratedReport } from './types.js'

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
    keywords: ['乳腺', '乳房', '乳头', '腋窝', '乳腺肿块', '乳房肿块', '钼靶', 'bi-rads', 'birads', 'her2', '雌激素', '孕激素', '保乳'],
    inferKeywords: ['乳腺癌', '乳癌', '乳腺肿瘤', '乳房肿瘤', '乳腺肿块', '乳房肿块', 'bi-rads4', 'bi-rads5', 'birads4', 'birads5', 'her2', '保乳'],
  },
  lung_cancer: {
    label: '肺部专科/肺肿瘤',
    diseaseKey: 'lung_cancer',
    keywords: ['肺', '肺部', '咳嗽', '咯血', '胸部ct', '肺结节', '磨玻璃', '肺癌', '靶向', '免疫治疗'],
    inferKeywords: ['肺癌', '肺部肿瘤', '肺肿瘤', '肺结节', '磨玻璃', '胸部ct', '非小细胞', '小细胞肺癌', 'egfr', 'alk', 'pd-l1', '靶向治疗', '免疫治疗'],
  },
  nasopharyngeal_cancer: {
    label: '鼻咽/头颈专科',
    diseaseKey: 'nasopharyngeal_cancer',
    keywords: ['鼻咽', '鼻咽癌', '涕血', '回吸血涕', '颈部淋巴', 'ebv', '头颈肿瘤', '鼻咽镜', '鼻塞', '耳鸣', '听力下降', '流鼻血', '鼻出血', '放疗'],
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
    keywords: ['脑', '颅内', '头痛', '头晕', '癫痫', '抽搐', '偏瘫', '胶质', '垂体', '动脉瘤', '脑瘤', '脑肿瘤', '神经外科'],
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
  lung_cancer: ['respiratory'],
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

  return matchedSignals.filter((item) => {
    if (selectedSignalKeys.includes(item.key) || item.diseaseKey === selectedKey) return false
    if (compatibleSignals.includes(item.key)) return false

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
  const complaintText = input.basicInfo.chiefComplaint
  const matchedSignals = getMatchedSignals(complaintText)
  const inferredDiseaseKey = getInferableDiseaseKey(complaintText, matchedSignals)

  if (requestedKey === 'other' && inferredDiseaseKey) {
    const inferredDisease = diseases[inferredDiseaseKey]
    return {
      key: inferredDiseaseKey,
      disease: inferredDisease,
      requestedKey,
      requestedDisease,
      mismatch: false,
      possibleDirections: [],
      secondaryDirections: getMatchedSignalLabels(getOtherSignalMatches(inferredDiseaseKey, getSelectedSignalKeys(inferredDiseaseKey), complaintText, matchedSignals)),
      selectedEvidence: matchedSignals.find((item) => item.diseaseKey === inferredDiseaseKey)?.hits || [],
      detectedSignals: matchedSignals,
    }
  }

  if (direct) {
    const selectedSignalKeys = getSelectedSignalKeys(input.basicInfo.visitPurpose)
    const selectedSignals = selectedSignalKeys.flatMap((key) => symptomSignalGroups[key]?.keywords || [])
    const selectedEvidence = getPositiveKeywordHits(complaintText, selectedSignals.length ? selectedSignals : direct.keywords)
    const matchesSelected = selectedEvidence.length > 0
    const otherSignalMatches = getOtherSignalMatches(input.basicInfo.visitPurpose, selectedSignalKeys, complaintText, matchedSignals)
    const otherSignals = getMatchedSignalLabels(otherSignalMatches)
    const shouldCheckMismatch = selectedDepartmentRequiresSymptomMatch.has(input.basicInfo.visitPurpose)

    if (shouldCheckMismatch && !matchesSelected && otherSignals.length > 0) {
      return {
        key: 'other',
        disease: defaultDisease,
        requestedKey,
        requestedDisease,
        mismatch: true,
        mismatchReason: `用户选择了“${direct.label}”，但症状描述更像${otherSignals.join('、')}方向，需要先重新确认科室。`,
        possibleDirections: otherSignals,
        selectedEvidence,
        detectedSignals: matchedSignals,
      }
    }

    return {
      key: input.basicInfo.visitPurpose,
      disease: direct,
      requestedKey,
      requestedDisease,
      mismatch: false,
      weakMatch: shouldCheckMismatch && !matchesSelected,
      possibleDirections: [],
      secondaryDirections: otherSignals,
      selectedEvidence,
      detectedSignals: matchedSignals,
    }
  }

  const matched = inferredDiseaseKey ? [inferredDiseaseKey, diseases[inferredDiseaseKey]] as const : undefined
  return matched
    ? { key: matched[0], disease: matched[1], requestedKey, requestedDisease, mismatch: false, possibleDirections: [], secondaryDirections: [], selectedEvidence: matchedSignals[0]?.hits || [], detectedSignals: matchedSignals }
    : { key: 'other', disease: defaultDisease, requestedKey, requestedDisease, mismatch: false, possibleDirections: [] }
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
    const dentalFees: Record<string, string> = {
      美国: '$2,000 - $15,000+（按牙位、植体和修复材料）',
      加拿大: '$1,800 - $12,000+（按单颗/多颗和植骨需求）',
      英国: '$1,500 - $10,000+（按私立牙科项目）',
      德国: '$1,500 - $10,000+（按种植系统和修复材料）',
      法国: '$1,200 - $8,000+（按项目和保险覆盖）',
      新加坡: '$800 - $8,000+（按补牙、根管、种植颗数）',
      泰国: '$500 - $6,000+（按医疗旅游牙科套餐）',
      马来西亚: '$400 - $5,000+（按项目和材料）',
      日本: '$1,000 - $9,000+（按自费牙科项目）',
      韩国: '$700 - $7,000+（按种植和修复项目）',
      澳大利亚: '$1,500 - $12,000+（按私立牙科项目）',
      新西兰: '$1,500 - $10,000+（按牙科项目）',
    }
    return {
      ...region,
      fee: dentalFees[region.name] || '需按补牙、根管、拔牙、种植颗数和材料评估',
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
  const complaint = input.basicInfo.chiefComplaint.trim()
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
    match.mismatch ? '先重新确认就诊科室和主要问题，不建议按原选择科室直接生成治疗方案' : '',
    match.weakMatch ? `用户选择了${match.requestedDisease.label}，但主诉缺少该科室的典型关键词，需先补充诊断、检查或既往医生意见` : '',
    match.secondaryDirections?.length ? `同时排查是否合并${match.secondaryDirections.slice(0, 2).join('、')}相关问题` : '',
    ...(decisionByDisease[match.key] || []),
    hasSurgery ? '判断是否真的需要手术，以及手术前还缺哪些证据' : '',
    hasCancer ? '明确病理、分期和既往治疗后再比较治疗方案' : '',
    hasCheckup ? '把体检项目和用户实际风险点绑定，而不是使用固定套餐' : '',
  ]).slice(0, 5)

  const planPriorities = unique([
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
    countryGuidance: '国家对比必须围绕当前主诉和专科需求；若通用地区费用不适合该科室，应改写为按项目评估或给出更保守的项目型费用描述。',
    specialtyRules,
  }
}

const estimateScore = (disease: typeof defaultDisease, input: ReportSubmissionInput, personalization?: CasePersonalization) => {
  if (personalization?.mismatch) return 58

  let score = disease.score
  if (input.selectedRegions.includes('north_america') || input.selectedRegions.includes('europe')) score += 2
  if (input.basicInfo.chiefComplaint.length > 80) score += 2
  if (input.basicInfo.visitPurpose === 'other') score -= 8
  return Math.max(60, Math.min(92, score))
}

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

  return {
    id: submissionNo,
    date: dateLabel,
    subtitle: '来华就医可行性预审报告',
    disease: personalization.mismatch ? '综合分诊评估' : personalization.reportDiseaseLabel,
    treatment: personalization.mismatch
      ? `${personalization.mismatchReason} 本次报告先按综合分诊处理，重点识别可能方向、危险信号和下一步资料清单。`
      : `${disease.treatment}（围绕用户主诉先判断：${firstDecision}）`,
    need: input.basicInfo.chiefComplaint,
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
    ],
    hospitals: disease.hospitals,
    plan: {
      direction,
      duration: diseaseKey === 'dental' && personalization.complaint.includes('种植')
        ? '短期可在华完成检查、止痛、补牙/根管/拔牙和种植评估；完整种植修复通常需数月或多次往返'
        : disease.duration,
      totalCost: disease.chinaFee,
      breakdown: disease.breakdown,
    },
    packages,
    highlights: [
      ...disease.advantages,
      `围绕“${firstDecision}”做专家人工复核`,
      `优先核对${firstMaterial || '关键检查资料'}后再出行`,
      '按检查、治疗、材料和随访阶段拆分费用',
    ],
    disclaimer: '本报告为基于用户提交信息和平台知识库生成的来华就医可行性预审，不构成诊断、处方或最终治疗建议。最终方案需以执业医生面诊、检查结果和医院正式意见为准。',
    generatedBy: 'rules',
  }
}

const buildPrompt = (context: ReportContext, ruleReport: GeneratedReport) => {
  const { input, disease, diseaseKey, personalization, selectedRegionItems, submissionNo, dateLabel } = context
  return [
    {
      role: 'system',
      content: [
        '你是寰宇云医的国际医疗预审报告生成助手。',
        '你的核心任务不是套模板，而是基于用户选择的科室、用户主诉、地区偏好和知识库，生成贴合实际情况的个性化预审报告。',
        '只能基于用户资料和给定知识库生成报告；不得编造不存在的医院、价格、疗效承诺或确定诊断。',
        '输出必须是严格 JSON，不要 Markdown，不要解释。',
        '报告语言使用简体中文。',
        '请保持医学审慎：使用“建议、可考虑、需医生确认”等措辞。',
        '如果用户主诉与所选科室不完全一致，应指出需要重新确认方向，不要强行按所选科室输出。',
        '如果所选科室与主诉明显无关，例如选牙科但描述掉头发、腹痛等，必须按综合分诊评估输出；disease 写“综合分诊评估”，treatment/concerns 说明不匹配原因和可能方向。',
        '如果主诉没有明显跑偏、但缺少所选科室典型信息，应按所选科室谨慎预审，并明确“信息不足、需补充检查/诊断资料”，不要直接改成其他病种。',
        '如用户描述包含急症或危险信号，应优先提示先就近处理风险，再讨论跨境就医。',
      ].join('\n'),
    },
    {
      role: 'user',
      content: JSON.stringify({
        task: '生成高度个性化的来华就医可行性预审报告 JSON',
        generationPrinciples: [
          '用户主诉必须是报告主轴：treatment、advantages、concerns、plan.direction、plan.breakdown、highlights 都要回应用户实际填写的症状/检查/诉求。',
          'baselineRuleReport 只能作为字段结构参考，不能照抄其中的通用文案。',
          '国家对比必须结合当前科室和用户诉求。如果知识库中的地区费用明显偏向大病种，不适用于当前科室，应改写成“按项目评估”的保守表达。',
          '费用明细要围绕可能发生的真实项目拆分；不确定时给分层区间，避免单一、看似精确但无依据的数字。',
          '医院推荐理由必须说明为什么适合当前用户主诉，而不是只说医院强。',
          '不要把“疾病/科室名称”当作已确诊诊断；需要医生结合资料确认。',
          'disease 字段只写简短科室/方向名称，不超过16个汉字；未确诊、需确认等说明放到 treatment 或 concerns。',
          '当 personalization.mismatch 为 true 时，不得按 requestedDepartment 生成专科治疗方案，必须优先输出“科室选择需确认/综合分诊”的报告。',
          '当 personalization.weakMatch 为 true 且 mismatch 为 false 时，可以保留 requestedDepartment 方向，但必须在 concerns 中提示关联信息不足和补资料要求。',
        ],
        personalization,
        specialtyRules: personalization.specialtyRules,
        qualityChecklist: [
          '是否明确回应了用户 chiefComplaint 中至少两个具体信息点？',
          '是否说明了下一步最关键的医学判断？',
          '是否列出了该场景真正需要补充的资料？',
          '费用、周期、随访是否与该科室和主诉匹配？',
          '是否避免了不恰当的通用文案，如把牙科写成肿瘤、把体检写成治疗、把未确诊写成确诊？',
        ],
        outputSchema: {
          id: 'string',
          date: 'string',
          subtitle: 'string',
          disease: 'string',
          treatment: 'string',
          need: 'string',
          countries: [{ flag: 'string', name: 'string', fee: 'string', wait: 'string', tech: 'string', service: 'string', visa: 'string', follow: 'string', recommended: 'boolean optional' }],
          score: 'integer 0-100',
          advantages: [{ label: 'string', value: 'string' }],
          concerns: [{ concern: 'string', solution: 'string' }],
          hospitals: [{ city: 'string', name: 'string', reason: 'string' }],
          plan: { direction: 'string', duration: 'string', totalCost: 'string', breakdown: [{ item: 'string', cost: 'string' }] },
          packages: [{ name: 'string', price: 'string', icon: 'FileText|Video|MessageSquare', highlight: 'boolean', features: ['string'] }],
          highlights: ['string'],
          disclaimer: 'string',
          generatedBy: '"llm"',
        },
        fixedFields: { id: submissionNo, date: dateLabel, generatedBy: 'llm' },
        patientInput: input,
        matchedKnowledge: {
          diseaseKey,
          disease,
          chinaCountry: chinaCountry(disease, personalization),
          selectedRegions: selectedRegionItems.map((item) => personalizeRegionItem(item, context)),
          packages,
        },
        baselineRuleReport: ruleReport,
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

const callLlm = async (context: ReportContext, ruleReport: GeneratedReport) => {
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
      temperature: 0.35,
      response_format: { type: 'json_object' },
    }),
    signal: AbortSignal.timeout(config.openaiTimeoutMs),
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`LLM request failed: ${response.status} ${body.slice(0, 500)}`)
  }

  const json = await response.json() as {
    choices?: Array<{ message?: { content?: string } }>
  }
  const content = json.choices?.[0]?.message?.content
  if (!content) throw new Error('LLM response did not include content')

  return generatedReportSchema.parse(JSON.parse(extractJson(content)))
}

const reportContainsAny = (report: GeneratedReport, terms: string[]) => {
  const text = JSON.stringify(report)
  return terms.some((term) => text.includes(term))
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
      return ruleReport
    }
  }

  if (context.input.basicInfo.visitPurpose === 'other' && !personalization.mismatch && report.disease === context.disease.label) {
    report.disease = personalization.reportDiseaseLabel
  }

  if (diseaseKey === 'dental' && reportContainsAny(report, ['肿瘤MDT', '放疗', '化疗', '靶向', '免疫治疗']) && !report.need.includes('肿瘤')) {
    return ruleReport
  }

  if (diseaseKey === 'premium_checkup' && reportContainsAny(report, ['手术及住院', '放疗', '化疗']) && !report.need.includes('已确诊')) {
    return ruleReport
  }

  return {
    ...report,
    id: context.submissionNo,
    date: context.dateLabel,
    need: context.input.basicInfo.chiefComplaint,
    generatedBy: 'llm' as const,
  }
}

export const generateReport = async (input: ReportSubmissionInput, submissionNo: string): Promise<GeneratedReport> => {
  const match = getDiseaseMatch(input)
  const context: ReportContext = {
    submissionNo,
    dateLabel: getDateLabel(),
    input,
    diseaseKey: match.key,
    disease: match.disease,
    personalization: buildPersonalization(input, match),
    selectedRegionItems: getRegionItems(input.selectedRegions),
  }
  const ruleReport = buildRuleReport(context)

  try {
    const llmReport = await callLlm(context, ruleReport)
    return llmReport ? enforceReportGuardrails(llmReport, context, ruleReport) : ruleReport
  } catch (error) {
    const message = error instanceof Error ? error.message.replace(/sk-[A-Za-z0-9_*.-]+/g, 'sk-***') : String(error)
    console.warn(`Report LLM generation failed, using rule fallback: ${message.slice(0, 240)}`)
    return ruleReport
  }
}
