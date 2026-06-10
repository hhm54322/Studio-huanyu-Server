import dotenv from 'dotenv'

dotenv.config({ override: true })

export const config = {
  port: Number(process.env.PORT || 3000),
  host: process.env.HOST || '0.0.0.0',
  databaseUrl:
    process.env.DATABASE_URL ||
    'postgres://huanyu:huanyu_dev_password@localhost:5432/huanyu_medical',
  corsOrigin: process.env.CORS_ORIGIN || 'http://localhost:5173,http://127.0.0.1:5173',
  openaiApiKey: process.env.OPENAI_API_KEY || '',
  openaiBaseUrl: (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, ''),
  openaiModel: process.env.OPENAI_MODEL || 'gpt-5.5',
  openaiVisionModel: process.env.OPENAI_VISION_MODEL || process.env.OPENAI_MODEL || 'gpt-5.5',
  openaiTimeoutMs: Number(process.env.OPENAI_TIMEOUT_MS || 180000),
  openaiReportTimeoutMs: Number(process.env.OPENAI_REPORT_TIMEOUT_MS || process.env.OPENAI_TIMEOUT_MS || 180000),
  openaiVisionTimeoutMs: Number(process.env.OPENAI_VISION_TIMEOUT_MS || process.env.OPENAI_TIMEOUT_MS || 180000),
  medicalLlmProvider: process.env.MEDICAL_LLM_PROVIDER || 'ant_ling',
  medicalLlmApiKey: process.env.MEDICAL_LLM_API_KEY || '',
  medicalLlmBaseUrl: (process.env.MEDICAL_LLM_BASE_URL || 'https://api.ant-ling.com/v1').replace(/\/$/, ''),
  medicalLlmModel: process.env.MEDICAL_LLM_MODEL || 'AntAngelMed',
  medicalLlmTimeoutMs: Number(process.env.MEDICAL_LLM_TIMEOUT_MS || process.env.OPENAI_REPORT_TIMEOUT_MS || process.env.OPENAI_TIMEOUT_MS || 180000),
  medicalLlmStream: process.env.MEDICAL_LLM_STREAM !== 'false',
  medicalLlmResponseFormat: process.env.MEDICAL_LLM_RESPONSE_FORMAT || 'json_object',
  ocrProvider: (process.env.OCR_PROVIDER || 'auto').toLowerCase(),
  uploadDir: process.env.UPLOAD_DIR || 'uploads',
}
