"""Discover redirect mappings by reading BOTH sitemaps and matching old → new by path.

Read the OLD site's `sitemap.xml` (the URLs that need redirecting) AND the NEW site's sitemap
(the URLs that actually exist now). For each old URL, find the **closest real new URL** by path
similarity and report a match % — so `/investor-relations` on the old site maps to the real
`/en/investor-relations` on the new site even when the path isn't identical, and the user sees
how confident that match is. If the new sitemap can't be read, fall back to a same-path domain
swap (match % = unknown). The proposed rows then feed verify + web.config. No state.
Raises BlockedURLError (→ router 400) / SitemapError (→ router 502, old sitemap only).
"""
from __future__ import annotations

import difflib
from urllib.parse import urlsplit, urlunsplit

from ..config import settings
from ..schemas import DiscoverIn, DiscoverOut, MappingRow
from .net_guard import BlockedURLError, assert_public_url
from .probe import make_client
from .sitemap import SitemapError, fetch_sitemap_urls

__all__ = ["discover", "SitemapError"]


def _origin(url: str) -> tuple[str, str]:
    """Return (scheme, netloc) for a base URL."""
    parts = urlsplit(str(url))
    return parts.scheme, parts.netloc


def _default_sitemap_url(base: str) -> str:
    """`<base>/sitemap.xml` — the conventional URL source."""
    scheme, netloc = _origin(base)
    return urlunsplit((scheme, netloc, "/sitemap.xml", "", ""))


def _swap_origin(url: str, base_scheme: str, base_netloc: str) -> str:
    """Replace a URL's scheme+host with the new base, keeping path/query — the same-path fallback
    used when there's no new sitemap to match against."""
    p = urlsplit(url)
    return urlunsplit((base_scheme, base_netloc, p.path or "/", p.query, ""))


def _norm_path(url: str) -> str:
    """Path of a URL, trailing slash stripped (so `/a/b` and `/a/b/` match) — the key we compare."""
    return (urlsplit(url).path or "/").rstrip("/") or "/"


def _best_match(old_path: str, new_paths: list[str], matcher: difflib.SequenceMatcher) -> tuple[str, float]:
    """Closest new path to `old_path` and its similarity ratio (0–1). `matcher` is reused across
    calls with seq2 fixed to old_path so difflib caches the heavy work."""
    matcher.set_seq2(old_path)
    best_p, best_r = new_paths[0], -1.0
    for p in new_paths:
        matcher.set_seq1(p)
        r = matcher.ratio()
        if r > best_r:
            best_r, best_p = r, p
    return best_p, best_r


async def discover(payload: DiscoverIn) -> DiscoverOut:
    old_base = str(payload.oldBase)
    new_base = str(payload.newBase)
    old_sitemap = str(payload.sitemapUrl) if payload.sitemapUrl else _default_sitemap_url(old_base)
    new_sitemap = str(payload.newSitemapUrl) if payload.newSitemapUrl else _default_sitemap_url(new_base)
    max_urls = payload.maxUrls or settings.redirect_max_rows

    # hard-reject internal targets up front (router → 400); the per-request guard hook still
    # covers redirects + URLs pulled from the sitemaps.
    assert_public_url(old_base)
    assert_public_url(new_base)
    assert_public_url(old_sitemap)

    new_scheme, new_netloc = _origin(new_base)
    client = make_client(follow_redirects=False)  # fetch_sitemap_urls follows per-request
    try:
        old_urls = await fetch_sitemap_urls(client, old_sitemap, max_urls=max_urls)
        # new sitemap is BEST-EFFORT: a missing/blocked new sitemap must not fail the run — we
        # just fall back to same-path domain swaps for every row (match % = None).
        new_urls: list[str] = []
        try:
            assert_public_url(new_sitemap)
            new_urls = await fetch_sitemap_urls(client, new_sitemap, max_urls=max_urls)
        except (SitemapError, BlockedURLError):
            new_urls = []
    finally:
        await client.aclose()

    # index real new URLs by normalized path (first wins on dup paths)
    new_by_path: dict[str, str] = {}
    for u in new_urls:
        new_by_path.setdefault(_norm_path(u), u)
    new_paths = list(new_by_path.keys())
    matcher = difflib.SequenceMatcher(autojunk=False)

    used_new: set[str] = set()
    rows: list[MappingRow] = []
    for ou in old_urls:
        if new_paths:
            op = _norm_path(ou)
            exact = new_by_path.get(op)
            if exact is not None:
                new_url, score = exact, 100.0
            else:
                bp, ratio = _best_match(op, new_paths, matcher)
                new_url, score = new_by_path[bp], round(ratio * 100, 1)
            used_new.add(new_url)
        else:
            # no new sitemap → same-path domain swap, similarity unknown
            new_url, score = _swap_origin(ou, new_scheme, new_netloc), None
        rows.append(MappingRow(symbol=payload.symbol, oldUrl=ou, newUrl=new_url, matchScore=score))

    # new-only: real new-site URLs that no old URL mapped to — show them too so the table covers
    # ALL URLs from BOTH sites (when the new site has more pages). oldUrl is empty (nothing to
    # redirect from); verify will mark these ไม่ต้อง Redirect.
    if new_paths:
        for nu in new_by_path.values():
            if nu not in used_new:
                rows.append(MappingRow(symbol=payload.symbol, oldUrl="", newUrl=nu, matchScore=None))

    return DiscoverOut(rows=rows, sitemapUrl=old_sitemap, count=len(rows))
