"""Verify a batch of redirect mapping rows by probing both sides.

For each row (oldUrl → newUrl): probe the OLD side without following redirects (so a 3xx and
its target are visible) and the NEW side following redirects (so we judge the final landing
page). From the two results, derive a suggested checklist status + note + (when the new URL
is dead) a fallback target. The router maps HTTP concerns; this module only knows URLs and
status codes. Stateless — nothing is persisted.
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from urllib.parse import urljoin, urlsplit, urlunsplit

from ..config import settings
from ..schemas import (
    STATUS_DONE, STATUS_PENDING, STATUS_PROBLEM, STATUS_SKIP,
    MappingRow, RowVerdict, VerifyIn, VerifyOut,
)
from .probe import make_client, probe_follow, probe_no_follow

_REDIRECT_CODES = (301, 302, 303, 307, 308)
# Codes that mean "the server answered but blocked/withheld the page" (WAF/bot-management, auth,
# rate-limit) rather than "no such page". A real browser usually gets through; our httpx probe
# can't emulate a full browser, so we must NOT report these as a missing page (404). The WHA new
# site, fronted by a WAF, returns 405 to automated probes for pages that load fine in a browser.
_BLOCKED_CODES = {401, 403, 405, 406, 429, 503}


def _norm(url: str) -> str:
    """Normalize a URL for equality (lowercased scheme+host, trailing slash stripped) — used to
    tell whether an old URL's redirect Location already points at the new URL."""
    p = urlsplit(url.strip())
    host = (p.netloc or "").lower()
    path = (p.path or "/").rstrip("/") or "/"
    return urlunsplit((p.scheme.lower(), host, path, p.query, ""))


def _new_site_home(new_url: str) -> str | None:
    """Root of the new URL's origin — the conventional fallback target when the exact new URL
    has no page yet (the checklist note suggests redirecting to Home in that case)."""
    p = urlsplit(new_url.strip())
    if not p.scheme or not p.netloc:
        return None
    return urlunsplit((p.scheme, p.netloc, "/", "", ""))


async def _verify_row(nofollow, follow, r: MappingRow) -> RowVerdict:
    old = r.oldUrl.strip()
    new = r.newUrl.strip()

    old_status, old_loc = (None, None)
    if old:
        old_status, old_loc = await probe_no_follow(nofollow, old)
    new_status, new_final = (None, None)
    if new:
        new_status, new_final = await probe_follow(follow, new)

    old_reachable = old_status is not None
    new_ok = new_status is not None and 200 <= new_status < 300
    new_blocked = new_status in _BLOCKED_CODES
    old_is_redirect = (old_status or 0) in _REDIRECT_CODES
    # resolve a possibly-relative Location (e.g. "/en/home") against the old URL before comparing
    old_target_abs = urljoin(old, old_loc) if old_loc else None
    already = bool(old_is_redirect and old_target_abs and new and _norm(old_target_abs) == _norm(new))

    if not new:
        status, note, target = STATUS_PROBLEM, "ยังไม่ได้ระบุ URL ใหม่ — ต้องเลือกปลายทาง", None
    elif new_ok:
        if already:
            status, note, target = STATUS_DONE, f"old → {old_status} → new แล้ว (redirect ตั้งถูกต้อง)", None
        elif not old_reachable:
            status, note, target = STATUS_SKIP, "URL เดิมเข้าถึงไม่ได้ — อาจปิดไปแล้ว ตรวจว่ายังต้อง redirect ไหม", None
        else:
            extra = f" (ตอนนี้เดิม redirect ไป {old_target_abs})" if old_is_redirect and old_target_abs else ""
            status, note, target = STATUS_PENDING, "พร้อมตั้ง redirect — URL ใหม่ใช้งานได้" + extra, None
    elif new_blocked:
        # server answered but blocked our probe (WAF/bot block) — the page likely loads in a real
        # browser, so DON'T call it missing. Leave it pending for a human to confirm via the link.
        status = STATUS_PENDING
        note = f"เว็บใหม่ตอบ {new_status} — น่าจะโดน WAF/bot block (หน้าจริงน่าจะใช้ได้) เปิดลิงก์ยืนยันเอง"
        target = None
    else:
        home = _new_site_home(new)
        code = new_status if new_status is not None else "เข้าถึงไม่ได้"
        note = f"URL ใหม่ยังไม่พร้อม (status {code})"
        if home:
            note += f" — เสนอปลายทาง: {home} (Home)"
        status, target = STATUS_PROBLEM, home

    return RowVerdict(
        symbol=r.symbol, oldUrl=old, newUrl=new,
        oldStatus=old_status, oldRedirectsTo=old_target_abs, oldReachable=old_reachable,
        newStatus=new_status, newFinalUrl=new_final, newOk=new_ok,
        alreadyRedirected=already, suggestedStatus=status, suggestedNote=note, suggestedTarget=target,
    )


async def verify(payload: VerifyIn) -> VerifyOut:
    """Probe every row (old + new side) in parallel, capped at a polite concurrency.

    No up-front DNS validation: an unresolvable new URL (a typo, or a new domain that isn't
    live yet) must be reported per-row as "not ready", NOT fail the whole batch — so the
    SSRF guard runs on the actual probe (net_guard event hook) and a blocked/unresolvable
    side simply comes back as status None.
    """
    rows = payload.rows[: settings.redirect_max_rows]
    requested = payload.concurrency or settings.redirect_default_concurrency
    effective = max(1, min(requested, settings.redirect_max_concurrency))
    sem = asyncio.Semaphore(effective)

    nofollow = make_client(follow_redirects=False)
    follow = make_client(follow_redirects=True)

    async def one(r: MappingRow) -> RowVerdict:
        async with sem:
            return await _verify_row(nofollow, follow, r)

    try:
        results = list(await asyncio.gather(*(one(r) for r in rows)))
    finally:
        await asyncio.gather(nofollow.aclose(), follow.aclose())

    return VerifyOut(results=results, generatedAt=datetime.now(timezone.utc))
