"""Unit tests for credentials — the per-host HTTP Basic Auth mapping that lets verify/discover
probe UAT/staging sites behind a "Sign in" dialog.

Pure: no network, no server. Host matching + the skip/dedupe rules are the whole contract, so
they're what we pin here.
"""
import httpx

from app.schemas import Credential
from app.services import credentials


def _cred(host="", username="u", password="p"):
    return Credential(host=host, username=username, password=password)


# --- build_auth_map ----------------------------------------------------------

def test_build_auth_map_skips_entries_with_no_host_or_no_username():
    out = credentials.build_auth_map([
        _cred(host="", username="u"),          # no host
        _cred(host="h.example.com", username=""),  # no username
    ])
    assert out == {}


def test_build_auth_map_keys_by_lowercased_host_from_bare_or_url():
    out = credentials.build_auth_map([
        _cred(host="Site.UAT.Example.com"),                 # bare host, mixed case
        _cred(host="https://Other.Example.com/some/path"),  # full URL — only its host is used
        _cred(host="with.port.example.com:8443"),           # port is dropped
    ])
    assert set(out) == {"site.uat.example.com", "other.example.com", "with.port.example.com"}


def test_build_auth_map_allows_blank_password():
    """Some Basic Auth setups use a username with an empty password — keep them."""
    out = credentials.build_auth_map([_cred(host="h.example.com", username="u", password="")])
    assert "h.example.com" in out
    assert isinstance(out["h.example.com"], httpx.BasicAuth)


def test_build_auth_map_later_duplicate_host_wins():
    out = credentials.build_auth_map([
        _cred(host="h.example.com", username="first", password="p1"),
        _cred(host="h.example.com", username="second", password="p2"),
    ])
    assert len(out) == 1
    assert out["h.example.com"]._auth_header == httpx.BasicAuth("second", "p2")._auth_header


def test_build_auth_map_handles_none():
    assert credentials.build_auth_map(None) == {}


# --- auth_for ----------------------------------------------------------------

def test_auth_for_matches_url_host_case_insensitively():
    amap = credentials.build_auth_map([_cred(host="h.example.com")])
    assert credentials.auth_for(amap, "https://H.Example.com/a/b?x=1") is amap["h.example.com"]


def test_auth_for_returns_none_for_unmatched_or_empty_map():
    amap = credentials.build_auth_map([_cred(host="h.example.com")])
    assert credentials.auth_for(amap, "https://other.example.com/") is None
    assert credentials.auth_for({}, "https://h.example.com/") is None
