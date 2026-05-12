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
