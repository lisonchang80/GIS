"""FastAPI entrypoint.

Run (from the GIS project root):
    uvicorn server.main:app --port 8000

In production it also serves the built frontend (../dist) at the same origin,
so the Cloudflare tunnel only needs to point at this one port.
"""
import os
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from . import db
from .routes import router
from .security import BodySizeLimit, SameOriginWriteGuard, project_body_limit

db.init_db()

# Interactive API docs only in dev: Swagger UI pulls scripts from a CDN and would
# run them on the production origin, next to the session cookie.
_dev = os.environ.get("GIS_DEV_LOGIN") == "1"
app = FastAPI(
    title="GIS backend",
    docs_url="/docs" if _dev else None,
    redoc_url="/redoc" if _dev else None,
    openapi_url="/openapi.json" if _dev else None,
)

# CORS is only needed when the frontend is served from a different origin.
# Dev uses the Vite proxy (same origin) and prod serves dist/ here (same origin),
# so by default no other origin is trusted; set GIS_CORS_ORIGINS to opt in.
origins = os.environ.get("GIS_CORS_ORIGINS", "").split(",")
cors_origins = [o.strip() for o in origins if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
# Writes must come from this origin (or an explicitly CORS-allowed one).
app.add_middleware(SameOriginWriteGuard, allowed_origins=cors_origins)
app.add_middleware(BodySizeLimit, project_limit=project_body_limit())

app.include_router(router)

# Serve the built SPA if present (prod). API routes above take precedence.
_dist = Path(__file__).parent.parent / "dist"
if _dist.is_dir():
    app.mount("/", StaticFiles(directory=str(_dist), html=True), name="static")
