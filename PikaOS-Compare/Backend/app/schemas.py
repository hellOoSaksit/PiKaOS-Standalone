"""Pydantic request/response schemas."""
from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import AnyHttpUrl, BaseModel, ConfigDict, Field


class LoginIn(BaseModel):
    usernameOrEmail: str = Field(min_length=1)
    password: str = Field(min_length=1)


class ForgotIn(BaseModel):
    usernameOrEmail: str = Field(min_length=1)


class TokenOut(BaseModel):
    accessToken: str
    tokenType: str = "bearer"
    expiresIn: int


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    username: str
    email: str
    display: str
    role: str
    status: str
    avatar: str
    quota: int | None
    period: str
    used: int
    last_login: datetime | None = None
    created_at: datetime
    permissions: list[str] = []  # server-resolved effective perms (set by /me + login)


class LoginResult(BaseModel):
    token: TokenOut
    user: UserOut


class HealthOut(BaseModel):
    status: str
    db: str
    redis: str
    minio: str


# --- UAT vs Production sitemap comparison ---------------------------------
# Production's sitemap is the source of truth for the "primary" URL set. Each
# URL is domain-swapped onto the UAT base and both sides are probed so we can
# report coverage: which primary URLs are present / missing / broken on UAT.


class CompareAuth(BaseModel):
    """Optional credentials for login-gated sites (HTTP Basic, or a custom header /
    session cookie). Attached to every outbound probe/fetch on BOTH sides. Sent to
    the SSRF-allowlisted target host only; never logged or persisted."""

    username: str | None = Field(default=None, max_length=256)
    password: str | None = Field(default=None, max_length=512)
    headerName: str | None = Field(default=None, max_length=128, description="e.g. Authorization or Cookie")
    headerValue: str | None = Field(default=None, max_length=8192)


class CompareIn(BaseModel):
    """Request to compare a UAT site against Production by sitemap coverage."""

    prodBase: AnyHttpUrl = Field(description="Production origin, e.g. https://www.example.com")
    uatBase: AnyHttpUrl = Field(description="UAT origin, e.g. https://uat.example.com")
    # default: <prodBase>/sitemap.xml — Production is the primary URL source
    sitemapUrl: AnyHttpUrl | None = Field(default=None, description="Override Production sitemap URL")
    # optional: UAT sitemap → also surface URLs that exist on UAT but NOT in Production
    uatSitemapUrl: AnyHttpUrl | None = Field(default=None, description="UAT sitemap, to find UAT-only (extra) URLs")
    maxUrls: int | None = Field(default=None, ge=1, le=10000, description="Cap on URLs probed")
    # default (None) = probe ALL sitemap URLs simultaneously (clamped to compare_max_concurrency)
    concurrency: int | None = Field(default=None, ge=1, le=500, description="Cap on parallel probes; omit to run the whole sitemap at once")
    # deep mode: fetch full HTML and compare title/h1/meta/body + image & link existence
    deep: bool = Field(default=False, description="Compare page bodies, not just status codes")
    deepLimit: int | None = Field(default=None, ge=1, le=500, description="How many matched pages to deep-compare (default compare_deep_limit)")
    # per-side credentials — Production and UAT can need different (or one-sided) logins.
    # prodAuth applies to the prodBase host, uatAuth to the uatBase host.
    prodAuth: CompareAuth | None = Field(default=None, description="Credentials for the Production host")
    uatAuth: CompareAuth | None = Field(default=None, description="Credentials for the UAT host")


class Heading(BaseModel):
    """One heading in a page's H1–H6 outline (level + text), for the structure diff."""

    level: int
    text: str


class DeepResult(BaseModel):
    """Deep (body-level) comparison of one source page vs its target twin."""

    deepState: str                          # identical | content_diff | meta_diff | headings_diff | images_missing | links_broken | docs_diff | mixed | unfetchable
    # on `unfetchable`: which side failed + why (status / type / exception) — actionable detail
    srcStatus: int | None = None
    tgtStatus: int | None = None
    srcReason: str | None = None
    tgtReason: str | None = None
    titleMatch: bool | None = None
    h1Match: bool | None = None
    srcTitle: str | None = None
    tgtTitle: str | None = None
    srcH1: str | None = None
    tgtH1: str | None = None
    srcMeta: dict[str, str] = Field(default_factory=dict)   # description/canonical/og:* — for field diff
    tgtMeta: dict[str, str] = Field(default_factory=dict)
    srcText: str | None = None              # truncated body text — for the client-side highlighted diff
    tgtText: str | None = None
    # content split into block-level chunks (chrome/menu excluded) — for the block-by-block
    # aligned diff so the user sees exactly WHICH paragraph/section differs PROD↔UAT
    srcBlocks: list[str] = Field(default_factory=list)
    tgtBlocks: list[str] = Field(default_factory=list)
    # H1–H6 outline per side (chrome excluded) — for the heading-structure diff (which heading
    # was added/removed/reworded PROD↔UAT), each clickable to jump to it on the live page
    srcHeadings: list[Heading] = Field(default_factory=list)
    tgtHeadings: list[Heading] = Field(default_factory=list)
    srcEmbeddable: bool | None = None       # can be shown in a cross-origin iframe (X-Frame-Options/CSP)
    tgtEmbeddable: bool | None = None
    bodySim: float | None = None            # 0..1 text similarity (difflib)
    wordDelta: int | None = None            # target words − source words
    metaDiff: list[str] = Field(default_factory=list)   # meta fields that differ
    imagesChecked: int = 0
    imagesMissing: int = 0
    imagesMissingUrls: list[str] = Field(default_factory=list)
    linksChecked: int = 0
    linksBroken: int = 0
    linksBrokenUrls: list[str] = Field(default_factory=list)   # which internal links 404 (for the diff detail)
    # per-side totals — for a direct two-page compare (A vs B counts)
    srcImages: int = 0
    tgtImages: int = 0
    srcLinks: int = 0
    tgtLinks: int = 0
    # downloadable files (PDF/DOC/XLS/…) compared BY FILENAME across sites — surfaces a
    # report/form present on one side but missing on the other (host/path differ, file is "the same")
    srcDocs: int = 0
    tgtDocs: int = 0
    docsOnlySrcUrls: list[str] = Field(default_factory=list)   # files on source whose filename isn't on target
    docsOnlyTgtUrls: list[str] = Field(default_factory=list)   # files on target whose filename isn't on source


