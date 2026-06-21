"""URL Redirect Map — standalone FastAPI app (v0.2.1).

Just the redirect-map tool: a thin app that mounts the redirect router and a health check.
No database / redis / minio / auth lifespan — the tool is stateless and (in this build) open
(no login). The only outbound path is the SSRF-guarded URL probe (services/net_guard).
"""
from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .config import settings
from .routers import redirect

app = FastAPI(title=settings.app_name, version=settings.app_version)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(redirect.router)


@app.get("/api/health")
async def health() -> dict:
    return {"status": "ok", "app": settings.app_name, "version": settings.app_version}
