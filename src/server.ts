import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import Fastify from 'fastify'
import { config } from './config.js'
import { closePool } from './db/pool.js'
import { registerReportSubmissionRoutes } from './routes/reportSubmissions.js'

const app = Fastify({
  logger: true,
})

await app.register(helmet)
await app.register(cors, {
  origin: config.corsOrigin.split(',').map((origin) => origin.trim()),
})

app.get('/health', async () => ({ ok: true }))

await registerReportSubmissionRoutes(app)

const shutdown = async () => {
  app.log.info('Shutting down server...')
  await app.close()
  await closePool()
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

await app.listen({ port: config.port, host: config.host })
