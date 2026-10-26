"""ASGI middlewares that harden the /api routes.

SameOriginWriteGuard: SameSite=Lax cookies are still sent by pages on sibling
subdomains (evil.tinghaochang.com -> gis.tinghaochang.com is "same-site"), so a
state-changing request is only accepted when the browser says it came from this
exact origin. Non-browser clients (curl, scripts) send neither Sec-Fetch-Site nor
Origin and are let through: they don't carry a victim's cookie automatically.

BodySizeLimit: uvicorn has no body limit, and FastAPI reads + JSON-parses a
Pydantic body *before* the auth dependency runs, so without this an anonymous
client could make the server buffer an arbitrarily large body.
"""
import os
import re
from urllib.parse import urlsplit

from starlette.datastructures import Headers
from starlette.exceptions import HTTPException
from starlette.responses import JSONResponse

SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}

DEFAULT_BODY_LIMIT = 64 * 1024  # login token / project name: a few KB at most
# Whole-project saves are the only big bodies (ProjectState JSON).
_PROJECT_SAVE = re.compile(r"^/api/project(s/[^/]+)?$")
DEFAULT_PROJECT_MB = 50  # the bundled demo project is ~3.4 MB


def project_body_limit() -> int:
    try:
        mb = float(os.environ.get("GIS_MAX_PROJECT_MB", DEFAULT_PROJECT_MB))
    except ValueError:
        mb = DEFAULT_PROJECT_MB
    return int(mb * 1024 * 1024)


def is_same_origin_request(headers: Headers, allowed_origins=frozenset()) -> bool:
    origin = headers.get("origin")
    if origin and origin.rstrip("/") in allowed_origins:
        return True
    site = headers.get("sec-fetch-site")
    if site is not None:
        return site in ("same-origin", "none")
    if origin is None:
        return True
    # Old browsers without Sec-Fetch-*: fall back to comparing Origin with Host.
    return urlsplit(origin).netloc.lower() == (headers.get("host") or "").lower()


class SameOriginWriteGuard:
    def __init__(self, app, allowed_origins=()):
        self.app = app
        self.allowed_origins = frozenset(o.rstrip("/") for o in allowed_origins)

    async def __call__(self, scope, receive, send):
        if (
            scope["type"] == "http"
            and scope["method"] not in SAFE_METHODS
            and scope["path"].startswith("/api/")
            and not is_same_origin_request(Headers(scope=scope), self.allowed_origins)
        ):
            response = JSONResponse({"detail": "cross-site request blocked"}, status_code=403)
            await response(scope, receive, send)
            return
        await self.app(scope, receive, send)


class BodySizeLimit:
    def __init__(self, app, default_limit=DEFAULT_BODY_LIMIT, project_limit=None):
        self.app = app
        self.default_limit = default_limit
        self.project_limit = project_limit  # None = unlimited

    def _limit_for(self, scope):
        if scope["method"] == "PUT" and _PROJECT_SAVE.match(scope["path"]):
            return self.project_limit
        return self.default_limit

    async def __call__(self, scope, receive, send):
        limit = self._limit_for(scope) if scope["type"] == "http" else None
        if limit is None:
            await self.app(scope, receive, send)
            return
        declared = Headers(scope=scope).get("content-length")
        if declared is not None and (not declared.isdigit() or int(declared) > limit):
            response = JSONResponse({"detail": "request body too large"}, status_code=413)
            await response(scope, receive, send)
            return

        received = 0

        async def limited_receive():
            # Chunked bodies have no Content-Length: count as they stream in.
            nonlocal received
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > limit:
                    raise HTTPException(status_code=413, detail="request body too large")
            return message

        await self.app(scope, limited_receive, send)
