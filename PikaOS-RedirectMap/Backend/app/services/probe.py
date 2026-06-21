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
from collections.abc import Awaitable, Callable

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


def make_client(*, follow_redirects: bool, verify: bool = True) -> httpx.AsyncClient:
    """An httpx client for the probe path with the SSRF guard attached (it fires on every
    request incl. redirect hops — see net_guard). `follow_redirects` distinguishes the two
    probe modes: old side = False (see the 3xx + where it points), new side = True (judge the
    final landing page). `verify=False` builds a no-TLS-verify client for the bad-cert fallback."""
    return httpx.AsyncClient(
        headers=_HEADERS,
        timeout=httpx.Timeout(settings.redirect_timeout_seconds),
        follow_redirects=follow_redirects,
        event_hooks=guarded_event_hooks(),
        verify=verify,
    )


def _is_ssl_error(exc: Exception) -> bool:
    """True when a request failed because of TLS certificate verification (an incomplete chain),
    NOT a DNS/refused/timeout error — only those are worth retrying without verification."""
    s = f"{type(exc).__name__}: {exc}"
    return "SSL" in s or "CERTIFICATE" in s.upper() or "certificate verify failed" in s


# WAF / rate-limit statuses worth re-probing after a cooldown: a burst into a WAF-fronted site
# (e.g. WHA's AWS WAF) gets these even though a browser sees the page. NOT 401 (needs auth, a retry
# won't help) and NOT 404 (genuinely absent).
_RETRY_STATUS = {403, 405, 429, 503}


def _should_retry(resp: httpx.Response | None, attempt: int) -> bool:
    """Whether to re-probe. resp is None = a transient network failure (retry up to
    `redirect_probe_retries`); a blocked status = a WAF/rate-limit wall (retry up to the usually
    larger `redirect_blocked_retries`, since a cooldown often clears it)."""
    if resp is None:
        return attempt < settings.redirect_probe_retries
    if resp.status_code in _RETRY_STATUS:
        return attempt < settings.redirect_blocked_retries
    return False


def _retry_delay(resp: httpx.Response | None, attempt: int) -> float:
    """Linear backoff. A WAF block waits longer than a transient network blip to give the WAF time
    to cool down before the next probe."""
    base = (settings.redirect_probe_backoff_seconds if resp is None
            else settings.redirect_blocked_backoff_seconds)
    return base * (attempt + 1)


async def _head_then_get(client: httpx.AsyncClient, url: str, auth: httpx.Auth | None) -> httpx.Response:
    """One probe attempt: HEAD, falling back to GET when HEAD is unsupported (405/501) or the server
    errors on it. Raises httpx.HTTPError on a network/TLS failure (the caller decides what to do)."""
    resp = await client.head(url, auth=auth)
    if resp.status_code in (405, 501) or (resp.status_code >= 400 and resp.status_code != 404):
        resp = await client.get(url, auth=auth)
    return resp


# For human: one retry loop, shared by the status probe and the body probe — the only difference
# between them is the per-attempt fetch (HEAD-then-GET vs a plain GET), which is passed in as `attempt`.
async def _with_retries(
    client: httpx.AsyncClient,
    url: str,
    insecure: httpx.AsyncClient | None,
    attempt: Callable[[httpx.AsyncClient], Awaitable[httpx.Response]],
) -> tuple[httpx.Response | None, bool]:
    """Run `attempt(client)` → (Response or None, ssl_insecure). Retried on a transient failure
    AND on a WAF/rate-limit status (403/405/429/503). On a TLS cert-verification failure, retries
    with the no-verify `insecure` client (when provided — i.e. the host has no Basic Auth to leak)
    and reports ssl_insecure=True. `attempt` already carries the URL + auth."""
    rounds = max(settings.redirect_probe_retries, settings.redirect_blocked_retries) + 1
    resp: httpx.Response | None = None
    ssl_insecure = False
    for n in range(rounds):
        use = insecure if ssl_insecure else client
        try:
            resp = await attempt(use)
        except httpx.HTTPError as exc:
            if insecure is not None and not ssl_insecure and _is_ssl_error(exc):
                ssl_insecure = True
                try:
                    resp = await attempt(insecure)
                except httpx.HTTPError:
                    resp = None
            else:
                resp = None
        if not _should_retry(resp, n):
            return resp, ssl_insecure
        await asyncio.sleep(_retry_delay(resp, n))
    return resp, ssl_insecure


