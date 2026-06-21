"""Settings for the standalone URL Redirect-Map service (env-driven, 12-factor).

Trimmed to ONLY what the redirect-map path needs — the tool is stateless (it probes
user-supplied URLs and emits redirect config text), so there's no database / redis /
minio / auth config here at all (that's the whole point of the split). Mappings are NOT
hardcoded here: they come from the UI / an imported checklist, never from this file.
"""
from __future__ import annotations

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    app_name: str = "URL Redirect Map"
    # Single source of truth for this app's version (UAT). Surfaced in /api/health + the OpenAPI
    # title. Bump on any behaviour/endpoint/schema change — see pikaos-dev-rules §6.5 (versioning)
    # + the registry PiKaOs-docs/docs/architecture/versions.md. Never hardcode the version elsewhere.
    app_version: str = "0.2.1"
    environment: str = "development"

    # --- URL probing (verify old → new mapping) ---
    # Per-request HTTP timeout when probing URLs (kept modest so a few slow/dead hosts can't
    # push total runtime past the dev-proxy timeout in Frontend/vite.config.js).
    redirect_timeout_seconds: float = 10.0
    # Polite default parallelism so a WAF/CDN-fronted site doesn't rate-limit our burst into
    # false "unreachable"/404 noise. A request may raise it via `concurrency`, never above max.
    redirect_default_concurrency: int = 8
    redirect_max_concurrency: int = 100        # hard ceiling on simultaneous probes
    redirect_max_rows: int = 2000              # safety cap on mapping rows verified in one call
    redirect_probe_retries: int = 1            # transient connect/read retries per probe (linear backoff)
    redirect_probe_backoff_seconds: float = 0.4
    # WAF / rate-limit retries: a burst into a WAF-fronted site (e.g. WHA's AWS WAF) comes back as
    # 403/405/429/503 even though the page is fine in a browser. Wait LONGER than a transient retry
    # (the WAF needs a cooldown), then re-probe; only after these are exhausted is the blocked status
    # reported. Set retries to 0 to disable. Backoff is linear: delay * attempt#.
    redirect_blocked_retries: int = 2
    redirect_blocked_backoff_seconds: float = 1.5
    # TLS verification. Default ON (verify certs). Many migrated sites ship an INCOMPLETE cert chain
    # (missing intermediate) — a browser fixes it via AIA-fetch but httpx can't, so a perfectly live
    # page reads as "unreachable" (the WHA new site does this). With verify ON, the probe auto-falls
    # back to a NO-VERIFY retry for such a host (and notes it), EXCEPT a host with Basic Auth — we
    # never send credentials over an unverified connection. Set False to skip verification outright.
    redirect_ssl_verify: bool = True

    # --- file scan (crawl pages → find downloadable files, compare old vs new) ---
    # Downloadable files (PDF/DOC/…) are linked INSIDE pages, not listed in the sitemap, so the
    # file check crawls pages and extracts the links. Bounded so a big site stays under the proxy
    # timeout: at most this many pages per site, fetched at this concurrency.
    redirect_file_scan_max_pages: int = 120
    redirect_file_scan_concurrency: int = 8
    redirect_file_exts: str = "pdf,doc,docx,xls,xlsx,ppt,pptx,zip,csv,rar,7z"

    # --- match quality (Discover fuzzy old→new) ---
    # Below this path-similarity %, the fuzzy best-match is too weak to trust (it's just the nearest
    # of whatever exists on the new site), so Discover leaves newUrl BLANK rather than auto-picking a
    # wrong page — the user chooses from the candidate list. Raise to be stricter, lower to auto-pick more.
    redirect_match_min_score: float = 60.0

    # --- body check (per-row, during verify) ---
    # A migrated page is "thin" when it has an <h1> heading but almost no body content beyond it
    # (a stub from an incomplete migration). After stripping chrome (header/nav/footer/script) and
    # the H1 text, fewer than this many visible characters left => flagged thin.
    redirect_body_min_chars: int = 40

    # --- SSRF guard (the tool probes user-supplied URLs — the only outbound path) ---
    # Reject URLs resolving to private/loopback/link-local/reserved IPs. Keep ON in any shared
    # deployment; turn off only for a trusted internal-only run.
    redirect_ssrf_block_private: bool = True
    # Optional comma-separated host allowlist (exact host or ".suffix"). Empty = any public host.
    redirect_url_allowlist: str = ""

    # --- CORS (frontend dev origin) ---
    cors_origins: str = "http://localhost:5175"

    @property
    def cors_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    @property
    def redirect_allowlist(self) -> list[str]:
        return [h.strip().lower() for h in self.redirect_url_allowlist.split(",") if h.strip()]

    @property
    def file_ext_list(self) -> list[str]:
        return [e.strip().lower().lstrip(".") for e in self.redirect_file_exts.split(",") if e.strip()]


settings = Settings()
