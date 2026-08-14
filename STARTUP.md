# Startup Guide

How to get Edu LLM running locally, with or without Docker.

## Prerequisites

- **Python 3.11+** (via Miniconda or Anaconda)
- **Node.js 20+** (for the frontend)
- **Docker + Docker Compose** (optional, for Postgres; see "Offline" section below if you don't have it)

## Setup (One Time)

### 1. Environment variables

Copy the example and update it:

```bash
cp .env.example .env
```

Edit `.env` if you need to:
- `NVIDIA_API_KEY` — your NVIDIA API Catalog key for chat models
- `HF_TOKEN` — optional HuggingFace token if you need it for downloads or future embeddings
- `RESEND_API_KEY` — leave blank for dev (magic links print to console); set to send real emails via Resend
- `DATABASE_URL` — default assumes Docker Postgres on port 5433; change if using a different setup
- `JWT_SECRET` — already has a dev key; generate a new one for production:
  ```bash
  python -c "import secrets; print(secrets.token_urlsafe(32))"
  ```

See `.env.example` for all available options.

### 2. Python environment

```bash
conda create -n edullm python=3.11 -y
conda activate edullm
cd backend
pip install -r requirements.txt
```

(First install is slow — `torch` and `docling` are large.)

### 3. Database

**Option A: With Docker (recommended)**
```bash
docker compose up -d postgres
python backend/scripts/init_db.py
```

**Option B: Without Docker** (see [Offline](#offline) below)

---

## Running the App

### Backend
```bash
cd backend
conda activate edullm
uvicorn app.main:app --reload --reload-dir app
```

`--reload-dir app` limits auto-reload to the `app/` package. Without it, uvicorn
watches the whole `backend/` working directory, so editing `scripts/*.py` (e.g.
`bulk_upload_docs.py`) or anything under `storage/` also restarts the server.

Health check: `curl http://localhost:8000/health`

Or run all services with Docker:
```bash
docker compose up
```

### Frontend
```bash
cd frontend
npm run dev
```

Visit `http://localhost:5173`

---

## Login (Phase 2: Email Magic Link)

The app now uses email-based login. You don't need to mint tokens manually anymore — just enter your institute email.

### In development:
1. Go to `/login`
2. Enter an email like:
   - `firstname.lastname@scet.ac.in` (faculty)
   - `name.co23d1@scet.ac.in` (student)
3. Check the **backend console** for the magic link (since Resend isn't configured locally)
4. Click the link to sign in

### In production:
1. Set `RESEND_API_KEY`, `RESEND_FROM_EMAIL` in `.env` (verify a custom domain in Resend to send to arbitrary recipients)
2. Users receive emails with sign-in links

---

## Offline — Without Docker or Services

If you don't have Docker or Postgres running, you can still test the frontend and chat logic with mocked data.

### Minimal backend setup (memory-only, no database)

This is **not recommended** for real testing, but useful for frontend iteration:

```bash
cd backend
conda activate edullm

# Mock mode: use an in-memory store (not implemented yet — you'd need to add it)
# For now, just run with a local SQLite or skip the backend
```

**Better option:** Use `docker compose up postgres` just for Postgres, no need for Docker's backend/frontend:

```bash
docker compose up -d postgres
cd backend && python scripts/init_db.py
uvicorn app.main:app --reload --reload-dir app  # This works without Docker

cd frontend
npm run dev
```

### Without email (force old dev login)

If you want to skip the email setup entirely:

```bash
python backend/scripts/mint_dev_token.py --sub student@scet.ac.in --role student
python backend/scripts/mint_dev_token.py --sub prof@scet.ac.in --role faculty
```

Then manually edit `frontend/src/auth/` to re-add the old `DevLoginPage.jsx` (it was deleted in Phase 2). Not recommended unless you really need it.

---

## Troubleshooting

**Port 5432/5433 already in use?**
- Change `docker-compose.yml` port mapping, or
- Change `DATABASE_URL` in `.env` to a different port

**Backend can't connect to Postgres?**
- Ensure `docker compose up -d postgres` is running
- Check `DATABASE_URL` in `.env` is correct
- Run `python backend/scripts/init_db.py` to create tables

**Frontend shows errors but backend is running?**
- Check `VITE_API_BASE_URL` in `.env` (default: `http://localhost:8000`)
- If backend is on a different port, update it

**LLM gives "provider not available" errors?**
- Check that `NVIDIA_API_KEY` is set in `.env`
- The default `LLM_MODEL` is a NVIDIA API Catalog model id. Swap it for another catalog model if needed

**Magic link isn't appearing in console?**
- Verify `logging.basicConfig()` is in `backend/app/main.py` (it is)
- Check the uvicorn output, not just stdin

**Ingestion fails for a PDF?**
- Docling is picky about file formats
- Try a simpler PDF or a Markdown file first

**"No such file or directory: backend/storage"?**
- The `storage/` directory is created on first upload
- Or: `mkdir -p backend/storage`

---

## Next Steps

- **Architecture deep dive?** → [ARCHITECTURE.md](ARCHITECTURE.md)
- **Add documents?** → Go to `/admin` (faculty only) after logging in
- **Deploy to production?** → See `docker-compose.yml` and `.env.example` for remote config
