"""Unit tests for webconfig — the pure rows → IIS URL-Rewrite web.config transform.

This is the tool's core *output* (the file customers actually deploy), and it's a pure string
transform with no network/state — so it's both high-value and trivially testable.
"""
from app.schemas import MappingRow, WebConfigIn
from app.services import webconfig


def _gen(rows, **kw):
    return webconfig.generate(WebConfigIn(rows=rows, **kw))


def test_one_rule_per_valid_row():
    out = _gen([
        MappingRow(symbol="WHA", oldUrl="https://old.example.com/a", newUrl="https://new.example.com/a"),
        MappingRow(symbol="WHA", oldUrl="https://old.example.com/b", newUrl="https://new.example.com/b"),
    ])
    assert out.ruleCount == 2
    assert out.skipped == []
    assert "https://new.example.com/a" in out.xml
    assert out.xml.count("<rule ") == 2


def test_row_missing_a_url_is_skipped_not_a_rule():
    out = _gen([
        MappingRow(symbol="WHA", oldUrl="https://old.example.com/a", newUrl=""),
        MappingRow(symbol="WHA", oldUrl="https://old.example.com/b", newUrl="https://new.example.com/b"),
    ])
    assert out.ruleCount == 1
    assert len(out.skipped) == 1


def test_match_trailing_slash_toggles_the_pattern():
    row = [MappingRow(oldUrl="https://old.example.com/products", newUrl="https://new.example.com/p")]
    assert "products/?$" in _gen(row, matchTrailingSlash=True).xml
    assert "products$" in _gen(row, matchTrailingSlash=False).xml


def test_invalid_redirect_type_falls_back_to_permanent():
    out = _gen([MappingRow(oldUrl="https://o.example.com/a", newUrl="https://n.example.com/a")],
               redirectType="Bogus")
    assert 'redirectType="Permanent"' in out.xml


def test_root_path_uses_empty_anchor_pattern():
    out = _gen([MappingRow(oldUrl="https://old.example.com/", newUrl="https://new.example.com/")])
    assert r'url="^$"' in out.xml          # IIS strips the leading slash → root matches ^$


def test_special_chars_in_values_are_xml_escaped():
    out = _gen([MappingRow(symbol="A&B", oldUrl="https://o.example.com/x",
                           newUrl="https://n.example.com/x?a=1&b=2")])
    assert "&amp;" in out.xml               # the & in the new URL / symbol is escaped
    assert "a=1&b=2" not in out.xml          # raw unescaped ampersand must not appear


def test_append_query_string_flag_is_emitted():
    rows = [MappingRow(oldUrl="https://o.example.com/a", newUrl="https://n.example.com/a")]
    assert 'appendQueryString="true"' in _gen(rows, appendQueryString=True).xml
    assert 'appendQueryString="false"' in _gen(rows, appendQueryString=False).xml
