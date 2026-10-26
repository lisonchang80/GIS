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
# optional: without GIS_SESSION_SECRET a random one is used per process,
# so every --reload logs you out
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
| GET    | /api/projects      | yes  | list own projects               |
| POST   | /api/projects      | yes  | create project                  |
| GET/PUT/PATCH/DELETE | /api/projects/{id} | yes | load / save / rename / delete (owner only, else 404) |

## Security behaviour

- `GIS_SESSION_SECRET` unset (or a placeholder from this repo) → a random secret
  per process is used and a warning is logged: nobody can forge a session, but
  everyone is logged out on restart. Always set it in production.
- Session cookie is `__Host-gis_session` (HttpOnly, Secure, SameSite=Lax, no
  Domain) when `GIS_COOKIE_SECURE=1`, so sibling `*.tinghaochang.com` pages
  can't plant one; plain-http dev uses `gis_session`.
- POST/PUT/PATCH/DELETE on `/api/*` must come from this origin
  (`Sec-Fetch-Site: same-origin`, or `Origin` == `Host` on older browsers);
  requests without `Origin` (curl, scripts) are allowed. `GIS_CORS_ORIGINS`
  (default: none) lists extra trusted origins.
- Body limits: 64 KB for everything except whole-project saves
  (`PUT /api/project`, `PUT /api/projects/{id}`), which are capped by
  `GIS_MAX_PROJECT_MB` (default 50). Over the limit → 413.
- Google tokens must have `email_verified`; failed logins return a generic
  `invalid credential` (details only in the server log); a missing
  `GIS_GOOGLE_CLIENT_ID` returns 500 `login not configured`.
- `/docs`, `/redoc`, `/openapi.json` only exist when `GIS_DEV_LOGIN=1`.

## Tests

```powershell
.\server\.venv\Scripts\python -m pip install -r server/requirements-dev.txt
npm run test:server        # or: npm test (frontend + backend)
```

Tests use a temporary SQLite file per test, block outbound network, and sign
fake Google ID tokens with a throwaway RSA key.
