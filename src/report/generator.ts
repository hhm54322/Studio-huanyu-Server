import { config } from '../config.js'
import type { ReportSubmissionInput } from '../validators/reportSubmission.js'
import { defaultDisease, diseases, packages, regions } from './knowledgeBase.js'
import { generatedReportSchema, type GeneratedReport } from './types.js'

type ReportContext = {
  submissionNo: string
  dateLabel: string
  input: ReportSubmissionInput
  disease: typeof defaultDisease
  selectedRegionItems: ReturnType<typeof getRegionItems>
}

const chinaCountry = (disease: typeof defaultDisease) => ({
  flag: '🇨🇳',
  name: '中国（推荐）',
  fee: disease.chinaFee,
  wait: '7-21天',
  tech: `${disease.label}相关专科病例量大，检查、会诊和治疗衔接效率较高`,
  service: '国际医疗部、医学翻译和就医管家可提供全流程协助',
  visa: '可协助医疗邀请函、M字签证或陪同家属材料准备',
  follow: '支持术后/治疗后远程随访和跨境云病房管理',
  recommended: true,
})

const getDateLabel = () => {
  const now = new Date()
  return `${now.getFullYear()}年${now.getMonth() + 1}月`
}

const getDisease = (input: ReportSubmissionInput) => {
  const direct = diseases[input.basicInfo.visitPurpose]
  if (direct) return direct

  const text = `${input.basicInfo.visitPurpose} ${input.basicInfo.chiefComplaint}`.toLowerCase()
  return Object.values(diseases).find((item) => item.keywords.some((keyword) => text.includes(keyword.toLowerCase()))) || defaultDisease
}

const getRegionItems = (selectedRegions: string[]) => {
  return selectedRegions.flatMap((region) => regions[region] || regions.other)
}

const estimateScore = (disease: typeof defaultDisease, input: ReportSubmissionInput) => {
  let score = disease.score
  if (input.selectedRegions.includes('north_america') || input.selectedRegions.includes('europe')) score += 2
  if (input.basicInfo.chiefComplaint.length > 80) score += 2
  if (input.basicInfo.visitPurpose === 'other') score -= 8
  return Math.max(60, Math.min(92, score))
}

const buildRuleReport = (context: ReportContext): GeneratedReport => {
  const { disease, input, selectedRegionItems, submissionNo, dateLabel } = context
  const countries = [chinaCountry(disease), ...selectedRegionItems]
  const score = estimateScore(disease, input)
  const selectedNames = selectedRegionItems.map((item) => item.name).join('、') || '所选目的地'

  return {
    id: submissionNo,
    date: dateLabel,
    subtitle: '来华就医可行性预审报告',
    disease: disease.label,
    treatment: disease.treatment,
    need: input.basicInfo.chiefComplaint,
    countries,
    score,
    advantages: [
      { label: '匹配度', value: `${score}/100` },
      { label: '费用与效率', value: `较${selectedNames}更具综合性价比` },
      { label: '关键提示', value: '建议先做病历翻译、影像复核和专家视频面诊' },
    ],
    concerns: [
      { concern: '诊断信息完整性', solution: '需补充近期影像、病理、检验报告和既往治疗记录，便于专家判断方案' },
      { concern: '语言沟通', solution: '建议配置医学翻译和就医管家，减少跨科室沟通误差' },
      { concern: '签证与行程', solution: '根据国籍、治疗周期和陪同家属情况，提前准备邀请函和资金证明' },
      { concern: '治疗连续性', solution: '出发前确认回国后的远程随访计划和当地医院衔接方式' },
    ],
    hospitals: disease.hospitals,
    plan: {
      direction: disease.direction,
      duration: disease.duration,
      totalCost: disease.chinaFee,
      breakdown: disease.breakdown,
    },
    packages,
    highlights: [
      ...disease.advantages,
      '副主任医师及以上专家人工复核',
      '医疗签证邀请函与跨境就医材料协助',
      '治疗后远程随访与康复档案管理',
    ],
    disclaimer: '本报告为基于用户提交信息和平台知识库生成的来华就医可行性预审，不构成诊断、处方或最终治疗建议。最终方案需以执业医生面诊、检查结果和医院正式意见为准。',
    generatedBy: 'rules',
  }
}

const buildPrompt = (context: ReportContext, ruleReport: GeneratedReport) => {
  const { input, disease, selectedRegionItems, submissionNo, dateLabel } = context
  return [
    {
      role: 'system',
      content: [
        '你是寰宇云医的国际医疗预审报告生成助手。',
        '只能基于用户资料和给定知识库生成报告，不得编造医院、价格、疗效承诺或确定诊断。',
        '输出必须是严格 JSON，不要 Markdown，不要解释。',
        '报告语言使用简体中文。',
        '请保持医学审慎：使用“建议、可考虑、需医生确认”等措辞。',
      ].join('\n'),
    },
    {
      role: 'user',
      content: JSON.stringify({
        task: '生成来华就医可行性预审报告 JSON',
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
          disease,
          chinaCountry: chinaCountry(disease),
          selectedRegions: selectedRegionItems,
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

export const generateReport = async (input: ReportSubmissionInput, submissionNo: string): Promise<GeneratedReport> => {
  const disease = getDisease(input)
  const context: ReportContext = {
    submissionNo,
    dateLabel: getDateLabel(),
    input,
    disease,
    selectedRegionItems: getRegionItems(input.selectedRegions),
  }
  const ruleReport = buildRuleReport(context)

  try {
    const llmReport = await callLlm(context, ruleReport)
    return llmReport || ruleReport
  } catch (error) {
    const message = error instanceof Error ? error.message.replace(/sk-[A-Za-z0-9_*.-]+/g, 'sk-***') : String(error)
    console.warn(`Report LLM generation failed, using rule fallback: ${message.slice(0, 240)}`)
    return ruleReport
  }
}
