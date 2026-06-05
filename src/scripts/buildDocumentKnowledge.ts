import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import mammoth from 'mammoth'
import { PDFParse } from 'pdf-parse'
import type { DocumentKnowledgeBlock, KnowledgeCategory } from '../report/documentKnowledge.js'

const repoRoot = path.resolve(process.cwd(), '..')
const outputPath = path.resolve(process.cwd(), 'src/report/generated/documentKnowledge.json')

const includedRoots = [
  'Kimi_Agent_双版医疗导航网站-4',
  '.',
]

const includedRootFiles = new Set([
  '专业版本报告提示词.md',
  '报告完整提示词.docx',
  '国际医疗保险中国就医白皮书.md',
  'china_medical_tourism_whitepaper.docx',
  '中国高端肿瘤治疗设备名单.docx',
  '外籍患者来华就医智能方案报告（Demo模板·脊髓星形细胞瘤WHO4级）.docx',
  '《全球医院基础信息查询及各科室专家查询白皮书》.docx',
])

const excludedSegments = new Set([
  'node_modules',
  'dist',
  '.git',
  'cloudflare-upload',
  'deploy-hospital',
  'final-deploy',
  'hospital-site-deploy',
  'patient-site',
  'unified-site',
  'webapp',
  'Kimi_Agent_双版医疗导航网站-3',
  'Studio-huanyu-Client',
  'Studio-huanyu-Server',
  '保险自查',
])

const allowedExtensions = new Set(['.md', '.txt', '.docx', '.pdf'])
const maxSourceChars = 180_000
const maxChunkChars = 2200
const minChunkChars = 180

const diseaseLexicon: Record<string, string[]> = {
  dental: ['牙', '口腔', '龋', '蛀牙', '牙痛', '牙疼', '根管', '种植', '牙周', 'cbct'],
  breast_cancer: ['乳腺', '乳腺癌', '保乳', 'her2', 'ki-67', '内分泌治疗'],
  lung_cancer: ['肺癌', '肺结节', '胸部ct', 'egfr', 'alk', 'pd-l1', '靶向', '免疫治疗'],
  nasopharyngeal_cancer: ['鼻咽', '鼻咽癌', 'ebv', '头颈', '调强放疗'],
  liver_cancer: ['肝癌', '肝脏', 'afp', '乙肝', '消融', '介入'],
  cardiovascular_tumor: ['心血管肿瘤', '心脏肿瘤', '心包', '心脏占位'],
  cardiology_cardiothoracic: ['心血管', '心脏', '冠脉', '搭桥', '瓣膜', 'tavi', '心内', '心胸'],
  neurosurgery: ['神经外科', '脑', '胶质', '脊髓星形细胞瘤', '垂体', '伽马刀'],
  spine_surgery: ['脊柱', '腰椎', '颈椎', '椎间盘', '脊髓'],
  endocrinology_metabolism: ['内分泌', '糖尿病', '甲状腺', '代谢', '糖化血红蛋白'],
  premium_checkup: ['体检', '筛查', '早筛', '健康管理', '胃肠镜'],
}

const regionLexicon: Record<string, string[]> = {
  north_america: ['美国', '加拿大', '北美', 'us ', 'usa'],
  europe: ['英国', '德国', '法国', '欧洲', '申根'],
  southeast_asia: ['新加坡', '泰国', '马来西亚', '东南亚'],
  japan_korea: ['日本', '韩国', '日韩'],
  middle_east: ['中东', '阿联酋', '沙特'],
  australia_new_zealand: ['澳大利亚', '新西兰', '澳新'],
}

const categoryLexicon: Record<KnowledgeCategory, string[]> = {
  report_structure: ['报告结构', '黄金动线', '提示词', '模板', '章节', '生成规则', '报告生成'],
  medical_safety: ['免责声明', '风险提示', '不构成诊断', '医生面诊', '缺失材料', '诚实', '合规'],
  cost: ['费用', '价格', '美元', '人民币', '成本', '报价', '预算', '隐形收费'],
  insurance: ['保险', '理赔', '直付', '预授权', 'aetna', 'cigna', 'bupa', 'allianz', 'axa'],
  hospital: ['医院', '专家', '科室', 'jci', '国际部', '三甲'],
  equipment: ['设备', '质子', '重离子', 'bnct', '达芬奇', '伽马刀', 'tomo', 'car-t'],
  travel: ['签证', '邀请函', '住宿', '机票', '行程', '接机'],
  service: ['翻译', '陪诊', '管家', '随访', '远程复诊', '服务包'],
  market: ['医疗旅游', '市场', '规模', 'cagr', '白皮书'],
  disease: ['病理', '分期', '治疗方案', '预后', '生存率', '复发率'],
  general: [],
}

