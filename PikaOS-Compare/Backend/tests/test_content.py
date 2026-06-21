"""Unit tests for content.extract / content.embeddable — the pure, network-free HTML extraction
that drives Compare's deep page diff.

`extract()` is what turns a page into the comparable fields (title/h1/meta/body/blocks/headings/
images/links/docs); `embeddable()` reads framing headers. Both are pure → the highest-value thing
to pin without a live server. (Network lives only in `fetch_page`, which isn't tested here.)
"""
from app.services import content

BASE = "https://prod.example.com/page"


def test_extract_title_h1_and_meta():
    data = content.extract(
        '<title>Home</title><h1>Welcome</h1>'
        '<meta name="description" content="A site"><p>Body paragraph one.</p>',
        BASE,
    )
    assert data["title"] == "Home"
    assert data["h1"] == "Welcome"
    assert data["meta"]["description"] == "A site"


def test_extract_excludes_chrome_from_body():
    """nav/header/footer text is page chrome — must NOT count as body content (it dominated the diff)."""
    data = content.extract(
        "<nav>Home Products Contact</nav><footer>Copyright</footer>"
        "<p>The real article content lives here.</p>",
        BASE,
    )
    assert "The real article content lives here." in data["text"]
    assert "Products" not in data["text"]
    assert "Copyright" not in data["text"]


def test_extract_blocks_and_heading_outline():
    data = content.extract("<h2>Section A</h2><p>Para one.</p><p>Para two.</p>", BASE)
    assert "Para one." in data["blocks"]
    assert "Para two." in data["blocks"]
    assert {"level": 2, "text": "Section A"} in data["headings"]


def test_extract_resolves_images_absolute():
    data = content.extract('<img src="/img/logo.png">', BASE)
    assert "https://prod.example.com/img/logo.png" in data["images"]


def test_extract_internal_links_vs_external_vs_docs():
    data = content.extract(
        '<a href="/about">about</a>'              # same host → internal link
        '<a href="https://other.com/x">ext</a>'   # different host → dropped
        '<a href="/files/report.pdf">pdf</a>',    # document → docs, by filename
        BASE,
    )
    assert "https://prod.example.com/about" in data["links"]
    assert all("other.com" not in u for u in data["links"])
    assert any(d["name"] == "report.pdf" for d in data["docs"])


def test_embeddable_reads_framing_headers():
    assert content.embeddable({"x-frame-options": "DENY"}) is False
    assert content.embeddable({"x-frame-options": "SAMEORIGIN"}) is False
    assert content.embeddable({"content-security-policy": "frame-ancestors 'none'"}) is False
    assert content.embeddable({}) is True            # no framing restriction → embeddable
