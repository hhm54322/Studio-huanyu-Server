export type KnowledgeDisease = {
  label: string
  treatment: string
  direction: string
  duration: string
  chinaFee: string
  score: number
  advantages: string[]
  hospitals: { city: string; name: string; reason: string }[]
  breakdown: { item: string; cost: string }[]
  keywords: string[]
}

export type KnowledgeRegion = {
  flag: string
  name: string
  fee: string
  wait: string
  tech: string
  service: string
  visa: string
  follow: string
}

export const diseases: Record<string, KnowledgeDisease> = {
  breast_cancer: {
    label: '乳腺癌',
    treatment: '乳腺外科评估 + 保乳/根治手术方案比选 + 术后辅助治疗',
    direction: '乳腺专科门诊 -> 影像与病理复核 -> MDT评估 -> 手术方案确认 -> 术后病理分期 -> 化疗/放疗/内分泌治疗',
    duration: '预计在华停留14-28天；如需放化疗，可分阶段来华或远程随访',
    chinaFee: '$15,000 - $28,000',
    score: 86,
    advantages: ['乳腺外科病例量大', '病理与影像复核效率高', '综合治疗路径成熟'],
    hospitals: [
      { city: '上海', name: '复旦大学附属肿瘤医院', reason: '肿瘤专科优势明显，乳腺肿瘤多学科诊疗经验丰富' },
      { city: '北京', name: '北京大学人民医院', reason: '乳腺外科实力强，保乳和综合治疗路径成熟' },
      { city: '北京', name: '北京协和医院', reason: '综合疑难病例处理能力强，国际医疗服务经验较好' },
    ],
    breakdown: [
      { item: '术前检查与病理复核', cost: '$800-$1,800' },
      { item: '乳腺手术及住院', cost: '$7,000-$13,000' },
      { item: '辅助治疗初期费用', cost: '$3,000-$7,000' },
      { item: '翻译、陪诊与就医协调', cost: '$1,200-$2,500' },
      { item: '住宿与生活', cost: '$2,000-$4,000' },
    ],
    keywords: ['乳腺', 'breast', '保乳', '化疗', '肿块'],
  },
  lung_cancer: {
    label: '肺癌',
    treatment: '胸外科/肿瘤内科联合评估 + 基因检测 + 手术、放疗、靶向或免疫治疗路径',
    direction: '胸部增强CT -> 病理与基因检测 -> MDT评估 -> 手术可行性判断 -> 靶向/免疫/放疗方案确认',
    duration: '预计在华停留10-21天完成评估；治疗周期取决于分期和基因检测结果',
    chinaFee: '$12,000 - $35,000',
    score: 84,
    advantages: ['肺癌诊疗路径完整', '基因检测和靶向药可及性较好', '微创胸外科成熟'],
    hospitals: [
      { city: '上海', name: '上海市肺科医院', reason: '肺部疾病专科优势突出，肺癌手术和综合治疗经验丰富' },
      { city: '广州', name: '广东省人民医院', reason: '肺癌多学科与精准治疗能力强' },
      { city: '北京', name: '中国医学科学院肿瘤医院', reason: '国家级肿瘤专科，肺癌规范化治疗经验充分' },
    ],
    breakdown: [
      { item: '影像、病理与基因检测', cost: '$1,200-$3,500' },
      { item: '微创手术及住院', cost: '$8,000-$18,000' },
      { item: '放疗/靶向/免疫初期方案', cost: '$4,000-$12,000' },
      { item: '翻译、陪诊与就医协调', cost: '$1,200-$2,500' },
      { item: '住宿与生活', cost: '$1,500-$4,000' },
    ],
    keywords: ['肺', 'lung', '咳嗽', '结节', '靶向', '免疫'],
  },
  nasopharyngeal_cancer: {
    label: '鼻咽癌',
    treatment: '头颈肿瘤MDT + 精准放疗 + 同步/诱导化疗评估',
    direction: '鼻咽镜与影像复核 -> 分期评估 -> 放疗计划设计 -> 化疗联合策略 -> 营养与口腔管理',
    duration: '预计在华停留21-45天；完整放疗周期通常需6-7周',
    chinaFee: '$18,000 - $38,000',
    score: 88,
    advantages: ['华南地区鼻咽癌病例经验丰富', '调强放疗与综合管理成熟', '随访路径规范'],
    hospitals: [
      { city: '广州', name: '中山大学肿瘤防治中心', reason: '鼻咽癌诊疗国际影响力强，放疗与综合治疗经验丰富' },
      { city: '上海', name: '复旦大学附属肿瘤医院', reason: '头颈肿瘤专科能力强，放疗技术成熟' },
      { city: '北京', name: '中国医学科学院肿瘤医院', reason: '国家级肿瘤中心，规范化治疗能力强' },
    ],
    breakdown: [
      { item: '影像分期与鼻咽镜检查', cost: '$900-$2,000' },
      { item: '放疗计划与完整疗程', cost: '$10,000-$22,000' },
      { item: '同步/诱导化疗', cost: '$4,000-$9,000' },
      { item: '翻译、陪诊与营养支持', cost: '$1,500-$3,000' },
      { item: '住宿与生活', cost: '$3,000-$6,000' },
    ],
    keywords: ['鼻咽', 'nasopharyngeal', '头颈', '放疗'],
  },
  liver_cancer: {
    label: '肝癌',
    treatment: '肝胆外科/介入/肿瘤内科联合评估 + 手术、消融、介入或系统治疗',
    direction: '肝脏增强MRI/CT -> 肝功能与病毒学评估 -> MDT判断手术/消融/介入 -> 系统治疗与随访计划',
    duration: '预计在华停留10-24天；介入或系统治疗可能需分阶段复诊',
    chinaFee: '$10,000 - $30,000',
    score: 85,
    advantages: ['肝胆外科和介入治疗病例量大', '治疗路径选择丰富', '费用相对欧美更可控'],
    hospitals: [
      { city: '上海', name: '东方肝胆外科医院', reason: '肝胆肿瘤外科特色突出，复杂肝癌处理经验丰富' },
      { city: '上海', name: '复旦大学附属中山医院', reason: '肝外科、介入和综合管理能力强' },
      { city: '广州', name: '中山大学肿瘤防治中心', reason: '肝癌综合治疗和肿瘤专科管理成熟' },
    ],
    breakdown: [
      { item: '肝脏影像与肝功能评估', cost: '$800-$1,800' },
      { item: '手术/消融/介入治疗', cost: '$6,000-$18,000' },
      { item: '系统治疗初期费用', cost: '$4,000-$10,000' },
      { item: '翻译、陪诊与就医协调', cost: '$1,200-$2,500' },
      { item: '住宿与生活', cost: '$1,500-$4,000' },
    ],
    keywords: ['肝', 'liver', '介入', '消融', '乙肝'],
  },
  cardiovascular_tumor: {
    label: '心血管肿瘤',
    treatment: '心血管影像复核 + 肿瘤/心内/心外多学科评估 + 手术或介入方案比选',
    direction: '心脏超声/增强CT/MRI复核 -> 肿瘤性质与累及范围评估 -> MDT会诊 -> 手术、介入或系统治疗路径确认',
    duration: '预计在华停留10-28天；复杂手术或围术期管理需根据心功能延长',
    chinaFee: '$15,000 - $45,000',
    score: 82,
    advantages: ['综合医院多学科协作能力强', '心血管影像和围术期管理成熟', '复杂病例可集中会诊'],
    hospitals: [
      { city: '北京', name: '中国医学科学院阜外医院', reason: '心血管专科优势突出，复杂心脏疾病评估经验丰富' },
      { city: '上海', name: '复旦大学附属中山医院', reason: '心血管内外科与综合诊疗能力强' },
      { city: '广州', name: '广东省人民医院', reason: '心血管诊疗体系完善，疑难病例处理经验较多' },
    ],
    breakdown: [
      { item: '心血管影像与功能评估', cost: '$1,000-$3,000' },
      { item: 'MDT会诊与术前准备', cost: '$800-$2,000' },
      { item: '手术/介入及住院', cost: '$12,000-$32,000' },
      { item: '翻译、陪诊与就医协调', cost: '$1,500-$3,000' },
      { item: '住宿与生活', cost: '$2,000-$5,000' },
    ],
    keywords: ['心血管肿瘤', '心脏肿瘤', 'cardiovascular tumor', '心包', '心肌肿瘤'],
  },
  neurosurgery: {
    label: '神经外科',
    treatment: '神经外科影像复核 + 显微/内镜/放射外科方案评估',
    direction: 'MRI/CTA/功能影像复核 -> 神经外科会诊 -> 手术风险评估 -> 显微手术/伽马刀/康复路径',
    duration: '预计在华停留10-25天；复杂病例需根据术后恢复延长',
    chinaFee: '$12,000 - $35,000',
    score: 82,
    advantages: ['神经外科中心病例量大', '显微手术和放射外科选择较多', '康复衔接能力较好'],
    hospitals: [
      { city: '北京', name: '首都医科大学附属北京天坛医院', reason: '神经外科全国领先，脑肿瘤和脑血管病经验丰富' },
      { city: '上海', name: '复旦大学附属华山医院', reason: '神经外科综合实力强，疑难病例处理能力突出' },
      { city: '上海', name: '上海交通大学医学院附属瑞金医院', reason: '综合医院支持完善，围术期管理能力强' },
    ],
    breakdown: [
      { item: '高级影像与术前评估', cost: '$1,000-$2,500' },
      { item: '神经外科手术及住院', cost: '$9,000-$25,000' },
      { item: '术后监护与康复评估', cost: '$2,000-$6,000' },
      { item: '翻译、陪诊与就医协调', cost: '$1,500-$3,000' },
      { item: '住宿与生活', cost: '$1,500-$4,000' },
    ],
    keywords: ['脑', '神经', '垂体', '胶质', '动脉瘤', 'neuro'],
  },
  spine_surgery: {
    label: '脊柱外科',
    treatment: '脊柱影像复核 + 微创/开放手术方案比选 + 康复计划',
    direction: 'MRI/CT复核 -> 脊柱外科会诊 -> 神经功能评估 -> 手术/保守治疗决策 -> 康复训练',
    duration: '预计在华停留10-21天；术后康复可远程跟进',
    chinaFee: '$9,000 - $26,000',
    score: 80,
    advantages: ['微创脊柱技术成熟', '住院效率较高', '术后康复衔接便利'],
    hospitals: [
      { city: '上海', name: '上海长征医院', reason: '脊柱外科特色强，复杂脊柱疾病经验丰富' },
      { city: '北京', name: '北京积水潭医院', reason: '骨科综合实力强，脊柱和创伤经验丰富' },
      { city: '广州', name: '南方医科大学南方医院', reason: '脊柱外科与康复支持较完善' },
    ],
    breakdown: [
      { item: '影像复核与神经功能评估', cost: '$700-$1,800' },
      { item: '脊柱手术及住院', cost: '$7,000-$20,000' },
      { item: '康复与支具费用', cost: '$1,000-$3,500' },
      { item: '翻译、陪诊与就医协调', cost: '$1,200-$2,500' },
      { item: '住宿与生活', cost: '$1,500-$3,500' },
    ],
    keywords: ['脊柱', '腰椎', '颈椎', 'spine', '椎间盘'],
  },
  premium_checkup: {
    label: '高端体检',
    treatment: '高端体检套餐 + 肿瘤早筛/心脑血管风险筛查 + 专家解读',
    direction: '风险问卷 -> 个性化体检套餐 -> 影像/实验室检查 -> 专家解读 -> 健康管理建议',
    duration: '预计在华停留3-7天，可与旅行或商务行程合并安排',
    chinaFee: '$1,500 - $8,000',
    score: 78,
    advantages: ['检查效率高', '套餐灵活', '高端影像和专家解读费用可控'],
    hospitals: [
      { city: '上海', name: '上海国际医学中心', reason: '国际化服务流程成熟，高端体检体验较好' },
      { city: '北京', name: '北京和睦家医院', reason: '多语言服务和外籍患者体验成熟' },
      { city: '博鳌', name: '博鳌乐城国际医疗旅游先行区', reason: '适合高端筛查、特许药械和国际医疗服务组合' },
    ],
    breakdown: [
      { item: '基础体检与实验室检查', cost: '$500-$1,500' },
      { item: '高端影像/肿瘤早筛', cost: '$800-$4,000' },
      { item: '专家解读与健康管理', cost: '$300-$1,500' },
      { item: '翻译与行程协调', cost: '$500-$1,200' },
      { item: '住宿与生活', cost: '$800-$2,000' },
    ],
    keywords: ['体检', '筛查', 'checkup', '健康管理'],
  },
  dental: {
    label: '牙科',
    treatment: '口腔综合评估 + 种植/正畸/修复方案 + 分阶段治疗计划',
    direction: '口腔影像 -> 牙周与咬合评估 -> 种植/正畸/修复方案 -> 费用和周期确认',
    duration: '预计在华停留5-14天；种植和正畸通常需要分阶段复诊',
    chinaFee: '$1,000 - $12,000',
    score: 76,
    advantages: ['种植和修复费用相对可控', '城市选择多', '可与其他行程合并'],
    hospitals: [
      { city: '北京', name: '北京大学口腔医院', reason: '口腔专科全国领先，复杂口腔问题处理能力强' },
      { city: '上海', name: '上海交通大学医学院附属第九人民医院', reason: '口腔颌面与修复能力强' },
      { city: '广州', name: '中山大学附属口腔医院', reason: '华南口腔专科实力突出' },
    ],
    breakdown: [
      { item: '口腔检查与影像', cost: '$100-$500' },
      { item: '种植/修复/正畸初期治疗', cost: '$800-$8,000' },
      { item: '材料与技工费用', cost: '$500-$3,000' },
      { item: '翻译与预约协调', cost: '$300-$1,000' },
      { item: '住宿与生活', cost: '$800-$2,000' },
    ],
    keywords: ['牙', '口腔', '种植', '正畸', 'dental'],
  },
  cardiology_cardiothoracic: {
    label: '心内科与心胸外科',
    treatment: '心血管专科评估 + 介入/外科手术方案比选 + 围术期管理',
    direction: '心电/超声/冠脉CTA或造影 -> 心内科与心胸外科联合评估 -> 介入、手术或药物方案确认 -> 康复与随访计划',
    duration: '预计在华停留7-21天；复杂外科手术或康复可能延长至28天以上',
    chinaFee: '$8,000 - $38,000',
    score: 83,
    advantages: ['心血管中心病例量大', '介入和外科路径选择丰富', '围术期管理和康复衔接较完整'],
    hospitals: [
      { city: '北京', name: '中国医学科学院阜外医院', reason: '国家级心血管专科，心内介入和心外科能力突出' },
      { city: '上海', name: '复旦大学附属中山医院', reason: '心血管综合实力强，疑难危重病例处理经验丰富' },
      { city: '武汉', name: '武汉亚洲心脏病医院', reason: '心脏专科服务成熟，适合部分国际患者评估与治疗' },
    ],
    breakdown: [
      { item: '心血管检查与风险评估', cost: '$600-$2,000' },
      { item: '介入/手术及住院', cost: '$6,000-$28,000' },
      { item: '药物调整与康复指导', cost: '$800-$3,000' },
      { item: '翻译、陪诊与就医协调', cost: '$1,200-$2,500' },
      { item: '住宿与生活', cost: '$1,500-$4,000' },
    ],
    keywords: ['心内', '心胸', '冠心病', '瓣膜', '搭桥', 'cardiology', 'cardiothoracic'],
  },
  endocrinology_metabolism: {
    label: '内分泌与代谢科',
    treatment: '内分泌代谢评估 + 个体化用药/生活方式干预 + 并发症筛查',
    direction: '代谢指标与激素谱检查 -> 并发症筛查 -> 专家评估 -> 药物、营养和运动方案 -> 远程随访调整',
    duration: '预计在华停留5-14天；慢病管理以远程随访和阶段性复诊为主',
    chinaFee: '$2,000 - $12,000',
    score: 77,
    advantages: ['慢病综合管理资源丰富', '检查效率高', '适合与体检和专科复查组合安排'],
    hospitals: [
      { city: '上海', name: '上海交通大学医学院附属瑞金医院', reason: '内分泌代谢专科优势明显，糖尿病和甲状腺疾病经验丰富' },
      { city: '北京', name: '北京协和医院', reason: '疑难内分泌疾病诊疗能力强' },
      { city: '成都', name: '四川大学华西医院', reason: '综合医院平台完善，代谢性疾病管理经验丰富' },
    ],
    breakdown: [
      { item: '实验室检查与激素/代谢评估', cost: '$400-$1,500' },
      { item: '影像与并发症筛查', cost: '$500-$2,500' },
      { item: '专家会诊与管理方案', cost: '$500-$2,000' },
      { item: '翻译、陪诊与健康管理', cost: '$700-$2,000' },
      { item: '住宿与生活', cost: '$800-$3,000' },
    ],
    keywords: ['内分泌', '代谢', '糖尿病', '甲状腺', '肥胖', 'endocrinology', 'metabolism'],
  },
  other: {
    label: '综合医学评估',
    treatment: '病历资料整理 + 专科方向识别 + 中国医院与专家初步匹配',
    direction: '症状与既往资料梳理 -> 明确优先专科 -> 补充检查清单 -> 专家预审 -> 形成来华就医路径建议',
    duration: '预计在华停留7-21天；需根据最终匹配专科和检查结果调整',
    chinaFee: '$3,000 - $20,000',
    score: 72,
    advantages: ['可先完成方向判断', '便于减少盲目跨境就医成本', '适合多症状或诊断未明患者'],
    hospitals: [
      { city: '北京', name: '北京协和医院', reason: '综合疑难病例处理能力强，适合诊断未明或多系统问题评估' },
      { city: '上海', name: '复旦大学附属中山医院', reason: '综合专科能力均衡，便于多学科协调' },
      { city: '广州', name: '中山大学附属第一医院', reason: '综合医院平台完善，华南地区转诊资源丰富' },
    ],
    breakdown: [
      { item: '病历翻译与资料整理', cost: '$300-$1,000' },
      { item: '基础检查与专科筛查', cost: '$800-$4,000' },
      { item: '专家评估与路径规划', cost: '$500-$2,500' },
      { item: '翻译、陪诊与就医协调', cost: '$1,000-$2,500' },
      { item: '住宿与生活', cost: '$1,500-$5,000' },
    ],
    keywords: ['其他', '不确定', '综合', '疑难', 'second opinion', '评估'],
  },
}