class DeepPair(BaseModel):
    """One source→target page pair to deep-compare (already domain-swapped)."""

    src: AnyHttpUrl
    tgt: AnyHttpUrl


class DeepBatchIn(BaseModel):
    """A small batch of pages to deep-compare, so the client can stream sets."""

    pairs: list[DeepPair] = Field(min_length=1, max_length=50)
    # per-side credentials: prodAuth → src (Production) host, uatAuth → tgt (UAT) host
    prodAuth: CompareAuth | None = Field(default=None, description="Credentials for the Production (src) host")
    uatAuth: CompareAuth | None = Field(default=None, description="Credentials for the UAT (tgt) host")


class DeepBatchOut(BaseModel):
    results: list[DeepResult]   # aligned to the input pairs


class UrlCheck(BaseModel):
    """Coverage result for one primary (Production) URL mapped onto UAT."""

    path: str                       # path (+query) shared by both sides
    prodUrl: str
    uatUrl: str
    prodStatus: int | None = None   # None = request failed (timeout/DNS/etc.)
    uatStatus: int | None = None
    state: str                      # match | missing_on_uat | broken_on_uat | redirect | prod_error | error
    note: str | None = None
    deep: DeepResult | None = None  # populated only in deep mode for compared pages


# --- streamed coverage: plan (read sitemap) then probe in batches -----------
# A 200+ URL sitemap probes both sides serially-throttled and overran the dev-proxy
# timeout in one /compare call. Splitting into plan + batches keeps every request fast
# and lets the UI fill the table live (same trick deep mode already uses).


class CoveragePair(BaseModel):
    """One primary URL and its domain-swapped twin — the unit the client streams back
    to /compare/batch."""

    path: str
    prodUrl: AnyHttpUrl
    uatUrl: AnyHttpUrl


class CoveragePlanIn(BaseModel):
    """Step 1: read the sitemap(s) and return the URL pairs + UAT-only extras, WITHOUT
    probing (fast). The client then probes the pairs in batches."""

    prodBase: AnyHttpUrl = Field(description="Production origin (source-of-truth sitemap host)")
    uatBase: AnyHttpUrl = Field(description="UAT origin (each path is checked here)")
    sitemapUrl: AnyHttpUrl | None = Field(default=None, description="Override the primary sitemap URL")
    uatSitemapUrl: AnyHttpUrl | None = Field(default=None, description="UAT sitemap, to find UAT-only (extra) URLs")
    maxUrls: int | None = Field(default=None, ge=1, le=10000, description="Cap on URLs pulled from the sitemap")


class CoveragePlanOut(BaseModel):
    prodBase: str
    uatBase: str
    sitemapUrl: str
    generatedAt: datetime
    pairs: list[CoveragePair]
    extraOnUat: list[str] = Field(default_factory=list)


class CoverageBatchIn(BaseModel):
    """Step 2: probe one chunk of pairs (both sides) and classify."""

    pairs: list[CoveragePair] = Field(min_length=1, max_length=100)
    concurrency: int | None = Field(default=None, ge=1, le=500, description="Parallel probes in this batch")
    # per-side credentials: prodAuth → prodUrl host, uatAuth → uatUrl host
    prodAuth: CompareAuth | None = Field(default=None, description="Credentials for the Production host")
    uatAuth: CompareAuth | None = Field(default=None, description="Credentials for the UAT host")


class CoverageBatchOut(BaseModel):
    results: list[UrlCheck]   # aligned to the input pairs


class CompareSummary(BaseModel):
    total: int = 0
    match: int = 0
    redirect: int = 0
    missing_on_uat: int = 0
    broken_on_uat: int = 0
    prod_error: int = 0
    error: int = 0
    extra_on_uat: int = 0
    deep_compared: int = 0          # pages that ran a deep body comparison
    deep_diff: int = 0              # of those, how many were not "identical"


class CompareOut(BaseModel):
    prodBase: str
    uatBase: str
    sitemapUrl: str
    generatedAt: datetime
    summary: CompareSummary
    items: list[UrlCheck]
    extraOnUat: list[str] = Field(default_factory=list)  # UAT-only URLs (if uatSitemapUrl given)
