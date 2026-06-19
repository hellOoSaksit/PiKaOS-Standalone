"""Compare downloadable files (PDF/DOC/XLS/…) across the old and new sites.

Files aren't listed in the sitemap — they're LINKED inside pages — so this crawls the sitemap's
pages (bounded), extracts document links from each page's HTML with a regex (no HTML-parser dep),
de-duplicates per site, and matches by filename: which files exist on both, which are only on the
old site (gone), which are only on the new site (added). Bounded by config so a big site stays
under the proxy timeout. SSRF-guarded via the shared probe client. No state.
"""
from __future__ import annotations

import asyncio
import re
from urllib.parse import urljoin, urlsplit

import httpx

from ..config import settings
from ..schemas import FileItem, FilesIn, FilesOut
from .net_guard import BlockedURLError, assert_public_url
from .probe import make_client
from .sitemap import SitemapError, fetch_sitemap_urls

__all__ = ["scan", "SitemapError"]


def _doc_regex() -> re.Pattern:
    exts = "|".join(re.escape(e) for e in settings.file_ext_list)
    # href/src="….pdf"  (optionally followed by ?query or #frag), single or double quoted
    return re.compile(rf'''(?:href|src)\s*=\s*["']([^"'>]+?\.(?:{exts}))(?:[?#][^"']*)?["']''', re.I)


def _default_sitemap_url(base: str) -> str:
    p = urlsplit(str(base))
    return f"{p.scheme}://{p.netloc}/sitemap.xml"


def _filename(url: str) -> str:
    """Last path segment, lowercased, query/fragment stripped — the key files are matched by."""
    path = urlsplit(url).path
    return (path.rsplit("/", 1)[-1] or path).split("?")[0].lower()


async def _scan_site(client: httpx.AsyncClient, page_urls: list[str], sem: asyncio.Semaphore,
                     doc_re: re.Pattern) -> dict[str, str]:
    """Crawl pages, extract document links → {filename: absolute_url} (first link per filename)."""
    found: dict[str, str] = {}

    async def one(page: str) -> None:
        async with sem:
            try:
                resp = await client.get(page)
            except httpx.HTTPError:
                return
        if resp.status_code != 200 or "html" not in resp.headers.get("content-type", "").lower():
            return  # WAF challenge / non-HTML / error → nothing to extract
        for m in doc_re.finditer(resp.text):
            full = urljoin(str(resp.url), m.group(1))
            if urlsplit(full).scheme not in ("http", "https"):
                continue
            found.setdefault(_filename(full), full)

    await asyncio.gather(*(one(u) for u in page_urls))
    return found


async def scan(payload: FilesIn) -> FilesOut:
    old_base, new_base = str(payload.oldBase), str(payload.newBase)
    old_sitemap = str(payload.sitemapUrl) if payload.sitemapUrl else _default_sitemap_url(old_base)
    new_sitemap = str(payload.newSitemapUrl) if payload.newSitemapUrl else _default_sitemap_url(new_base)
    max_pages = min(payload.maxPages or settings.redirect_file_scan_max_pages, settings.redirect_max_rows)

    assert_public_url(old_base)
    assert_public_url(new_base)
    assert_public_url(old_sitemap)

    doc_re = _doc_regex()
    sem = asyncio.Semaphore(settings.redirect_file_scan_concurrency)
    # follow redirects so a page that 301s still yields its HTML; browser UA already set in probe
    client = make_client(follow_redirects=True)
    try:
        old_pages = (await fetch_sitemap_urls(client, old_sitemap, max_urls=max_pages))[:max_pages]
        new_pages: list[str] = []
        try:
            assert_public_url(new_sitemap)
            new_pages = (await fetch_sitemap_urls(client, new_sitemap, max_urls=max_pages))[:max_pages]
        except (SitemapError, BlockedURLError):
            new_pages = []
        old_docs, new_docs = await asyncio.gather(
            _scan_site(client, old_pages, sem, doc_re),
            _scan_site(client, new_pages, sem, doc_re),
        )
    finally:
        await client.aclose()

    old_names, new_names = set(old_docs), set(new_docs)
    matched = [FileItem(name=n, oldUrl=old_docs[n], newUrl=new_docs[n]) for n in sorted(old_names & new_names)]
    only_old = [FileItem(name=n, oldUrl=old_docs[n]) for n in sorted(old_names - new_names)]
    only_new = [FileItem(name=n, newUrl=new_docs[n]) for n in sorted(new_names - old_names)]
    return FilesOut(
        oldCount=len(old_docs), newCount=len(new_docs),
        oldPages=len(old_pages), newPages=len(new_pages),
        matched=matched, onlyOld=only_old, onlyNew=only_new,
    )