export const defaultDisease = diseases.other

export const regions: Record<string, KnowledgeRegion[]> = {
  north_america: [
    { flag: '🇺🇸', name: '美国', fee: '$80,000 - $180,000', wait: '2-8周', tech: '新药和临床试验可及性强，但费用高', service: '国际患者服务成熟，流程较复杂', visa: 'B1/B2签证，通常需要面签预约', follow: '跨境随访便利性一般，费用高' },
    { flag: '🇨🇦', name: '加拿大', fee: '$45,000 - $100,000', wait: '公立等待较长；私立资源有限', tech: '规范化程度高，但国际患者通道有限', service: '英语/法语服务成熟', visa: '访客签证周期不确定', follow: '远程随访需单独协调' },
  ],
  europe: [
    { flag: '🇬🇧', name: '英国', fee: '$45,000 - $90,000', wait: 'NHS等待较长；私立1-4周', tech: '临床规范和研究能力强', service: '私立医院英文服务成熟', visa: '医疗访问签证材料要求较高', follow: '回国后随访支持有限' },
    { flag: '🇩🇪', name: '德国', fee: '$40,000 - $85,000', wait: '2-5周', tech: '外科、康复和工程化医疗能力强', service: '英语服务视医院而定', visa: '申根医疗签证，材料准备较多', follow: '德语区复诊和资料翻译成本较高' },
    { flag: '🇫🇷', name: '法国', fee: '$35,000 - $75,000', wait: '2-6周', tech: '专科诊疗规范化程度较高，需结合具体病种和医院资源评估', service: '法语环境为主，英文支持有限', visa: '申根医疗签证', follow: '跨境随访便利性一般' },
  ],
  southeast_asia: [
    { flag: '🇸🇬', name: '新加坡', fee: '$30,000 - $70,000', wait: '1-3周', tech: '亚洲高水平医疗，双语环境', service: '国际患者服务成熟', visa: '入境便利，医疗停留需确认期限', follow: '英文随访较便利但费用较高' },
    { flag: '🇹🇭', name: '泰国', fee: '$10,000 - $35,000', wait: '1-2周', tech: '医疗旅游成熟，复杂病例资源差异较大', service: '服务体验较好', visa: '旅游签或医疗签相对便利', follow: '远程随访体系相对薄弱' },
    { flag: '🇲🇾', name: '马来西亚', fee: '$12,000 - $32,000', wait: '1-3周', tech: '性价比突出，部分专科发展较快', service: '英文/中文环境较友好', visa: '入境便利', follow: '中文/英文随访支持较好' },
  ],
  middle_east: [
    { flag: '🇦🇪', name: '阿联酋', fee: '$35,000 - $90,000', wait: '1-3周', tech: '高端私立医疗发展快，复杂病例依赖专家资源', service: '国际化服务强', visa: '入境便利，医疗签证可协调', follow: '适合中东患者短途复诊' },
    { flag: '🇸🇦', name: '沙特', fee: '$30,000 - $80,000', wait: '2-5周', tech: '大型医疗中心能力较强', service: '阿语环境为主，国际服务差异较大', visa: '签证政策需按个案确认', follow: '区域内随访便利' },
  ],
  japan_korea: [
    { flag: '🇯🇵', name: '日本', fee: '$35,000 - $85,000', wait: '2-6周', tech: '早筛、影像和精细化诊疗强', service: '日语为主，英文服务有限', visa: '医疗签证通常需日方担保', follow: '语言和文化沟通成本较高' },
    { flag: '🇰🇷', name: '韩国', fee: '$25,000 - $65,000', wait: '1-4周', tech: '专科服务和医疗旅游流程较成熟，需按具体科室与项目评估', service: '国际患者服务较成熟', visa: '医疗旅游签证相对成熟', follow: '亚洲范围随访较便利' },
  ],
  australia_new_zealand: [
    { flag: '🇦🇺', name: '澳大利亚', fee: '$45,000 - $100,000', wait: '3-8周', tech: '规范化诊疗和康复体系成熟', service: '英文服务成熟', visa: '医疗访问签证材料较多', follow: '远程随访可行但成本较高' },
    { flag: '🇳🇿', name: '新西兰', fee: '$40,000 - $90,000', wait: '3-8周', tech: '医疗规范，但国际专科资源有限', service: '英文服务成熟', visa: '访问签证周期需确认', follow: '回国后持续跟进成本较高' },
  ],
  other: [
    { flag: '🌐', name: '其他目的地', fee: '需按具体国家评估', wait: '需按医院资源确认', tech: '建议结合病种和预算重新筛选', service: '国际患者支持差异较大', visa: '签证政策需个案确认', follow: '需提前确认远程随访机制' },
  ],
}

export const packages = [
  {
    name: '书面评估基础包',
    price: '60💲',
    icon: 'FileText',
    highlight: false,
    features: ['病历整理与归档', '专家智能匹配', '书面初步评估PDF'],
  },
  {
    name: '单次视频面诊标准包',
    price: '235💲',
    icon: 'Video',
    highlight: true,
    features: ['专家视频面诊15-30分钟', '书面诊疗总结', '7天内1次跟进答疑'],
  },
  {
    name: '双专家视频面诊深度包',
    price: '450💲',
    icon: 'MessageSquare',
    highlight: false,
    features: ['2位相关科室专家会诊', '综合诊疗报告', '14天内2次跟进答疑'],
  },
]
