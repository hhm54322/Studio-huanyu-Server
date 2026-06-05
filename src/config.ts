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
  openaiTimeoutMs: Number(process.env.OPENAI_TIMEOUT_MS || 180000),
  uploadDir: process.env.UPLOAD_DIR || 'uploads',
}
