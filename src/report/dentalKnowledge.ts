const usd = (cny: number) => Math.round(cny / 7.2 / 100) * 100

const cny = (value: number) => `¥${new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 }).format(value)}`
const usdText = (value: number) => `$${new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(usd(value))}`

const dual = (min: number, max?: number) => {
  if (!max || min === max) return `${cny(min)}（约${usdText(min)}）`
  return `${cny(min)}-${cny(max)}（约${usdText(min)}-${usdText(max)}）`
}

export const dentalPartner = {
  city: '深圳',
  name: '深圳鼎植口腔（鼎植医生集团）',
  department: '口腔种植 / 修复 / 数字化口腔',
  shortName: '鼎植口腔',
  brandIntro: '鼎植医生集团是以口腔医疗连锁管理、机构投资、医学教育和供应链为核心的口腔医疗集团；品牌资料显示，其在长三角和珠三角布局多家机构，深圳门店可承接口腔种植、修复和数字化口腔评估。',
  recommendationReason: '本次牙科方向仅推荐深圳鼎植口腔。该机构适合围绕缺牙、半口/全口种植、骨量不足、贴面修复等诉求做CBCT评估、种植方案设计、费用拆分和分阶段复诊安排。',
  preparation: '建议先提交口腔全景片/CBCT、缺牙位置、既往拔牙/根管/种植记录、牙周情况和药物过敏史，由鼎植团队判断保牙、种植或修复路径。',
}

export const dentalAdvantages = [
  {
    label: 'VIIV穿颧穿翼种植能力',
    value: '品牌资料显示，鼎植VIIV专利种牙可通过颧骨、翼板等结构辅助固定种植体，适用于部分骨量不足、半口/全口缺牙或常规种植受限的患者；是否适用必须以CBCT和医生评估为准。',
  },
  {
    label: '数字化方案设计',
    value: '可基于CBCT/3D模型规划种植体位置、角度、深度和型号，帮助患者在专业版中提前看到种植牙模拟方案和手术概要。',
  },
  {
    label: '价格和材料透明',
    value: '资料中给出了半口即刻负重、复杂穿翼/穿颧路径以及高端牙贴面的人民币价格区间，报告会优先按项目、颗数、材料和复诊阶段拆分。',
  },
]

export const dentalImplantPriceItems = [
  { item: '半口即刻负重（上半口/下半口，一般All-on-6）', cost: dual(98000), note: '特殊病例可能增加1-2颗植体；最终以CBCT、骨量和医生方案为准。' },
  { item: '半口即刻负重需双侧穿翼或下颌复杂技术', cost: dual(128000), note: '适用于部分上半口双侧穿翼、下半口神经游离或穿下颌骨等复杂路径。' },
  { item: '上半口穿颧/穿翼复杂即刻负重', cost: dual(198000, 298000), note: '覆盖双穿颧双穿翼、四穿颧双穿翼等复杂场景，需医生确认适应证。' },
]

export const dentalVeneerPriceItems = [
  { item: '高端牙贴面单颗', cost: dual(2680, 5800), note: '覆盖义获嘉蓝瓷、HASS明星瓷、登士柏、德国VITA琥珀瓷等不同材料和纹理工艺。' },
  { item: '高端牙贴面8颗', cost: dual(19800, 42800), note: '按材料品牌、纹理仿真和手工工艺不同浮动。' },
  { item: '高端牙贴面16颗', cost: dual(35800, 85000), note: '适合美学修复诉求，需结合咬合、牙周和医生设计。' },
]

export const dentalImplantSteps = [
  '术前面诊检查：拍片/CBCT、医生面诊、制定种植方案和术前检查。',
  '一期手术：植入种植体，通常7-10天拆线，骨结合约3-6个月。',
  '二期手术：安装愈合基台，等待软组织成形。',
  '三期修复：取模、制作牙冠约7-10天，佩戴牙冠并完成修复。',
  '复查维护：建议每3-6个月定期复查，持续管理咬合、牙周和种植体稳定性。',
]

export const dentalSimulationPlan = {
  service: '种植牙模拟方案',
  value: '专业报告可加入种植牙模拟设计服务：根据CBCT/口腔影像输出诊断概览、3D设计概览、种植体位置/型号/角度/深度规划和手术概要，帮助患者在来华前理解可行路径。',
  requiredMaterials: ['CBCT或口腔全景片', '缺牙位置和牙列照片', '既往拔牙/种植/修复记录', '牙周和咬合情况说明'],
}

export const dentalCostCurrencyNote = '牙科价格明细以资料中的人民币价格为基础，美元为按 1 USD≈7.2 RMB 的约算；最终以鼎植口腔医生检查、材料选择、种植颗数和正式报价为准。'

export const dentalComparableRegionFees: Record<string, string> = {
  美国: '$5,000 - $24,000+',
  加拿大: '$4,800 - $20,000+',
  英国: '$4,500 - $18,000+',
  德国: '$4,500 - $18,000+',
  法国: '$4,000 - $16,000+',
  新加坡: '$4,000 - $17,000+',
  泰国: '$2,800 - $13,000+',
  马来西亚: '$2,500 - $11,000+',
  日本: '$4,500 - $18,000+',
  韩国: '$3,500 - $16,000+',
  澳大利亚: '$5,000 - $22,000+',
  新西兰: '$5,000 - $20,000+',
}

export const isFullArchImplantNeed = (text: string) => /半口|全口|all\s*on|即刻负重|穿颧|穿翼|骨量不足|缺骨|无牙颌/i.test(text)
export const isVeneerNeed = (text: string) => /贴面|美学修复|瓷贴面|veneer/i.test(text)
