import path from 'node:path'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'

// Pinned multilingual E5 ONNX model. It is loaded from disk only: clinical
// queries never leave the server and no downloads happen during generation.
export const semanticModel = 'multilingual-e5-small@761b726dd34fb83930e26aab4e9ac3899aa1fa78:q8:384'
export const semanticHash = (text: string) => createHash('sha256').update(text).digest('hex')
let extractor: Promise<any> | undefined
let inferenceQueue: Promise<unknown> = Promise.resolve()

async function loadExtractor() {
  if (!extractor) extractor = (async () => {
    const { pipeline, env } = await import('@huggingface/transformers')
    env.allowRemoteModels = false
    const modelPath = process.env.EXPERT_EMBEDDING_MODEL_DIR || path.resolve('models/multilingual-e5-small')
    const expected: Record<string, string> = {
      'config.json': 'cb99455288675345e1a4f411438d5d0adbba5fbd3a67ea4fb03c015433b996c1',
      'tokenizer.json': '0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39',
      'tokenizer_config.json': 'a1d6bc8734a6f635dc158508bef000f8e2e5a759c7d92f984b2c86e5ff53425b',
      'onnx/model_quantized.onnx': 'f80102d3f2a1229f387d3c81909990d8945513e347b0eab049f7de3c6f98c193',
    }
    for (const [file, hash] of Object.entries(expected)) {
      const checksum = createHash('sha256')
      for await (const chunk of createReadStream(path.join(modelPath, file))) checksum.update(chunk)
      if (checksum.digest('hex') !== hash) throw new Error('Local embedding model integrity check failed')
    }
    return pipeline('feature-extraction', modelPath, {
      local_files_only: true, dtype: 'q8', device: 'cpu',
      session_options: { intraOpNumThreads: 1, interOpNumThreads: 1 },
    })
  })().catch(error => { extractor = undefined; throw error })
  return extractor
}

export async function embedTexts(texts: string[], kind: 'query' | 'passage'): Promise<number[][]> {
  const operation = inferenceQueue.then(async () => {
    const model = await loadExtractor(), vectors: number[][] = []
    // Short, independently meaningful passages avoid truncating away conditions.
    for (let i = 0; i < texts.length; i += 4) {
      const output = await model(texts.slice(i, i + 4).map(t => `${kind}: ${t}`), {
        pooling: 'mean', normalize: true, truncation: true, max_length: 512,
      })
      const batch = output.tolist() as number[][]
      if (batch.length !== Math.min(4, texts.length - i) || batch.some(v => v.length !== 384 || v.some(n => !Number.isFinite(n)))) {
        throw new Error('Invalid local embedding dimensions')
      }
      vectors.push(...batch)
    }
    return vectors
  })
  inferenceQueue = operation.catch(() => {})
  return operation
}
export async function disposeEmbeddingModel() {
  await inferenceQueue
  if (extractor) { const model = await extractor; await model.dispose(); extractor = undefined }
}

export function cosine(a: number[], b: number[]) {
  if (a.length !== b.length || !a.length) return 0
  let dot = 0, aa = 0, bb = 0
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; aa += a[i] ** 2; bb += b[i] ** 2 }
  return aa && bb ? Math.max(-1, Math.min(1, dot / Math.sqrt(aa * bb))) : 0
}
