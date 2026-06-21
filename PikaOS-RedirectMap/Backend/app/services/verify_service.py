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
import httpx

from . import page_inspect
from .credentials import auth_for, build_auth_map
from .probe import (
    make_client, probe_follow, probe_follow_body, probe_no_follow, probe_no_follow_body,
)

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


def _match_caveat(score: float | None) -> str:
    """A warning when the matched new URL's path is far from the old one (a fuzzy best-match from
    Discover, e.g. /board-of-directors → /contact-us at 42%). "" when the match is good/unknown.
    `score` is the path-similarity % Discover set (None = domain-swap fallback, no similarity)."""
    if score is None or score >= 90:
        return ""
    if score >= 60:
        return f"path ใกล้เคียงเดิมแค่ {score}% (ไม่ตรงเป๊ะ) — เช็กว่าปลายทางถูกหน้าก่อนตั้ง redirect"
    return f"path ไม่ตรงกับเดิม (ใกล้เคียงแค่ {score}%) — น่าจะคนละหน้า เช็ก/แก้ปลายทางให้ถูกก่อนตั้ง redirect"


def _new_site_home(new_url: str) -> str | None:
    """Root of the new URL's origin — the conventional fallback target when the exact new URL
    has no page yet (the checklist note suggests redirecting to Home in that case)."""
    p = urlsplit(new_url.strip())
    if not p.scheme or not p.netloc:
        return None
    return urlunsplit((p.scheme, p.netloc, "/", "", ""))


