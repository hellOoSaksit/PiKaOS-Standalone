"""UAT vs Production comparison — sitemap URL coverage.

Production's sitemap is the source of truth for the "primary" URL set. For each
primary URL we domain-swap the origin onto the UAT base, probe both sides, and
classify the result (match / missing / broken / redirect). Optionally a UAT
sitemap is read too, to surface URLs that exist on UAT but not in Production.

HTTP concerns live in routers/compare.py; this module only knows about URLs and
status codes. It raises SitemapError (re-exported from .sitemap) which the
router maps to a 4xx/5xx.
"""
from __future__ import annotations

import asyncio
import base64
import difflib
from datetime import datetime, timezone
from urllib.parse import urlsplit, urlunsplit

import httpx

from ..config import settings
from ..schemas import (
    CompareAuth, CompareIn, CompareOut, CompareSummary, CoverageBatchIn, CoveragePair,
    CoveragePlanIn, CoveragePlanOut, DeepBatchIn, DeepResult, UrlCheck,
)
from .content import fetch_page
from .net_guard import BlockedURLError, assert_public_url, guarded_event_hooks
from .sitemap import SitemapError, fetch_sitemap_urls

__all__ = [
    "compare", "deep_batch", "coverage_plan", "coverage_batch",
    "SitemapError", "BlockedURLError", "swap_origin", "default_sitemap_url",
]

# browser-ish UA — some CDNs 403 the default httpx agent
_HEADERS = {"User-Agent": "PiKaOs-SiteCompare/1.0 (+https://pikaos.local)"}


class _HostAuth(httpx.Auth):
    """Per-host credentials. A compare run hits BOTH the Production and UAT hosts on
    one client, so auth is dispatched by `request.url.host` — Production and UAT can
    use different (or one-sided) logins, and creds never leak to the other origin or
    to redirected third parties. Adds HTTP Basic (from user/pass) and/or a free-form
    header (`Authorization: Bearer …` / `Cookie: …`). Credentials are never logged."""

    def __init__(self, by_host: dict[str, CompareAuth]):
        self._by_host = {h.lower(): a for h, a in by_host.items() if a}

    def __bool__(self) -> bool:
        return bool(self._by_host)

    def auth_flow(self, request):
        a = self._by_host.get(request.url.host.lower())
        if a:
            if a.username:
                token = base64.b64encode(f"{a.username}:{a.password or ''}".encode()).decode()
                request.headers["Authorization"] = f"Basic {token}"
            if a.headerName and a.headerValue:
                request.headers[a.headerName] = a.headerValue
        yield request


def _make_client(
    *, follow_redirects: bool, limits: httpx.Limits | None = None, host_auth: dict[str, CompareAuth] | None = None
) -> httpx.AsyncClient:
    """Build an httpx client for the compare path with the SSRF guard attached
    (the guard fires on every request incl. redirects — see net_guard). `host_auth`
    maps target host → credentials for login-gated sites (dispatched per request)."""
    kwargs = dict(
        headers=_HEADERS,
        timeout=httpx.Timeout(settings.compare_timeout_seconds),
        follow_redirects=follow_redirects,
        event_hooks=guarded_event_hooks(),
    )
    ha = _HostAuth(host_auth) if host_auth else None
    if ha:  # falsy when no host has creds
        kwargs["auth"] = ha
    if limits is not None:  # else httpx uses its default Limits (as render_page did before)
        kwargs["limits"] = limits
    return httpx.AsyncClient(**kwargs)


def _origin(url: str) -> tuple[str, str]:
    """Return (scheme, netloc) for a base URL."""
    parts = urlsplit(str(url))
    return parts.scheme, parts.netloc


def swap_origin(url: str, base_scheme: str, base_netloc: str) -> str:
    """Replace a URL's scheme+host with the target base, keeping path/query/fragment.

    This is the "domain swap" that maps a Production URL onto its UAT twin.
    """
    p = urlsplit(url)
    return urlunsplit((base_scheme, base_netloc, p.path or "/", p.query, ""))


def default_sitemap_url(prod_base: str) -> str:
    """`<prodBase>/sitemap.xml` — the conventional primary URL source."""
    scheme, netloc = _origin(prod_base)
    return urlunsplit((scheme, netloc, "/sitemap.xml", "", ""))


def _rel_key(url: str) -> str:
    """Path + query, origin-independent — used to compare URL *sets* across hosts."""
    p = urlsplit(url)
    return (p.path or "/") + (("?" + p.query) if p.query else "")


