import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { extractMedicalFactsFromText } from './medicalFactExtractor.js'
import {
  recognizeOpenaiVisionImage,
  recognizeTesseractImage,
  shouldUseTesseractFallback,
  shouldUseVisionOcr,
  type MedicalOcrResult,
} from './medicalOcrProvider.js'
import type { ProfessionalParsedFile, ProfessionalUploadedFile } from '../validators/professionalReportSubmission.js'

type ParserInput = ProfessionalUploadedFile & {
  absolutePath: string
}

const MAX_TEXT_LENGTH = 12000
const SUMMARY_LENGTH = 900
const PDF_OCR_MAX_PAGES = Math.max(1, Math.min(10, Number(process.env.PDF_OCR_MAX_PAGES || 3)))
const PDF_OCR_DESIRED_WIDTH = Math.max(900, Math.min(2400, Number(process.env.PDF_OCR_DESIRED_WIDTH || 1600)))
const PDF_TEXT_MIN_LENGTH = 120

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
): ProfessionalParsedFile => {
  const normalizedText = normalizeText(text)
  const medicalFacts = extractMedicalFactsFromText(normalizedText, {
    fileName: input.originalName,
    parser,
  })

  return {
    originalName: input.originalName,
    mimeType: input.mimeType,
    parser,
    status,
    text: truncate(normalizedText, MAX_TEXT_LENGTH),
    summary: truncate(normalizedText, SUMMARY_LENGTH),
    metadata: {
      ...metadata,
      medicalFacts,
      recognitionQuality: {
        textLength: normalizedText.length,
        medicalFactConfidence: medicalFacts.confidence,
        actionableFacts:
          medicalFacts.diagnoses.length +
          medicalFacts.indicators.length +
          medicalFacts.findings.length +
          medicalFacts.metastasisSignals.length,
      },
    },
    error,
  }
}

const getExtension = (fileName: string) => path.extname(fileName).toLowerCase()

const parseTextFile = async (input: ParserInput) => {
  const content = await readFile(input.absolutePath, 'utf8')
  return createParsedFile(input, 'text', 'parsed', content)
}

const parsePdfFile = async (input: ParserInput) => {
  const { PDFParse } = await import('pdf-parse')
  const buffer = await readFile(input.absolutePath)
  let textExtractionError = ''
  let textLayer: { text: string; pages?: number; info?: unknown } | null = null

  try {
    const parser = new PDFParse({ data: new Uint8Array(buffer) })
    try {
      const [textResult, infoResult] = await Promise.all([
        parser.getText(),
        parser.getInfo(),
      ])

      textLayer = {
        text: cleanPdfTextLayer(textResult.text),
        pages: infoResult.total,
        info: infoResult.info || {},
      }
    } finally {
      await parser.destroy()
    }
  } catch (error) {
    textExtractionError = error instanceof Error ? error.message : String(error)
  }

  if (textLayer && isUsefulPdfText(textLayer.text, input.originalName)) {
    return createParsedFile(input, 'pdf-parse', 'parsed', textLayer.text, {
      pages: textLayer.pages,
      info: textLayer.info || {},
      textLayerLength: textLayer.text.length,
    })
  }

  try {
    const ocrResult = await parsePdfScreenshots(input, buffer, textLayer?.pages)
    if (ocrResult.text.trim()) {
      const combinedText = [
        textLayer?.text.trim() && isUsefulPdfText(textLayer.text, input.originalName) ? textLayer.text : '',
        ocrResult.text,
      ].filter(Boolean).join('\n\n')
      const facts = extractMedicalFactsFromText(combinedText, { fileName: input.originalName, parser: ocrResult.parser })
      return createParsedFile(input, ocrResult.parser, facts.confidence >= 0.45 ? 'parsed' : 'partial', combinedText, {
        pages: textLayer?.pages,
        info: textLayer?.info || {},
        textLayerLength: textLayer?.text.length || 0,
        textExtractionError,
        ...ocrResult.metadata,
      })
    }
  } catch (error) {
    const ocrError = error instanceof Error ? error.message : String(error)
    const fallbackText = textLayer?.text || ''
    return createParsedFile(input, 'pdf-parse+ocr', fallbackText.trim() ? 'partial' : 'failed', fallbackText, {
      pages: textLayer?.pages,
      info: textLayer?.info || {},
      textLayerLength: fallbackText.length,
      textExtractionError,
      pdfOcrError: ocrError.slice(0, 300),
    }, ocrError.slice(0, 300))
  }

  const fallbackText = textLayer?.text || ''
  return createParsedFile(input, 'pdf-parse', fallbackText.trim() ? 'partial' : 'failed', fallbackText, {
    pages: textLayer?.pages,
    info: textLayer?.info || {},
    textLayerLength: fallbackText.length,
    textExtractionError,
    pdfOcrPagesAttempted: PDF_OCR_MAX_PAGES,
  }, textExtractionError || 'PDF did not contain extractable text and OCR produced no readable content')
}

const parseDocxFile = async (input: ParserInput) => {
  const mammoth = await import('mammoth')
  const result = await mammoth.extractRawText({ path: input.absolutePath })
  return createParsedFile(input, 'mammoth', result.value.trim() ? 'parsed' : 'partial', result.value, {
    messages: result.messages,
  })
}

