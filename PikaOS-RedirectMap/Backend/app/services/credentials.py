"""HTTP Basic Auth for probing/fetching auth-gated sites (the browser "Sign in" dialog).

Some old/new sites — typically a UAT/staging environment — sit behind HTTP Basic Auth: a bare
probe just gets a `401` (the WHA UAT sites do this). The user supplies per-host credentials on the
request; this module maps a URL's host to its `httpx.BasicAuth` so both the verify probe and the
sitemap fetch can authenticate. Matching is by **exact host** (case-insensitive).

Secrets ride on the request ONLY — never persisted server-side, never in config/.env (the tool is
stateless and the no-hardcode rule forbids baking them in). On a cross-host redirect httpx itself
strips the Authorization header, so creds for site A never leak to site B.
"""
from __future__ import annotations

from urllib.parse import urlsplit

import httpx

from ..schemas import Credential


def _host(value: str) -> str:
    """Lowercased hostname of `value`, which may be a bare host (`site.uat.example.com`,
    optionally with a port) OR a full URL (`https://site.uat.example.com/path`). "" if unparseable."""
    v = (value or "").strip()
    if not v:
        return ""
    parsed = urlsplit(v if "://" in v else "//" + v)   # `//host` lets urlsplit read a bare host
    return (parsed.hostname or "").lower()


def build_auth_map(creds: list[Credential] | None) -> dict[str, httpx.BasicAuth]:
    """host (lowercased) -> BasicAuth, from the request's credential list. Entries with no host or
    no username are skipped (a blank password is allowed — some Basic Auth setups use one). Later
    duplicates win."""
    out: dict[str, httpx.BasicAuth] = {}
    for c in creds or []:
        host = _host(c.host)
        if not host or not c.username:
            continue
        out[host] = httpx.BasicAuth(c.username, c.password or "")
    return out


def auth_for(auth_map: dict[str, httpx.BasicAuth], url: str) -> httpx.BasicAuth | None:
    """BasicAuth for `url`'s host, or None when nothing matches (the common case — most sites are open)."""
    if not auth_map:
        return None
    return auth_map.get(_host(url))
