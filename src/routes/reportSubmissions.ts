import type { FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import { createReportSubmission, getReportSubmission, updateReportSubmissionResult } from '../db/reportSubmissions.js'
import { type ReportGenerationEvent, writeReportGenerationEvent } from '../report/generationEventLog.js'
import { generateReport } from '../report/generator.js'
import { reportSubmissionSchema } from '../validators/reportSubmission.js'

const getErrorMessage = (error: unknown) => error instanceof Error ? error.message : String(error)
type GenerationLogMeta = Pick<ReportGenerationEvent, 'locale' | 'visitPurpose' | 'selectedRegionCount' | 'hasUploads' | 'uploadedFileCount' | 'parsedFileCount'>

export const registerReportSubmissionRoutes = async (app: FastifyInstance) => {
  app.post('/api/report-submissions', async (request, reply) => {
    let createdSubmissionNo = ''
    let logMeta: Partial<GenerationLogMeta> = {}
    const startedAt = Date.now()
    try {
      if (request.isMultipart()) {
        return reply.code(400).send({
          success: false,
          error: 'FREE_REPORT_UPLOAD_DISABLED',
          message: 'Simple reports only use basic user input. Upload medical records on the professional report page.',
        })
      }

      const parsedInput = reportSubmissionSchema.parse(request.body)
      const input = {
        ...parsedInput,
        uploadedFiles: [],
        parsedFiles: [],
      }
      logMeta = {
        locale: input.locale,
        visitPurpose: input.basicInfo.visitPurpose,
        selectedRegionCount: input.selectedRegions.length,
        hasUploads: false,
        uploadedFileCount: 0,
        parsedFileCount: 0,
      }
      const created = await createReportSubmission(input, {
        userAgent: request.headers['user-agent'],
        ip: request.ip,
      })
      createdSubmissionNo = created.submission_no
      await updateReportSubmissionResult(created.submission_no, 'generating', null)
      await writeReportGenerationEvent({
        event: 'generation_started',
        mode: 'free',
        status: 'started',
        submissionNo: created.submission_no,
        ...logMeta,
      }).catch((logError) => request.log.error(logError))

      const report = await generateReport(input, created.submission_no)
      await updateReportSubmissionResult(created.submission_no, 'generated', report)
      await writeReportGenerationEvent({
        event: 'generation_completed',
        mode: 'free',
        status: 'generated',
        submissionNo: created.submission_no,
        durationMs: Date.now() - startedAt,
        ...logMeta,
        generatedBy: report.generatedBy,
      }).catch((logError) => request.log.error(logError))

      return reply.code(201).send({
        success: true,
        submissionId: created.id,
        submissionNo: created.submission_no,
        status: 'generated',
        createdAt: created.created_at,
        basicInfo: input.basicInfo,
        selectedRegions: input.selectedRegions,
        uploadedFiles: input.uploadedFiles,
        parsedFiles: input.parsedFiles,
        report,
      })
    } catch (error) {
      if (error instanceof ZodError) {
        return reply.code(400).send({
          success: false,
          error: 'VALIDATION_ERROR',
          message: 'Invalid report submission payload',
          issues: error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        })
      }

      request.log.error(error)
      if (createdSubmissionNo) {
        await writeReportGenerationEvent({
          event: 'generation_completed',
          mode: 'free',
          status: 'failed',
          submissionNo: createdSubmissionNo,
          durationMs: Date.now() - startedAt,
          ...logMeta,
          errorCode: 'REPORT_GENERATION_FAILED',
          errorMessage: getErrorMessage(error),
        }).catch((logError) => request.log.error(logError))
        await updateReportSubmissionResult(createdSubmissionNo, 'failed', {
          error: 'REPORT_GENERATION_FAILED',
          message: 'Medical LLM did not return a complete qualified report.',
        }).catch((dbError) => request.log.error(dbError))
      }
      return reply.code(500).send({
        success: false,
        error: 'REPORT_GENERATION_FAILED',
        message: '本次报告生成时间较长或内容未通过质量检查，请稍后再试。我们没有使用通用模板替代，以避免生成不准确的报告。',
      })
    }
  })

  app.get('/api/report-submissions/:submissionNo', async (request, reply) => {
    const { submissionNo } = request.params as { submissionNo: string }
    const row = await getReportSubmission(submissionNo)

    if (!row) {
      return reply.code(404).send({
        success: false,
        error: 'NOT_FOUND',
        message: 'Report submission not found',
      })
    }

    return reply.send({
      success: true,
      submissionId: row.id,
      submissionNo: row.submission_no,
      status: row.report_status,
      createdAt: row.created_at,
      basicInfo: {
        fullName: row.full_name,
        gender: row.gender,
        dateOfBirth: row.date_of_birth || '',
        nationality: row.nationality,
        idType: row.id_type || '',
        idNumber: row.id_number || '',
        phone: row.phone || '',
        email: row.email,
        city: row.city,
        preferredLanguage: row.preferred_language,
        visitPurpose: row.visit_purpose,
        chiefComplaint: row.chief_complaint,
      },
      selectedRegions: row.selected_regions,
      uploadedFiles: row.uploaded_files,
      parsedFiles: row.parsed_files,
      report: row.report_result,
    })
  })
}
