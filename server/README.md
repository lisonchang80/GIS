# GIS backend (FastAPI + SQLite + Google login)

Per-user project storage. The frontend talks to this through `src/persistence.ts`
(`/api/project`) and `src/auth.ts` (`/api/auth/*`). One project per user (MVP);
the schema already supports multiple.

## Setup (Windows, no admin needed)

```powershell
cd "D:\Claude code\GIS\server"
py -3.11 -m venv .venv
.\.venv\Scripts\python -m pip install -r requirements.txt
```

## Run — dev (plain http localhost, fake login)

```powershell
cd "D:\Claude code\GIS"
$env:GIS_DEV_LOGIN = "1"        # enables /api/auth/dev-login
$env:GIS_COOKIE_SECURE = "0"    # cookie works over http
.\server\.venv\Scripts\python -m uvicorn server.main:app --port 8000 --reload
```

Then run the frontend (`npm run dev`); Vite proxies `/api` to :8000.

## Run — prod (behind Cloudflare tunnel, real Google login)

```powershell
cd "D:\Claude code\GIS"
npm run build                  # produces dist/, served by FastAPI at same origin
$env:GIS_GOOGLE_CLIENT_ID = "<client-id>.apps.googleusercontent.com"
$env:GIS_SESSION_SECRET   = "<long-random-string>"
$env:GIS_COOKIE_SECURE    = "1"
.\server\.venv\Scripts\python -m uvicorn server.main:app --port 8000
# cloudflared tunnel -> gis.tinghaochang.com -> localhost:8000
```

Do NOT also put Cloudflare Access in front (it would double the login).

## Endpoints

| Method | Path               | Auth | Purpose                         |
|--------|--------------------|------|---------------------------------|
| POST   | /api/auth/google   | -    | verify Google ID token, set cookie |
| POST   | /api/auth/logout   | -    | clear cookie                    |
| GET    | /api/me            | yes  | current user or 401             |
| GET    | /api/project       | yes  | latest project (204 if none)    |
| PUT    | /api/project       | yes  | upsert project                  |
| DELETE | /api/project       | yes  | clear project                   |
