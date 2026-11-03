# Studio Huanyu Server

Local backend for report submissions.

## First-party contact analytics (M05)

WhatsApp clicks are collected by `/api/analytics/events` and stored separately from patient data. Authenticated admins can query `/api/expert/analytics/contacts`; `npm run contacts:stats -- --group-by campaign,keyword --format json` also pulls paginated JSON/CSV from the server. Metrics are clicks and anonymous-browser counts, not confirmed conversations or payments. Run `db:migrate` before publishing the frontend. API, filters, identity/queue limits, test isolation and release order are documented in [docs/contact-analytics.md](docs/contact-analytics.md).

## Expert review workbench

正式入口 `/expert-review/` 使用本服务 `/api/expert/`，需要 `EXPERT_REVIEW_ENABLED=true`。完整边界和入库门禁见 [docs/expert-review-flow.md](docs/expert-review-flow.md)。

- 专家：读取全部已生成病例、脱敏输入及病历副本；只修改自己的审阅。
- 管理员/资料处理人员：逐页框选身份信息后发布私密的不可逆脱敏副本；与医学知识确认不是同一权限。
- 专人确认：角色/状态/门禁预留为后续功能，暂不开通。当前设置 `EXPERT_KNOWLEDGE_REQUIRE_CONFIRMATION=false`，专家提交所勾选的医学修改/补充后直接发布；未确认候选和草稿仍不能被引用。
- 生成器使用本地 E5 语义向量 + BM25/关键词混合检索，经条件硬拦截及现有医疗模型适用性核验后，按报告模块提供知识并记录实际提供项的版本来源；没有可用知识时保持原生成输入，不覆盖历史报告。管理员或原专家可撤回知识，后续新生成不再引用。将开关改为 `true` 可恢复需专人确认模式。

设置 `EXPERT_EMBEDDING_MODEL_DIR` 为固定版本的本地 ONNX 模型目录，完整文件/预算/故障边界见流程文档。运行时不下载模型；通用检索模型与工程相关分不等于临床置信度。`npm run expert:matching-check` 仅使用合成文本测试真实医疗 API，不写病例库。

后台开通账号：`EXPERT_ACCOUNT_PASSWORD=<密码> npm run expert:account -- create <账号> expert`；正式账号至少14位密码。测试账号可显式加 `--test-account`，禁止前端硬编码认证。禁用账号用 `npm run expert:account -- disable <账号>`。

自动测试 `npm run test:expert` 只允许独立的 `huanyu_expert_qa` 数据库；会清理并播种该测试库，**绝不能在业务数据库运行**。通过 `HUANYU_ENV_FILE` 指定隔离环境文件，避免默认 `.env` 覆盖测试数据库设置。

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
HTTP_REQUEST_TIMEOUT_MS=600000
OPENAI_TIMEOUT_MS=600000
OPENAI_REPORT_TIMEOUT_MS=600000
OPENAI_VISION_TIMEOUT_MS=600000
MEDICAL_LLM_TIMEOUT_MS=600000
MEDICAL_LLM_STREAM=true
MEDICAL_LLM_RESPONSE_FORMAT=json_object
MEDICAL_LLM_STRICT_REPORTS=true
REPORT_GENERATION_LOG_DIR=logs
```

If `MEDICAL_LLM_API_KEY` is empty, report generation falls back to the existing `OPENAI_*` OpenAI-compatible report model. OCR is independent: backend defaults route uploaded medical records to Baidu OCR; production still needs `BAIDU_OCR_API_KEY` and `BAIDU_OCR_SECRET_KEY` in `.env`. Set `OCR_FALLBACK_PROVIDER=openai` only if you intentionally want oversized images to fall back to the old vision path.

`MEDICAL_LLM_STRICT_REPORTS` is kept in generation logs for operational visibility. Report content no longer falls back to the old rule-based hospital/fee/treatment baseline when medical LLM output is missing or invalid; affected sections render user-facing "资料不足/暂不估算" guidance instead, while logs keep the failure reason for debugging.

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
- `POST /api/consultations`
- `POST /api/dental-assessments` (multipart form with at least one image/PDF)

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

Report generation events are written as JSONL files under `REPORT_GENERATION_LOG_DIR`, one file per day, for example `logs/report-generation-2026-06-11.jsonl`. The event log is intentionally non-sensitive: it records mode, submission number, visit purpose, upload counts, parser statuses, phase durations, per-file OCR/parser timing, result, provider/model, and failure code/message, but not patient identity fields or raw medical record text.
