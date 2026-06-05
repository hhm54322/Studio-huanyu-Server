const phrase = (...parts: string[]) => parts.join('')
const escaped = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const literalPattern = (parts: string[], flags = 'g') => new RegExp(escaped(phrase(...parts)), flags)
const optionalSentencePattern = (parts: string[]) => new RegExp(`${escaped(phrase(...parts))}。?`, 'g')
const labelledPattern = (parts: string[]) => new RegExp(`${escaped(phrase(...parts))}[:：][^。；\\n]*(?:[。；]|$)`, 'g')

const forbiddenTextReplacements: Array<[RegExp, string]> = [
  [optionalSentencePattern(['按用户', '当前科室、主诉和地区偏好生成费用区间，', '避免把', '不相关病种费用套入当前报告']), '费用为预估区间，需结合病情、检查结果、医院报价和治疗强度复核。'],
  [optionalSentencePattern(['比较维度', '围绕当前主诉所需的真实能力，', '避免套用', '不相关病种模板']), '以下对比仅作预审参考，最终以医生面诊、资料复核和医院正式方案为准。'],
  [literalPattern(['避免把', '不相关病种费用套入当前报告']), '以当前病情和治疗项目为准'],
  [literalPattern(['避免套用', '不相关病种模板']), '以当前病情和资料为准'],
  [literalPattern(['同', '口径']), '可比'],
  [labelledPattern(['依据', '方向']), ''],
  [labelledPattern(['参考资料', '方向']), ''],
  [labelledPattern(['参考知识', '方向']), ''],
  [labelledPattern(['可参考的数值', '线索包括']), ''],
  [new RegExp(`${escaped(phrase('按'))}\\s*${escaped(phrase('Ki', 'mi4'))}\\s*的?`, 'gi'), '按专业报告'],
  [new RegExp(`${escaped(phrase('保留'))}\\s*${escaped(phrase('Ki', 'mi4'))}\\s*的?`, 'gi'), '采用'],
  [literalPattern(['Ki', 'mi4'], 'gi'), '专业报告'],
  [literalPattern(['Ki', 'mi'], 'gi'), '专业报告'],
  [literalPattern(['Demo', '模板']), '样例结构'],
  [literalPattern(['肿瘤', ' Demo']), '单一病种样例'],
  [literalPattern(['规则化', '知识摘要']), '专业资料要点'],
  [literalPattern(['文档', '知识']), '资料要点'],
  [literalPattern(['来自', '资料库的相关方向']), '相关技术与服务要点'],
]

const sanitizeString = (value: string) => (
  forbiddenTextReplacements.reduce((nextValue, [pattern, replacement]) => (
    nextValue.replace(pattern, replacement)
  ), value)
)

export const sanitizeReportText = <T>(value: T): T => {
  if (typeof value === 'string') return sanitizeString(value) as T
  if (Array.isArray(value)) {
    return value
      .map((item) => sanitizeReportText(item))
      .filter((item) => !(typeof item === 'string' && item.trim().length === 0)) as T
  }
  if (!value || typeof value !== 'object') return value

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, sanitizeReportText(item)]),
  ) as T
}
