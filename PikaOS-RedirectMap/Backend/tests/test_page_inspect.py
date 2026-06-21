"""Unit tests for page_inspect — the pure, network-free HTML inspection that drives verify's
deep check (soft-error detection, thin-body detection, document-link extraction).

These are the detection rules that decide a row's verdict, so they're the highest-value thing to
pin: no DB, no network, no server needed — just HTML in, signal out.
"""
from app.config import settings
from app.services import page_inspect

MIN = settings.redirect_body_min_chars  # the has-body / thin threshold (default 40)


# --- body_signal -------------------------------------------------------------

def test_body_signal_empty_html_is_all_false():
    sig = page_inspect.body_signal("")
    assert sig.has_h1 is False
    assert sig.has_body is False
    assert sig.thin is False
    assert sig.error == ""


def test_body_signal_h1_only_is_thin():
    """An <h1> with almost nothing else = an incomplete-migration stub → thin, not has_body."""
    sig = page_inspect.body_signal("<html><body><h1>About Us</h1></body></html>")
    assert sig.has_h1 is True
    assert sig.thin is True
    assert sig.has_body is False


def test_body_signal_real_content_has_body_not_thin():
    body = "<h1>About</h1><p>" + ("Real content about the company. " * 5) + "</p>"
    sig = page_inspect.body_signal(f"<html><body>{body}</body></html>")
    assert sig.has_body is True
    assert sig.thin is False
    assert sig.error == ""


def test_body_signal_chrome_is_not_counted_as_content():
    """Nav/footer/script text is page chrome — stripped before measuring the body, so a page that is
    only chrome reads as empty, not as content."""
    chrome = "<nav>" + ("Home Products Contact " * 10) + "</nav><footer>(c) 2026 lots of footer</footer>"
    sig = page_inspect.body_signal(f"<html><body>{chrome}<h1>Hi</h1></body></html>")
    assert sig.has_body is False
    assert sig.thin is True


def test_body_signal_detects_soft_error_in_200_body():
    """A page can answer 200 whose body is an error screen — body_signal must surface the label."""
    html = "<html><body><h1>Error</h1><p>Internal Server Error</p></body></html>"
    assert page_inspect.body_signal(html).error == "500"


def test_body_signal_error_only_scans_the_top():
    """'page not found' buried deep in real content must NOT trip the error flag (bounded to ~800 chars)."""
    filler = "Welcome to our site. " * 60  # > 800 chars before the phrase
    html = f"<html><body><p>{filler} the page not found message is down here</p></body></html>"
    assert page_inspect.body_signal(html).error == ""


# --- SPA detection (JS-rendered shell) ---------------------------------------

def test_body_signal_spa_shell_is_js_render_not_thin():
    """A client-rendered shell (empty mount node + script) must read as SPA, not empty/thin —
    our server-side probe can't see the JS-injected content."""
    html = '<html><body><div id="root"></div><script src="/assets/app.bundle.js"></script></body></html>'
    sig = page_inspect.body_signal(html)
    assert sig.spa is True
    assert sig.has_body is False
    assert sig.thin is False          # a SPA shell is not a genuine H1-only stub


def test_body_signal_waf_challenge_is_browser_only():
    """An AWS-WAF CAPTCHA interstitial returned with 200 (what the WHA new site serves a probe) must
    read as browser-only, not empty — a real browser would get the actual page."""
    html = (
        '<html><body><div id="captcha-container"></div>'
        '<script>AwsWafIntegration.saveReferrer(); CaptchaScript.renderCaptcha();</script>'
        '<noscript><h1>JavaScript is disabled</h1> verify that you\'re not a robot</noscript>'
        '</body></html>'
    )
    sig = page_inspect.body_signal(html)
    assert sig.spa is True
    assert sig.has_body is False
    assert sig.thin is False


def test_body_signal_empty_without_mount_is_not_spa():
    sig = page_inspect.body_signal("<html><body></body></html>")
    assert sig.spa is False


def test_body_signal_error_beats_spa():
    """A SPA host whose visible body is an error screen must surface the error, not 'JS-render'."""
    html = '<html><body><div id="root">Internal Server Error</div><script src="/a.js"></script></body></html>'
    sig = page_inspect.body_signal(html)
    assert sig.error == "500"
    assert sig.spa is False


def test_body_signal_real_content_is_not_spa_even_with_mount():
    html = f'<html><body><div id="root"><p>{("Lots of real content here. " * 6)}</p></div></body></html>'
    sig = page_inspect.body_signal(html)
    assert sig.has_body is True
    assert sig.spa is False


# --- extract_files -----------------------------------------------------------

def test_extract_files_finds_docs_by_filename_absolute():
    html = '<a href="/docs/report.pdf">report</a> <a href="files/form.docx">form</a>'
    files = page_inspect.extract_files(html, "https://old.example.com/page")
    assert files["report.pdf"] == "https://old.example.com/docs/report.pdf"
    assert files["form.docx"] == "https://old.example.com/files/form.docx"


def test_extract_files_ignores_non_documents_and_dedupes():
    html = (
        '<a href="/a.pdf">1</a><a href="/sub/a.pdf">dup-name</a>'
        '<a href="/page.html">page</a><img src="/logo.png">'
    )
    files = page_inspect.extract_files(html, "https://old.example.com/")
    assert "page.html" not in files
    assert "logo.png" not in files
    assert list(files.keys()) == ["a.pdf"]          # non-docs skipped; first link wins per filename


def test_extract_files_empty_html_is_empty():
    assert page_inspect.extract_files(None, "https://x.example.com/") == {}
