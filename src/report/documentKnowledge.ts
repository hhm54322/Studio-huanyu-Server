import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type { ProfessionalReportSubmissionInput } from '../validators/professionalReportSubmission.js'
import type { ReportSubmissionInput } from '../validators/reportSubmission.js'

export type KnowledgeCategory =
  | 'report_structure'
  | 'medical_safety'
  | 'cost'
  | 'insurance'
  | 'hospital'
  | 'equipment'
  | 'travel'
  | 'service'
  | 'market'
  | 'disease'
  | 'general'

export type DocumentKnowledgeBlock = {
  id: string
  source: string
  title: string
  category: KnowledgeCategory
  diseaseKeys: string[]
  regionKeys: string[]
  keywords: string[]
  guidance: string
  evidenceSummary: string
  weight: number
}

export type KnowledgeSearchInput = {
  diseaseKey?: string
  visitPurpose?: string
  chiefComplaint?: string
  diagnosis?: string
  selectedRegions?: string[]
}

const builtKnowledgePath = path.resolve(process.cwd(), 'src/report/generated/documentKnowledge.json')
const fallbackKnowledgePath = path.resolve(process.cwd(), 'dist/report/generated/documentKnowledge.json')

const normalizeText = (text: string) => text.toLowerCase().replace(/\s+/g, '')

const includesAny = (text: string, terms: string[]) => {
  const normalized = normalizeText(text)
  return terms.some((term) => normalized.includes(normalizeText(term)))
}

const loadBlocks = (): DocumentKnowledgeBlock[] => {
  const filePath = existsSync(builtKnowledgePath)
    ? builtKnowledgePath
    : existsSync(fallbackKnowledgePath)
      ? fallbackKnowledgePath
      : ''

  if (!filePath) return []

  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as { blocks?: DocumentKnowledgeBlock[] }
    return Array.isArray(parsed.blocks) ? parsed.blocks : []
  } catch (error) {
    console.warn(`Failed to load document knowledge: ${error instanceof Error ? error.message : String(error)}`)
    return []
  }
}

const documentKnowledgeBlocks = loadBlocks()

const scoreBlock = (block: DocumentKnowledgeBlock, input: KnowledgeSearchInput) => {
  const queryText = [
    input.diseaseKey,
    input.visitPurpose,
    input.chiefComplaint,
    input.diagnosis,
    ...(input.selectedRegions || []),
  ].join(' ')
  let score = block.weight || 1

  if (input.diseaseKey && block.diseaseKeys.includes(input.diseaseKey)) score += 18
  if (input.visitPurpose && block.diseaseKeys.includes(input.visitPurpose)) score += 12
  for (const region of input.selectedRegions || []) {
    if (block.regionKeys.includes(region)) score += 4
  }
  for (const keyword of block.keywords) {
    if (includesAny(queryText, [keyword])) score += 2
  }
  if (['medical_safety', 'report_structure', 'cost'].includes(block.category)) score += 3

  return score
}

export const searchDocumentKnowledge = (input: KnowledgeSearchInput, limit = 8) => {
  if (!documentKnowledgeBlocks.length) return []

  return documentKnowledgeBlocks
    .map((block) => ({ block, score: scoreBlock(block, input) }))
    .filter((item) => item.score > (item.block.weight || 1))
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map((item) => item.block)
}

export const getDocumentKnowledgeStats = () => ({
  count: documentKnowledgeBlocks.length,
  categories: documentKnowledgeBlocks.reduce<Record<string, number>>((acc, block) => {
    acc[block.category] = (acc[block.category] || 0) + 1
    return acc
  }, {}),
})

export const getKnowledgeForFreeReport = (input: ReportSubmissionInput, diseaseKey: string) => searchDocumentKnowledge({
  diseaseKey,
  visitPurpose: input.basicInfo.visitPurpose,
  chiefComplaint: input.basicInfo.chiefComplaint,
  selectedRegions: input.selectedRegions,
}, 7)

export const getKnowledgeForProfessionalReport = (
  input: ProfessionalReportSubmissionInput,
  diseaseKey: string,
) => searchDocumentKnowledge({
  diseaseKey,
  visitPurpose: input.medical.visitPurpose,
  diagnosis: input.medical.diagnosis,
  chiefComplaint: [
    input.medical.chiefComplaint,
    input.medical.pathologySummary,
    input.medical.imagingSummary,
    input.medical.geneticSummary,
    input.medical.treatmentHistory,
    ...input.parsedFiles.map((file) => file.summary),
  ].join(' '),
  selectedRegions: input.preferences.selectedRegions,
}, 10)