async def _probe(client: httpx.AsyncClient, url: str) -> int | None:
    """Return the HTTP status for `url`, or None if the request failed.

    Tries HEAD first (cheap); falls back to GET when HEAD is unsupported (405/501).
    Redirects are NOT followed so 3xx is visible in coverage. A transient connect/
    read failure is retried a few times (settings.compare_probe_retries) with linear
    backoff — WAF/CDN fronted sites drop a fraction of a burst, which would otherwise
    surface as bogus "unreachable" noise for a perfectly live URL.
    """
    for attempt in range(settings.compare_probe_retries + 1):
        try:
            resp = await client.head(url)
            if resp.status_code in (405, 501) or (resp.status_code >= 400 and resp.status_code != 404):
                resp = await client.get(url)
            return resp.status_code
        except httpx.HTTPError:
            try:
                resp = await client.get(url)
                return resp.status_code
            except httpx.HTTPError:
                if attempt < settings.compare_probe_retries:
                    await asyncio.sleep(settings.compare_probe_backoff_seconds * (attempt + 1))
    return None


def _classify(prod_status: int | None, uat_status: int | None) -> tuple[str, str | None]:
    """Decide the coverage state for one URL pair."""
    prod_ok = prod_status is not None and 200 <= prod_status < 400
    if not prod_ok:
        return "prod_error", f"Production returned {prod_status}" if prod_status else "Production unreachable"
    if uat_status is None:
        return "error", "UAT unreachable"
    if uat_status == 404:
        return "missing_on_uat", "404 on UAT"
    if 300 <= uat_status < 400:
        return "redirect", f"UAT redirects ({uat_status})"
    if uat_status >= 400:
        return "broken_on_uat", f"UAT returned {uat_status}"
    return "match", None


def _ok(status: int | None) -> bool:
    return status is not None and 200 <= status < 400


# For human: build the {host: credentials} map a compare run dispatches auth by. A run hits BOTH the
# Production and UAT hosts on one client, so creds are keyed by host (see _HostAuth). None when
# neither side has credentials — the common, open-site case.
def _host_auth_for(prod_url: str, uat_url: str, prod_auth, uat_auth) -> dict | None:
    if not (prod_auth or uat_auth):
        return None
    return {urlsplit(prod_url).netloc: prod_auth, urlsplit(uat_url).netloc: uat_auth}


# For human: an httpx client sized for the compare path — the pool covers prod+uat probes at the hard
# concurrency ceiling, with the SSRF guard + per-host auth attached. follow_redirects=False so a 3xx
# stays visible in coverage.
def _coverage_client(host_auth: dict | None = None) -> httpx.AsyncClient:
    ceiling = settings.compare_max_concurrency
    return _make_client(
        follow_redirects=False,
        limits=httpx.Limits(max_connections=ceiling * 2 + 10, max_keepalive_connections=ceiling),
        host_auth=host_auth,
    )


# For human: probe one prod/uat URL pair (both sides, under `sem`) and classify the coverage state.
# Shared by the streamed coverage_batch and the one-shot compare so the classify+UrlCheck shape can't drift.
async def _check_pair(client: httpx.AsyncClient, prod_url: str, uat_url: str, sem: asyncio.Semaphore, path: str) -> UrlCheck:
    async with sem:
        prod_status, uat_status = await asyncio.gather(_probe(client, prod_url), _probe(client, uat_url))
    state, note = _classify(prod_status, uat_status)
    return UrlCheck(
        path=path, prodUrl=prod_url, uatUrl=uat_url,
        prodStatus=prod_status, uatStatus=uat_status, state=state, note=note,
    )


