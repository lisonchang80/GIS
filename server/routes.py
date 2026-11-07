"""/api/* routes: Google auth + per-user project CRUD."""
import json
import logging
import os

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from . import auth, db, security

router = APIRouter(prefix="/api")
log = logging.getLogger(__name__)

DEV_LOGIN = os.environ.get("GIS_DEV_LOGIN") == "1"
COOKIE_SECURE = auth.COOKIE_SECURE


def _public_user(u):
    if not u:
        return None
    return {"id": u["id"], "email": u["email"], "name": u["name"], "picture": u["picture"]}


def set_session_cookie(response: Response, uid: int) -> None:
    response.set_cookie(
        auth.COOKIE_NAME,
        auth.make_session(uid, db.get_session_version(uid) or 0),
        max_age=auth.SESSION_MAX_AGE,
        httponly=True,
        samesite="lax",
        secure=COOKIE_SECURE,
        path="/",
    )


async def read_project_payload(request: Request, default_name: str):
    """Parse + validate a ProjectState body -> (version, name, json_text); bad input is a 400."""
    try:
        payload = await request.json()
    except ValueError:
        raise HTTPException(status_code=400, detail="body must be JSON")
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="payload must be an object")
    try:
        version = int(payload.get("version", 1))
    except (TypeError, ValueError, OverflowError):
        raise HTTPException(status_code=400, detail="invalid version")
    if not 0 <= version < 2**31:
        raise HTTPException(status_code=400, detail="invalid version")
    name = payload.get("projectName") or default_name
    if not isinstance(name, str):
        raise HTTPException(status_code=400, detail="invalid projectName")
    try:
        # NaN/Infinity parse fine but can't be sent back (JSONResponse refuses them),
        # which would make the stored project unloadable.
        data_json = json.dumps(payload, ensure_ascii=False, allow_nan=False)
    except ValueError:
        raise HTTPException(status_code=400, detail="NaN/Infinity not allowed")
    return version, name, data_json


def session_uid(request: Request):
    """uid of a valid, not-revoked session cookie, else None."""
    token = request.cookies.get(auth.COOKIE_NAME)
    session = auth.read_session(token) if token else None
    if not session:
        return None
    uid, sv = session
    # Logged out since this cookie was issued (or the user is gone): not a session.
    if db.get_session_version(uid) != sv:
        return None
    return uid


def current_uid(request: Request) -> int:
    uid = session_uid(request)
    if not uid:
        raise HTTPException(status_code=401, detail="not authenticated")
    return uid


def _etag(updated_at: str) -> str:
    return f'"{updated_at}"'


def _if_match(request: Request):
    """Revision the client based its edit on (None = no precondition)."""
    raw = request.headers.get("if-match")
    if raw is None:
        return None
    value = raw.strip()
    if value in ("", "*"):
        return None
    if value.startswith("W/"):
        value = value[2:]
    return value.strip().strip('"')


def _mb(n: int) -> str:
    return f"{n / (1024 * 1024):.1f}".removesuffix(".0")


# ---- auth ----
class GoogleLoginBody(BaseModel):
    credential: str


@router.post("/auth/google")
def auth_google(body: GoogleLoginBody, response: Response):
    if not auth.GOOGLE_CLIENT_ID:
        log.error("GIS_GOOGLE_CLIENT_ID not configured - Google login disabled")
        raise HTTPException(status_code=500, detail="login not configured")
    try:
        info = auth.verify_google_credential(body.credential)
    except Exception as e:  # noqa: BLE001 - surface a clean 401, details only in the log
        log.warning("rejected Google credential: %s", e)
        raise HTTPException(status_code=401, detail="invalid credential")
    uid = db.upsert_user(
        info["sub"], info.get("email", ""), info.get("name"), info.get("picture")
    )
    set_session_cookie(response, uid)
    return {"user": _public_user(db.get_user(uid))}


