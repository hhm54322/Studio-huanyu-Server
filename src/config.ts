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
  baiduOcrApiKey: process.env.BAIDU_OCR_API_KEY || '',
  baiduOcrSecretKey: process.env.BAIDU_OCR_SECRET_KEY || '',
  baiduOcrBaseUrl: (process.env.BAIDU_OCR_BASE_URL || 'https://aip.baidubce.com').replace(/\/$/, ''),
  baiduOcrTokenUrl: process.env.BAIDU_OCR_TOKEN_URL || 'https://aip.baidubce.com/oauth/2.0/token',
  baiduOcrTimeoutMs: Number(process.env.BAIDU_OCR_TIMEOUT_MS || 60000),
  baiduMedicalOcrEndpoint: (process.env.BAIDU_MEDICAL_OCR_ENDPOINT || 'auto').toLowerCase(),
  baiduMedicalOcrMinTextLength: Number(process.env.BAIDU_MEDICAL_OCR_MIN_TEXT_LENGTH || 80),
  baiduOcrGeneralFallback: process.env.BAIDU_OCR_GENERAL_FALLBACK !== 'false',
  baiduOcrGeneralEndpoint: (process.env.BAIDU_OCR_GENERAL_ENDPOINT || 'general_basic').toLowerCase(),
  baiduOcrGeneralLanguage: process.env.BAIDU_OCR_GENERAL_LANGUAGE || 'CHN_ENG',
  medicalLlmProvider: process.env.MEDICAL_LLM_PROVIDER || 'ant_ling',
  medicalLlmApiKey: process.env.MEDICAL_LLM_API_KEY || '',
  medicalLlmBaseUrl: (process.env.MEDICAL_LLM_BASE_URL || 'https://api.ant-ling.com/v1').replace(/\/$/, ''),
  medicalLlmModel: process.env.MEDICAL_LLM_MODEL || 'AntAngelMed',
  medicalLlmTimeoutMs: Number(process.env.MEDICAL_LLM_TIMEOUT_MS || process.env.OPENAI_REPORT_TIMEOUT_MS || process.env.OPENAI_TIMEOUT_MS || 300000),
  medicalLlmStream: process.env.MEDICAL_LLM_STREAM !== 'false',
  medicalLlmResponseFormat: process.env.MEDICAL_LLM_RESPONSE_FORMAT || 'json_object',
  medicalLlmStrictReports: process.env.MEDICAL_LLM_STRICT_REPORTS !== 'false',
  reportGenerationLogDir: process.env.REPORT_GENERATION_LOG_DIR || 'logs',
  ocrProvider: (process.env.OCR_PROVIDER || 'baidu_medical').toLowerCase(),
  ocrFallbackProvider: (process.env.OCR_FALLBACK_PROVIDER || 'none').toLowerCase(),
  uploadDir: process.env.UPLOAD_DIR || 'uploads',
}
