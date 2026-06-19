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

    # --- file scan (crawl pages → find downloadable files, compare old vs new) ---
    # Downloadable files (PDF/DOC/…) are linked INSIDE pages, not listed in the sitemap, so the
    # file check crawls pages and extracts the links. Bounded so a big site stays under the proxy
    # timeout: at most this many pages per site, fetched at this concurrency.
    redirect_file_scan_max_pages: int = 120
    redirect_file_scan_concurrency: int = 8
    redirect_file_exts: str = "pdf,doc,docx,xls,xlsx,ppt,pptx,zip,csv,rar,7z"

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
