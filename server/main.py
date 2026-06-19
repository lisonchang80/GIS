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

db.init_db()

app = FastAPI(title="GIS backend")

# CORS is only needed when the frontend is served from a different origin.
# Dev uses the Vite proxy (same origin) and prod serves dist/ here (same origin),
# so this mainly covers a directly-hit dev frontend on :5173.
origins = os.environ.get("GIS_CORS_ORIGINS", "http://localhost:5173").split(",")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in origins if o.strip()],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(router)

# Serve the built SPA if present (prod). API routes above take precedence.
_dist = Path(__file__).parent.parent / "dist"
if _dist.is_dir():
    app.mount("/", StaticFiles(directory=str(_dist), html=True), name="static")
