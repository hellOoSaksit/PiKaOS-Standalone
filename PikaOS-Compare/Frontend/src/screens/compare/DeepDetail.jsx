/* For human — the expanded deep-diff view for one page pair: DIFFERENCES ONLY (SEO/meta, body
   word/block diff with jump-to-live-text, heading outline, broken/missing assets, doc-by-name gaps,
   technical stats). Identical pages collapse to one line. Pure presentation, driven by a DeepResult
   (`d`); a rendered side-by-side preview was deliberately removed — it can't faithfully show
   JS+API-driven SPAs, so we link out to the real pages instead. */
import React from 'react';
import { blockDiff, decodeUrl, textFragmentUrl, wordDiff } from './helpers.js';

export function DeepDetail({ d, srcUrl, tgtUrl, srcShort, tgtShort, t }) {
  if (d.deepState === "unfetchable") return (
    <div className="col" style={{ gap: 8 }}>
      <div className="mono" style={{ color: "var(--crimson)", fontSize: 12.5 }}>⚠ {t("compare.deep.unfetchable")}</div>
      {/* which side failed + why (status / type / exception) */}
      {d.srcReason && <div className="mono" style={{ fontSize: 11, color: "var(--crimson)" }}>{srcShort}: {d.srcReason}</div>}
      {d.tgtReason && <div className="mono" style={{ fontSize: 11, color: "var(--crimson)" }}>{tgtShort}: {d.tgtReason}</div>}
      {/* no per-side reason → the whole batch request failed (slow site / network); guide to per-row deep */}
      {!d.srcReason && !d.tgtReason && <div className="qei-note" style={{ fontSize: 11 }}>{t("compare.deep.unfetchableHint")}</div>}
      <div className="row" style={{ gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <span className="qei-note" style={{ fontSize: 11 }}>{t("compare.deep.openReal")}</span>
        <a className="cmp-link mono" href={srcUrl} target="_blank" rel="noreferrer">{srcShort} ↗</a>
        <a className="cmp-link mono" href={tgtUrl} target="_blank" rel="noreferrer">{tgtShort} ↗</a>
      </div>
    </div>
  );
  // column heads spell out BOTH the side (PROD/UAT) and the host, so it's never ambiguous
  // which column is which site (e.g. "PROD · www.ratch.co.th").
  const hostName = (u) => { try { return new URL(u).host.replace(/^www\./, ""); } catch (e) { return ""; } };
  const srcHead = [srcShort, hostName(srcUrl)].filter(Boolean).join(" · ");
  const tgtHead = [tgtShort, hostName(tgtUrl)].filter(Boolean).join(" · ");
  const m = (meta, k) => (meta && meta[k]) || "";
  // fields grouped by audience: Content (what readers see) vs SEO/meta (webmaster)
  const contentFields = [["H1", d.srcH1, d.tgtH1]];
  const seoFields = [
    ["Title", d.srcTitle, d.tgtTitle],
    ["description", m(d.srcMeta, "description"), m(d.tgtMeta, "description")],
    ["canonical", m(d.srcMeta, "canonical"), m(d.tgtMeta, "canonical")],
    ["og:title", m(d.srcMeta, "og:title"), m(d.tgtMeta, "og:title")],
    ["og:image", m(d.srcMeta, "og:image"), m(d.tgtMeta, "og:image")],
  ];
  // DIFFERENCES ONLY: a field/section appears only when the two sides actually differ.
  const differs = ([, s, g]) => (s || "") !== (g || "");
  const contentDiff = contentFields.filter(differs);
  const seoDiff = seoFields.filter(differs);
  const words = (d.srcText || "").split(/\s+/).length + (d.tgtText || "").split(/\s+/).length;
  const bodyDiffers = d.bodySim != null && d.bodySim < 1;
  // block-by-block aligned diff (menu/header/footer already stripped backend-side); falls back
  // to the flat word-diff only for legacy results that have no blocks.
  const bdiff = (d.srcBlocks?.length || d.tgtBlocks?.length) ? blockDiff(d.srcBlocks, d.tgtBlocks) : null;
  const diff = (!bdiff && bodyDiffers && d.srcText && d.tgtText && words <= 1400) ? wordDiff(d.srcText, d.tgtText) : null;
  const bodyPct = d.bodySim != null ? Math.round(d.bodySim * 100) + "%" : "—";
  const docsOnlySrc = d.docsOnlySrcUrls || [];
  const docsOnlyTgt = d.docsOnlyTgtUrls || [];
  // heading outline (H1–H6) aligned diff — reuse the block LCS over "H{level} text" strings.
  const fmtHead = (h) => `H${h.level} ${h.text}`;
  const headText = (s) => (s || "").replace(/^H\d+\s/, "");   // strip the level prefix for the jump fragment
  const srcHeads = d.srcHeadings || [], tgtHeads = d.tgtHeadings || [];
  const headRows = (srcHeads.length || tgtHeads.length) ? blockDiff(srcHeads.map(fmtHead), tgtHeads.map(fmtHead)) : null;
  const headingsDiffer = !!headRows && headRows.some(r => r.t === "chg");
  const anyDiff = contentDiff.length > 0 || seoDiff.length > 0 || bodyDiffers || headingsDiffer || d.imagesMissing > 0 || d.linksBroken > 0 || docsOnlySrc.length > 0 || docsOnlyTgt.length > 0;
  const chg = { background: "color-mix(in srgb, var(--gold) 16%, transparent)" };
  const cell = { padding: "6px 9px", verticalAlign: "top", borderTop: "1px solid var(--line-soft)", wordBreak: "break-word" };
  const yn = (e) => e === true ? "✓" : e === false ? "✕" : "—";
  const sect = (icon, title) => <div className="mono faint" style={{ fontSize: 11, marginBottom: 4 }}>{icon} {title}</div>;
  // a body block rendered as a deep-link into the LIVE page: clicking opens it scrolled to + highlighting
  // this exact text (native scroll-to-text-fragment). `url` is the side's real page (PROD/UAT).
  const jumpLink = (url, text, label) => text == null ? <span className="faint">—</span> : (
    <a className="cmp-jump" href={textFragmentUrl(url, text)} target="_blank" rel="noreferrer" title={t("compare.deep.jump")}>
      {label ?? text}<span className="cmp-jump-ic"> ↗</span>
    </a>
  );
  const fieldTable = (rows) => (
    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
      <thead><tr>
        <th style={{ ...cell, color: "var(--ink-3)", width: 120 }}>field</th>
        <th style={{ ...cell, color: "var(--ink-3)" }}>{srcHead}</th>
        <th style={{ ...cell, color: "var(--ink-3)" }}>{tgtHead}</th>
      </tr></thead>
      <tbody>
        {rows.map(([label, s, g]) => (
          <tr key={label}>
            <td style={{ ...cell, fontFamily: "var(--font-mono)", color: "var(--ink-2)", whiteSpace: "nowrap" }}>✕ {label}</td>
            <td style={{ ...cell, ...chg }}>{s || <span className="faint">—</span>}</td>
            <td style={{ ...cell, ...chg }}>{g || <span className="faint">—</span>}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
  // list EVERY broken/missing URL (backend caps at 20) so the webmaster/dev sees exactly
  // which asset — one clickable line each, in a soft box so a long list stays readable.
  const urlList = (urls) => {
    const list = urls || [];
    if (!list.length) return null;
    return (
      <div style={{ marginTop: 4, padding: "6px 8px", border: "1px solid var(--line-soft)", borderRadius: 6, background: "color-mix(in srgb, var(--ink) 3%, transparent)", display: "flex", flexDirection: "column", gap: 2 }}>
        {list.map((u, k) => (
          <a key={k} className="cmp-link mono" href={u} target="_blank" rel="noreferrer" style={{ display: "block", fontSize: 11 }}>{decodeUrl(u)} ↗</a>
        ))}
      </div>
    );
  };
  // like urlList but leads with the FILENAME (bold) — for downloadable docs, where the name is
  // what matters ("annual-report-2024.pdf") and the full URL is secondary.
  const baseName = (u) => { try { return decodeURIComponent(new URL(u).pathname.split("/").pop()) || u; } catch (e) { return u; } };
  const fileList = (urls) => {
    const list = urls || [];
    if (!list.length) return null;
    return (
      <div style={{ marginTop: 4, padding: "6px 8px", border: "1px solid var(--line-soft)", borderRadius: 6, background: "color-mix(in srgb, var(--ink) 3%, transparent)", display: "flex", flexDirection: "column", gap: 3 }}>
        {list.map((u, k) => (
          <div key={k} style={{ fontSize: 11, lineHeight: 1.4 }}>
            <b className="mono">📄 {baseName(u)}</b>{" "}
            <a className="cmp-link mono" href={u} target="_blank" rel="noreferrer">↗</a>
          </div>
        ))}
      </div>
    );
  };
  return (
    <div className="cmp-reveal" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {!anyDiff ? (
        <div className="mono" style={{ color: "var(--emerald)", fontSize: 12.5 }}>
          ✓ {t("compare.deep.noDiff")} · {t("compare.deep.bodySim")} {bodyPct}
        </div>
      ) : (
        <>
          {/* 🔍 SEO / Meta — webmaster first: title, description, canonical, og:* */}
          {seoDiff.length > 0 && (
            <div>
              {sect("🔍", t("compare.deep.catSeo"))}
              {fieldTable(seoDiff)}
            </div>
          )}

          {/* 📝 Content — headline + body text, SIDE-BY-SIDE so each side reads on its own:
              left = source (removed parts red), right = target (added parts green). */}
          {(contentDiff.length > 0 || bodyDiffers) && (
            <div>
              {sect("📝", t("compare.deep.catContent"))}
              {contentDiff.length > 0 && fieldTable(contentDiff)}
              {bodyDiffers && (
                <div style={{ marginTop: contentDiff.length > 0 ? 8 : 0 }}>
                  <div className="faint mono" style={{ fontSize: 11, marginBottom: 4 }}>{t("compare.deep.bodyDiff")} · {t("compare.deep.bodySim")}: {bodyPct} · Δ{d.wordDelta > 0 ? "+" : ""}{d.wordDelta ?? 0} · 🔗 {t("compare.deep.jumpHint")}</div>
                  {bdiff ? (
                    bdiff.some(r => r.t === "chg") ? (
                    <div style={{ border: "1px solid var(--line)", borderRadius: 8, overflow: "hidden", fontSize: 12.5 }}>
                      {/* column headers — never ambiguous which side is which */}
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 1, background: "var(--line)" }}>
                        <div className="mono faint" style={{ fontSize: 11, padding: "5px 8px", background: "var(--bg-1)" }}>🔴 {srcHead}</div>
                        <div className="mono faint" style={{ fontSize: 11, padding: "5px 8px", background: "var(--bg-1)" }}>🟢 {tgtHead}</div>
                      </div>
                      {bdiff.map((r, k) => r.t === "same" ? (
                        <div key={k} className="faint" style={{ padding: "5px 9px", borderTop: "1px solid var(--line-soft)", lineHeight: 1.6 }}>✓ {r.src}</div>
                      ) : (
                        <div key={k} style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 1, background: "var(--line-soft)", borderTop: "1px solid var(--line-soft)" }}>
                          <div style={{ padding: "6px 9px", lineHeight: 1.6, background: r.src != null ? "color-mix(in srgb,var(--crimson) 13%,transparent)" : "var(--bg-1)" }}>
                            {jumpLink(srcUrl, r.src)}
                          </div>
                          <div style={{ padding: "6px 9px", lineHeight: 1.6, background: r.tgt != null ? "color-mix(in srgb,var(--emerald) 13%,transparent)" : "var(--bg-1)" }}>
                            {jumpLink(tgtUrl, r.tgt)}
                          </div>
                        </div>
                      ))}
                    </div>
                    ) : <div className="faint" style={{ fontSize: 12 }}>✓ {t("compare.deep.blkSame")}</div>
                  ) : diff ? (
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, alignItems: "start" }}>
                      <div style={{ minWidth: 0 }}>
                        <div className="mono faint" style={{ fontSize: 11, marginBottom: 3 }}>🔴 {srcHead} <span style={{ opacity: .7 }}>({t("compare.deep.sideRemoved")})</span></div>
                        <div style={{ padding: 10, lineHeight: 1.8, border: "1px solid var(--line)", borderRadius: 8, fontSize: 12.5 }}>
                          {diff.filter(([type]) => type !== "add").map(([type, w], k) => type === "del"
                            ? <span key={k} style={{ background: "color-mix(in srgb,var(--crimson) 22%,transparent)" }}>{w} </span>
                            : <span key={k}>{w} </span>)}
                        </div>
                      </div>
                      <div style={{ minWidth: 0 }}>
                        <div className="mono faint" style={{ fontSize: 11, marginBottom: 3 }}>🟢 {tgtHead} <span style={{ opacity: .7 }}>({t("compare.deep.sideAdded")})</span></div>
                        <div style={{ padding: 10, lineHeight: 1.8, border: "1px solid var(--line)", borderRadius: 8, fontSize: 12.5 }}>
                          {diff.filter(([type]) => type !== "del").map(([type, w], k) => type === "add"
                            ? <span key={k} style={{ background: "color-mix(in srgb,var(--emerald) 22%,transparent)" }}>{w} </span>
                            : <span key={k}>{w} </span>)}
                        </div>
                      </div>
                    </div>
                  ) : <div className="faint" style={{ fontSize: 12 }}>{t("compare.deep.bodyTooBig")}</div>}
                </div>
              )}
            </div>
          )}

          {/* 📑 Headings / Outline — which H1–H6 was added/removed/reworded PROD↔UAT; each clickable
              to open + scroll to that heading on the live page (same block-LCS aligned view as body) */}
          {headingsDiffer && (
            <div>
              {sect("📑", t("compare.deep.catHeadings"))}
              <div style={{ border: "1px solid var(--line)", borderRadius: 8, overflow: "hidden", fontSize: 12.5 }}>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 1, background: "var(--line)" }}>
                  <div className="mono faint" style={{ fontSize: 11, padding: "5px 8px", background: "var(--bg-1)" }}>🔴 {srcHead}</div>
                  <div className="mono faint" style={{ fontSize: 11, padding: "5px 8px", background: "var(--bg-1)" }}>🟢 {tgtHead}</div>
                </div>
                {headRows.map((r, k) => r.t === "same" ? (
                  <div key={k} className="faint" style={{ padding: "5px 9px", borderTop: "1px solid var(--line-soft)", lineHeight: 1.6 }}>✓ {r.src}</div>
                ) : (
                  <div key={k} style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 1, background: "var(--line-soft)", borderTop: "1px solid var(--line-soft)" }}>
                    <div style={{ padding: "6px 9px", lineHeight: 1.6, background: r.src != null ? "color-mix(in srgb,var(--crimson) 13%,transparent)" : "var(--bg-1)" }}>
                      {r.src != null ? jumpLink(srcUrl, headText(r.src), r.src) : <span className="faint">—</span>}
                    </div>
                    <div style={{ padding: "6px 9px", lineHeight: 1.6, background: r.tgt != null ? "color-mix(in srgb,var(--emerald) 13%,transparent)" : "var(--bg-1)" }}>
                      {r.tgt != null ? jumpLink(tgtUrl, headText(r.tgt), r.tgt) : <span className="faint">—</span>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 🔗 Links & images — webmaster/dev: exactly which assets are missing/broken on the target */}
          {(d.imagesMissing > 0 || d.linksBroken > 0) && (
            <div>
              {sect("🔗", t("compare.deep.catAssets"))}
              <div className="col" style={{ gap: 8, fontSize: 12 }}>
                {d.imagesMissing > 0 && (
                  <div>
                    <b className="mono" style={{ color: "var(--crimson)" }}>{t("compare.deep.images")}</b> {d.imagesMissing}/{d.imagesChecked} {t("compare.deep.missing")} ({tgtShort})
                    {urlList(d.imagesMissingUrls)}
                  </div>
                )}
                {d.linksBroken > 0 && (
                  <div>
                    <b className="mono" style={{ color: "var(--crimson)" }}>{t("compare.deep.links")}</b> {d.linksBroken}/{d.linksChecked} {t("compare.deep.broken")} ({tgtShort})
                    {urlList(d.linksBrokenUrls)}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* 📎 Downloads / files — content: PDF/DOC/XLS… present on one side but not the other,
              matched BY FILENAME (host/path differ across sites). Names shown bold + link. */}
          {(docsOnlySrc.length > 0 || docsOnlyTgt.length > 0) && (
            <div>
              {sect("📎", t("compare.deep.catDocs"))}
              <div className="col" style={{ gap: 8, fontSize: 12 }}>
                {docsOnlySrc.length > 0 && (
                  <div>
                    <b className="mono" style={{ color: "var(--crimson)" }}>{t("compare.deep.docsOnly", { side: srcHead })}</b> ({docsOnlySrc.length})
                    {fileList(docsOnlySrc)}
                  </div>
                )}
                {docsOnlyTgt.length > 0 && (
                  <div>
                    <b className="mono" style={{ color: "var(--crimson)" }}>{t("compare.deep.docsOnly", { side: tgtHead })}</b> ({docsOnlyTgt.length})
                    {fileList(docsOnlyTgt)}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ⚙️ Technical — dev: similarity, word delta, per-side counts, frameability (XFO/CSP) */}
          <div>
            {sect("⚙️", t("compare.deep.catDev"))}
            <div className="row" style={{ gap: 18, flexWrap: "wrap", fontSize: 12 }}>
              <span><b className="mono faint">{t("compare.deep.bodySim")}</b> {bodyPct} · Δ{d.wordDelta > 0 ? "+" : ""}{d.wordDelta ?? 0}</span>
              <span><b className="mono faint">{t("compare.deep.catHeadings")}</b> {srcShort} {srcHeads.length} · {tgtShort} {tgtHeads.length}</span>
              <span><b className="mono faint">{t("compare.deep.catDocs")}</b> {srcShort} {d.srcDocs ?? "—"} · {tgtShort} {d.tgtDocs ?? "—"}</span>
              <span><b className="mono faint">{t("compare.deep.images")}</b> {srcShort} {d.srcImages ?? "—"} · {tgtShort} {d.tgtImages ?? "—"}</span>
              <span><b className="mono faint">{t("compare.deep.links")}</b> {srcShort} {d.srcLinks ?? "—"} · {tgtShort} {d.tgtLinks ?? "—"}</span>
              <span><b className="mono faint">{t("compare.deep.frameable")}</b> {srcShort} {yn(d.srcEmbeddable)} · {tgtShort} {yn(d.tgtEmbeddable)}</span>
            </div>
          </div>
        </>
      )}

      {/* open the real pages in a new tab — a rendered preview was removed (couldn't faithfully
          show JS+API SPAs); the structured diff above is the source of truth */}
      <div className="row" style={{ gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <span className="qei-note" style={{ fontSize: 11 }}>{t("compare.deep.openReal")}</span>
        <a className="cmp-link mono" href={srcUrl} target="_blank" rel="noreferrer">{srcShort} ↗</a>
        <a className="cmp-link mono" href={tgtUrl} target="_blank" rel="noreferrer">{tgtShort} ↗</a>
      </div>
    </div>
  );
}
