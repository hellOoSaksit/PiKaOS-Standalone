"""Unit tests for verify_service — the per-row verdict logic (status/note/fallback) plus the
deep-check merge (file compare, thin body, soft-error override) and Basic-Auth wiring.

The network probes are monkeypatched so these stay pure and fast: we feed each row the exact
(status, Location, html) a real probe would return and assert the verdict. page_inspect runs for
real on the supplied HTML — so this also pins the verify ↔ page_inspect integration.
"""
import asyncio

import httpx

from app.schemas import (
    STATUS_DONE, STATUS_PENDING, STATUS_PROBLEM, STATUS_SKIP,
    Credential, MappingRow, MatchCandidate, VerifyIn,
)
from app.services import verify_service
from app.services.credentials import build_auth_map

_CONTENT = "Real company content that fills the page well past the threshold. " * 4
GOOD_BODY = f"<html><body><h1>About</h1><p>{_CONTENT}</p></body></html>"


def _run(coro):
    return asyncio.run(coro)


def _patch(monkeypatch, *, old=None, new=None, old_shallow=None, new_shallow=None, capture=None):
    """Replace the four probe functions in verify_service with canned returns. Each probe now also
    returns an ssl_insecure flag (appended as False here). `capture` records the `auth` passed to
    the new-side deep probe, for the credential-wiring test."""
    async def f_old_body(client, url, auth=None, insecure=None):
        return (*old, False)

    async def f_new_body(client, url, auth=None, insecure=None):
        if capture is not None:
            capture["new_auth"] = auth
        return (*new, False)

    async def f_old(client, url, auth=None, insecure=None):
        return (*old_shallow, False)

    async def f_new(client, url, auth=None, insecure=None):
        return (*new_shallow, False)

    monkeypatch.setattr(verify_service, "probe_no_follow_body", f_old_body)
    monkeypatch.setattr(verify_service, "probe_follow_body", f_new_body)
    monkeypatch.setattr(verify_service, "probe_no_follow", f_old)
    monkeypatch.setattr(verify_service, "probe_follow", f_new)


def _verdict(monkeypatch, row, *, deep=True, auth_map=None, **probes):
    _patch(monkeypatch, **probes)
    return _run(verify_service._verify_row(None, None, row, deep, auth_map or {}))


def _row(old="https://old.example.com/a", new="https://new.example.com/a", **kw):
    return MappingRow(symbol="WHA", oldUrl=old, newUrl=new, **kw)


# --- core verdict ------------------------------------------------------------

def test_old_already_301s_to_new_is_done(monkeypatch):
    v = _verdict(
        monkeypatch, _row(),
        old=(301, "https://new.example.com/a", None),
        new=(200, "https://new.example.com/a", GOOD_BODY),
    )
    assert v.alreadyRedirected is True
    assert v.suggestedStatus == STATUS_DONE


def test_new_works_and_old_reachable_is_pending(monkeypatch):
    v = _verdict(
        monkeypatch, _row(),
        old=(200, None, GOOD_BODY),
        new=(200, "https://new.example.com/a", GOOD_BODY),
    )
    assert v.suggestedStatus == STATUS_PENDING
    assert "พร้อมตั้ง redirect" in v.suggestedNote
    assert v.bodyChecked is True


def test_low_match_score_warns_target_may_be_wrong(monkeypatch):
    v = _verdict(
        monkeypatch, _row(matchScore=42),
        old=(200, None, GOOD_BODY),
        new=(200, "https://new.example.com/a", GOOD_BODY),
    )
    assert v.suggestedStatus == STATUS_PENDING
    assert "path ไม่ตรงกับเดิม" in v.suggestedNote


def test_new_404_is_problem_with_home_fallback(monkeypatch):
    v = _verdict(
        monkeypatch, _row(),
        old=(200, None, GOOD_BODY),
        new=(404, "https://new.example.com/a", None),
    )
    assert v.suggestedStatus == STATUS_PROBLEM
    assert v.suggestedTarget == "https://new.example.com/"


def test_new_401_without_creds_points_to_login_section(monkeypatch):
    v = _verdict(
        monkeypatch, _row(),
        old=(200, None, GOOD_BODY),
        new=(401, "https://new.example.com/a", None),
    )
    assert v.suggestedStatus == STATUS_PENDING
    assert "ใส่ username/password" in v.suggestedNote


def test_no_old_no_new_is_skip(monkeypatch):
    v = _verdict(monkeypatch, _row(old="", new=""))
    assert v.suggestedStatus == STATUS_SKIP


def test_new_only_no_old_is_skip(monkeypatch):
    v = _verdict(
        monkeypatch, _row(old=""),
        new=(200, "https://new.example.com/a", GOOD_BODY),
    )
    assert v.suggestedStatus == STATUS_SKIP
    assert "เฉพาะบนเว็บใหม่" in v.suggestedNote


def test_blank_new_with_candidates_points_to_picker(monkeypatch):
    """A too-weak fuzzy match leaves newUrl blank — verify must tell the user to pick from candidates,
    not silently pass it as 'ready'."""
    cands = [MatchCandidate(url="https://new.example.com/a", score=42.0),
             MatchCandidate(url="https://new.example.com/b", score=38.0)]
    v = _verdict(
        monkeypatch, _row(new="", matchScore=42.0, candidates=cands),
        old=(200, None, GOOD_BODY),
    )
    assert v.suggestedStatus == STATUS_PROBLEM
    assert "ตัวเลือก" in v.suggestedNote


