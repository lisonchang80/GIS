# Deploying Web GIS publicly (gis.tinghaochang.com)

The app runs entirely on this Windows PC: FastAPI serves both the built SPA and
the `/api` routes from `127.0.0.1:8000` (same origin), and the **shared**
Cloudflare tunnel (the one already serving ClinScope) routes
`gis.tinghaochang.com` to it. Login is in-app Google OAuth, so do **not** put
Cloudflare Access in front (it would double the login).

## One-time setup

### 1. Google OAuth client  (only you can do this — your Google account)
1. https://console.cloud.google.com → pick/create a project.
2. **APIs & Services → OAuth consent screen** → External → fill app name +
   support email (your gmail) + authorized domain `tinghaochang.com`. Add
   yourself as a Test user, or Publish.
3. **Credentials → Create OAuth client ID → Web application**:
   - Authorized JavaScript origins:
     `https://gis.tinghaochang.com` and `http://localhost:5180` (dev).
   - (ID-token flow needs no redirect URI and no client secret.)
4. Copy the **Client ID**.

### 2. Frontend client id
Copy `.env.local.example` → `.env.local` and set
`VITE_GOOGLE_CLIENT_ID=<the client id>`. The id is baked in at build time, so
rebuild after changing it.

### 3. Backend secrets
Copy `packaging/env.local.bat.example` → `packaging/env.local.bat` and set
`GIS_GOOGLE_CLIENT_ID` (same id) and `GIS_SESSION_SECRET` (a long random string,
e.g. `python -c "import secrets; print(secrets.token_urlsafe(48))"`).

### 4. Tunnel ingress  (edit `C:\Users\hao80\.cloudflared\config.yml`)
The `gis.tinghaochang.com` rule has already been added above the catch-all 404.
Create the DNS record once (this touches your Cloudflare DNS):

```
cloudflared tunnel route dns clinscope gis.tinghaochang.com
```

Then restart the shared tunnel so it picks up the new ingress (briefly drops
ClinScope):

```
cloudflared tunnel run clinscope
```

## Each deploy

```powershell
cd "D:\Claude code\GIS"
npm run build                       # rebuild dist/ (includes the client id)
packaging\start_public.bat          # starts the GIS server on :8000
```

The public site is then live at https://gis.tinghaochang.com (assuming the
shared tunnel is running).

## Autostart at login (optional)
Put a shortcut to `packaging\autostart\gis_public.vbs` in the Startup folder
(`Win+R` → `shell:startup`). It launches `start_public.bat` hidden. The tunnel
already autostarts for ClinScope.

## Notes / gotchas
- Google login does **not** work inside in-app browsers (LINE / IG / calendar
  WebViews) → `403 disallowed_useragent`. Open in Safari/Chrome proper.
- `server/gis.db` (SQLite) holds all users' projects — back it up to keep data.
- Local http testing uses `GIS_DEV_LOGIN=1` + `GIS_COOKIE_SECURE=0`; production
  (`start_public.bat`) forces `GIS_DEV_LOGIN=0` + `GIS_COOKIE_SECURE=1`.