@router.post("/auth/dev-login")
def dev_login(response: Response):
    """Local-only bypass for testing without a real Google client. Gated by env."""
    if not DEV_LOGIN:
        raise HTTPException(status_code=404, detail="not found")
    uid = db.upsert_user("dev-sub-local", "dev@local", "Dev User", None)
    set_session_cookie(response, uid)
    return {"user": _public_user(db.get_user(uid))}


@router.post("/auth/logout")
def auth_logout(request: Request, response: Response):
    # Revoke server-side: a copy of this cookie (or the same account's cookie on
    # another device) must not keep working for the rest of its 30 days.
    uid = session_uid(request)
    if uid:
        db.bump_session_version(uid)
    # Same attributes as when set: browsers ignore a __Host- Set-Cookie without Secure.
    response.delete_cookie(
        auth.COOKIE_NAME, path="/", secure=COOKIE_SECURE, httponly=True, samesite="lax"
    )
    return {"ok": True}


@router.get("/me")
def me(uid: int = Depends(current_uid)):
    return {"user": _public_user(db.get_user(uid))}


# ---- projects (explicit ids) ----
# The old single-project /api/project (GET/PUT/DELETE) and PATCH rename routes
# were removed: the frontend never calls them, DELETE wiped ALL of the user's
# projects, and a rename was overwritten by the next PUT's projectName.
class CreateProjectBody(BaseModel):
    name: str | None = None


@router.get("/projects")
def list_projects_route(uid: int = Depends(current_uid)):
    return db.list_projects(uid)


@router.post("/projects")
def create_project_route(body: CreateProjectBody, uid: int = Depends(current_uid)):
    limit = security.max_projects()
    try:
        return db.create_project(uid, body.name or "未命名專案", max_projects=limit)
    except db.QuotaExceeded:
        raise HTTPException(
            status_code=413,
            detail=f"專案數量已達上限（每位使用者最多 {limit} 個），請先刪除不需要的專案再新增。",
        )


@router.get("/projects/{pid}")
def get_project_by_id_route(pid: int, uid: int = Depends(current_uid)):
    row = db.get_project_by_id(uid, pid)
    if not row:
        raise HTTPException(status_code=404, detail="not found")
    # ETag = updated_at: the client sends it back as If-Match when saving.
    headers = {"ETag": _etag(row["updated_at"]), "Cache-Control": "no-store"}
    if not row["data"]:
        return Response(status_code=204, headers=headers)
    # Stored text is already validated JSON (read_project_payload): send it as-is
    # instead of parsing + re-serializing a multi-MB document on every load.
    return Response(content=row["data"], media_type="application/json", headers=headers)


@router.put("/projects/{pid}")
async def put_project_by_id_route(pid: int, request: Request, uid: int = Depends(current_uid)):
    version, name, data_json = await read_project_payload(request, "未命名專案")
    limit = security.max_user_bytes()
    try:
        ts = db.update_project_by_id(
            uid,
            pid,
            version,
            data_json,
            name,
            expected_updated_at=_if_match(request),
            max_user_bytes=limit,
        )
    except db.ProjectNotFound:
        raise HTTPException(status_code=404, detail="not found")
    except db.RevisionConflict:
        raise HTTPException(
            status_code=409,
            detail="此專案已在其他分頁或裝置更新，請重新載入。",
        )
    except db.QuotaExceeded as e:
        raise HTTPException(
            status_code=413,
            detail=(
                f"儲存空間已達上限：每位使用者所有專案合計最多 {_mb(limit)} MB"
                f"（其他專案已用 {_mb(e.used)} MB，這次存檔 {_mb(e.requested)} MB）。"
                "請刪除不需要的專案或圖層後再試。"
            ),
        )
    return JSONResponse({"savedAt": ts}, headers={"ETag": _etag(ts)})


@router.delete("/projects/{pid}")
def delete_project_by_id_route(pid: int, uid: int = Depends(current_uid)):
    db.delete_project_by_id(uid, pid)
    return {"ok": True}