const normalize = (text: string) => text.toLowerCase().replace(/\s+/g, '')

const includesAny = (text: string, keywords: string[]) => {
  const normalized = normalize(text)
  return keywords.some((keyword) => normalized.includes(normalize(keyword)))
}

const walk = async (dir: string): Promise<string[]> => {
  const entries = await readdir(dir, { withFileTypes: true })
  const files: string[] = []

  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.name !== '.') continue
    if (excludedSegments.has(entry.name)) continue

    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...await walk(fullPath))
      continue
    }

    if (entry.isFile() && allowedExtensions.has(path.extname(entry.name).toLowerCase())) {
      files.push(fullPath)
    }
  }

  return files
}

const shouldIncludeSource = (relativeSource: string) => {
  const normalized = relativeSource.split(path.sep).join('/')
  if (normalized.startsWith('Kimi_Agent_双版医疗导航网站-4/')) {
    if (normalized.endsWith('/README.md') || normalized.endsWith('/info.md')) return false
    return allowedExtensions.has(path.extname(normalized).toLowerCase())
  }

  return includedRootFiles.has(path.basename(normalized))
}

const collectFiles = async () => {
  const seen = new Set<string>()
  const files: string[] = []

  for (const root of includedRoots) {
    const absoluteRoot = path.resolve(repoRoot, root)
    try {
      const rootStat = await stat(absoluteRoot)
      if (!rootStat.isDirectory()) continue
      for (const file of await walk(absoluteRoot)) {
        const relative = path.relative(repoRoot, file)
        if (!shouldIncludeSource(relative)) continue
        if (seen.has(relative)) continue
        seen.add(relative)
        files.push(file)
      }
    } catch {
      // Missing optional source directory.
    }
  }

  return files
}

const readPdf = async (filePath: string) => {
  const buffer = await readFile(filePath)
  const parser = new PDFParse({ data: buffer })
  try {
    const result = await parser.getText()
    return result.text
  } finally {
    await parser.destroy()
  }
}

const readSourceText = async (filePath: string) => {
  const ext = path.extname(filePath).toLowerCase()
  if (ext === '.docx') {
    const result = await mammoth.extractRawText({ path: filePath })
    return result.value
  }
  if (ext === '.pdf') return readPdf(filePath)
  return readFile(filePath, 'utf8')
}

