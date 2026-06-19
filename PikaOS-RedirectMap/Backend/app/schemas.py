"""Pydantic request/response schemas for the URL Redirect-Map tool.

The unit of work is a *mapping row*: one old URL that should 301 to one new URL, tagged
by a Symbol/site. The tool (1) **verifies** rows by probing both sides and (2) generates an
**IIS web.config** URL-Rewrite block from them. It is stateless — rows come in on the
request and results go back on the response; nothing is persisted server-side.
"""
from __future__ import annotations

from datetime import datetime

from pydantic import AnyHttpUrl, BaseModel, Field

# Status vocabulary mirrors the central checklist (Thai). `suggestedStatus` on a verdict is
# always one of these — the UI shows it as a chip the user can accept or override.
STATUS_PENDING = "รอดำเนินการ"        # mapping is valid and ready to configure
STATUS_DONE = "ดำเนินการแล้ว"          # old URL already 301s to the new one
STATUS_PROBLEM = "ติดปัญหา"            # new URL has no page / mapping incomplete
STATUS_SKIP = "ไม่ต้อง Redirect"       # old URL is gone/irrelevant — nothing to redirect


class MappingRow(BaseModel):
    """One redirect mapping: old URL → new URL, tagged by Symbol/site.

    URLs are plain strings (not AnyHttpUrl) on purpose: a row may be mid-edit with a blank
    or partial `newUrl`, and verify must report that gracefully rather than 422 the whole
    batch. The probe path validates each URL before any network call (services/probe)."""

    symbol: str = Field(default="", max_length=128, description="Symbol / site id, e.g. WHA-ID")
    oldUrl: str = Field(default="", max_length=2048, description="Old-site URL to redirect FROM")
    newUrl: str = Field(default="", max_length=2048, description="New-site URL to redirect TO")
    status: str = Field(default="", max_length=64, description="Current checklist status (free-form)")
    note: str = Field(default="", max_length=2048)
    # Set by Discover when BOTH sitemaps are read: how close the old path is to the matched new URL's
    # path (0–100; 100 = exact path exists on the new site). None = no new sitemap → domain-swap fallback.
    matchScore: float | None = Field(default=None)


# --- verify -----------------------------------------------------------------


class VerifyIn(BaseModel):
    rows: list[MappingRow] = Field(min_length=1, max_length=2000)
    concurrency: int | None = Field(default=None, ge=1, le=100, description="Cap on parallel probes")


class RowVerdict(BaseModel):
    """Result of probing one mapping row (old side + new side)."""

    symbol: str
    oldUrl: str
    newUrl: str
    # old side — probed WITHOUT following redirects, so a 3xx (and where it points) is visible
    oldStatus: int | None = None            # None = request failed (timeout/DNS/blocked)
    oldRedirectsTo: str | None = None       # Location header when oldStatus is 3xx
    oldReachable: bool = False              # old URL returned any HTTP response
    # new side — probed FOLLOWING redirects, so we judge the final landing page
    newStatus: int | None = None            # final status after following redirects
    newFinalUrl: str | None = None          # where the new URL ultimately lands
    newOk: bool = False                     # final page is a real 2xx (a valid landing page)
    # verdict
    alreadyRedirected: bool = False         # old already 301/302s onto the new URL
    suggestedStatus: str = STATUS_PENDING   # one of the STATUS_* values above
    suggestedNote: str = ""                 # human-readable reason / next action
    suggestedTarget: str | None = None      # fallback target when newUrl 404s (e.g. new-site home)


class VerifyOut(BaseModel):
    results: list[RowVerdict]               # aligned to the input rows
    generatedAt: datetime


# --- IIS web.config generation ----------------------------------------------


class WebConfigIn(BaseModel):
    rows: list[MappingRow] = Field(min_length=1, max_length=2000)
    redirectType: str = Field(default="Permanent", description="Permanent (301) | Found (302) | Temporary (307)")
    appendQueryString: bool = Field(default=False, description="Carry the old query string onto the new URL")
    matchTrailingSlash: bool = Field(default=True, description="Match the old path with or without a trailing slash")


class WebConfigOut(BaseModel):
    xml: str                                # the full web.config text, ready to download
    ruleCount: int                          # how many rewrite rules were emitted
    skipped: list[str] = Field(default_factory=list)  # rows skipped (missing old/new URL) — symbol/old for context


# --- discover from sitemap --------------------------------------------------
# Like Compare's coverage: read the OLD site's sitemap, then domain-swap every URL onto the NEW
# base to propose a redirect target per page — so the whole site is mapped at once instead of by
# hand. The proposed rows then flow into the same verify + web.config path.


class DiscoverIn(BaseModel):
    oldBase: AnyHttpUrl = Field(description="Old-site origin, e.g. https://whaind.azurewebsites.net")
    newBase: AnyHttpUrl = Field(description="New-site origin, e.g. https://www.wha-industrialestate.com")
    symbol: str = Field(default="", max_length=128, description="Symbol applied to every discovered row")
    # default: <oldBase>/sitemap.xml — the old site is the source of the URL set
    sitemapUrl: AnyHttpUrl | None = Field(default=None, description="Override the old-site sitemap URL")
    # default: <newBase>/sitemap.xml — read too, so each old URL is matched to the closest REAL new URL
    # (with a similarity %). Best-effort: if it can't be read, fall back to a same-path domain swap.
    newSitemapUrl: AnyHttpUrl | None = Field(default=None, description="Override the new-site sitemap URL")
    maxUrls: int | None = Field(default=None, ge=1, le=5000, description="Cap on URLs pulled from each sitemap")


class DiscoverOut(BaseModel):
    rows: list[MappingRow]                  # one proposed mapping per old-site URL (new = domain-swapped)
    sitemapUrl: str                         # the sitemap actually read
    count: int


# --- file check (crawl pages → compare downloadable files old vs new) -------


class FilesIn(BaseModel):
    oldBase: AnyHttpUrl = Field(description="Old-site origin")
    newBase: AnyHttpUrl = Field(description="New-site origin")
    sitemapUrl: AnyHttpUrl | None = Field(default=None, description="Override old-site sitemap")
    newSitemapUrl: AnyHttpUrl | None = Field(default=None, description="Override new-site sitemap")
    maxPages: int | None = Field(default=None, ge=1, le=2000, description="Cap on pages crawled per site")


class FileItem(BaseModel):
    name: str                               # filename (lowercased) — the key files are matched by
    oldUrl: str | None = None               # where it's linked on the old site (if present)
    newUrl: str | None = None               # where it's linked on the new site (if present)


class FilesOut(BaseModel):
    oldCount: int                           # distinct files found on the old site
    newCount: int                           # distinct files found on the new site
    oldPages: int                           # pages actually crawled on the old site
    newPages: int
    matched: list[FileItem] = Field(default_factory=list)   # same filename on both sites
    onlyOld: list[FileItem] = Field(default_factory=list)   # file on old only (gone on new)
    onlyNew: list[FileItem] = Field(default_factory=list)   # file on new only (added)


# --- .xlsx export -----------------------------------------------------------


class ExportIn(BaseModel):
    rows: list[MappingRow] = Field(min_length=1, max_length=5000)
    files: FilesOut | None = Field(default=None, description="Optional file-comparison → adds a Files sheet")
