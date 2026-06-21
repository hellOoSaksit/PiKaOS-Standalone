"""Inspect a page's HTML — used by verify's deep check (per row).

Two pure-regex passes over a page's HTML (no HTML-parser dep):
- extract_files(): the downloadable-document links (PDF/DOC/…) on the page, keyed by filename —
  so verify can compare the files linked on the OLD page vs the NEW page for one mapping row.
- body_signal(): does the page have an <h1>, and is its body essentially empty beyond that H1?
  A migrated page that's just an H1 with no real content is a stub from an incomplete migration.

Stateless and network-free: callers pass the already-fetched HTML.
"""
from __future__ import annotations

import re
from urllib.parse import urljoin, urlsplit

from ..config import settings

__all__ = ["extract_files", "body_signal", "BodySignal"]


def _build_doc_regex() -> re.Pattern:
    exts = "|".join(re.escape(e) for e in settings.file_ext_list)
    # href/src="….pdf"  (optionally followed by ?query or #frag), single or double quoted
    return re.compile(rf'''(?:href|src)\s*=\s*["']([^"'>]+?\.(?:{exts}))(?:[?#][^"']*)?["']''', re.I)


_DOC_RE = _build_doc_regex()
# "Browser-only" pages: the server hands an automated probe something OTHER than the real page, so a
# sparse body here means "can't read server-side", NOT "empty". Two causes, same effect:
#   1. Bot-wall / WAF challenge — a CAPTCHA / "are you human" interstitial returned with HTTP 200.
#      The WHA new site (wha-group.com) sits behind AWS WAF and serves exactly this to httpx/curl.
#   2. SPA shell — a client-rendered app (React/Next/Vue/Angular) whose content only appears after JS
#      runs, which our probe does not do.
# A real browser gets past both, so we must not report these as a thin/missing page — flag them and
# tell the user to confirm in a browser.
_BROWSER_ONLY_RE = re.compile(
    # bot-wall / WAF challenge signatures (answer 200 with a challenge instead of the page)
    r'''awswaf|captcha|cf-browser-verification|challenge-platform|just a moment'''
    r'''|checking your (?:browser|site connection)|not a robot|incapsula|imperva'''
    # SPA mount nodes / framework hints (real content is injected by JS)
    r'''|id=["'](?:root|app|__next|__nuxt|q-app|application)["']|\bng-app\b|\bdata-reactroot\b''',
    re.I,
)
# blocks whose text is page chrome, not content — stripped before measuring the body
_CHROME_RE = re.compile(r"<(script|style|noscript|template|header|footer|nav|aside)\b[^>]*>.*?</\1>", re.I | re.S)
_H1_RE = re.compile(r"<h1\b[^>]*>(.*?)</h1>", re.I | re.S)
_TAG_RE = re.compile(r"<[^>]+>")
_WS_RE = re.compile(r"\s+")

# Soft-error pages: a server can return HTTP 200 (or 404) whose BODY is actually an error screen
# ("Internal Server Error", "Bad Gateway", a maintenance notice…). The status code alone hides this,
# so we scan the top of the visible text for known error signatures → a short label (mostly a code).
# Order matters: more specific first. Only the first ~800 chars are scanned (error screens put it up top).
_ERROR_SIGNS = [
    ("the server encountered an internal error", "500"),
    ("internal server error", "500"),
    ("http error 500", "500"),
    ("502 bad gateway", "502"),
    ("bad gateway", "502"),
    ("503 service", "503"),
    ("service temporarily unavailable", "503"),
    ("service unavailable", "503"),
    ("504 gateway", "504"),
    ("gateway timeout", "504"),
    ("403 forbidden", "403"),
    ("access denied", "403"),
    ("page not found", "404"),
    ("404 not found", "404"),
    ("under maintenance", "maintenance"),
]


def _detect_error(visible_lower: str) -> str:
    head = visible_lower[:800]
    for needle, label in _ERROR_SIGNS:
        if needle in head:
            return label
    return ""


def _filename(url: str) -> str:
    """Last path segment, lowercased, query/fragment stripped — the key files are matched by."""
    path = urlsplit(url).path
    return (path.rsplit("/", 1)[-1] or path).split("?")[0].lower()


def extract_files(html: str | None, base_url: str) -> dict[str, str]:
    """{filename: absolute_url} for every document link on the page (first link per filename)."""
    found: dict[str, str] = {}
    if not html:
        return found
    for m in _DOC_RE.finditer(html):
        full = urljoin(base_url, m.group(1))
        if urlsplit(full).scheme not in ("http", "https"):
            continue
        found.setdefault(_filename(full), full)
    return found


def _strip_tags(fragment: str) -> str:
    return _WS_RE.sub(" ", _TAG_RE.sub(" ", fragment)).strip()


class BodySignal:
    """has_h1: page has an <h1>. h1: its text. body_chars: visible chars left after removing chrome
    + the H1 text. thin: has_h1 AND body_chars < threshold (an H1-only stub). has_body: the page has
    real visible content (>= threshold chars). error: a soft-error label (e.g. "500") when the body
    reads as an error/maintenance screen even if the HTTP status said otherwise; "" when it looks fine.
    spa: the page is "browser-only" — a bot-wall/WAF challenge (e.g. an AWS WAF CAPTCHA returned with
    200) or a JS-rendered SPA shell. Either way a server-side probe can't see the real content, so
    callers must NOT treat this as empty/thin — a real browser would get the actual page."""

    __slots__ = ("has_h1", "h1", "body_chars", "thin", "has_body", "error", "spa")

    def __init__(self, has_h1: bool, h1: str, body_chars: int, thin: bool, has_body: bool, error: str, spa: bool) -> None:
        self.has_h1 = has_h1
        self.h1 = h1
        self.body_chars = body_chars
        self.thin = thin
        self.has_body = has_body
        self.error = error
        self.spa = spa


def body_signal(html: str | None) -> BodySignal:
    if not html:
        return BodySignal(False, "", 0, False, False, "", False)
    h1m = _H1_RE.search(html)
    has_h1 = h1m is not None
    h1_text = _strip_tags(h1m.group(1)) if h1m else ""
    visible = _strip_tags(_CHROME_RE.sub(" ", html))      # all visible page text (minus chrome)
    body = visible
    if h1_text and h1_text in body:
        body = body.replace(h1_text, "", 1).strip()       # "only an H1" => near-zero remaining text
    body_chars = len(body)
    has_body = len(visible) >= settings.redirect_body_min_chars
    error = _detect_error(visible.lower())
    # browser-only (WAF challenge / SPA shell) only when the body is sparse AND not an error page —
    # a real error screen behind a WAF should still read as an error, not "open in a browser".
    spa = (not has_body) and (not error) and bool(_BROWSER_ONLY_RE.search(html))
    # a challenge/shell isn't a genuine "H1-only stub" — don't double-flag it as thin
    thin = has_h1 and body_chars < settings.redirect_body_min_chars and not spa
    return BodySignal(has_h1, h1_text, body_chars, thin, has_body, error, spa)