async def _deep_compare(
    client: httpx.AsyncClient, src_url: str, tgt_url: str, *, sub_sem: asyncio.Semaphore | None = None
) -> DeepResult:
    """Fetch both pages and compare title/h1/meta/body + image & link existence.

    `sub_sem` (when given) caps the *total* in-flight image/link sub-requests across
    all concurrently-running deep pages. Without it, N deep pages each fan out
    img_cap + link_cap probes at once (N × ~35) — a burst that trips the same WAF
    rate-limiting the coverage path was tamed for, surfacing as bogus "all links
    broken" on a page that's actually fine.
    """
    src, tgt = await asyncio.gather(fetch_page(client, src_url), fetch_page(client, tgt_url))
    if not (src.get("ok") and tgt.get("ok")):
        # say WHICH side failed and why (status / type / exception) so it's actionable
        return DeepResult(
            deepState="unfetchable",
            srcStatus=src.get("status"), tgtStatus=tgt.get("status"),
            srcReason=None if src.get("ok") else (src.get("reason") or "fetch failed"),
            tgtReason=None if tgt.get("ok") else (tgt.get("reason") or "fetch failed"),
        )

    async def probe(u: str) -> int | None:
        if sub_sem is None:
            return await _probe(client, u)
        async with sub_sem:
            return await _probe(client, u)

    title_match = src["title"] == tgt["title"]
    h1_match = src["h1"] == tgt["h1"]
    meta_keys = set(src["meta"]) | set(tgt["meta"])
    meta_diff = sorted(k for k in meta_keys if src["meta"].get(k) != tgt["meta"].get(k))
    body_sim = difflib.SequenceMatcher(None, src["text"].lower(), tgt["text"].lower()).ratio()

    # image presence on the TARGET page (just 200/404, capped)
    imgs = tgt["images"][: settings.compare_deep_img_cap]
    img_status = await asyncio.gather(*(probe(u) for u in imgs)) if imgs else []
    missing_imgs = [u for u, s in zip(imgs, img_status) if not _ok(s)]

    # internal-link presence on the TARGET page (capped) — keep the broken URLs so the
    # diff detail can list exactly which links 404 (for the webmaster/dev), not just a count
    links = tgt["links"][: settings.compare_deep_link_cap]
    link_status = await asyncio.gather(*(probe(u) for u in links)) if links else []
    broken_link_urls = [u for u, s in zip(links, link_status) if not _ok(s)]
    broken_links = len(broken_link_urls)

    # downloadable files compared by filename (case-insensitive) — a doc on one side whose
    # name isn't on the other is a real content gap (missing report/form), independent of host.
    src_docs, tgt_docs = src.get("docs", []), tgt.get("docs", [])
    src_doc_names = {d["name"].lower() for d in src_docs}
    tgt_doc_names = {d["name"].lower() for d in tgt_docs}
    docs_only_src = [d["url"] for d in src_docs if d["name"].lower() not in tgt_doc_names]
    docs_only_tgt = [d["url"] for d in tgt_docs if d["name"].lower() not in src_doc_names]

    # heading outline (H1-H6) per side — a structure change (heading added/removed/reworded) is a
    # real content difference even when the body similarity stays high, so flag it on its own.
    src_headings = src.get("headings", [])
    tgt_headings = tgt.get("headings", [])
    headings_differ = src_headings != tgt_headings

    issues = []
    if not title_match or not h1_match or meta_diff:
        issues.append("meta_diff")
    if body_sim < settings.compare_body_sim_threshold:
        issues.append("content_diff")
    if headings_differ:
        issues.append("headings_diff")
    if missing_imgs:
        issues.append("images_missing")
    if broken_links:
        issues.append("links_broken")
    if docs_only_src or docs_only_tgt:
        issues.append("docs_diff")
    state = "identical" if not issues else (issues[0] if len(issues) == 1 else "mixed")

    cap = settings.compare_deep_text_chars
    nb = settings.compare_deep_max_blocks
    src_blocks = [b[:600] for b in src.get("blocks", [])[:nb]]
    tgt_blocks = [b[:600] for b in tgt.get("blocks", [])[:nb]]
    return DeepResult(
        deepState=state,
        titleMatch=title_match, h1Match=h1_match,
        srcTitle=src["title"][:300] or None, tgtTitle=tgt["title"][:300] or None,
        srcH1=src["h1"][:300] or None, tgtH1=tgt["h1"][:300] or None,
        srcMeta=src["meta"], tgtMeta=tgt["meta"],
        srcText=src["text"][:cap] or None, tgtText=tgt["text"][:cap] or None,
        srcBlocks=src_blocks, tgtBlocks=tgt_blocks,
        srcHeadings=src_headings, tgtHeadings=tgt_headings,
        srcEmbeddable=src.get("embeddable"), tgtEmbeddable=tgt.get("embeddable"),
        bodySim=round(body_sim, 4), wordDelta=tgt["words"] - src["words"], metaDiff=meta_diff,
        imagesChecked=len(imgs), imagesMissing=len(missing_imgs), imagesMissingUrls=missing_imgs[:20],
        linksChecked=len(links), linksBroken=broken_links, linksBrokenUrls=broken_link_urls[:20],
        # per-side totals — for a direct two-page compare ("A has 12 images, B has 8")
        srcImages=len(src["images"]), tgtImages=len(tgt["images"]),
        srcLinks=len(src["links"]), tgtLinks=len(tgt["links"]),
        # downloadable files: per-side counts + which files exist on only one side (by name)
        srcDocs=len(src_docs), tgtDocs=len(tgt_docs),
        docsOnlySrcUrls=docs_only_src[:20], docsOnlyTgtUrls=docs_only_tgt[:20],
    )


