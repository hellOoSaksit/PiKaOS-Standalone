"""HTML content extraction for deep page comparison.

Stdlib-only (`html.parser`) so there's no extra dependency to install in the
Docker image, and it runs in tests without network. Pulls title / h1 / meta,
normalized body text, images, and internal links out of a page's HTML.
"""
from __future__ import annotations

import asyncio
import re
from html.parser import HTMLParser
from urllib.parse import unquote, urljoin, urlsplit

import httpx

from ..config import settings

_SKIP = {"script", "style", "noscript", "template", "svg"}
# page CHROME (menu/header/footer/sidebar) — excluded from body text + content blocks so the
# diff compares real page content, not the nav mega-menu (which dominated + differed by site).
_CHROME = {"nav", "header", "footer", "aside"}
_CHROME_ROLES = {"navigation", "banner", "contentinfo", "search", "menu", "menubar", "complementary", "dialog"}
# block-level tags — text is segmented at these boundaries into comparable "blocks"
# (paragraph / heading / list item / cell), so the diff can align block-by-block.
_BLOCK = {"p", "div", "section", "article", "li", "h1", "h2", "h3", "h4", "h5", "h6",
          "td", "th", "tr", "caption", "blockquote", "dd", "dt", "figcaption", "summary"}
# heading tags — captured as a (level, text) OUTLINE so the deep diff can compare the page's
# H1–H6 structure PROD↔UAT (not just the single primary H1). Chrome headings are excluded (below).
_HEADERS = {"h1", "h2", "h3", "h4", "h5", "h6"}
# void (self-closing) elements have no end tag — never pushed on the open-element stack
_VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}
_WS = re.compile(r"\s+")
# downloadable document types — compared by FILENAME across sites (a PDF/report on PROD
# vs its UAT twin), since the host/path differ but the file is "the same document".
_DOC_EXTS = (".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".csv", ".zip", ".rar", ".7z", ".txt")


def _is_doc(url: str) -> bool:
    path = urlsplit(url).path.lower()
    return path.endswith(_DOC_EXTS)


def _norm(s: str) -> str:
    return _WS.sub(" ", s or "").strip()


class _PageParser(HTMLParser):
    """Collect the bits we compare. First <title> and first <h1> only.

    Body text + content `blocks` EXCLUDE page chrome (nav/header/footer/aside, ARIA
    landmarks) so the diff reflects real content, not the navigation mega-menu. Text is
    segmented at block-level boundaries into `blocks` for a block-by-block aligned diff.
    """

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.title: list[str] = []
        self.h1: list[str] = []
        self.text: list[str] = []
        self.blocks: list[str] = []   # content segmented into block-level chunks
        self.headings: list[tuple[int, str]] = []   # (level, text) outline — chrome excluded
        self.images: list[str] = []
        self.links: list[str] = []
        self.meta: dict[str, str] = {}
        self._in_title = False
        self._in_h1 = False
        self._h1_done = False
        self._skip = 0
        self._chrome = 0              # >0 while inside nav/header/footer/aside/landmark
        self._stack: list[bool] = []  # open non-void elements; True = opened a chrome region
        self._buf: list[str] = []     # current block's text, flushed at block boundaries
        self._h_lvl = 0               # >0 while inside an h1-h6 (the level); accumulates _h_text
        self._h_text: list[str] = []

    def _flush(self) -> None:
        if self._buf:
            chunk = _norm(" ".join(self._buf))
            if chunk:
                self.blocks.append(chunk)
            self._buf = []

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag in _SKIP:
            self._skip += 1
            return
        is_chrome = tag in _CHROME or (a.get("role") or "").strip().lower() in _CHROME_ROLES
        if tag not in _VOID:
            self._stack.append(is_chrome)
            if is_chrome:
                self._chrome += 1
        if is_chrome or tag in _BLOCK:
            self._flush()   # close the current block at a boundary / before entering chrome
        if tag in _HEADERS and not self._chrome:   # start an outline heading (content only, not nav/footer)
            self._h_lvl = int(tag[1])
            self._h_text = []
        if tag == "title":
            self._in_title = True
        elif tag == "h1" and not self._h1_done:
            self._in_h1 = True
        elif tag == "img":
            if a.get("src"):
                self.images.append(a["src"])
        elif tag == "a":
            if a.get("href"):
                self.links.append(a["href"])
        elif tag == "meta":
            name = (a.get("name") or "").strip().lower()
            prop = (a.get("property") or "").strip().lower()
            content = (a.get("content") or "").strip()
            if content and name == "description":
                self.meta["description"] = content
            elif content and prop == "og:title":
                self.meta["og:title"] = content
            elif content and prop == "og:image":
                self.meta["og:image"] = content
        elif tag == "link":
            rel = (a.get("rel") or "").strip().lower()
            if "canonical" in rel and a.get("href"):
                self.meta["canonical"] = a["href"].strip()

    def handle_startendtag(self, tag, attrs):  # self-closing <img/> <meta/> <link/>
        self.handle_starttag(tag, attrs)

    def handle_endtag(self, tag):
        if tag in _SKIP and self._skip:
            self._skip -= 1
            return
        if tag in _BLOCK:
            self._flush()
        if tag in _HEADERS and self._h_lvl:   # close the current outline heading
            htext = _norm(" ".join(self._h_text))
            if htext:
                self.headings.append((self._h_lvl, htext))
            self._h_lvl = 0
            self._h_text = []
        if tag not in _VOID and self._stack:
            if self._stack.pop() and self._chrome:
                self._chrome -= 1
        if tag == "title":
            self._in_title = False
        elif tag == "h1" and self._in_h1:
            self._in_h1 = False
            self._h1_done = True

    def handle_data(self, data):
        if self._skip:
            return
        # title/h1 are page-level fields — captured even if they live inside <header> chrome
        if self._in_title:
            self.title.append(data)
        if self._in_h1:
            self.h1.append(data)
        if self._chrome:   # nav/menu/footer text is excluded from body content
            return
        s = data.strip()
        if s:
            self.text.append(s)
            self._buf.append(s)
            if self._h_lvl:           # also accumulate into the current heading's text
                self._h_text.append(s)

    def close(self):
        super().close()
        self._flush()


def extract(html: str, base_url: str) -> dict:
    """Parse a page's HTML into the comparable fields (URLs resolved absolute)."""
    p = _PageParser()
    try:
        p.feed(html)
        p.close()   # flush the final pending block
    except Exception:  # malformed HTML — keep whatever we got
        pass
    host = urlsplit(base_url).netloc

    # content blocks: drop tiny fragments + consecutive duplicates (repeated UI labels)
    blocks: list[str] = []
    for b in p.blocks:
        if len(b) < 2:
            continue
        if blocks and blocks[-1] == b:
            continue
        blocks.append(b)

    # heading outline (level + text): drop consecutive duplicates, cap so a pathological page
    # can't bloat the response (the diff only needs the structure, not every repeat).
    headings: list[dict] = []
    for lvl, txt in p.headings:
        if headings and headings[-1]["level"] == lvl and headings[-1]["text"] == txt:
            continue
        headings.append({"level": lvl, "text": txt[:300]})
        if len(headings) >= 80:
            break

    images, seen = [], set()
    for s in p.images:
        u = urljoin(base_url, s)
        if u.startswith("http") and u not in seen:
            seen.add(u)
            images.append(u)

    links, lseen = [], set()
    docs, dseen = [], set()
    for h in p.links:
        if h.startswith(("#", "mailto:", "tel:", "javascript:", "data:")):
            continue
        u = urljoin(base_url, h)
        if not u.startswith("http"):
            continue
        # downloadable file (any host, incl. a CDN) → keep url + filename for cross-site compare
        if _is_doc(u):
            if u not in dseen:
                dseen.add(u)
                name = unquote(urlsplit(u).path.rsplit("/", 1)[-1]) or u
                docs.append({"url": u, "name": name})
            continue
        if urlsplit(u).netloc == host and u not in lseen:
            lseen.add(u)
            links.append(u)

    text = _norm(" ".join(p.text))   # original case (lowercased only where needed for sim)
    return {
        "title": _norm(" ".join(p.title)),
        "h1": _norm(" ".join(p.h1)),
        "meta": p.meta,
        "text": text,
        "words": len(text.split()),
        "images": images,
        "links": links,
        "docs": docs,       # [{url, name}] — downloadable files, compared by name across sites
        "blocks": blocks,   # content segmented into block chunks — for the block-by-block diff
        "headings": headings,  # [{level, text}] H1–H6 outline — for the heading-structure diff
    }


def embeddable(headers) -> bool:
    """Can this response be shown in a cross-origin <iframe>? Reads X-Frame-Options
    and CSP frame-ancestors. Conservative: a specific (non-wildcard) allowlist that
    won't include our dev origin counts as blocked."""
    xfo = (headers.get("x-frame-options", "") or "").lower()
    if "deny" in xfo or "sameorigin" in xfo:
        return False
    csp = (headers.get("content-security-policy", "") or "").lower()
    if "frame-ancestors" in csp:
        part = csp.split("frame-ancestors", 1)[1].split(";", 1)[0]
        if "'none'" in part or "*" not in part:
            return False
    return True


async def fetch_page(client: httpx.AsyncClient, url: str) -> dict:
    """GET the full page and return extracted fields, or {ok: False, status, reason} on a
    miss. Retries transient connect/read failures (a single WAF drop shouldn't read as
    'unfetchable'); a miss carries a human `reason` (status+type, or the exception type)."""
    resp = None
    last_exc: httpx.HTTPError | None = None
    for attempt in range(settings.compare_probe_retries + 1):
        try:
            resp = await client.get(url, follow_redirects=True)
            break
        except httpx.HTTPError as exc:
            last_exc = exc
            if attempt < settings.compare_probe_retries:
                await asyncio.sleep(settings.compare_probe_backoff_seconds * (attempt + 1))
    if resp is None:
        return {"ok": False, "status": None, "reason": str(last_exc) or type(last_exc).__name__}
    ctype = resp.headers.get("content-type", "").lower()
    if resp.status_code != 200 or "html" not in ctype:
        return {"ok": False, "status": resp.status_code, "embeddable": embeddable(resp.headers),
                "reason": f"status {resp.status_code}, type {ctype or 'unknown'}"}
    data = extract(resp.text, str(resp.url))
    data["ok"] = True
    data["status"] = resp.status_code
    data["reason"] = None
    data["embeddable"] = embeddable(resp.headers)
    return data
