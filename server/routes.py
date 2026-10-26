"""/api/* routes: Google auth + per-user project CRUD."""
import json
import logging
import os

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from . import auth, db

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
        auth.make_session(uid),
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


def current_uid(request: Request) -> int:
    token = request.cookies.get(auth.COOKIE_NAME)
    uid = auth.read_session(token) if token else None
    if not uid:
        raise HTTPException(status_code=401, detail="not authenticated")
    return uid


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
def auth_logout(response: Response):
    # Same attributes as when set: browsers ignore a __Host- Set-Cookie without Secure.
    response.delete_cookie(
        auth.COOKIE_NAME, path="/", secure=COOKIE_SECURE, httponly=True, samesite="lax"
    )
    return {"ok": True}


@router.get("/me")
def me(uid: int = Depends(current_uid)):
    return {"user": _public_user(db.get_user(uid))}


# ---- project ----
@router.get("/project")
def get_project_route(uid: int = Depends(current_uid)):
    row = db.get_project(uid)
    if not row:
        return Response(status_code=204)
    return JSONResponse(content=json.loads(row["data"]))


@router.put("/project")
async def put_project_route(request: Request, uid: int = Depends(current_uid)):
    version, name, data_json = await read_project_payload(request, "My Project")
    saved_at = db.put_project(uid, version, data_json, name)
    return {"savedAt": saved_at}


@router.delete("/project")
def delete_project_route(uid: int = Depends(current_uid)):
    db.delete_project(uid)
    return {"ok": True}


# ---- multi-project (explicit ids) ----
class CreateProjectBody(BaseModel):
    name: str | None = None


class RenameBody(BaseModel):
    name: str


@router.get("/projects")
def list_projects_route(uid: int = Depends(current_uid)):
    return db.list_projects(uid)


@router.post("/projects")
def create_project_route(body: CreateProjectBody, uid: int = Depends(current_uid)):
    return db.create_project(uid, body.name or "未命名專案")


@router.get("/projects/{pid}")
def get_project_by_id_route(pid: int, uid: int = Depends(current_uid)):
    row = db.get_project_by_id(uid, pid)
    if not row:
        raise HTTPException(status_code=404, detail="not found")
    if not row["data"]:
        return Response(status_code=204)
    return JSONResponse(content=json.loads(row["data"]))


@router.put("/projects/{pid}")
async def put_project_by_id_route(pid: int, request: Request, uid: int = Depends(current_uid)):
    version, name, data_json = await read_project_payload(request, "未命名專案")
    ok, ts = db.update_project_by_id(uid, pid, version, data_json, name)
    if not ok:
        raise HTTPException(status_code=404, detail="not found")
    return {"savedAt": ts}


@router.patch("/projects/{pid}")
def rename_project_route(pid: int, body: RenameBody, uid: int = Depends(current_uid)):
    if not db.rename_project_by_id(uid, pid, body.name):
        raise HTTPException(status_code=404, detail="not found")
    return {"ok": True}


@router.delete("/projects/{pid}")
def delete_project_by_id_route(pid: int, uid: int = Depends(current_uid)):
    db.delete_project_by_id(uid, pid)
    return {"ok": True}
