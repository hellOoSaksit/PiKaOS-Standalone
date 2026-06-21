"""Unit tests for probe's retry + SSL-fallback behaviour.

Two things are pinned here:
- transient + WAF/rate-limit (403/405/429/503) retry that keeps a WAF-fronted site (e.g. WHA) from
  reading as a false "unreachable"/blocked;
- the bad-cert fallback: a TLS verification failure retries on a no-verify client (when one is
  supplied — i.e. the host has no Basic Auth), reporting ssl_insecure=True.

httpx.MockTransport feeds canned responses; asyncio.sleep is stubbed so backoff doesn't wait. Both
`_request` and `_request_get` return (response, ssl_insecure).
"""
import asyncio

import httpx

from app.config import settings
from app.services import probe


async def _noop(*a, **k):
    return None


def _client(handler, follow=True):
    return httpx.AsyncClient(transport=httpx.MockTransport(handler), follow_redirects=follow)


def _run(coro):
    return asyncio.run(coro)


# --- _request_get (deep-probe path) ------------------------------------------

def test_request_get_retries_blocked_then_succeeds(monkeypatch):
    monkeypatch.setattr(probe.asyncio, "sleep", _noop)
    calls = {"n": 0}

    def handler(request):
        calls["n"] += 1
        return httpx.Response(403 if calls["n"] == 1 else 200, text="<html>ok</html>")

    async def run():
        async with _client(handler) as c:
            return await probe._request_get(c, "https://x.example.com/")

    resp, ssl_insecure = _run(run())
    assert resp.status_code == 200
    assert ssl_insecure is False
    assert calls["n"] == 2          # one blocked, retried once, then OK


def test_request_get_persistent_block_returns_last(monkeypatch):
    monkeypatch.setattr(probe.asyncio, "sleep", _noop)
    calls = {"n": 0}

    def handler(request):
        calls["n"] += 1
        return httpx.Response(503)

    async def run():
        async with _client(handler) as c:
            return await probe._request_get(c, "https://x.example.com/")

    resp, _ = _run(run())
    assert resp.status_code == 503                          # blocked status is still reported
    assert calls["n"] == settings.redirect_blocked_retries + 1


def test_request_get_success_is_not_retried(monkeypatch):
    monkeypatch.setattr(probe.asyncio, "sleep", _noop)
    calls = {"n": 0}

    def handler(request):
        calls["n"] += 1
        return httpx.Response(200, text="<html>ok</html>")

    async def run():
        async with _client(handler) as c:
            return await probe._request_get(c, "https://x.example.com/")

    resp, _ = _run(run())
    assert resp.status_code == 200
    assert calls["n"] == 1


def test_request_get_404_is_not_retried(monkeypatch):
    """404 = genuinely absent, not a WAF wall — must not burn retries."""
    monkeypatch.setattr(probe.asyncio, "sleep", _noop)
    calls = {"n": 0}

    def handler(request):
        calls["n"] += 1
        return httpx.Response(404)

    async def run():
        async with _client(handler) as c:
            return await probe._request_get(c, "https://x.example.com/")

    resp, _ = _run(run())
    assert resp.status_code == 404
    assert calls["n"] == 1


# --- SSL fallback ------------------------------------------------------------

def test_request_get_falls_back_to_insecure_on_cert_error(monkeypatch):
    monkeypatch.setattr(probe.asyncio, "sleep", _noop)

    def secure(request):
        raise httpx.ConnectError("[SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed")

    def insecure(request):
        return httpx.Response(200, text="<html>ok</html>")

    async def run():
        sc = _client(secure)
        ic = _client(insecure)
        try:
            return await probe._request_get(sc, "https://x.example.com/", None, ic)
        finally:
            await sc.aclose()
            await ic.aclose()

    resp, ssl_insecure = _run(run())
    assert resp.status_code == 200
    assert ssl_insecure is True


def test_request_get_no_fallback_client_returns_none_on_cert_error(monkeypatch):
    monkeypatch.setattr(probe.asyncio, "sleep", _noop)

    def secure(request):
        raise httpx.ConnectError("[SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed")

    async def run():
        async with _client(secure) as c:
            return await probe._request_get(c, "https://x.example.com/", None, None)

    resp, ssl_insecure = _run(run())
    assert resp is None
    assert ssl_insecure is False


def test_request_get_does_not_downgrade_on_non_ssl_error(monkeypatch):
    """A plain connect failure (refused/DNS) must NOT switch to the insecure client."""
    monkeypatch.setattr(probe.asyncio, "sleep", _noop)
    hit = {"insecure": 0}

    def secure(request):
        raise httpx.ConnectError("Connection refused")

    def insecure(request):
        hit["insecure"] += 1
        return httpx.Response(200)

    async def run():
        sc = _client(secure)
        ic = _client(insecure)
        try:
            return await probe._request_get(sc, "https://x.example.com/", None, ic)
        finally:
            await sc.aclose()
            await ic.aclose()

    resp, ssl_insecure = _run(run())
    assert resp is None
    assert ssl_insecure is False
    assert hit["insecure"] == 0          # never touched the no-verify client


# --- _request (HEAD-first path) ----------------------------------------------

def test_request_head_405_falls_back_to_get_no_retry(monkeypatch):
    monkeypatch.setattr(probe.asyncio, "sleep", _noop)
    seen = []

    def handler(request):
        seen.append(request.method)
        return httpx.Response(405) if request.method == "HEAD" else httpx.Response(200, text="ok")

    async def run():
        async with _client(handler) as c:
            return await probe._request(c, "https://x.example.com/")

    resp, _ = _run(run())
    assert resp.status_code == 200
    assert seen == ["HEAD", "GET"]          # GET succeeded → no retry


def test_request_persistent_block_retries(monkeypatch):
    monkeypatch.setattr(probe.asyncio, "sleep", _noop)
    calls = {"n": 0}

    def handler(request):                    # HEAD 403 → GET 403 every attempt
        calls["n"] += 1
        return httpx.Response(403)

    async def run():
        async with _client(handler) as c:
            return await probe._request(c, "https://x.example.com/")

    resp, _ = _run(run())
    assert resp.status_code == 403
    # (blocked_retries + 1) attempts, each doing HEAD + GET
    assert calls["n"] == (settings.redirect_blocked_retries + 1) * 2
