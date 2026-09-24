import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import multipart from '@fastify/multipart'
import Fastify from 'fastify'
import { config } from './config.js'
import { closePool } from './db/pool.js'
import { registerProfessionalReportSubmissionRoutes } from './routes/professionalReportSubmissions.js'
import { registerReportSubmissionRoutes } from './routes/reportSubmissions.js'
import { registerPatientSubmissionRoutes } from './routes/patientSubmissions.js'

const app = Fastify({
  logger: true,
  connectionTimeout: config.httpRequestTimeoutMs,
  requestTimeout: config.httpRequestTimeoutMs,
})

await app.register(helmet)
await app.register(cors, {
  origin: config.corsOrigin.split(',').map((origin) => origin.trim()),
})
await app.register(multipart, {
  limits: {
    fileSize: 50 * 1024 * 1024,
    files: 20,
  },
})

app.get('/health', async () => ({ ok: true }))

await registerReportSubmissionRoutes(app)
await registerProfessionalReportSubmissionRoutes(app)
await registerPatientSubmissionRoutes(app)

let shuttingDown = false

const shutdown = async () => {
  if (shuttingDown) return
  shuttingDown = true
  app.log.info('Shutting down server...')
  await app.close()
  await closePool()
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

await app.listen({ port: config.port, host: config.host })
