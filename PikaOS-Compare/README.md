# Website Compare — v0.1 (standalone)

A self-contained build of the **Compare** feature lifted out of [PiKaOs](../../PiKaOs). It compares a
**UAT** site against **Production** — sitemap URL coverage + an optional deep body/heading/SEO/
image/link diff — and **nothing else**: no sidebar nav, no other modules, **no login**.

> Extracted from PiKaOs on 2026-06-16. The compare feature is *stateless* (no database/redis/
> object-store), which is exactly why it splits out cleanly into this two-service app.

## Run it

Whole thing runs in Docker (backend + frontend). Either:

- **Windows:** double-click [`start-compare.bat`](start-compare.bat) — brings the stack up and opens the browser.
- **Any OS:** `docker compose up -d --build`, then open **http://localhost:5174**.

> Uses host ports **5174** (frontend) and **8001** (backend) — chosen so this runs **side-by-side
> with the main PiKaOs stack** (5173/8000) and every other standalone. See the
> [port registry](../../PiKaOs-docs/docs/architecture/ports.md) (single source of truth). Change the
> `ports:` in [`docker-compose.yml`](docker-compose.yml) only if you reassign in the registry too.

Logs: Docker Desktop, or `docker compose logs -f backend` (or `frontend`). Config is optional —
copy [`.env.example`](.env.example) → `.env` only to override (CORS, SSRF guard, host allowlist).

## What's inside

| | |
|---|---|
| **Frontend** | Vite + React, the Compare screen + the UI kit pieces it uses (`Frontend/src`). Proxies `/api` → backend. |
| **Backend** | FastAPI, **open** (no auth): `POST /api/compare/plan` · `/batch` · `/deep` (+ legacy `/api/compare`) and `/api/health`. Stateless — no DB. |

Backend layering is unchanged from PiKaOs: `routers/compare.py` → `services/compare_service.py`
→ `services/{content,sitemap,net_guard}.py`. Outbound fetches are **SSRF-guarded** (`net_guard`)
— private/internal targets are rejected (toggle with `COMPARE_SSRF_BLOCK_PRIVATE`).

## Features (same engine as PiKaOs)

- **Sitemap coverage** — Production's `sitemap.xml` is the source of truth; each path is checked on UAT (match / redirect / missing / broken). Streams in batches with a live table + Cancel.
- **Two pages (direct)** — deep-diff any two exact URLs (even unrelated sites).
- **Deep diff** — title/meta/canonical/og, **H1–H6 heading outline**, block-by-block body diff, images & internal links, downloadable files (by name). **Incremental**: raise the page count and it fetches only the new pages.
- **Jump to the live page** — click any differing body block / heading to open the real page scrolled to + highlighting that text (native scroll-to-text-fragment).
- **Per-side login** — HTTP Basic / header creds for login-gated PROD or UAT sites (held in memory).
- **Saved sites** — store reusable Prod/UAT pairs (+ creds) and a per-run cache, persisted in the browser. ⚠️ Saved credentials (incl. passwords) live in `localStorage` on this machine only — local/internal use, never synced.

## Differences from the full PiKaOs Compare

- **No login** — endpoints are open (drop the `Depends(get_current_user)` gate). Put it behind a network boundary / reverse proxy if exposed.
- Only the Compare screen ships — no nav, dashboards, RBAC, world, etc.
- Backend deps trimmed to `fastapi · uvicorn · httpx · pydantic · pydantic-settings` (no sqlalchemy/asyncpg/redis/minio/jwt/argon2).

Behaviour reference: the parent repo's [docs/features/compare.md](../../PiKaOs-docs/docs/features/compare.md).
