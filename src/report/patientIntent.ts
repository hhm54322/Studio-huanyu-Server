export const careNeedValues = [
  'advanced_surgery',
  'targeted_immunotherapy',
  'second_opinion',
  'postoperative_rehab_recurrence_prevention',
  'other',
] as const

export const expectedTreatmentTimeValues = [
  'within_1_month',
  '1_to_3_months',
  '3_to_6_months',
  'consult_only',
] as const

export type CareNeed = typeof careNeedValues[number]
export type ExpectedTreatmentTime = typeof expectedTreatmentTimeValues[number]

export const careNeedLabels: Record<CareNeed, string> = {
  advanced_surgery: '寻求前沿手术方案',
  targeted_immunotherapy: '寻求靶向/免疫新药治疗',
  second_opinion: '寻求第二诊疗意见',
  postoperative_rehab_recurrence_prevention: '术后康复与防复发方案',
  other: '其他',
}

export const expectedTreatmentTimeLabels: Record<ExpectedTreatmentTime, string> = {
  within_1_month: '1个月内',
  '1_to_3_months': '1-3个月',
  '3_to_6_months': '3-6个月',
  consult_only: '仅咨询方案，暂无赴华计划',
}

export const getCareNeedLabel = (careNeed = '', careNeedOther = '') => {
  if (!careNeed) return ''
  if (careNeed === 'other') {
    const otherText = careNeedOther.trim()
    return otherText ? `其他：${otherText}` : careNeedLabels.other
  }
  return careNeedLabels[careNeed as CareNeed] || careNeed
}

export const getExpectedTreatmentTimeLabel = (expectedTreatmentTime = '') => (
  expectedTreatmentTimeLabels[expectedTreatmentTime as ExpectedTreatmentTime] || expectedTreatmentTime
)

export const getPatientIntentSummary = (input: {
  careNeed?: string
  careNeedOther?: string
  expectedTreatmentTime?: string
}) => [
  getCareNeedLabel(input.careNeed, input.careNeedOther) ? `就医诉求：${getCareNeedLabel(input.careNeed, input.careNeedOther)}` : '',
  getExpectedTreatmentTimeLabel(input.expectedTreatmentTime) ? `期望治疗时间：${getExpectedTreatmentTimeLabel(input.expectedTreatmentTime)}` : '',
].filter(Boolean).join('；')
