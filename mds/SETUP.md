# Setup

## Requirements

- Python 3.11+
- Node.js 20+
- Docker + Docker Compose (for Postgres)

## First-time setup

```bash
# 1. Config
cp .env.example .env          # then fill in NVIDIA_API_KEY and JWT_SECRET

# 2. Python env (run from repo root; first install is slow)
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# 3. Database
docker compose up -d postgres
python backend/scripts/init_db.py
```

Generate a `JWT_SECRET` with:
`python -c "import secrets; print(secrets.token_urlsafe(32))"`

## Run

```bash
# Database (Postgres on port 5433; start it again after every reboot)
docker compose up -d postgres

# Backend (http://localhost:8000, health: /health)
cd backend && uvicorn app.main:app --reload --reload-dir app

# Frontend (http://localhost:5173)
cd frontend && npm run dev
```

`--reload-dir app` stops edits in `scripts/` or `storage/` from restarting the server.
To run everything in Docker instead: `docker compose up`.

## Login

1. Open `/login` and enter an institute email:
   - Faculty: `firstname.lastname@scet.ac.in`
   - Student: `name.co23d1@scet.ac.in`
2. With `RESEND_API_KEY` blank, the magic link is printed in the **backend console**. Open it to sign in.
3. To log in with a non-institute email as faculty (dev only), add it to `DEV_FACULTY_EMAILS`.
4. Faculty manage documents, workspaces and classrooms under **Library** (`/library`). Students join a classroom from the shelf switcher at the top, with its code.

For curl testing without login: `python backend/scripts/mint_dev_token.py --sub prof@scet.ac.in --role faculty`

## Environment variables

| Variable | Notes |
|---|---|
| `NVIDIA_API_KEY` | Required. From build.nvidia.com |
| `NVIDIA_API_KEY_2`, `NVIDIA_API_KEY_3` | Optional backups, tried in order if the previous key is blank or fails |
| `LLM_MODEL` | NVIDIA API Catalog model id |
| `JWT_SECRET` | Required. Session token signing key |
| `DATABASE_URL` | Default: Docker Postgres on port **5433** |
| `RESEND_API_KEY`, `RESEND_FROM_EMAIL` | Blank = links logged to console. Real sending needs a verified domain in Resend |
| `MAGIC_LINK_BASE_URL` | Must point to the frontend's `/auth/verify` route |
| `DEV_FACULTY_EMAILS` | Dev only. Never set in production |
| `LANGSMITH_*` | Optional tracing. Off when unset |
| `HF_TOKEN` | Optional, for model downloads |
| `VITE_API_BASE_URL` | Backend URL for the frontend (default `http://localhost:8000`) |

Full list: `.env.example`.

## Troubleshooting

| Problem | Fix |
|---|---|
| Port 5433 in use | Change the port in `docker-compose.yml` and `DATABASE_URL` |
| `column "scope_ids" does not exist` (or similar) after pulling | Run `python backend/scripts/init_db.py`; it migrates the schema in place and is safe to re-run |
| Backend can't reach Postgres | Check `docker compose up -d postgres` is running, `DATABASE_URL` is right, and run `init_db.py` |
| Frontend can't reach backend | Check `VITE_API_BASE_URL` |
| "Model unavailable" answers | Check `NVIDIA_API_KEY` (and `_2`/`_3`) and `LLM_MODEL` |
| No magic link in console | Look at the uvicorn output |
| PDF ingestion fails | Try a simpler PDF or a Markdown file |
| `backend/storage` missing | `mkdir -p backend/storage` (also created on first upload) |

## Production checklist

1. Set real `JWT_SECRET`, `NVIDIA_API_KEY`, `RESEND_*`; choose `LLM_MODEL`.
2. Use a managed Postgres and real file storage (S3/GCS) instead of `backend/storage`.
3. Enable HTTPS (reverse proxy or a host that provides it).
4. Optionally enable LangSmith (`LANGSMITH_TRACING=true` + `LANGSMITH_API_KEY`).
5. Leave `DEV_FACULTY_EMAILS` empty.
6. Sizing for 30–75 concurrent users: start with 4 vCPU / 16 GB RAM.
