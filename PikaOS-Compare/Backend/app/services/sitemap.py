"""Sitemap fetching + parsing.

Knows how to pull the URL list out of a `sitemap.xml`, transparently following
`<sitemapindex>` entries down to the leaf `<urlset>` documents. Pure-ish: the
only side effect is the HTTP GET via the httpx client handed in by the caller.
No FastAPI types here — the service/router layers own those.
"""
from __future__ import annotations

import xml.etree.ElementTree as ET

import httpx


class SitemapError(Exception):
    """Sitemap could not be fetched or parsed."""


def _localname(tag: str) -> str:
    """Strip the XML namespace: '{http://...}url' -> 'url'."""
    return tag.rsplit("}", 1)[-1].lower()


def parse_sitemap_xml(xml_text: str) -> tuple[list[str], list[str]]:
    """Parse one sitemap document.

    Returns (page_urls, child_sitemaps): `<urlset>` yields page URLs, a
    `<sitemapindex>` yields child sitemap URLs to recurse into.
    """
    try:
        root = ET.fromstring(xml_text.strip())
    except ET.ParseError as exc:  # malformed XML
        raise SitemapError(f"invalid sitemap XML: {exc}") from exc

    pages: list[str] = []
    children: list[str] = []
    root_name = _localname(root.tag)
    for entry in root:
        if _localname(entry.tag) not in ("url", "sitemap"):
            continue
        loc = next((c.text for c in entry if _localname(c.tag) == "loc" and c.text), None)
        if not loc:
            continue
        loc = loc.strip()
        if root_name == "sitemapindex" or _localname(entry.tag) == "sitemap":
            children.append(loc)
        else:
            pages.append(loc)
    return pages, children


async def fetch_sitemap_urls(
    client: httpx.AsyncClient,
    sitemap_url: str,
    *,
    max_urls: int,
    max_sitemaps: int = 50,
) -> list[str]:
    """Fetch `sitemap_url` and return de-duplicated page URLs.

    Follows sitemap-index files breadth-first up to `max_sitemaps` documents and
    stops collecting once `max_urls` page URLs have been gathered.
    """
    seen_docs: set[str] = set()
    queue: list[str] = [sitemap_url]
    pages: list[str] = []
    seen_pages: set[str] = set()
    docs_read = 0

    while queue and len(pages) < max_urls and docs_read < max_sitemaps:
        doc = queue.pop(0)
        if doc in seen_docs:
            continue
        seen_docs.add(doc)
        docs_read += 1
        try:
            # follow redirects — a 301 from /sitemap.xml to the real sitemap is common
            resp = await client.get(doc, follow_redirects=True)
        except httpx.HTTPError as exc:
            if doc == sitemap_url:
                # str(exc) is often empty (ConnectError/timeout) — name the type + URL
                reason = str(exc) or type(exc).__name__
                raise SitemapError(f"could not fetch {doc} ({reason})") from exc
            continue  # a broken child sitemap shouldn't kill the whole crawl
        if resp.status_code != 200:
            if doc == sitemap_url:
                raise SitemapError(f"sitemap {doc} returned HTTP {resp.status_code}")
            continue
        new_pages, children = parse_sitemap_xml(resp.text)
        queue.extend(children)
        for url in new_pages:
            if url not in seen_pages:
                seen_pages.add(url)
                pages.append(url)
                if len(pages) >= max_urls:
                    break

    if not pages and docs_read:
        raise SitemapError("sitemap contained no URLs")
    return pages[:max_urls]
