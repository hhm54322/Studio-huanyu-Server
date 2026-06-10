import path from 'node:path'
import { config } from '../config.js'
import { parseUploadedFile } from '../report/fileParser.js'

const getMimeType = (filePath: string) => {
  const ext = path.extname(filePath).toLowerCase()
  if (['.jpg', '.jpeg'].includes(ext)) return 'image/jpeg'
  if (ext === '.png') return 'image/png'
  if (ext === '.webp') return 'image/webp'
  if (ext === '.pdf') return 'application/pdf'
  if (ext === '.txt') return 'text/plain'
  return 'application/octet-stream'
}

const filePath = path.resolve(process.argv[2] || '../报告/1.jpg')
const parsed = await parseUploadedFile({
  fieldName: 'file',
  originalName: path.basename(filePath),
  storedName: path.basename(filePath),
  relativePath: filePath,
  mimeType: getMimeType(filePath),
  size: 0,
  absolutePath: filePath,
})

const quality = parsed.metadata?.recognitionQuality
const facts = parsed.metadata?.medicalFacts

console.log(JSON.stringify({
  ocrProvider: config.ocrProvider,
  openaiVisionModel: config.openaiVisionModel,
  file: filePath,
  status: parsed.status,
  parser: parsed.parser,
  error: parsed.error || null,
  summary: parsed.summary,
  recognitionQuality: quality,
  medicalFacts: facts,
}, null, 2))
