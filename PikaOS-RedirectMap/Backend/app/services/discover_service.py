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
from ..schemas import DiscoverIn, DiscoverOut, MappingRow, MatchCandidate
from .credentials import auth_for, build_auth_map
from .net_guard import BlockedURLError, assert_public_url
from .probe import make_client
from .sitemap import SitemapError, fetch_sitemap_urls

__all__ = ["discover", "SitemapError"]

# how many close new URLs to surface per row (best first) for the user to sanity-check the pick
_MAX_CANDIDATES = 5


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


def _ranked_matches(old_path: str, new_paths: list[str], matcher: difflib.SequenceMatcher, n: int) -> list[tuple[str, float]]:
    """Top `n` new paths by similarity to `old_path` (best first), each with its ratio (0–1).
    `matcher` is reused with seq2 fixed to old_path so difflib caches the heavy work."""
    matcher.set_seq2(old_path)
    scored: list[tuple[str, float]] = []
    for p in new_paths:
        matcher.set_seq1(p)
        scored.append((p, matcher.ratio()))
    scored.sort(key=lambda x: x[1], reverse=True)
    return scored[:n]


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

    # HTTP Basic Auth per host — a UAT site's sitemap.xml is often behind the same login as its pages.
    auth_map = build_auth_map(payload.credentials)
    old_auth = auth_for(auth_map, old_sitemap)
    new_auth = auth_for(auth_map, new_sitemap)

    new_scheme, new_netloc = _origin(new_base)
    verify_tls = settings.redirect_ssl_verify
    client = make_client(follow_redirects=False, verify=verify_tls)  # fetch_sitemap_urls follows per-request
    # no-verify fallback so a sitemap on a misconfigured-TLS host (incomplete cert chain, common after
    # a migration) still loads — without it the new sitemap fails and every row degrades to a same-path
    # domain swap (404s when the new site reorganised paths, e.g. /about/x → /about-company/x).
    insecure = make_client(follow_redirects=False, verify=False) if verify_tls else None
    try:
        old_urls = await fetch_sitemap_urls(client, old_sitemap, max_urls=max_urls, auth=old_auth, insecure=insecure)
        # new sitemap is BEST-EFFORT: a missing/blocked new sitemap must not fail the run — we
        # just fall back to same-path domain swaps for every row (match % = None).
        new_urls: list[str] = []
        try:
            assert_public_url(new_sitemap)
            new_urls = await fetch_sitemap_urls(client, new_sitemap, max_urls=max_urls, auth=new_auth, insecure=insecure)
        except (SitemapError, BlockedURLError):
            new_urls = []
    finally:
        await client.aclose()
        if insecure is not None:
            await insecure.aclose()

    # index real new URLs by normalized path (first wins on dup paths)
    new_by_path: dict[str, str] = {}
    for u in new_urls:
        new_by_path.setdefault(_norm_path(u), u)
    new_paths = list(new_by_path.keys())
    matcher = difflib.SequenceMatcher(autojunk=False)

    min_score = settings.redirect_match_min_score
    used_new: set[str] = set()
    rows: list[MappingRow] = []
    for ou in old_urls:
        candidates: list[MatchCandidate] = []
        if new_paths:
            op = _norm_path(ou)
            ranked = _ranked_matches(op, new_paths, matcher, _MAX_CANDIDATES)
            exact = new_by_path.get(op)
            if exact is not None:
                new_url, score = exact, 100.0
                # chosen exact match first, then the next-closest paths for context
                candidates = [MatchCandidate(url=exact, score=100.0)]
                candidates += [MatchCandidate(url=new_by_path[p], score=round(r * 100, 1))
                               for p, r in ranked if new_by_path[p] != exact]
            else:
                bp, ratio = ranked[0]
                score = round(ratio * 100, 1)
                candidates = [MatchCandidate(url=new_by_path[p], score=round(r * 100, 1)) for p, r in ranked]
                # too weak to auto-pick → leave newUrl blank; the user chooses from `candidates`.
                # keep the (low) score so the table flags how poor the best match was.
                new_url = new_by_path[bp] if score >= min_score else ""
            candidates = candidates[:_MAX_CANDIDATES]
            if new_url:
                used_new.add(new_url)
        else:
            # no new sitemap → same-path domain swap, similarity unknown (no candidates to compare)
            new_url, score = _swap_origin(ou, new_scheme, new_netloc), None
        rows.append(MappingRow(symbol=payload.symbol, oldUrl=ou, newUrl=new_url, matchScore=score, candidates=candidates))

    # collision flag: a non-blank newUrl chosen as best-match for >1 old URL = forced match, worth a look
    target_count: dict[str, int] = {}
    for r in rows:
        if r.oldUrl and r.newUrl:
            target_count[r.newUrl] = target_count.get(r.newUrl, 0) + 1
    for r in rows:
        if r.oldUrl and r.newUrl and target_count.get(r.newUrl, 0) > 1:
            r.collision = True

    # new-only: real new-site URLs that no old URL mapped to — show them too so the table covers
    # ALL URLs from BOTH sites (when the new site has more pages). oldUrl is empty (nothing to
    # redirect from); verify will mark these ไม่ต้อง Redirect.
    if new_paths:
        for nu in new_by_path.values():
            if nu not in used_new:
                rows.append(MappingRow(symbol=payload.symbol, oldUrl="", newUrl=nu, matchScore=None))

    return DiscoverOut(rows=rows, sitemapUrl=old_sitemap, count=len(rows))
