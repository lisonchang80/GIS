"""/api/* routes: Google auth + per-user project CRUD."""
import json
import os

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from . import auth, db

router = APIRouter(prefix="/api")

DEV_LOGIN = os.environ.get("GIS_DEV_LOGIN") == "1"
COOKIE_SECURE = os.environ.get("GIS_COOKIE_SECURE", "1") == "1"


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
    try:
        info = auth.verify_google_credential(body.credential)
    except Exception as e:  # noqa: BLE001 - surface a clean 401
        raise HTTPException(status_code=401, detail=f"invalid credential: {e}")
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
    response.delete_cookie(auth.COOKIE_NAME, path="/")
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
    payload = await request.json()
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="payload must be an object")
    version = int(payload.get("version", 1))
    name = payload.get("projectName") or "My Project"
    saved_at = db.put_project(uid, version, json.dumps(payload, ensure_ascii=False), name)
    return {"savedAt": saved_at}


@router.delete("/project")
def delete_project_route(uid: int = Depends(current_uid)):
    db.delete_project(uid)
    return {"ok": True}
