"""Website Compare — standalone FastAPI app (v0.1).

Just the compare feature: a thin app that mounts the compare router and a health check.
No database / redis / minio / auth lifespan — compare is stateless and (in this build) open
(no login). The only outbound path is the SSRF-guarded compare fetch (services/net_guard).
"""
from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .config import settings
from .routers import compare

app = FastAPI(title="Website Compare", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(compare.router)


@app.get("/api/health")
async def health() -> dict:
    return {"status": "ok", "app": settings.app_name, "version": "0.1.0"}