def test_blank_new_does_not_report_file_diff(monkeypatch):
    """Old page has files but newUrl is blank → nothing to compare, so no 'missing on new'."""
    old_html = f'<html><body><h1>X</h1><p>{_CONTENT}</p><a href="/a.pdf">a</a><a href="/b.pdf">b</a></body></html>'
    cands = [MatchCandidate(url="https://new.example.com/a", score=55.0)]
    v = _verdict(monkeypatch, _row(new="", matchScore=55.0, candidates=cands), old=(200, None, old_html))
    assert v.filesSame is None
    assert v.filesOnlyOld == []
    assert v.oldFileCount == 0
    assert "ไฟล์ดาวน์โหลดไม่ตรงกัน" not in v.suggestedNote


def test_collision_adds_caveat(monkeypatch):
    v = _verdict(
        monkeypatch, _row(collision=True),
        old=(200, None, GOOD_BODY),
        new=(200, "https://new.example.com/a", GOOD_BODY),
    )
    assert "ซ้ำ" in v.suggestedNote


def test_old_only_no_new_is_problem(monkeypatch):
    v = _verdict(
        monkeypatch, _row(new=""),
        old=(200, None, GOOD_BODY),
    )
    assert v.suggestedStatus == STATUS_PROBLEM
    assert "ยังไม่ได้ระบุ URL ใหม่" in v.suggestedNote


# --- deep check: body + files ------------------------------------------------

def test_soft_error_body_overrides_200_to_problem(monkeypatch):
    error_body = "<html><body><h1>Error</h1><p>Internal Server Error</p></body></html>"
    v = _verdict(
        monkeypatch, _row(),
        old=(200, None, GOOD_BODY),
        new=(200, "https://new.example.com/a", error_body),
    )
    assert v.newError == "500"
    assert v.suggestedStatus == STATUS_PROBLEM
    assert "หน้า error" in v.suggestedNote


def test_thin_new_body_adds_caveat_but_stays_pending(monkeypatch):
    thin_body = "<html><body><h1>About Us</h1></body></html>"
    v = _verdict(
        monkeypatch, _row(),
        old=(200, None, GOOD_BODY),
        new=(200, "https://new.example.com/a", thin_body),
    )
    assert v.newBodyThin is True
    assert v.suggestedStatus == STATUS_PENDING
    assert "มีแค่หัวข้อ" in v.suggestedNote


def test_file_mismatch_adds_caveat_and_lists_diff(monkeypatch):
    old_html = f'<html><body><h1>About</h1><p>{_CONTENT}</p><a href="/docs/a.pdf">a</a></body></html>'
    new_html = f'<html><body><h1>About</h1><p>{_CONTENT}</p><a href="/docs/b.pdf">b</a></body></html>'
    v = _verdict(
        monkeypatch, _row(),
        old=(200, None, old_html),
        new=(200, "https://new.example.com/a", new_html),
    )
    assert v.filesSame is False
    assert v.filesOnlyOld == ["a.pdf"]
    assert v.filesOnlyNew == ["b.pdf"]
    assert "ไฟล์ดาวน์โหลดไม่ตรงกัน" in v.suggestedNote


_SPA_HTML = '<html><body><div id="root"></div><script src="/assets/main.js"></script></body></html>'


def test_spa_new_page_reports_js_render_not_empty(monkeypatch):
    v = _verdict(
        monkeypatch, _row(),
        old=(200, None, GOOD_BODY),
        new=(200, "https://new.example.com/a", _SPA_HTML),
    )
    assert v.newSpa is True
    assert v.newBodyThin is False
    assert v.suggestedStatus == STATUS_PENDING
    assert "JS-render" in v.suggestedNote


def test_spa_new_page_skips_file_mismatch_caveat(monkeypatch):
    old_html = f'<html><body><h1>About</h1><p>{_CONTENT}</p><a href="/docs/a.pdf">a</a></body></html>'
    v = _verdict(
        monkeypatch, _row(),
        old=(200, None, old_html),
        new=(200, "https://new.example.com/a", _SPA_HTML),
    )
    assert v.newSpa is True
    assert "ไฟล์ดาวน์โหลดไม่ตรงกัน" not in v.suggestedNote


def test_deep_false_skips_body_and_file_check(monkeypatch):
    v = _verdict(
        monkeypatch, _row(), deep=False,
        old_shallow=(200, None),
        new_shallow=(200, "https://new.example.com/a"),
    )
    assert v.bodyChecked is False
    assert v.oldFileCount == 0 and v.newFileCount == 0
    assert v.suggestedStatus == STATUS_PENDING


# --- auth wiring -------------------------------------------------------------

def test_credentials_are_matched_by_host_and_passed_to_probe(monkeypatch):
    capture: dict = {}
    auth_map = build_auth_map([Credential(host="new.example.com", username="u", password="p")])
    _patch(
        monkeypatch,
        old=(200, None, GOOD_BODY),
        new=(200, "https://new.example.com/a", GOOD_BODY),
        capture=capture,
    )
    _run(verify_service._verify_row(None, None, _row(), True, auth_map))
    assert isinstance(capture["new_auth"], httpx.BasicAuth)


# --- verify() batch ----------------------------------------------------------

def test_verify_runs_the_whole_batch(monkeypatch):
    _patch(
        monkeypatch,
        old=(200, None, GOOD_BODY),
        new=(200, "https://new.example.com/a", GOOD_BODY),
    )
    payload = VerifyIn(rows=[
        _row(old="https://old.example.com/a", new="https://new.example.com/a"),
        _row(old="https://old.example.com/b", new="https://new.example.com/b"),
    ])
    out = _run(verify_service.verify(payload))
    assert len(out.results) == 2
    assert out.generatedAt is not None
    assert all(r.bodyChecked for r in out.results)
