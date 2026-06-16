# PiKaOs — Standalone builds

Self-contained, single-feature extractions of [PiKaOs](https://github.com/hellOoSaksit/PiKaOs) —
each runs on its own (no login, no nav, minimal services) so a department can deploy just the one
tool it needs. Each lives in its own folder here and ships as a tagged **Release** with a `.zip`.

## Builds

### 🔀 [`PikaOS-Compare/`](PikaOS-Compare) — Website Compare · v0.1
UAT vs Production content comparison: sitemap coverage + a deep diff (title/meta/canonical/og,
**H1–H6 heading outline**, block-by-block body diff, images/links/files), jump-to-live-text,
per-side login for gated sites, saved sites + per-run cache. Stateless backend (no DB/redis/minio).

- **Download:** **[Website Compare v0.1](https://github.com/hellOoSaksit/PiKaOS-Standalone/releases/tag/website-compare-v0.1)** → [`PikaOS-Compare-v0.1.zip`](https://github.com/hellOoSaksit/PiKaOS-Standalone/releases/download/website-compare-v0.1/PikaOS-Compare-v0.1.zip)
- **Run:** unzip → `cd PikaOS-Compare` → `docker compose up -d --build` (or `start-compare.bat` on Windows) → http://localhost:5173

See [`PikaOS-Compare/README.md`](PikaOS-Compare/README.md) for details.
