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

Uploaded images and scanned PDFs are parsed before report generation. The OCR layer is configurable so domestic medical OCR can be used independently from the report-writing model.

```env
OCR_PROVIDER=baidu_medical
OCR_FALLBACK_PROVIDER=none
BAIDU_OCR_API_KEY=your-baidu-api-key
BAIDU_OCR_SECRET_KEY=your-baidu-secret-key
BAIDU_OCR_BASE_URL=https://aip.baidubce.com
BAIDU_OCR_TOKEN_URL=https://aip.baidubce.com/oauth/2.0/token
BAIDU_OCR_TIMEOUT_MS=60000
BAIDU_MEDICAL_OCR_ENDPOINT=auto
BAIDU_MEDICAL_OCR_MIN_TEXT_LENGTH=80
BAIDU_OCR_GENERAL_FALLBACK=true
BAIDU_OCR_GENERAL_ENDPOINT=general_basic
BAIDU_OCR_GENERAL_LANGUAGE=CHN_ENG
```

## Medical LLM

Simple and professional report writing can be routed through AntAngelMed without changing the OCR provider:

```env
MEDICAL_LLM_PROVIDER=ant_ling
MEDICAL_LLM_API_KEY=your-ant-ling-api-key
MEDICAL_LLM_BASE_URL=https://api.ant-ling.com/v1
MEDICAL_LLM_MODEL=AntAngelMed
MEDICAL_LLM_TIMEOUT_MS=300000
MEDICAL_LLM_STREAM=true
MEDICAL_LLM_RESPONSE_FORMAT=json_object
MEDICAL_LLM_STRICT_REPORTS=true
REPORT_GENERATION_LOG_DIR=logs
```

If `MEDICAL_LLM_API_KEY` is empty, report generation falls back to the existing `OPENAI_*` OpenAI-compatible report model. OCR is independent: backend defaults route uploaded medical records to Baidu OCR; production still needs `BAIDU_OCR_API_KEY` and `BAIDU_OCR_SECRET_KEY` in `.env`. Set `OCR_FALLBACK_PROVIDER=openai` only if you intentionally want oversized images to fall back to the old vision path.

`MEDICAL_LLM_STRICT_REPORTS` defaults to `true`. In strict mode, simple and professional report generation fails visibly if the medical LLM is unavailable, returns invalid JSON, or does not pass completeness/fact-alignment checks. Set it to `false` only for local development if you intentionally want the rule-based baseline to be returned.

`OCR_PROVIDER` supports:

- `baidu_medical`: use Baidu Medical OCR first, then Baidu general OCR when structured medical OCR returns no text. This is the recommended production path for uploaded hospital reports.
- `openai`: require OpenAI Vision.
- `auto`: use OpenAI Vision when `OPENAI_API_KEY` is configured, then fallback to local `tesseract.js`.
- `tesseract`: local OCR only, useful for offline smoke tests but not enough for production medical report interpretation.

`BAIDU_MEDICAL_OCR_ENDPOINT=auto` tries Baidu `health_report` and `medical_report_detection` for uploaded medical images. When both structured medical endpoints produce no readable text, or only produce a tiny label fragment shorter than `BAIDU_MEDICAL_OCR_MIN_TEXT_LENGTH`, `BAIDU_OCR_GENERAL_FALLBACK=true` tries Baidu 通用文字识别. `general_basic` uses `BAIDU_OCR_GENERAL_LANGUAGE=CHN_ENG`; use `BAIDU_OCR_GENERAL_ENDPOINT=accurate_basic` only after enabling 通用文字识别（高精度版） in the Baidu console.

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