async def deep_batch(payload: DeepBatchIn, *, _client: httpx.AsyncClient | None = None) -> list[DeepResult]:
    """Deep-compare a small batch of page pairs — lets the client stream sets so no
    single request runs long enough to hit the dev-proxy timeout."""
    own_client = _client is None
    # derive the two hosts from the first pair (src=Production, tgt=UAT) for per-host auth
    host_auth = _host_auth_for(str(payload.pairs[0].src), str(payload.pairs[0].tgt),
                               payload.prodAuth, payload.uatAuth) if payload.pairs else None
    client = _client or _coverage_client(host_auth)
    sem = asyncio.Semaphore(max(1, min(len(payload.pairs), settings.compare_deep_concurrency)))
    # caps total img/link sub-requests across all pages in the batch (not just pages). Kept at
    # the polite coverage default — raising it backfires on WAF-fronted sites (throttling makes
    # the batch SLOWER and inflates false "broken link" counts).
    sub_sem = asyncio.Semaphore(settings.compare_default_concurrency)

    async def one(p) -> DeepResult:
        async with sem:
            return await _deep_compare(client, str(p.src), str(p.tgt), sub_sem=sub_sem)

    try:
        return list(await asyncio.gather(*(one(p) for p in payload.pairs)))
    finally:
        if own_client:
            await client.aclose()


async def coverage_plan(payload: CoveragePlanIn, *, _client: httpx.AsyncClient | None = None) -> CoveragePlanOut:
    """Step 1 of streamed coverage: read Production's sitemap (and optionally UAT's) and
    return the URL pairs to probe + UAT-only extras — WITHOUT probing. Fast, so the heavy
    per-URL checking can be chunked by the client (a big sitemap overran the proxy timeout
    when probed in one shot)."""
    prod_base = str(payload.prodBase)
    uat_base = str(payload.uatBase)
    sitemap_url = str(payload.sitemapUrl) if payload.sitemapUrl else default_sitemap_url(prod_base)
    max_urls = payload.maxUrls or settings.compare_max_urls
    uat_scheme, uat_netloc = _origin(uat_base)

    own_client = _client is None
    if own_client:
        assert_public_url(prod_base)
        assert_public_url(uat_base)
        assert_public_url(sitemap_url)
        if payload.uatSitemapUrl:
            assert_public_url(str(payload.uatSitemapUrl))

    client = _client or _make_client(follow_redirects=False)
    try:
        prod_urls = await fetch_sitemap_urls(client, sitemap_url, max_urls=max_urls)
        pairs = [
            CoveragePair(path=_rel_key(u), prodUrl=u, uatUrl=swap_origin(u, uat_scheme, uat_netloc))
            for u in prod_urls
        ]
        extra_on_uat: list[str] = []
        if payload.uatSitemapUrl:
            try:
                uat_urls = await fetch_sitemap_urls(client, str(payload.uatSitemapUrl), max_urls=max_urls)
                prod_keys = {_rel_key(u) for u in prod_urls}
                extra_on_uat = sorted({u for u in uat_urls if _rel_key(u) not in prod_keys})
            except SitemapError:
                extra_on_uat = []  # UAT sitemap is best-effort; don't fail the plan
    finally:
        if own_client:
            await client.aclose()

    return CoveragePlanOut(
        prodBase=prod_base,
        uatBase=uat_base,
        sitemapUrl=sitemap_url,
        generatedAt=datetime.now(timezone.utc),
        pairs=pairs,
        extraOnUat=extra_on_uat,
    )