async def _request(
    client: httpx.AsyncClient, url: str, auth: httpx.Auth | None = None,
    insecure: httpx.AsyncClient | None = None,
) -> tuple[httpx.Response | None, bool]:
    """Status probe: HEAD first, GET fallback (see _head_then_get). Returns (Response|None, ssl_insecure)."""
    return await _with_retries(client, url, insecure, lambda c: _head_then_get(c, url, auth))


async def probe_no_follow(client: httpx.AsyncClient, url: str, auth: httpx.Auth | None = None,
                          insecure: httpx.AsyncClient | None = None) -> tuple[int | None, str | None, bool]:
    """Old-side probe: (status, Location, ssl_insecure). Redirects are NOT followed, so a 3xx and its
    target stay visible — that's how we detect an old URL that already redirects onto the new one.
    The client must have been built with follow_redirects=False."""
    resp, ssl_insecure = await _request(client, url, auth, insecure)
    if resp is None:
        return None, None, ssl_insecure
    return resp.status_code, resp.headers.get("location"), ssl_insecure


async def probe_follow(client: httpx.AsyncClient, url: str, auth: httpx.Auth | None = None,
                       insecure: httpx.AsyncClient | None = None) -> tuple[int | None, str | None, bool]:
    """New-side probe: (final status, final URL, ssl_insecure) after following redirects — judges
    whether the new URL actually lands on a real page. The client must have follow_redirects=True."""
    resp, ssl_insecure = await _request(client, url, auth, insecure)
    if resp is None:
        return None, None, ssl_insecure
    return resp.status_code, str(resp.url), ssl_insecure


# --- body-returning variants (deep check: also need the page HTML for files + body) ---------
# A GET (HEAD has no body), retried like _request (transient + WAF/rate-limit). Returns the HTML
# only for a real 2xx HTML page — a redirect/blocked/non-HTML response yields html=None.


async def _request_get(
    client: httpx.AsyncClient, url: str, auth: httpx.Auth | None = None,
    insecure: httpx.AsyncClient | None = None,
) -> tuple[httpx.Response | None, bool]:
    """Body probe: a plain GET (HEAD has no body), same retry + SSL-fallback as _request."""
    return await _with_retries(client, url, insecure, lambda c: c.get(url, auth=auth))


def _html_of(resp: httpx.Response) -> str | None:
    ct = resp.headers.get("content-type", "").lower()
    if 200 <= resp.status_code < 300 and "html" in ct:
        return resp.text
    return None


async def probe_no_follow_body(client: httpx.AsyncClient, url: str, auth: httpx.Auth | None = None,
                               insecure: httpx.AsyncClient | None = None) -> tuple[int | None, str | None, str | None, bool]:
    """Old-side deep probe: (status, Location, html, ssl_insecure). Redirects NOT followed. html is
    the old page's content only when it's a live 2xx HTML page. follow_redirects=False client."""
    resp, ssl_insecure = await _request_get(client, url, auth, insecure)
    if resp is None:
        return None, None, None, ssl_insecure
    return resp.status_code, resp.headers.get("location"), _html_of(resp), ssl_insecure


async def probe_follow_body(client: httpx.AsyncClient, url: str, auth: httpx.Auth | None = None,
                            insecure: httpx.AsyncClient | None = None) -> tuple[int | None, str | None, str | None, bool]:
    """New-side deep probe: (final status, final URL, html, ssl_insecure) after following redirects.
    follow_redirects=True client."""
    resp, ssl_insecure = await _request_get(client, url, auth, insecure)
    if resp is None:
        return None, None, None, ssl_insecure
    return resp.status_code, str(resp.url), _html_of(resp), ssl_insecure