async def _verify_row(nofollow, follow, r: MappingRow, deep: bool, auth_map: dict[str, httpx.BasicAuth],
                      ins_nofollow=None, ins_follow=None) -> RowVerdict:
    old = r.oldUrl.strip()
    new = r.newUrl.strip()
    # HTTP Basic Auth per side, when its host is behind a login (UAT etc.) — None for an open host.
    old_auth = auth_for(auth_map, old)
    new_auth = auth_for(auth_map, new)
    # bad-cert fallback client per side — ONLY for a host with no auth (never send creds over an
    # unverified TLS connection). None disables the fallback for that side.
    old_ins = ins_nofollow if old_auth is None else None
    new_ins = ins_follow if new_auth is None else None

    # deep = also pull the page HTML (one GET per side) so we can compare linked files + check the
    # body; otherwise the cheap status-only probe. The verdict (status/note) logic below is identical
    # either way — it only reads status codes + Location.
    old_status, old_loc, old_html, old_ssl = (None, None, None, False)
    if old:
        if deep:
            old_status, old_loc, old_html, old_ssl = await probe_no_follow_body(nofollow, old, old_auth, old_ins)
        else:
            old_status, old_loc, old_ssl = await probe_no_follow(nofollow, old, old_auth, old_ins)
    new_status, new_final, new_html, new_ssl = (None, None, None, False)
    if new:
        if deep:
            new_status, new_final, new_html, new_ssl = await probe_follow_body(follow, new, new_auth, new_ins)
        else:
            new_status, new_final, new_ssl = await probe_follow(follow, new, new_auth, new_ins)

    old_reachable = old_status is not None
    new_ok = new_status is not None and 200 <= new_status < 300
    new_blocked = new_status in _BLOCKED_CODES
    old_is_redirect = (old_status or 0) in _REDIRECT_CODES
    # resolve a possibly-relative Location (e.g. "/en/home") against the old URL before comparing
    old_target_abs = urljoin(old, old_loc) if old_loc else None
    already = bool(old_is_redirect and old_target_abs and new and _norm(old_target_abs) == _norm(new))

    # One detailed, human-readable note per case. The note must stand alone in the table + the Excel
    # export, so it spells out BOTH sides' state (HTTP status, which side is missing) in plain Thai.
    if not new:
        if not old:
            status, note, target = STATUS_SKIP, "แถวนี้ไม่มีทั้ง URL เดิมและ URL ใหม่", None
        elif r.candidates:
            # Discover found close matches but none was strong enough to auto-pick — point the user
            # at the candidate list instead of guessing a wrong target.
            best = r.matchScore if r.matchScore is not None else 0
            status, target = STATUS_PROBLEM, None
            note = (f"ยังไม่ได้เลือกปลายทาง — คู่ที่ใกล้สุดเหมือนเดิมแค่ {best}% (น่าจะคนละหน้า) "
                    f"มี {len(r.candidates)} ตัวเลือกใกล้เคียง เปิด 'รายละเอียด' แล้วเลือกปลายทางที่ถูก")
        else:
            status, note, target = STATUS_PROBLEM, "มีแต่ URL เดิม ยังไม่ได้ระบุ URL ใหม่ปลายทาง — ต้องเลือกปลายทางก่อนตั้ง redirect", None
    elif new_ok:
        if already:
            status, note, target = STATUS_DONE, f"ตั้ง redirect ถูกต้องแล้ว — URL เดิมตอบ {old_status} เด้งไป URL ใหม่เรียบร้อย", None
        elif not old:
            # new-only: a page that exists on the NEW site with no old URL mapped to it (shown for
            # completeness — every URL from both sites appears). Nothing to redirect FROM.
            status, note, target = STATUS_SKIP, f"URL ใหม่ใช้งานได้ (สถานะ {new_status}) แต่ไม่มี URL เดิมจับคู่มาหน้านี้ — เป็นหน้าที่มีเฉพาะบนเว็บใหม่ จึงไม่ต้องทำ redirect", None
        elif not old_reachable:
            status, note, target = STATUS_SKIP, f"URL ใหม่ใช้งานได้ (สถานะ {new_status}) แต่ URL เดิมเข้าถึงไม่ได้ — อาจปิดไปแล้ว ตรวจว่ายังต้อง redirect ไหม", None
        else:
            # the new URL works — but if Discover only fuzzy-matched it (low path similarity), the
            # target is probably the WRONG page. Don't say "ready"; tell the user to check the target.
            mc = _match_caveat(r.matchScore)
            if mc:
                note = f"URL ใหม่เปิดได้ (สถานะ {new_status}) แต่ {mc}"
            else:
                note = f"พร้อมตั้ง redirect — URL ใหม่ใช้งานได้ (สถานะ {new_status})"
            if old_is_redirect and old_target_abs:
                note += f" · ตอนนี้ URL เดิมเด้งไปที่ {old_target_abs} (ยังไม่ใช่ URL ใหม่)"
            status, target = STATUS_PENDING, None
    elif new_blocked:
        # server answered but blocked our probe (WAF/bot block) — the page likely loads in a real
        # browser, so DON'T call it missing. Leave it pending for a human to confirm via the link.
        # 401 is special: the site wants HTTP Basic Auth — point the user at the Login section.
        status = STATUS_PENDING
        if new_status == 401 and new_auth is None:
            note = "URL ใหม่ตอบ 401 (ต้องล็อกอิน) — ใส่ username/password ของเว็บนี้ที่หัวข้อ 'เว็บที่ต้องล็อกอิน' แล้วตรวจใหม่"
        elif new_status == 401:
            note = "URL ใหม่ตอบ 401 (ต้องล็อกอิน) — username/password (Basic Auth) ที่ใส่อาจไม่ถูกต้อง"
        else:
            note = f"URL ใหม่ตอบ {new_status} — น่าจะโดน WAF/bot block (หน้าจริงในเบราว์เซอร์น่าจะใช้ได้) เปิดลิงก์ยืนยันเอง"
        target = None
    else:
        home = _new_site_home(new)
        code = new_status if new_status is not None else "เข้าถึงไม่ได้"
        note = f"URL ใหม่ยังไม่พร้อมใช้งาน (สถานะ {code})"
        if home:
            note += f" — เสนอให้ redirect ไปหน้าแรกแทนก่อน: {home}"
        status, target = STATUS_PROBLEM, home

    # --- deep check: compare files linked on each page + flag a thin (H1-only) body ---------
    deep_fields: dict = {}
    if deep:
        # File comparison needs BOTH pages. With one side missing (e.g. newUrl left blank because no
        # match was strong enough), there is nothing to compare — don't report the old page's files
        # as "missing on new" (there's no new page yet).
        if old and new:
            old_files = page_inspect.extract_files(old_html, old)
            new_files = page_inspect.extract_files(new_html, new_final or new)
            old_names, new_names = set(old_files), set(new_files)
            matched = sorted(old_names & new_names)
            only_old = sorted(old_names - new_names)
            only_new = sorted(new_names - old_names)
            files_same = (old_names == new_names) if (old_names or new_names) else None
            old_fc, new_fc = len(old_files), len(new_files)
        else:
            matched, only_old, only_new, files_same, old_fc, new_fc = [], [], [], None, 0, 0
        old_body = page_inspect.body_signal(old_html)
        new_body = page_inspect.body_signal(new_html)
        deep_fields = dict(
            oldFileCount=old_fc, newFileCount=new_fc,
            filesMatched=matched, filesOnlyOld=only_old, filesOnlyNew=only_new, filesSame=files_same,
            oldHasH1=old_body.has_h1, newHasH1=new_body.has_h1,
            oldBodyThin=old_body.thin, newBodyThin=new_body.thin,
            oldHasBody=old_body.has_body, newHasBody=new_body.has_body,
            oldError=old_body.error, newError=new_body.error,
            oldSpa=old_body.spa, newSpa=new_body.spa,
            bodyChecked=True,
        )
        # Content-aware override: a NEW page that returned 200 but whose body is an error/maintenance
        # screen ("Internal Server Error", etc.) is NOT a good landing page — flag it as a problem so
        # the status code can't hide it. (Only override an otherwise-"fine" verdict.)
        if new and new_body.error and status in (STATUS_PENDING, STATUS_DONE):
            status = STATUS_PROBLEM
            note = f"URL ใหม่ตอบ {new_status} แต่เนื้อหาเป็นหน้า error ({new_body.error}) — หน้าจริงใช้งานไม่ได้"
            target = target or _new_site_home(new)

        # Append content caveats so the note reads as one clear line: a migrated-but-empty new page
        # or a mismatched downloadable-file set is worth flagging even when the status is otherwise OK.
        caveats: list[str] = []
        if new and new_body.spa:
            # browser-only (WAF/bot-wall or JS-rendered): our server-side probe can't see the real
            # body/files, so DON'T claim the page is empty or its files differ — confirm in a browser.
            caveats.append("เว็บใหม่กันบอต (WAF) หรือเป็น JS-render — ระบบอ่านเนื้อหา/ไฟล์อัตโนมัติไม่ได้ เปิดลิงก์ยืนยันเอง")
        elif new and new_body.thin and not new_body.error:
            caveats.append("หน้าใหม่มีแค่หัวข้อ (H1) แทบไม่มีเนื้อหา — อาจย้ายข้อมูลไม่ครบ")
        # file mismatch only makes sense when BOTH pages exist AND neither is a SPA (a SPA's links
        # are injected by JS, so a server-side file list is unreliable — skip the comparison).
        if old and new and files_same is False and not (old_body.spa or new_body.spa):
            bits = []
            if only_old:
                bits.append(f"หายบนใหม่ {len(only_old)}")
            if only_new:
                bits.append(f"เพิ่มบนใหม่ {len(only_new)}")
            caveats.append("ไฟล์ดาวน์โหลดไม่ตรงกัน" + (f" ({', '.join(bits)})" if bits else ""))
        if caveats:
            note = f"{note} · " + " · ".join(caveats)

    # Collision: this new URL is the fuzzy best-match for more than one old URL (Discover flagged it)
    # — likely a forced match, so warn even when the page itself is fine.
    if r.collision and new:
        note = f"{note} · ⚠ ปลายทางนี้ซ้ำกับแถวอื่น (URL ใหม่เดียวกันถูกจับคู่หลาย URL เดิม — เช็กว่าตรงหน้า)"

    # A side reached only by dropping TLS verification = an incomplete cert chain on that server
    # (common after a migration). The page IS reachable, but flag the weak TLS so it's not silent.
    if old_ssl or new_ssl:
        which = "ใหม่" if new_ssl and not old_ssl else ("เดิม" if old_ssl and not new_ssl else "เดิม+ใหม่")
        note = f"{note} · ⚠ SSL cert ฝั่ง{which}ไม่สมบูรณ์ — ตรวจแบบไม่ verify TLS (เปิดใน browser ได้ปกติ แต่ควรแจ้งให้แก้ cert)"

    return RowVerdict(
        symbol=r.symbol, oldUrl=old, newUrl=new,
        oldStatus=old_status, oldRedirectsTo=old_target_abs, oldReachable=old_reachable,
        newStatus=new_status, newFinalUrl=new_final, newOk=new_ok,
        alreadyRedirected=already, suggestedStatus=status, suggestedNote=note, suggestedTarget=target,
        **deep_fields,
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
    auth_map = build_auth_map(payload.credentials)   # host -> BasicAuth, for sites behind a login

    verify_tls = settings.redirect_ssl_verify
    nofollow = make_client(follow_redirects=False, verify=verify_tls)
    follow = make_client(follow_redirects=True, verify=verify_tls)
    # no-verify fallback clients, built only when TLS verification is ON (when it's off the primary
    # clients already skip verification, so no fallback is needed). Reused across rows.
    ins_nofollow = make_client(follow_redirects=False, verify=False) if verify_tls else None
    ins_follow = make_client(follow_redirects=True, verify=False) if verify_tls else None

    async def one(r: MappingRow) -> RowVerdict:
        async with sem:
            return await _verify_row(nofollow, follow, r, payload.deepCheck, auth_map, ins_nofollow, ins_follow)

    clients = [c for c in (nofollow, follow, ins_nofollow, ins_follow) if c is not None]
    try:
        results = list(await asyncio.gather(*(one(r) for r in rows)))
    finally:
        await asyncio.gather(*(c.aclose() for c in clients))

    return VerifyOut(results=results, generatedAt=datetime.now(timezone.utc))
