"""URL Redirect-Map endpoints (standalone build — NO auth).

Thin layer: parse request → call a service → map domain errors to HTTP.
- POST /api/redirect/discover  — read the old site's sitemap → propose old→new mapping rows.
- POST /api/redirect/verify    — probe each mapping row (old + new side) → suggested status/note.
- POST /api/redirect/webconfig — turn the rows into an IIS URL-Rewrite web.config (no network).
The discover + verify runs are cancellable: a Cancel on the frontend closes the socket, which
aborts the in-flight outbound work (a big batch holds many).
"""
from __future__ import annotations

import asyncio

from fastapi import APIRouter, HTTPException, Request, status
from fastapi.responses import Response

from ..schemas import (
    DiscoverIn, DiscoverOut, ExportIn, VerifyIn, VerifyOut, WebConfigIn, WebConfigOut,
)
from ..services import checklist_xlsx, discover_service, verify_service, webconfig
from ..services.net_guard import BlockedURLError
from ..services.sitemap import SitemapError

XLSX_MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"

router = APIRouter(prefix="/api/redirect", tags=["redirect"])

# status used when the client aborts mid-run (nginx's "client closed request")
CLIENT_CLOSED = 499


async def _run_cancellable(request: Request, coro):
    """Run `coro` but cancel it the moment the client disconnects (a Cancel/abort on the
    frontend closes the socket). A verify holds many in-flight outbound probes; cancelling
    the task propagates CancelledError into those awaits so the outbound work actually STOPS."""
    task = asyncio.ensure_future(coro)

    async def watch():
        while not task.done():
            if await request.is_disconnected():
                task.cancel()
                return
            await asyncio.sleep(0.4)

    watcher = asyncio.ensure_future(watch())
    try:
        return await task
    except asyncio.CancelledError:
        raise HTTPException(CLIENT_CLOSED, "Client cancelled the request")
    finally:
        watcher.cancel()
        if not task.done():
            task.cancel()


@router.post("/discover", response_model=DiscoverOut)
async def discover(body: DiscoverIn, request: Request) -> DiscoverOut:
    """Read the old site's sitemap and propose an old→new mapping row per URL (domain-swapped)."""
    try:
        return await _run_cancellable(request, discover_service.discover(body))
    except BlockedURLError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Blocked URL: {exc}")
    except SitemapError as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, f"Sitemap error: {exc}")


@router.post("/verify", response_model=VerifyOut)
async def verify(body: VerifyIn, request: Request) -> VerifyOut:
    """Probe each mapping row (old side no-follow, new side follow) and suggest a status/note."""
    try:
        return await _run_cancellable(request, verify_service.verify(body))
    except BlockedURLError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Blocked URL: {exc}")


@router.post("/webconfig", response_model=WebConfigOut)
async def webconfig_gen(body: WebConfigIn) -> WebConfigOut:
    """Generate an IIS URL-Rewrite web.config from the mapping rows (pure transform, no network)."""
    return webconfig.generate(body)


@router.post("/export")
async def export_xlsx(body: ExportIn) -> Response:
    """Export the mapping rows as an .xlsx matching the central checklist template."""
    data = checklist_xlsx.build(body.rows)
    return Response(
        content=data,
        media_type=XLSX_MEDIA_TYPE,
        headers={"Content-Disposition": 'attachment; filename="redirect-checklist.xlsx"'},
    )