async def coverage_batch(payload: CoverageBatchIn, *, _client: httpx.AsyncClient | None = None) -> list[UrlCheck]:
    """Step 2 of streamed coverage: probe one chunk of pairs (both sides) and classify —
    aligned to the input order. Per-host auth is derived from the first pair's hosts (the
    whole batch shares the same Production/UAT origins)."""
    own_client = _client is None
    host_auth = _host_auth_for(str(payload.pairs[0].prodUrl), str(payload.pairs[0].uatUrl),
                               payload.prodAuth, payload.uatAuth) if payload.pairs else None
    client = _client or _coverage_client(host_auth)
    requested = payload.concurrency or settings.compare_default_concurrency
    effective = max(1, min(requested, settings.compare_max_concurrency))
    sem = asyncio.Semaphore(effective)

    try:
        return list(await asyncio.gather(
            *(_check_pair(client, str(p.prodUrl), str(p.uatUrl), sem, p.path) for p in payload.pairs)
        ))
    finally:
        if own_client:
            await client.aclose()


async def compare(payload: CompareIn, *, _client: httpx.AsyncClient | None = None) -> CompareOut:
    """Run the full UAT-vs-Production sitemap coverage comparison.

    `_client` lets tests inject an httpx.AsyncClient backed by a MockTransport so the
    whole flow runs without real network; in production it's created here.
    """
    prod_base = str(payload.prodBase)
    uat_base = str(payload.uatBase)
    sitemap_url = str(payload.sitemapUrl) if payload.sitemapUrl else default_sitemap_url(prod_base)
    max_urls = payload.maxUrls or settings.compare_max_urls
    uat_scheme, uat_netloc = _origin(uat_base)

    own_client = _client is None
    if own_client:
        # hard-reject internal targets in user-supplied bases/sitemaps up front (router → 400);
        # the per-request guard hook still covers redirects + URLs pulled from the sitemap.
        assert_public_url(prod_base)
        assert_public_url(uat_base)
        assert_public_url(sitemap_url)
        if payload.uatSitemapUrl:
            assert_public_url(str(payload.uatSitemapUrl))

    client = _client or _coverage_client(_host_auth_for(prod_base, uat_base, payload.prodAuth, payload.uatAuth))
    try:
        prod_urls = await fetch_sitemap_urls(client, sitemap_url, max_urls=max_urls)

        # Default to a polite parallelism so a WAF/CDN-fronted host doesn't rate-limit our burst
        # into false "unreachable"/404s. A request may raise it via `concurrency`; never above the ceiling.
        requested = payload.concurrency or settings.compare_default_concurrency
        effective = max(1, min(requested, settings.compare_max_concurrency))
        sem = asyncio.Semaphore(effective)

        async def check(prod_url: str) -> UrlCheck:
            uat_url = swap_origin(prod_url, uat_scheme, uat_netloc)
            return await _check_pair(client, prod_url, uat_url, sem, _rel_key(prod_url))

        items = await asyncio.gather(*(check(u) for u in prod_urls))

        # deep mode: body/title/meta/image/link compare for the first N reachable pages
        if payload.deep:
            deep_limit = min(payload.deepLimit or settings.compare_deep_limit, settings.compare_deep_max_limit)
            targets = [it for it in items if it.state in ("match", "redirect")][:deep_limit]
            deep_sem = asyncio.Semaphore(max(1, min(effective, settings.compare_deep_concurrency)))
            # caps total img/link sub-requests across all deep pages (not just pages)
            sub_sem = asyncio.Semaphore(effective)

            async def deep_one(it: UrlCheck) -> None:
                async with deep_sem:
                    it.deep = await _deep_compare(client, it.prodUrl, it.uatUrl, sub_sem=sub_sem)

            await asyncio.gather(*(deep_one(it) for it in targets))

        # optional: UAT-only ("extra") URLs not present in Production's sitemap
        extra_on_uat: list[str] = []
        if payload.uatSitemapUrl:
            try:
                uat_urls = await fetch_sitemap_urls(client, str(payload.uatSitemapUrl), max_urls=max_urls)
                prod_keys = {_rel_key(u) for u in prod_urls}
                extra_on_uat = sorted({u for u in uat_urls if _rel_key(u) not in prod_keys})
            except SitemapError:
                extra_on_uat = []  # UAT sitemap is best-effort; don't fail the whole run
    finally:
        if own_client:
            await client.aclose()

    summary = CompareSummary(total=len(items), extra_on_uat=len(extra_on_uat))
    for it in items:
        setattr(summary, it.state, getattr(summary, it.state) + 1)
        if it.deep:
            summary.deep_compared += 1
            if it.deep.deepState != "identical":
                summary.deep_diff += 1

    return CompareOut(
        prodBase=prod_base,
        uatBase=uat_base,
        sitemapUrl=sitemap_url,
        generatedAt=datetime.now(timezone.utc),
        summary=summary,
        items=items,
        extraOnUat=extra_on_uat,
    )
