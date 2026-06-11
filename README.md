# Studio Huanyu Server

Local backend for report submissions.

## Local Setup

```bash
cd /Users/hhm/Desktop/1024Clients/huanyu
docker compose up -d postgres

cd Studio-huanyu-Server
cp .env.example .env
npm install
npm run db:migrate
npm run dev
```

## Medical Record OCR

Uploaded images and scanned PDFs are parsed before report generation. The OCR layer is configurable so high-quality vision recognition can be used independently from the report-writing model.

```env
OCR_PROVIDER=auto
OPENAI_API_KEY=sk-...
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_VISION_MODEL=gpt-5.5
OPENAI_REPORT_TIMEOUT_MS=240000
OPENAI_VISION_TIMEOUT_MS=180000
```

## Medical LLM

Simple and professional report writing can be routed through AntAngelMed without changing the OCR provider:

```env
MEDICAL_LLM_PROVIDER=ant_ling
MEDICAL_LLM_API_KEY=your-ant-ling-api-key
MEDICAL_LLM_BASE_URL=https://api.ant-ling.com/v1
MEDICAL_LLM_MODEL=AntAngelMed
MEDICAL_LLM_TIMEOUT_MS=180000
MEDICAL_LLM_STREAM=true
MEDICAL_LLM_RESPONSE_FORMAT=json_object
MEDICAL_LLM_STRICT_REPORTS=true
REPORT_GENERATION_LOG_DIR=logs
```

If `MEDICAL_LLM_API_KEY` is empty, report generation falls back to the existing `OPENAI_*` OpenAI-compatible report model. OCR continues to use `OPENAI_API_KEY`, `OPENAI_BASE_URL`, and `OPENAI_VISION_MODEL`.

`MEDICAL_LLM_STRICT_REPORTS` defaults to `true`. In strict mode, simple and professional report generation fails visibly if the medical LLM is unavailable, returns invalid JSON, or does not pass completeness/fact-alignment checks. Set it to `false` only for local development if you intentionally want the rule-based baseline to be returned.

`OCR_PROVIDER` supports:

- `auto`: use OpenAI Vision when `OPENAI_API_KEY` is configured, then fallback to local `tesseract.js`.
- `openai`: require OpenAI Vision and fail visibly if the vision call fails. Use this for production validation so low-quality OCR does not quietly distort reports.
- `tesseract`: local OCR only, useful for offline smoke tests but not enough for production medical report interpretation.

Quick OCR check:

```bash
npm run reports:check-ocr -- "/Users/hhm/Desktop/1024Clients/huanyu/报告/1.jpg"
npm run reports:preview-real-upload -- --reuse-ocr
```

API:

- `GET /health`
- `POST /api/report-submissions`

CLI:

```bash
npm run reports:stats
npm run reports:stats -- --from 2026-06-11 --to 2026-06-12
npm run reports:stats -- --mode professional --format json
npm run submissions:list
npm run submissions:get -- rpt_20260510_xxxxxxxx
npm run submissions:export -- --from 2026-05-01 --to 2026-05-10
npm run submissions:export -- --format json
```

Report generation events are written as JSONL files under `REPORT_GENERATION_LOG_DIR`, one file per day, for example `logs/report-generation-2026-06-11.jsonl`. The event log is intentionally non-sensitive: it records mode, submission number, visit purpose, upload counts, parser statuses, duration, result, provider/model, and failure code/message, but not patient identity fields or raw medical record text.
