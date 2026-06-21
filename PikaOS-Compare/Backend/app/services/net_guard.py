"""SSRF guard for outbound HTTP to user-supplied URLs (the compare/audit path).

Compare is the only feature that fetches arbitrary user URLs. Without a guard a
user could aim it at internal hosts — cloud metadata (169.254.169.254), `minio:9000`,
`localhost`, RFC1918 ranges — and read the internal responses back through the
compare results. See docs/features/compare-hardening.md §1.

Two layers use this module:
- `assert_public_url()` — validate user-supplied URLs **up front**; the router maps the
  resulting `BlockedURLError` to HTTP 400 (a clear, hard rejection of bad input).
- `guarded_event_hooks()` — an httpx **request** event hook attached to every client in
  the compare path. httpx fires it for the initial request *and every redirect hop*, so
  a 302 to an internal host is blocked too. There it raises `httpx.RequestError`, which
  the existing `except httpx.HTTPError` handlers treat as a normal fetch failure (the URL
  is marked broken rather than crashing the whole run).

Stdlib only (`socket` + `ipaddress`) — no new dependency.
"""
from __future__ import annotations

import asyncio
import ipaddress
import socket
from urllib.parse import urlsplit

import httpx

from ..config import settings


class BlockedURLError(Exception):
    """A URL was rejected by the SSRF guard (non-public target or bad scheme)."""


def _is_public_ip(ip: str) -> bool:
    """True only for a globally-routable address (rejects private/loopback/link-local/
    reserved/multicast/unspecified — which is where SSRF targets live)."""
    addr = ipaddress.ip_address(ip)
    if any((addr.is_private, addr.is_loopback, addr.is_link_local,
            addr.is_reserved, addr.is_multicast, addr.is_unspecified)):
        return False
    return addr.is_global


def assert_public_url(url: str) -> None:
    """Raise `BlockedURLError` unless `url` is http(s) to a host that resolves to
    only public IPs (and passes the optional allowlist). No-op if the guard is off.

    Note: this resolves DNS once here; httpx resolves again when connecting, so a
    determined DNS-rebinding attacker could still slip a TOCTOU window. Pinning the
    resolved IP into the connection is future hardening (compare-hardening.md §1).
    """
    if not settings.compare_ssrf_block_private:
        return

    parts = urlsplit(url)
    if parts.scheme not in ("http", "https"):
        raise BlockedURLError(f"scheme not allowed: {parts.scheme or '(none)'}")
    host = parts.hostname
    if not host:
        raise BlockedURLError("missing host")

    allow = settings.compare_allowlist
    if allow and not any(host == a or host.endswith("." + a) for a in allow):
        raise BlockedURLError(f"host not in allowlist: {host}")

    try:
        infos = socket.getaddrinfo(host, parts.port or None, proto=socket.IPPROTO_TCP)
    except socket.gaierror as exc:
        raise BlockedURLError(f"cannot resolve host: {host}") from exc

    ips = {info[4][0] for info in infos}
    for ip in ips:
        if not _is_public_ip(ip):
            raise BlockedURLError(f"non-public address blocked: {host} -> {ip}")


async def _guard_request(request: httpx.Request) -> None:
    """httpx 'request' event hook — fires on the first request AND every redirect.

    DNS resolution blocks, so it's run off the event loop. A blocked URL is re-raised
    as `httpx.RequestError` so callers' `except httpx.HTTPError` degrade gracefully.
    """
    loop = asyncio.get_running_loop()
    try:
        await loop.run_in_executor(None, assert_public_url, str(request.url))
    except BlockedURLError as exc:
        raise httpx.RequestError(f"blocked by SSRF guard: {exc}", request=request) from exc


def guarded_event_hooks() -> dict:
    """`event_hooks` for httpx clients in the compare path (empty if the guard is off)."""
    if not settings.compare_ssrf_block_private:
        return {}
    return {"request": [_guard_request]}
