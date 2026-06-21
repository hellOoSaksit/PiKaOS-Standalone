<div align="center">

# PiKaOS-Standalone

**Single-capability tools, each lifted out of [PiKaOs](https://github.com/hellOoSaksit/PiKaOs) to run on its own.**
No login · no database · two small containers · deployable by a QA or content team with nothing but Docker.

![Python](https://img.shields.io/badge/Python-3.12-3776AB?logo=python&logoColor=white)
![FastAPI](https://img.shields.io/badge/FastAPI-0.137-009688?logo=fastapi&logoColor=white)
![React](https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=black)
![Docker](https://img.shields.io/badge/Docker-compose-2496ED?logo=docker&logoColor=white)
![Stateless](https://img.shields.io/badge/backend-stateless-success)
[![CI](https://github.com/hellOoSaksit/PiKaOS-Standalone/actions/workflows/ci.yml/badge.svg)](https://github.com/hellOoSaksit/PiKaOS-Standalone/actions/workflows/ci.yml)

</div>

> **Reader’s note.** This is the **standalone line** of the [PiKaOs](https://github.com/hellOoSaksit/PiKaOs)
> platform: each build is a single capability extracted to stand on its own — and kept
> re-integration-ready. Every app folder carries its own compact **BA/SA dossier** (problem →
> scope → system design). Start there for depth; this page is the index.

---

## The apps

| App | What it does | Ports (fe / be) | Version | Source | Docs |
|---|---|---|---|---|---|
| **Website Compare** | Catch what changed between **UAT** and **Production** before go-live — sitemap coverage + a section-by-section deep content diff | `5174 / 8001` | **0.1.0** · [release](https://github.com/hellOoSaksit/PiKaOS-Standalone/releases/tag/website-compare-v0.1) | [`PikaOS-Compare/`](PikaOS-Compare) | [README](PikaOS-Compare/README.md) |
| **URL Redirect Map** | Map every **old-site URL → new target**, verify both sides, generate an IIS `web.config` + an Excel checklist | `5175 / 8002` | **0.2.1** · [release](https://github.com/hellOoSaksit/PiKaOS-Standalone/releases/tag/redirect-map-v0.2) | [`PikaOS-RedirectMap/`](PikaOS-RedirectMap) | [README](PikaOS-RedirectMap/README.md) |

Host ports are owned by the shared
[port registry](https://github.com/hellOoSaksit/PiKaOs-docs/blob/main/docs/architecture/ports.md);
versions by each app’s `config.py` `app_version` + the
[version registry](https://github.com/hellOoSaksit/PiKaOs-docs/blob/main/docs/architecture/versions.md).
Both run **side-by-side** with each other and the main PiKaOs stack (`5173/8000`) — no port clashes.

---

## The standalone contract

Every build in this repo obeys the same rules — that’s what makes them cheap to ship and easy to fold
back into the platform:

- **Stateless** — no DB / redis / object-store. The only state lives in your browser (or in memory for the current run).
- **No login** — endpoints are open by design; put a network boundary / reverse proxy in front if you expose one.
- **Two containers** — a FastAPI API + a Vite/React SPA, wired by `docker compose`.
- **SSRF-guarded** — these tools fetch *user-supplied* URLs, so every outbound request **and every redirect hop** is checked against private / loopback / cloud-metadata ranges (`net_guard`).
- **Polite, streamed probing** — modest outbound concurrency + retries + chunked work, so a WAF/CDN-fronted site isn’t throttled into false negatives and no single request overruns the proxy timeout.
- **Config-driven version** — declared once in `config.py` (`app_version`), surfaced in `/api/health` + the OpenAPI title; CI fails the build if a version literal is hardcoded.
- **Secrets never persisted server-side** — per-site credentials live only in memory (a run) or this browser, and are never logged.

---

## Run an app

Each app is self-contained in its own folder:

```bash
cd PikaOS-Compare          # or:  cd PikaOS-RedirectMap
docker compose up -d --build       # backend + frontend, no db/redis/minio
# Compare      → http://localhost:5174
# RedirectMap  → http://localhost:5175
```

On Windows, double-click the app’s `start-*.bat`. Configuration is optional per app
(`.env.example` → `.env`: CORS origin, the SSRF-guard toggle, an optional host allowlist).

---

## CI

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs on every push / PR to `main`:

- **per-app unit tests** — pure logic (HTML/content extraction, page inspection, web.config, xlsx), no server needed, and
- a **version-guard** — fails the build if the app version is hardcoded in `main.py` instead of read from `config.py` (pikaos-dev-rules §6.5).

---

## Repo layout

```
PiKaOS-Standalone/
├─ PikaOS-Compare/        # Website Compare   (5174 / 8001) — v0.1
├─ PikaOS-RedirectMap/    # URL Redirect Map  (5175 / 8002) — v0.2.1
└─ .github/workflows/     # CI for both apps
```

Each app folder is a full stack: `Backend/` (FastAPI) · `Frontend/` (Vite + React) · `docker-compose.yml` · `start-*.bat`.

---

<div align="center">

Extracted from **[PiKaOs](https://github.com/hellOoSaksit/PiKaOs)** · Author — Saksit Chuenmaiwaiy
· built as a full-stack + BA/SA portfolio piece.

</div>