const cleanPdfTextLayer = (text: string) => normalizeText(text)
  .replace(/--\s*\d+\s+of\s+\d+\s*--/gi, '')
  .replace(/\n{3,}/g, '\n\n')
  .trim()

const isUsefulPdfText = (text: string, fileName: string) => {
  const cleaned = cleanPdfTextLayer(text)
  if (cleaned.length >= PDF_TEXT_MIN_LENGTH) return true

  const facts = extractMedicalFactsFromText(cleaned, {
    fileName,
    parser: 'pdf-parse',
  })
  const actionableFacts =
    facts.diagnoses.length +
    facts.indicators.length +
    facts.findings.length +
    facts.metastasisSignals.length

  return actionableFacts > 0
}

const parseVisionImageFile = async (input: ParserInput) => {
  const result = await recognizeOpenaiVisionImage(input)
  if (!result) return null

  return createParsedFile(input, result.parser, result.text.length > 30 ? 'parsed' : 'partial', result.text, result.metadata)
}

const parseImageFile = async (input: ParserInput) => {
  if (shouldUseVisionOcr()) {
    try {
      const visionResult = await parseVisionImageFile(input)
      if (visionResult) return visionResult
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!shouldUseTesseractFallback()) throw error
      console.warn(`Image vision OCR failed, falling back to tesseract: ${message.slice(0, 180)}`)
    }
  }

  if (!shouldUseTesseractFallback()) {
    throw new Error('No OCR result: vision OCR unavailable and local OCR fallback is disabled')
  }

  const result = await recognizeTesseractImage(input.absolutePath)
  return createParsedFile(input, result.parser, result.text.trim() ? 'parsed' : 'partial', result.text, result.metadata)
}

const parsePdfScreenshots = async (
  input: ParserInput,
  buffer: Buffer,
  knownPages?: number,
): Promise<MedicalOcrResult> => {
  const { PDFParse } = await import('pdf-parse')
  const parser = new PDFParse({ data: new Uint8Array(buffer) })
  try {
    const screenshotResult = await parser.getScreenshot({
      first: PDF_OCR_MAX_PAGES,
      desiredWidth: PDF_OCR_DESIRED_WIDTH,
      imageBuffer: true,
      imageDataUrl: false,
    })
    const pages = screenshotResult.pages.slice(0, PDF_OCR_MAX_PAGES)
    const pageResults: Array<{
      pageNumber: number
      parser: string
      textLength: number
      confidence?: unknown
      notes?: unknown
      error?: string
    }> = []
    const pageTexts: string[] = []

    if (shouldUseVisionOcr()) {
      for (const page of pages) {
        try {
          const visionResult = await recognizeOpenaiVisionImage(input, {
            buffer: page.data,
            mimeType: 'image/png',
            label: `PDF第${page.pageNumber}页`,
          })
          if (!visionResult) continue
          pageTexts.push(`【PDF第${page.pageNumber}页 OCR】\n${visionResult.text}`)
          pageResults.push({
            pageNumber: page.pageNumber,
            parser: visionResult.parser,
            textLength: visionResult.text.length,
            notes: visionResult.metadata.recognitionNotes,
          })
        } catch (error) {
          pageResults.push({
            pageNumber: page.pageNumber,
            parser: 'openai-vision',
            textLength: 0,
            error: error instanceof Error ? error.message.slice(0, 180) : String(error).slice(0, 180),
          })
        }
      }
    }

    const visionText = pageTexts.join('\n\n').trim()
    if (isUsefulPdfText(visionText, input.originalName)) {
      return {
        text: visionText,
        parser: 'pdf-screenshot+openai-vision',
        metadata: {
          pdfOcrPagesAttempted: pages.length,
          pdfOcrTotalPages: screenshotResult.total || knownPages,
          pdfOcrDesiredWidth: PDF_OCR_DESIRED_WIDTH,
          pdfOcrPageResults: pageResults,
        },
      }
    }

    if (!shouldUseTesseractFallback()) {
      return {
        text: visionText,
        parser: 'pdf-screenshot+openai-vision',
        metadata: {
          pdfOcrPagesAttempted: pages.length,
          pdfOcrTotalPages: screenshotResult.total || knownPages,
          pdfOcrDesiredWidth: PDF_OCR_DESIRED_WIDTH,
          pdfOcrPageResults: pageResults,
          fallbackDisabled: true,
        },
      }
    }

    const { createWorker } = await import('tesseract.js')
    const worker = await createWorker('eng+chi_sim')
    try {
      const tesseractTexts: string[] = []
      for (const page of pages) {
        const result = await worker.recognize(Buffer.from(page.data))
        tesseractTexts.push(`【PDF第${page.pageNumber}页 OCR】\n${result.data.text}`)
        pageResults.push({
          pageNumber: page.pageNumber,
          parser: 'tesseract.js',
          textLength: result.data.text.length,
          confidence: result.data.confidence,
        })
      }

      return {
        text: tesseractTexts.join('\n\n').trim(),
        parser: 'pdf-screenshot+tesseract.js',
        metadata: {
          pdfOcrPagesAttempted: pages.length,
          pdfOcrTotalPages: screenshotResult.total || knownPages,
          pdfOcrDesiredWidth: PDF_OCR_DESIRED_WIDTH,
          pdfOcrPageResults: pageResults,
        },
      }
    } finally {
      await worker.terminate()
    }
  } finally {
    await parser.destroy()
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
