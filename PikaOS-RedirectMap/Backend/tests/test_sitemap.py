"""Unit tests for sitemap fetching — parsing + the bad-cert (TLS) fallback that lets Discover read a
new-site sitemap on a misconfigured-TLS host (e.g. wha-group), so rows fuzzy-match a close new URL
instead of degrading to a same-path domain swap (which 404s when the new site reorganised paths).

httpx.MockTransport feeds canned responses — no network.
"""
import asyncio

import httpx

from app.services.sitemap import SitemapError, fetch_sitemap_urls

_XML = (
    '<?xml version="1.0"?>'
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
    '<url><loc>https://x.example.com/a</loc></url>'
    '<url><loc>https://x.example.com/b</loc></url>'
    '</urlset>'
)


def _ac(handler):
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


def test_parses_page_urls():
    async def run():
        async with _ac(lambda r: httpx.Response(200, text=_XML)) as c:
            return await fetch_sitemap_urls(c, "https://x.example.com/sitemap.xml", max_urls=10)

    assert asyncio.run(run()) == ["https://x.example.com/a", "https://x.example.com/b"]


def test_falls_back_to_insecure_on_cert_error():
    def secure(req):
        raise httpx.ConnectError("[SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed")

    def insecure(req):
        return httpx.Response(200, text=_XML)

    async def run():
        sc, ic = _ac(secure), _ac(insecure)
        try:
            return await fetch_sitemap_urls(sc, "https://x.example.com/sitemap.xml", max_urls=10, insecure=ic)
        finally:
            await sc.aclose()
            await ic.aclose()

    assert asyncio.run(run()) == ["https://x.example.com/a", "https://x.example.com/b"]


def test_cert_error_without_fallback_raises():
    def secure(req):
        raise httpx.ConnectError("[SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed")

    async def run():
        async with _ac(secure) as c:
            return await fetch_sitemap_urls(c, "https://x.example.com/sitemap.xml", max_urls=10)

    try:
        asyncio.run(run())
        assert False, "expected SitemapError"
    except SitemapError:
        pass
