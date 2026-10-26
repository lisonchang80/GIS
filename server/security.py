"""ASGI middlewares that harden the /api routes.

SameOriginWriteGuard: SameSite=Lax cookies are still sent by pages on sibling
subdomains (evil.tinghaochang.com -> gis.tinghaochang.com is "same-site"), so a
state-changing request is only accepted when the browser says it came from this
exact origin. Non-browser clients (curl, scripts) send neither Sec-Fetch-Site nor
Origin and are let through: they don't carry a victim's cookie automatically.
"""
from urllib.parse import urlsplit

from starlette.datastructures import Headers
from starlette.responses import JSONResponse

SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}


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
