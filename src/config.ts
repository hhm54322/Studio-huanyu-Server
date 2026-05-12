import dotenv from 'dotenv'

dotenv.config()

export const config = {
  port: Number(process.env.PORT || 3000),
  host: process.env.HOST || '0.0.0.0',
  databaseUrl:
    process.env.DATABASE_URL ||
    'postgres://huanyu:huanyu_dev_password@localhost:5432/huanyu_medical',
  corsOrigin: process.env.CORS_ORIGIN || 'http://localhost:5173',
}
