"""Low-level URL probing for the redirect-map tool.

One job: given a URL, return its HTTP status (and, depending on mode, its redirect Location
or final landing URL) without ever crashing the run on a dead/slow/blocked host. HEAD is tried
first (cheap); a GET fallback covers servers that mishandle HEAD. Transient connect/read
failures are retried a few times — a WAF/CDN drops a fraction of a burst, which would otherwise
read as a bogus "unreachable". Every client carries the SSRF guard (net_guard), so a blocked
internal target surfaces here as a failed request (→ status None) rather than a real connection.
"""
from __future__ import annotations

import asyncio

import httpx

from ..config import settings
from .net_guard import guarded_event_hooks

# Look like a real browser. WAF/CDN (Cloudflare etc.) block a non-browser User-Agent — the WHA
# new site returns 404/405 to a bot UA but 301→200 to a browser UA. A custom UA like
# "PiKaOs-RedirectMap/1.0" made every probe a false "URL ใหม่ยังไม่พร้อม". So send a full Chrome
# UA + the Accept headers a browser sends (still no JS/TLS-fingerprint, so a hard JS-challenge
# WAF can still 403/405 — verify_service treats those as "blocked", not "page missing").
_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9,th;q=0.8",
}


def make_client(*, follow_redirects: bool) -> httpx.AsyncClient:
    """An httpx client for the probe path with the SSRF guard attached (it fires on every
    request incl. redirect hops — see net_guard). `follow_redirects` distinguishes the two
    probe modes: old side = False (see the 3xx + where it points), new side = True (judge the
    final landing page)."""
    return httpx.AsyncClient(
        headers=_HEADERS,
        timeout=httpx.Timeout(settings.redirect_timeout_seconds),
        follow_redirects=follow_redirects,
        event_hooks=guarded_event_hooks(),
    )


async def _request(client: httpx.AsyncClient, url: str) -> httpx.Response | None:
    """Fetch `url` → its Response, or None if it failed after retries.

    HEAD first; fall back to GET when HEAD is unsupported (405/501) or errors out. A transient
    connect/read failure is retried `redirect_probe_retries` times with linear backoff."""
    for attempt in range(settings.redirect_probe_retries + 1):
        try:
            resp = await client.head(url)
            if resp.status_code in (405, 501) or (resp.status_code >= 400 and resp.status_code != 404):
                resp = await client.get(url)
            return resp
        except httpx.HTTPError:
            try:
                return await client.get(url)
            except httpx.HTTPError:
                if attempt < settings.redirect_probe_retries:
                    await asyncio.sleep(settings.redirect_probe_backoff_seconds * (attempt + 1))
    return None


async def probe_no_follow(client: httpx.AsyncClient, url: str) -> tuple[int | None, str | None]:
    """Old-side probe: (status, Location). Redirects are NOT followed, so a 3xx and its target
    stay visible — that's how we detect an old URL that already redirects onto the new one.
    The client must have been built with follow_redirects=False."""
    resp = await _request(client, url)
    if resp is None:
        return None, None
    return resp.status_code, resp.headers.get("location")


async def probe_follow(client: httpx.AsyncClient, url: str) -> tuple[int | None, str | None]:
    """New-side probe: (final status, final URL) after following redirects — judges whether the
    new URL actually lands on a real page. The client must have follow_redirects=True."""
    resp = await _request(client, url)
    if resp is None:
        return None, None
    return resp.status_code, str(resp.url)
