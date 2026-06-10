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
npm run submissions:list
npm run submissions:get -- rpt_20260510_xxxxxxxx
npm run submissions:export -- --from 2026-05-01 --to 2026-05-10
npm run submissions:export -- --format json
```
