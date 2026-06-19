"""Settings for the standalone Website-Compare service (env-driven, 12-factor).

Trimmed to ONLY what the compare path needs — the compare feature is stateless, so there's
no database / redis / minio / auth config here at all (that's the whole point of the split).
"""
from __future__ import annotations

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    app_name: str = "Website Compare"
    environment: str = "development"

    # --- UAT vs Production sitemap comparison ---
    # Per-request HTTP timeout when probing URLs (kept modest so a few slow/dead hosts can't
    # push total runtime past the dev-proxy timeout in Frontend/vite.config.js).
    compare_timeout_seconds: float = 10.0
    # Polite default parallelism so a WAF/CDN-fronted site doesn't rate-limit our burst into
    # false "unreachable"/404 noise. A request may raise it via `concurrency`, never above max.
    compare_default_concurrency: int = 8
    compare_max_concurrency: int = 200       # hard ceiling on simultaneous probes
    compare_max_urls: int = 2000             # safety cap on URLs pulled from a sitemap
    compare_probe_retries: int = 1           # transient connect/read retries per probe (linear backoff)
    compare_probe_backoff_seconds: float = 0.4
    # --- deep mode (fetch full HTML + compare body/title/meta/headings/images/links) ---
    compare_deep_limit: int = 5              # default # of pages to deep-compare (heavy + slow)
    compare_deep_max_limit: int = 500        # hard ceiling on deep pages
    compare_deep_concurrency: int = 8        # pages deep-compared in parallel
    compare_deep_img_cap: int = 15           # max images probed per page
    compare_deep_link_cap: int = 20          # max internal links probed per page
    compare_body_sim_threshold: float = 0.98 # below this = body content differs
    compare_deep_text_chars: int = 2000      # body text returned per side for the client-side diff
    compare_deep_max_blocks: int = 150       # content blocks returned per side for the block diff

    # --- SSRF guard (compare fetches user-supplied URLs — the only outbound path) ---
    # Reject URLs resolving to private/loopback/link-local/reserved IPs. Keep ON in any shared
    # deployment; turn off only for a trusted internal-only run.
    compare_ssrf_block_private: bool = True
    # Optional comma-separated host allowlist (exact host or ".suffix"). Empty = any public host.
    compare_url_allowlist: str = ""

    # --- CORS (frontend dev origin) ---
    cors_origins: str = "http://localhost:5174"   # host frontend port (registry: PiKaOs-docs/docs/architecture/ports.md)

    @property
    def cors_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    @property
    def compare_allowlist(self) -> list[str]:
        return [h.strip().lower() for h in self.compare_url_allowlist.split(",") if h.strip()]


settings = Settings()
