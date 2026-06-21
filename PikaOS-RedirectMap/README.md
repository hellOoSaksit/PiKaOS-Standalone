# URL Redirect Map — v0.2 (standalone)

A self-contained tool for the **old-site → new-site URL redirect** workflow, in the standalone
line of [PiKaOs](../../PiKaOs). You map each old URL to its new target, **verify** both sides,
generate an **IIS `web.config`** to set up the 301s, and round-trip the central **checklist** as
CSV — and **nothing else**: no sidebar nav, no other modules, **no login**.

> The tool is *stateless* (no database/redis/object-store) — it probes the URLs you give it and
> emits config text. Mappings live in **your browser** (localStorage) and the CSV you import/export.

## Run it

Whole thing runs in Docker (backend + frontend). Either:

- **Windows:** double-click [`start-redirectmap.bat`](start-redirectmap.bat) — brings the stack up and opens the browser.
- **Any OS:** `docker compose up -d --build`, then open **http://localhost:5175**.

> Host ports **5175** (frontend) / **8002** (backend) — chosen so this runs **side-by-side with the
> main PiKaOs stack** (5173/8000) and every other standalone. See the
> [port registry](../../PiKaOs-docs/docs/architecture/ports.md) (single source of truth). Change the
> `ports:` in [`docker-compose.yml`](docker-compose.yml) only if you reassign in the registry too.

Logs: Docker Desktop, or `docker compose logs -f backend` (or `frontend`). Config is optional —
copy [`.env.example`](.env.example) → `.env` only to override (CORS, SSRF guard, host allowlist).

## The workflow

1. **Build the mapping** — one row per old URL: `Symbol · old URL · new URL · status · note`.
   Three ways: **Discover from sitemap** (enter the old + new base URLs → it reads the old site's
   `sitemap.xml` and proposes `old → new` for *every* page, domain-swapped onto the new host — like
   Compare's coverage), **Import CSV** from the central checklist, or type rows by hand.
2. **Verify all** — probes the **old** side (without following redirects, so a 3xx and where it
   points stay visible) and the **new** side (following redirects, to judge the final landing
   page). Each row gets a suggested **status** + **note**:
   - `รอดำเนินการ` — new URL works, old reachable → ready to configure the redirect.
   - `ดำเนินการแล้ว` — old URL already 301/302s onto the new URL.
   - `ติดปัญหา` — new URL has no page (404/unreachable). The note suggests a fallback target
     (the new site's Home), per the brief's "no matching page → pick nearest" rule.
   - `ไม่ต้อง Redirect` — old URL is gone/unreachable; confirm whether a redirect is still needed.
3. **web.config** — turn the rows into an IIS URL-Rewrite file (301 by default; 302/307 and
   query-string handling are options). Download → drop at the old site's web root.
4. **Export Excel** — write the updated checklist back out as an **.xlsx that matches the central
   template** (`Ref/http_redirect_checklist_5_sites_by_symbol.xlsx`): three sheets (Redirect
   Checklist · Symbol Setup · Summary), the same title rows, 7-column header, and status dropdown.
   The tool's 4 statuses are mapped onto the template's dropdown vocabulary so every cell stays
   valid in Excel; the Summary sheet's per-Symbol counts are computed at export time.

## What's inside

| | |
|---|---|
| **Frontend** | Vite + React, one screen (`Frontend/src/screens/screens-redirect.jsx`) + the UI-kit pieces it uses. Proxies `/api` → backend. CSV parse/build + download are client-side. |
| **Backend** | FastAPI, **open** (no auth): `POST /api/redirect/{discover,verify,webconfig,export}` · `GET /api/health`. Stateless — no DB. |

Backend layering: `routers/redirect.py` → `services/{discover_service, verify_service, page_inspect, probe, sitemap, net_guard, webconfig, checklist_xlsx, credentials}.py`.
Outbound probes are **SSRF-guarded** (`net_guard`, reused from PiKaOs Compare) — private/internal
targets are rejected (toggle with `REDIRECT_SSRF_BLOCK_PRIVATE`).

## API

| Endpoint | Purpose |
|---|---|
| `POST /api/redirect/discover` | Read the old site's sitemap → propose one `old → new` row per URL (domain-swapped onto the new base). Cancellable. |
| `POST /api/redirect/verify` | Probe each mapping row (old + new side) → per-row status code, `alreadyRedirected`, suggested status/note/fallback. Cancellable (abort on the client stops the in-flight probes); the UI streams it in chunks so a whole-site batch fills live. |
| `POST /api/redirect/webconfig` | Rows → IIS URL-Rewrite `web.config` text + rule count + which rows were skipped (missing URL). Pure transform, no network. |
| `POST /api/redirect/export` | Rows → `.xlsx` matching the central checklist template (Redirect Checklist · Symbol Setup · Summary · ผลตรวจ sheets). |
| `GET  /api/health` | Liveness. |

## Scope (by decision)

- **Tool only** — it produces + verifies the mapping and the config; it does **not** serve the
  live 301s. The old domain's own infra (Azure App Service / IIS) does that using the generated
  `web.config`.
- **Config target = IIS web.config** — the old WHA sites run on Azure App Service (Windows/IIS).
  nginx / Front Door / generic-list targets are not generated (as of v0.2).
- **No login**, single screen, deps trimmed to `fastapi · uvicorn · httpx · pydantic · pydantic-settings · openpyxl`.

Extracted from **[PiKaOs](../../PiKaOs)** as the second build in the standalone line (after
[PikaOS-Compare](../PikaOS-Compare)).