const stripMarkdown = (text: string) => text
  .replace(/```[\s\S]*?```/g, ' ')
  .replace(/!\[[^\]]*]\([^)]*\)/g, ' ')
  .replace(/\[[^\]]+]\([^)]*\)/g, ' ')
  .replace(/[#>*_`|~-]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()

const isNoisyChunk = (text: string) => {
  const compact = text.toLowerCase()
  const noisyMarkers = [
    'graph tb',
    'subgraph',
    'className',
    'import ',
    'export default',
    'npm ',
    'pnpm ',
    'vite',
    'package.json',
    '<template',
    '<script',
    '<style',
    '```',
  ]
  if (noisyMarkers.some((marker) => compact.includes(marker.toLowerCase()))) return true

  const symbolCount = (text.match(/[{}[\]<>=>|`]/g) || []).length
  if (symbolCount > Math.max(18, text.length * 0.035)) return true

  const lineLikeCount = (text.match(/(?:^|\s)(?:const|let|var|function|interface|type)\s+[A-Za-z_$]/g) || []).length
  return lineLikeCount >= 3
}

const splitIntoChunks = (text: string) => {
  const paragraphs = text
    .split(/\n{2,}|(?=^#{1,4}\s+)/m)
    .map((item) => stripMarkdown(item))
    .filter((item) => item.length >= minChunkChars && !isNoisyChunk(item))

  const chunks: string[] = []
  let current = ''

  for (const paragraph of paragraphs) {
    if ((current + paragraph).length > maxChunkChars && current.length >= minChunkChars) {
      chunks.push(current.trim())
      current = ''
    }
    current += `${paragraph}\n`
  }
  if (current.trim().length >= minChunkChars) chunks.push(current.trim())

  return chunks
}

const classifyCategory = (text: string, filePath: string): KnowledgeCategory => {
  const combined = `${filePath} ${text}`
  const scored = Object.entries(categoryLexicon).map(([category, keywords]) => ({
    category: category as KnowledgeCategory,
    score: keywords.filter((keyword) => includesAny(combined, [keyword])).length,
  })).sort((left, right) => right.score - left.score)

  return scored[0]?.score ? scored[0].category : 'general'
}

const matchKeys = (text: string, lexicon: Record<string, string[]>) => Object.entries(lexicon)
  .filter(([, keywords]) => includesAny(text, keywords))
  .map(([key]) => key)

const extractKeywords = (text: string, category: KnowledgeCategory, diseaseKeys: string[], regionKeys: string[]) => {
  const keywords = new Set<string>([category, ...diseaseKeys, ...regionKeys])
  const domainTerms = [
    '费用', '保险', '预授权', '直付', '签证', '邀请函', '翻译', '陪诊', '随访', '远程复诊',
    '医院', '专家', '国际部', '质子', '重离子', 'bnct', '达芬奇', '伽马刀', 'car-t',
    '病理', '影像', '基因', '分期', '手术', '放疗', '化疗', '靶向', '免疫', '体检',
    '种植', '根管', 'cbct', '糖尿病', '甲状腺', '冠脉', '脊柱', '神经外科',
  ]
  for (const term of domainTerms) {
    if (includesAny(text, [term])) keywords.add(term)
  }
  return Array.from(keywords).slice(0, 18)
}

const extractNumbers = (text: string) => Array.from(new Set(text.match(/(?:\d+(?:\.\d+)?%|\$\s?\d[\d,]*(?:-\$?\s?\d[\d,]*)?|¥\s?\d[\d,]*|\d+(?:-\d+)?\s?(?:天|周|月|年|个工作日|小时))/g) || [])).slice(0, 5)

const makeGuidance = (category: KnowledgeCategory, text: string) => {
  const guidanceByCategory: Record<KnowledgeCategory, string> = {
    report_structure: '作为报告结构和决策动线参考，按当前患者资料重组章节，不复制模板表述。',
    medical_safety: '作为合规与风险披露约束，缺资料时明确提示，不输出诊断承诺或疗效承诺。',
    cost: '作为费用拆分和波动因素参考，按当前病种、治疗强度和资料完整度生成区间。',
    insurance: '作为保险预授权、直付和理赔材料提醒参考，避免承诺一定报销。',
    hospital: '作为医院/科室匹配方向参考，推荐理由必须结合当前病情和资料状态。',
    equipment: '作为设备和技术可及性参考，只在与当前病种相关时使用。',
    travel: '作为来华行程、签证、住宿和陪同安排参考，按紧急程度调整。',
    service: '作为服务包和跨境随访设计参考，避免营销夸大。',
    market: '作为宏观背景参考，除非用户需要市场解释，否则不进入核心医学结论。',
    disease: '作为疾病路径、检查材料和治疗排序参考，需结合用户上传资料判断适用性。',
    general: '作为背景资料参考，仅在与当前用户问题匹配时使用。',
  }

  const numbers = extractNumbers(text)
  const numericHint = numbers.length ? `可参考的数值线索包括：${numbers.join('、')}。` : ''
  return `${guidanceByCategory[category]}${numericHint}`
}

const categoryLabel: Record<KnowledgeCategory, string> = {
  report_structure: '报告结构与生成质量',
  medical_safety: '医学安全与合规边界',
  cost: '费用拆分与区间估算',
  insurance: '保险预授权与理赔材料',
  hospital: '医院、科室与专家匹配',
  equipment: '设备和技术可及性',
  travel: '来华就医行程与签证',
  service: '跨境服务与随访安排',
  market: '国际医疗市场背景',
  disease: '疾病路径和资料要求',
  general: '综合背景',
}

const keywordLabel: Record<string, string> = {
  dental: '牙科/口腔',
  breast_cancer: '乳腺肿瘤',
  lung_cancer: '肺部肿瘤',
  nasopharyngeal_cancer: '鼻咽/头颈肿瘤',
  liver_cancer: '肝脏疾病/肿瘤',
  cardiovascular_tumor: '心血管肿瘤',
  cardiology_cardiothoracic: '心血管/心胸',
  neurosurgery: '神经外科',
  spine_surgery: '脊柱外科',
  endocrinology_metabolism: '内分泌代谢',
  premium_checkup: '高端体检',
  north_america: '北美',
  europe: '欧洲',
  southeast_asia: '东南亚',
  japan_korea: '日韩',
  middle_east: '中东',
  australia_new_zealand: '澳新',
}

const summarizeEvidence = (
  text: string,
  category: KnowledgeCategory,
  diseaseKeys: string[],
  regionKeys: string[],
  keywords: string[],
) => {
  const diseasePart = diseaseKeys.length ? `，适用病种线索：${diseaseKeys.map((key) => keywordLabel[key] || key).join('、')}` : ''
  const regionPart = regionKeys.length ? `，地区线索：${regionKeys.map((key) => keywordLabel[key] || key).join('、')}` : ''
  const aspectKeywords = keywords
    .filter((keyword) => ![category, ...diseaseKeys, ...regionKeys].includes(keyword))
    .slice(0, 8)
  const aspectPart = aspectKeywords.length ? `，涉及要点：${aspectKeywords.join('、')}` : ''
  const numberPart = extractNumbers(text).length ? `，含${extractNumbers(text).join('、')}等数值线索` : ''
  return `该资料被抽象为${categoryLabel[category]}参考${diseasePart}${regionPart}${aspectPart}${numberPart}；生成报告时需按患者资料重新判断适用性。`
}

const sourceTitle = (filePath: string) => path.basename(filePath).replace(/\.(md|txt|docx|pdf)$/i, '')

const build = async () => {
  const files = await collectFiles()
  const blocks: DocumentKnowledgeBlock[] = []

  for (const filePath of files) {
    let text = ''
    try {
      text = (await readSourceText(filePath)).slice(0, maxSourceChars)
    } catch (error) {
      console.warn(`Skip unreadable source ${path.relative(repoRoot, filePath)}: ${error instanceof Error ? error.message : String(error)}`)
      continue
    }

    const relativeSource = path.relative(repoRoot, filePath)
    const chunks = splitIntoChunks(text)
    chunks.forEach((chunk, index) => {
      const sourceAwareText = `${relativeSource} ${chunk}`
      const category = classifyCategory(sourceAwareText, relativeSource)
      const diseaseKeys = matchKeys(sourceAwareText, diseaseLexicon)
      const regionKeys = matchKeys(sourceAwareText, regionLexicon)
      const keywords = extractKeywords(sourceAwareText, category, diseaseKeys, regionKeys)

      blocks.push({
        id: `${relativeSource.replace(/[^a-zA-Z0-9]+/g, '_')}_${index + 1}`,
        source: relativeSource,
        title: sourceTitle(filePath),
        category,
        diseaseKeys,
        regionKeys,
        keywords,
        guidance: makeGuidance(category, chunk),
        evidenceSummary: summarizeEvidence(chunk, category, diseaseKeys, regionKeys, keywords),
        weight: category === 'medical_safety' || category === 'report_structure' ? 5 : 3,
      })
    })
  }

  await mkdir(path.dirname(outputPath), { recursive: true })
  await writeFile(outputPath, `${JSON.stringify({
    generatedAt: new Date().toISOString(),
    sourceRoot: repoRoot,
    sourceCount: files.length,
    blockCount: blocks.length,
    note: 'Knowledge blocks are extracted as guidance and summaries for report generation. They are not intended for verbatim reuse.',
    blocks,
  }, null, 2)}\n`)

  console.log(`Built ${blocks.length} knowledge blocks from ${files.length} source files.`)
  console.log(outputPath)
}

await build()
