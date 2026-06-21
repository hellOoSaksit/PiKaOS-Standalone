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


class Credential(BaseModel):
    """HTTP Basic Auth for ONE host (e.g. a UAT site behind a browser "Sign in" dialog).

    Matched to a probed URL by host. Secrets ride on the request only — never persisted, never in
    config (the tool is stateless). `host` accepts a bare host or a full URL; only its host is used.
    """

    host: str = Field(default="", max_length=255, description="Host the creds apply to, e.g. site.uat.example.com")
    username: str = Field(default="", max_length=255)
    password: str = Field(default="", max_length=255)


class MatchCandidate(BaseModel):
    """One close new-site URL for an old URL, by path similarity — an alternative the user can eyeball
    when the chosen match isn't obviously right (the new site reorganised paths). Read-only context."""

    url: str = Field(max_length=2048)
    score: float = Field(description="Path-similarity % to the old URL (0–100)")


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
    # Top alternative new URLs by path similarity (best first; [0] is the chosen newUrl). Set by
    # Discover from the new sitemap — surfaced as a "close matches" list so the user can sanity-check
    # the pick and open a better one. Empty on a domain-swap (no new sitemap to compare against).
    candidates: list[MatchCandidate] = Field(default_factory=list, max_length=10)
    # Set by Discover when this newUrl is the fuzzy best-match for MORE THAN ONE old URL — a sign the
    # match was forced (the new site has no distinct page for each old one). A cue to double-check.
    collision: bool = Field(default=False)


# --- verify -----------------------------------------------------------------


class VerifyIn(BaseModel):
    rows: list[MappingRow] = Field(min_length=1, max_length=2000)
    concurrency: int | None = Field(default=None, ge=1, le=100, description="Cap on parallel probes")
    # When True (default) each row's probe GETs the page HTML to also compare linked files and flag
    # a thin (H1-only) body. False = fast status-only probe (no body fetch).
    deepCheck: bool = Field(default=True, description="Also fetch HTML to compare files + check body")
    # Optional HTTP Basic Auth per host — for old/new sites behind a login (e.g. UAT). Matched to
    # each probed URL by host; a side whose host has no credential is probed as before.
    credentials: list[Credential] = Field(default_factory=list, max_length=50)


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
    # --- deep check (only when VerifyIn.deepCheck): compare files + detect thin body, per row ---
    # Downloadable files (PDF/DOC/…) LINKED in the old page vs the new page — by filename.
    oldFileCount: int = 0
    newFileCount: int = 0
    filesMatched: list[str] = Field(default_factory=list)   # filenames linked on BOTH pages
    filesOnlyOld: list[str] = Field(default_factory=list)   # on the old page, missing on the new
    filesOnlyNew: list[str] = Field(default_factory=list)   # added on the new page
    filesSame: bool | None = None           # True = identical file set, False = differ, None = no files / not checked
    # Body check (both sides): a page that has an <h1> but almost no body content beyond it.
    oldHasH1: bool = False
    newHasH1: bool = False
    oldBodyThin: bool = False                # old page is H1-only (stub)
    newBodyThin: bool = False                # new page is H1-only — incomplete migration
    oldHasBody: bool = False                 # old page has real visible content
    newHasBody: bool = False                 # new page has real visible content
    oldError: str = ""                       # soft-error read from the OLD body (e.g. "500"); "" = looks fine
    newError: str = ""                       # soft-error read from the NEW body even if status was 200
    oldSpa: bool = False                      # old page is browser-only (WAF challenge / SPA shell) — body/files unreadable server-side
    newSpa: bool = False                      # new page is browser-only (WAF challenge / SPA shell) — don't trust its body/file check
    bodyChecked: bool = False                # the body/file pass actually ran for this row


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
    # Optional HTTP Basic Auth per host — when an old/new site (or its sitemap) sits behind a login.
    credentials: list[Credential] = Field(default_factory=list, max_length=50)


class DiscoverOut(BaseModel):
    rows: list[MappingRow]                  # one proposed mapping per old-site URL (new = domain-swapped)
    sitemapUrl: str                         # the sitemap actually read
    count: int


# --- .xlsx export -----------------------------------------------------------


class ExportRow(MappingRow):
    """A mapping row PLUS the verify findings (when the row was verified) — drives the rich
    "Verify Detail" sheet. Every check field is optional/defaulted, so a plain unverified row
    (just symbol/old/new/status/note) still validates and exports."""

    # old side
    oldStatus: int | None = None
    oldRedirectsTo: str | None = None
    oldReachable: bool = False
    # new side
    newStatus: int | None = None
    newFinalUrl: str | None = None
    newOk: bool = False
    alreadyRedirected: bool = False
    suggestedTarget: str | None = None
    # body (both sides)
    oldHasBody: bool = False
    newHasBody: bool = False
    oldBodyThin: bool = False
    newBodyThin: bool = False
    oldHasH1: bool = False
    newHasH1: bool = False
    oldError: str = ""
    newError: str = ""
    oldSpa: bool = False
    newSpa: bool = False
    bodyChecked: bool = False
    # downloadable files linked on each page
    oldFileCount: int = 0
    newFileCount: int = 0
    filesSame: bool | None = None
    filesMatched: list[str] = Field(default_factory=list)
    filesOnlyOld: list[str] = Field(default_factory=list)
    filesOnlyNew: list[str] = Field(default_factory=list)


class ExportIn(BaseModel):
    rows: list[ExportRow] = Field(min_length=1, max_length=5000)
