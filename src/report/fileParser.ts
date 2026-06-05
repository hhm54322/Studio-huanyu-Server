import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { ProfessionalParsedFile, ProfessionalUploadedFile } from '../validators/professionalReportSubmission.js'

type ParserInput = ProfessionalUploadedFile & {
  absolutePath: string
}

const MAX_TEXT_LENGTH = 12000
const SUMMARY_LENGTH = 900

const normalizeText = (text: string) => text
  .replace(/\u0000/g, '')
  .replace(/[ \t]+/g, ' ')
  .replace(/\n{3,}/g, '\n\n')
  .trim()

const truncate = (text: string, length: number) => {
  const normalized = normalizeText(text)
  return normalized.length > length ? `${normalized.slice(0, length)}...` : normalized
}

const createParsedFile = (
  input: ParserInput,
  parser: string,
  status: ProfessionalParsedFile['status'],
  text: string,
  metadata: Record<string, unknown> = {},
  error?: string,
): ProfessionalParsedFile => ({
  originalName: input.originalName,
  mimeType: input.mimeType,
  parser,
  status,
  text: truncate(text, MAX_TEXT_LENGTH),
  summary: truncate(text, SUMMARY_LENGTH),
  metadata,
  error,
})

const getExtension = (fileName: string) => path.extname(fileName).toLowerCase()

const parseTextFile = async (input: ParserInput) => {
  const content = await readFile(input.absolutePath, 'utf8')
  return createParsedFile(input, 'text', 'parsed', content)
}

const parsePdfFile = async (input: ParserInput) => {
  const { PDFParse } = await import('pdf-parse')
  const buffer = await readFile(input.absolutePath)
  const parser = new PDFParse({ data: buffer })

  try {
    const [textResult, infoResult] = await Promise.all([
      parser.getText(),
      parser.getInfo(),
    ])

    return createParsedFile(input, 'pdf-parse', textResult.text.trim() ? 'parsed' : 'partial', textResult.text, {
      pages: infoResult.total,
      info: infoResult.info || {},
    })
  } finally {
    await parser.destroy()
  }
}

const parseDocxFile = async (input: ParserInput) => {
  const mammoth = await import('mammoth')
  const result = await mammoth.extractRawText({ path: input.absolutePath })
  return createParsedFile(input, 'mammoth', result.value.trim() ? 'parsed' : 'partial', result.value, {
    messages: result.messages,
  })
}

const parseImageFile = async (input: ParserInput) => {
  const { createWorker } = await import('tesseract.js')
  const worker = await createWorker('eng+chi_sim')
  try {
    const result = await worker.recognize(input.absolutePath)
    return createParsedFile(input, 'tesseract.js', result.data.text.trim() ? 'parsed' : 'partial', result.data.text, {
      confidence: result.data.confidence,
    })
  } finally {
    await worker.terminate()
  }
}

const parseDicomFile = async (input: ParserInput) => {
  const dcmjs = await import('dcmjs')
  const buffer = await readFile(input.absolutePath)
  const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
  const dicomData = dcmjs.data.DicomMessage.readFile(arrayBuffer)
  const dataset = dcmjs.data.DicomMetaDictionary.naturalizeDataset(dicomData.dict)
  const metadata = {
    patientName: dataset.PatientName,
    studyDate: dataset.StudyDate,
    modality: dataset.Modality,
    studyDescription: dataset.StudyDescription,
    seriesDescription: dataset.SeriesDescription,
    bodyPartExamined: dataset.BodyPartExamined,
    institutionName: dataset.InstitutionName,
  }
  const text = Object.entries(metadata)
    .filter(([, value]) => value)
    .map(([key, value]) => `${key}: ${String(value)}`)
    .join('\n')
  return createParsedFile(input, 'dcmjs', text ? 'partial' : 'unsupported', text, metadata)
}

export const parseUploadedFile = async (input: ParserInput): Promise<ProfessionalParsedFile> => {
  const ext = getExtension(input.originalName)

  try {
    if (input.mimeType === 'application/pdf' || ext === '.pdf') return await parsePdfFile(input)
    if (ext === '.docx') return await parseDocxFile(input)
    if (input.mimeType.startsWith('text/') || ext === '.txt') return await parseTextFile(input)
    if (input.mimeType.startsWith('image/') || ['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) return await parseImageFile(input)
    if (['.dcm', '.dicom'].includes(ext) || input.mimeType === 'application/dicom') return await parseDicomFile(input)

    return createParsedFile(input, 'none', 'unsupported', '', {}, 'Unsupported file format')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return createParsedFile(input, 'auto', 'failed', '', {}, message.slice(0, 300))
  }
}
