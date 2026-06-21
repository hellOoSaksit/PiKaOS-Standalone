# URL Redirect Map — v0.2.1 (standalone)

A self-contained tool for the **old-site → new-site URL redirect** workflow, in the standalone
line of [PiKaOs](../../PiKaOs). You map each old URL to its new target, **verify** both sides with
real HTTP probes, generate an **IIS `web.config`** for the 301s, and export a multi-sheet **Excel
checklist** — and **nothing else**: no sidebar nav, no other modules, **no login**.

> The tool is *stateless* (no database/redis/object-store) — it probes the URLs you give it and
> emits config text. **Rows live in memory** and are cleared on refresh (F5); a manual **Save/Load
> snapshot** persists the rows to *this browser* when you ask it to. **Probe credentials are
> in-memory only** — never written to disk, never logged, gone on refresh.

## What’s new in v0.2

- **Smarter Discover** — fuzzy `old → new` path matching with a ranked **candidate list**; when the best
  match is below the score threshold it leaves the target **blank** (so you pick, instead of auto-accepting
  a wrong page) and **flags duplicate-target collisions**.
- **Deep verify** — per-row downloadable-**file compare**, **thin-body** + **soft-error** (HTTP 200 but an
  error page) detection, **SPA / JS-render** and **AWS-WAF / CAPTCHA** page detection, and per-host **Basic Auth**.
- **Hardened probing** — **SSL incomplete-chain auto-fallback** (a live site with a missing intermediate cert
  reads as reachable; never attempted for an authenticated host) and **WAF / rate-limit blocked-retry** with backoff.
- **Richer export** — a **5-sheet** `.xlsx` including a focused **“ต้องแก้” worklist** and a **“ผลตรวจ”** detail
  sheet (candidates, collision flags, full file list per side, status colours).

## Run it

The whole thing runs in Docker (backend + frontend). Either:

- **Windows:** double-click [`start-redirectmap.bat`](start-redirectmap.bat) — brings the stack up and opens the browser.
- **Any OS:** `docker compose up -d --build`, then open **http://localhost:5175**.

> Host ports **5175** (frontend) / **8002** (backend) — chosen so this runs **side-by-side with the
> main PiKaOs stack** (5173/8000) and every other standalone. See the
> [port registry](../../PiKaOs-docs/docs/architecture/ports.md) (single source of truth). Change the
> `ports:` in [`docker-compose.yml`](docker-compose.yml) only if you reassign in the registry too.

Logs: Docker Desktop, or `docker compose logs -f backend` (or `frontend`). Config is optional —
copy [`.env.example`](.env.example) → `.env` only to override (CORS, SSRF guard, host allowlist,
retry/SSL/match-score knobs).

## The workflow

1. **Build the mapping** — one row per old URL: `Symbol · old URL · new URL · status · note`.
   Three ways:
   - **Discover from sitemap** — enter the old + new base URLs; it reads the old site’s `sitemap.xml`
     and proposes `old → new` for *every* page by **fuzzy path match** onto the new host. Weak matches are
     left blank with a **candidate list** to choose from; pages that several old URLs would point at the same
     new URL are flagged as a **collision**.
   - **Import CSV** from the central checklist, or **type rows** by hand.
2. **Verify all** — probes the **old** side *without* following redirects (so a 3xx and where it points
   stay visible) and the **new** side *following* redirects (to judge the final landing page). The deep
   check also compares **downloadable files** by filename, detects **thin / error / SPA / WAF** pages, and
   uses per-host **Basic Auth** where supplied. Each row gets a suggested **status** + **note**:
   - `รอดำเนินการ` — new URL works, old reachable → ready to configure the redirect.
   - `ดำเนินการแล้ว` — old URL already 301/302s onto the new URL.
   - `ติดปัญหา` — new URL has no page (404/unreachable), or the target is still blank → the note points to the
     candidate picker / a fallback (the new site’s Home).
   - `ไม่ต้อง Redirect` — old URL is gone/unreachable; confirm whether a redirect is still needed.
3. **web.config** — turn the rows into an IIS URL-Rewrite file (301 by default; 302/307 and
   query-string handling are options). Download → drop at the old site’s web root.
4. **Export Excel** — write the checklist out as an **`.xlsx`** named **`{Symbol} - Redirectmap - {YYYYMMDD}.xlsx`**,
   with **five sheets**:

   | Sheet | Contents |
   |---|---|
   | **Redirect Checklist** | the mapping, matching the central template’s title rows + 7-column header + status dropdown |
   | **Symbol Setup** | per-Symbol setup rows |
   | **Summary** | per-Symbol status counts, computed at export time |
   | **ต้องแก้** | a focused **worklist** — only the rows that need a human (blank/weak target with candidates, collisions, problems) |
   | **ผลตรวจ** | per-row **detail** — verify verdict, candidates, collision flag, full file list **per side**, with status colours |

## What’s inside

| | |
|---|---|
| **Frontend** | Vite + React, one screen (`Frontend/src/screens/screens-redirect.jsx`) + the UI-kit pieces it uses. Proxies `/api` → backend. CSV parse/build + downloads are client-side. Rows are in-memory with a manual Save/Load snapshot. |
| **Backend** | FastAPI, **open** (no auth): `POST /api/redirect/{discover,verify,webconfig,export}` · `GET /api/health`. Stateless — no DB. |

Backend layering: `routers/redirect.py` → `services/{discover_service, verify_service, page_inspect, probe, sitemap, net_guard, webconfig, checklist_xlsx, credentials}.py`.
Outbound probes are **SSRF-guarded** (`net_guard`, reused from PiKaOs Compare) — private/internal
targets are rejected (toggle with `REDIRECT_SSRF_BLOCK_PRIVATE`).

## API

| Endpoint | Purpose |
|---|---|
| `POST /api/redirect/discover` | Read the old site’s sitemap → propose one `old → new` row per URL via fuzzy match (ranked candidates, blank-on-weak-match, collision flags). Cancellable. |
| `POST /api/redirect/verify` | Probe each mapping row (old + new side) → per-row status code, `alreadyRedirected`, deep checks (files / thin / error / SPA / WAF), and a suggested status/note/fallback. Streams in chunks; cancellable. |
| `POST /api/redirect/webconfig` | Rows → IIS URL-Rewrite `web.config` text + rule count + which rows were skipped (missing URL). Pure transform, no network. |
| `POST /api/redirect/export` | Rows → the 5-sheet `.xlsx` checklist (binary). |
| `GET  /api/health` | Liveness (`app_version` from `config.py`). |

## Scope (by decision)

- **Tool only** — it produces + verifies the mapping and the config; it does **not** serve the
  live 301s. The old domain’s own infra (Azure App Service / IIS) does that using the generated `web.config`.
- **Config target = IIS web.config** — the old WHA sites run on Azure App Service (Windows/IIS).
  nginx / Front Door / generic-list targets are not generated (as of v0.2).
- **No login**, single screen, deps trimmed to `fastapi · uvicorn · httpx · pydantic · pydantic-settings · openpyxl`.

Extracted from **[PiKaOs](../../PiKaOs)** as the second build in the standalone line (after
[PikaOS-Compare](../PikaOS-Compare)).
