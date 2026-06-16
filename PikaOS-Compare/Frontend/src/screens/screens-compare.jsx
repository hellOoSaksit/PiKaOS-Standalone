/* PiKaOs — COMPARE CONTENT (UAT vs Production).
   The SOURCE side's sitemap is the source of truth; each URL is domain-swapped
   onto the TARGET base and both sides are probed for coverage. A direction toggle
   flips which side is source (Production → UAT, or UAT → Production). Calls the
   backend POST /api/compare (via lib/api.js). All UI text comes from t("compare.*"). */
import React from 'react';
const { useState } = React;
import { Btn, Empty, PageHead, Panel, StatTile } from '../components/components.jsx';
import Switch from '../components/ui/Switch.jsx';
import Modal from '../components/ui/Modal.jsx';
import Field from '../components/ui/Input.jsx';
import Select from '../components/ui/Dropdown.jsx';
import { ApiError, compareDeep, coverageBatch, coveragePlan } from '../lib/api.js';
import { useToast } from '../components/ui/Toast.jsx';
import { loadSites, saveSites, newSiteId } from '../data/compare-sites.jsx';

const DEEP_BATCH = 2;    // pages deep-compared per streamed request — small so even a SLOW, WAF-throttled
                         // site (PROD pages ~15s each + throttled probes) finishes a batch under the proxy timeout
const COV_BATCH = 30;    // coverage URLs probed per streamed request (a big sitemap can't run in one shot)

// Session cache persisted across reloads (Layer 2). sessionStorage survives F5 but clears when the
// tab closes — right for ephemeral compare data. It NEVER holds credentials: auth is in-memory only,
// the cache KEY folds just the username + header NAME (see credSig), never secrets, and the cached
// results carry no creds. Best-effort: a quota/parse error just means "no persisted cache", never throws.
const VIEW_KEY = "guildos.compare.view.v1";    // small: the inputs (re-saved cheaply on every edit)
const CACHE_KEY = "guildos.compare.cache.v1";  // heavy: coverage + deep results (+ the pair result)
function loadJSON(key) { try { const r = sessionStorage.getItem(key); return r ? JSON.parse(r) : null; } catch (e) { return null; } }
function saveJSON(key, val) { try { sessionStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* quota / private mode: just don't persist */ } }

// Cache-signature builders, shared by render AND the reload-restore path so the key format can't drift.
// Deep settings are intentionally NOT in the key — coverage is identical no matter how many pages we
// deep-compare, and deep results live per-path in the entry's `deep` map, so raising the deep limit
// reuses the coverage + already-fetched pages instead of restarting (Layer 1, incremental deep).
const credSig = (c) => c ? (c.username || "") + ":" + (c.headerName || "") : "";
const authSigOf = (a) => "P" + credSig((a || {}).prod) + "U" + credSig((a || {}).uat);
const makeSig = (dir, prod, uat, authSig) => `${dir}|${(prod || "").trim()}|${(uat || "").trim()}|${authSig}`;

// recount the coverage summary from the items collected so far (streamed coverage fills
// the table batch by batch; `total`/`extra` come from the plan so chips are right from t=0)
function tallySummary(items, total, extra) {
  const s = { total, match: 0, redirect: 0, missing_on_uat: 0, broken_on_uat: 0, prod_error: 0, error: 0, extra_on_uat: extra, deep_compared: 0, deep_diff: 0 };
  items.forEach(it => { if (s[it.state] != null) s[it.state] += 1; });
  return s;
}

const DEEP_TONE = {
  identical: "on", content_diff: "warn", meta_diff: "info", headings_diff: "info",
  images_missing: "warn", links_broken: "warn", docs_diff: "warn", mixed: "warn", unfetchable: "busy",
};

/* Map a thrown error (usually ApiError) to a friendly, localized message. */
function errMessage(e, t) {
  if (e instanceof ApiError) {
    if (e.status === 0) return t("compare.err.network");       // backend unreachable / timed out
    if (e.status === 401 || e.status === 403) return t("compare.err.auth");
    if (e.status === 502) return e.message || t("compare.err.sitemap");  // backend detail
    if (e.status === 422 || e.status === 400) return t("compare.err.input");
    return e.message || t("compare.failed");
  }
  return (e && e.message) || t("compare.failed");
}

/* Build the sitemap URL for `base`. Sitemaps are derived automatically from each
   base URL — no manual field. Defaults to <base>/sitemap.xml; `field` is an
   optional override (full URL or bare path) kept for flexibility. */
function sitemapFor(base, field) {
  let path = (field || "").trim();
  if (/^https?:\/\//i.test(path)) {
    try { const u = new URL(path); path = u.pathname + u.search; } catch (e) { path = ""; }
  }
  if (!path || path === "/") path = "/sitemap.xml";
  if (!path.startsWith("/")) path = "/" + path;
  try { return new URL(path, base).toString(); } catch (e) { return base.replace(/\/+$/, "") + path; }
}

/* Group the six fine-grained states into the filter categories shown to the user.
   prod_error + error collapse into the "other" bucket. */
function catOf(state) {
  if (state === "missing_on_uat") return "missing";
  if (state === "broken_on_uat") return "broken";
  if (state === "match" || state === "redirect") return state;
  return "other";   // prod_error · error
}

const STATE_TONE = {
  match: "on", redirect: "info", missing_on_uat: "warn",
  broken_on_uat: "warn", prod_error: "busy", error: "warn",
};

/* Percent-encoded URLs (e.g. Thai slugs) are unreadable and unbreakable — decode
   for display; callers keep it on one line so iframe columns stay aligned. */
function decodeUrl(u) { try { return decodeURIComponent(u); } catch (e) { return u; } }

/* Build a scroll-to-text-fragment URL (`https://… #:~:text=…`) so opening it in a modern browser
   (Chromium/Edge/Safari) auto-scrolls to AND highlights this exact text on the LIVE page — no JS,
   no dependency. Long blocks use a `textStart,textEnd` range (whole passage highlights + a unique
   match); short ones match whole. encodeURIComponent already encodes the reserved `,`/`&`; `-` (the
   prefix/suffix delimiter) isn't, so we encode it too. Browsers without the feature (Firefox) just
   open the page with no scroll — graceful. */
const encFrag = (s) => encodeURIComponent(s).replace(/-/g, "%2D");
function textFragmentUrl(baseUrl, text) {
  if (!baseUrl) return "#";
  const base = String(baseUrl).split("#")[0];
  const words = (text || "").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return base;
  let directive = "text=" + encFrag(words.slice(0, Math.min(8, words.length)).join(" "));
  if (words.length > 12) directive += "," + encFrag(words.slice(-6).join(" "));   // bound long passages
  return base + "#:~:" + directive;
}

/* Word-level diff (LCS) → [type, word] where type is eq | del (only in source) |
   add (only in target). Used to color the body comparison. */
function wordDiff(src, tgt) {
  const a = (src || "").split(/\s+/).filter(Boolean);
  const b = (tgt || "").split(/\s+/).filter(Boolean);
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = []; let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push(["eq", a[i]]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push(["del", a[i]]); i++; }
    else { out.push(["add", b[j]]); j++; }
  }
  while (i < n) out.push(["del", a[i++]]);
  while (j < m) out.push(["add", b[j++]]);
  return out;
}

/* Block-level diff (LCS over content blocks) → rows for an aligned PROD↔UAT view.
   Each row: {t:"same", src} · {t:"chg", src, tgt} where a null side means the block exists
   on only one side. Consecutive del/add runs are paired index-wise into "changed" rows so a
   reworded paragraph shows side-by-side instead of as a separate remove + add. */
function blockDiff(aIn, bIn) {
  const a = aIn || [], b = bIn || [];
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const ops = []; let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push(["same", a[i]]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push(["del", a[i]]); i++; }
    else { ops.push(["add", b[j]]); j++; }
  }
  while (i < n) ops.push(["del", a[i++]]);
  while (j < m) ops.push(["add", b[j++]]);
  const rows = [];
  for (let k = 0; k < ops.length;) {
    if (ops[k][0] === "same") { rows.push({ t: "same", src: ops[k][1] }); k++; continue; }
    const dels = [], adds = [];
    while (k < ops.length && ops[k][0] === "del") dels.push(ops[k++][1]);
    while (k < ops.length && ops[k][0] === "add") adds.push(ops[k++][1]);
    const L = Math.max(dels.length, adds.length);
    for (let x = 0; x < L; x++) rows.push({ t: "chg", src: dels[x] ?? null, tgt: adds[x] ?? null });
  }
  return rows;
}

/* Expanded deep-diff: DIFFERENCES ONLY — field diff, body word-diff, missing images / broken
   links; identical pages collapse to one line. (A rendered side-by-side preview was removed:
   it can't faithfully show JS+API-driven SPAs — open the real pages in a new tab instead.) */
function DeepDetail({ d, srcUrl, tgtUrl, srcShort, tgtShort, t }) {
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

function Compare({ t }) {
  const toast = useToast();   // bottom-right completion notifications (no-op if no ToastProvider)

  // --- reload restore (Layer 2): read the persisted view + cache ONCE, then re-show the last result.
  // After a reload auth is gone (in-memory only) → authSig is empty, so a credentialed run won't
  // silently re-show (you must re-auth); a plain run (the common case) restores fully. ---
  const boot = React.useRef(undefined);
  if (boot.current === undefined) {
    const view = loadJSON(VIEW_KEY) || {};
    const cache = loadJSON(CACHE_KEY) || {};
    const entries = new Map(Array.isArray(cache.entries) ? cache.entries : []);
    const sig = makeSig(view.dir || "p2u", view.prod, view.uat, authSigOf(null));  // no creds after reload
    boot.current = { view, entries, sig, hit: entries.get(sig) || null, pairRes: cache.pairRes || null };
  }
  const _b = boot.current;

  const [mode, setMode] = useState(_b.view.mode || "coverage");   // coverage = sitemap path-match · pair = two exact URLs
  const [pageA, setPageA] = useState(_b.view.pageA || "");        // direct-pair mode: the two exact page URLs
  const [pageB, setPageB] = useState(_b.view.pageB || "");
  const [pairRes, setPairRes] = useState(_b.pairRes);   // DeepResult of the A↔B compare
  const [prod, setProd] = useState(_b.view.prod || "");
  const [uat, setUat] = useState(_b.view.uat || "");
  const [dir, setDir] = useState(_b.view.dir || "p2u");          // p2u: Production→UAT · u2p: UAT→Production
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [res, setRes] = useState(_b.hit ? _b.hit.res : null);
  const [filter, setFilter] = useState("all");    // category filter for the results
  const [q, setQ] = useState("");                 // path search
  const [sort, setSort] = useState("diff");        // diff (differences first) · path · status
  const [deep, setDeep] = useState(!!_b.view.deep);        // deep body/title/meta/image compare
  const [deepLimit, setDeepLimit] = useState(_b.view.deepLimit ?? 5);   // deep is heavy/slow — start at 5 pages, raise per run
  const [open, setOpen] = useState(() => new Set());  // expanded deep-detail rows, keyed by PATH (stable across re-sort)
  const toggleRow = (key) => setOpen(s => { const n = new Set(s); n.has(key) ? n.delete(key) : n.add(key); return n; });
  // session cache: per direction+inputs result, so flipping UAT↔Prod is instant. Seeded from
  // sessionStorage on mount (above) and persisted via bumpCache → the CACHE_KEY effect below.
  const cacheRef = React.useRef(null);
  if (cacheRef.current === null) cacheRef.current = _b.entries;
  const [cacheVer, setCacheVer] = useState(0);   // bump after any cacheRef mutation → persist effect fires
  const bumpCache = () => setCacheVer(v => v + 1);
  const [resSig, setResSig] = useState(_b.hit ? _b.sig : null);   // signature of the result currently shown
  const [deepData, setDeepData] = useState(_b.hit ? (_b.hit.deep || {}) : {}); // path → DeepResult (streamed in batches)
  const [deepTargets, setDeepTargets] = useState(() => new Set()); // paths still awaiting their batch
  const [deepProg, setDeepProg] = useState(null);  // {done,total} while streaming
  const [covProg, setCovProg] = useState(null);    // {done,total} while coverage probes stream in
  const deepRunRef = React.useRef(0);           // cancels an in-flight stream when a new run/toggle starts
  const covRunRef = React.useRef(0);            // supersedes an in-flight coverage stream (new run / cancel)
  const abortRef = React.useRef(null);          // aborts the in-flight coverage request (Cancel)
  const deepAbortRef = React.useRef(null);      // aborts the in-flight deep batch (Cancel)
  // login-gated sites: per-side credentials (Production / UAT), attached by host. Held
  // in memory only (never persisted). The popup auto-opens when a run hits 401/403.
  const BLANK_CRED = { username: "", password: "", headerName: "", headerValue: "" };
  const [auth, setAuthState] = useState({ prod: null, uat: null });  // each: cred obj | null
  const authRef = React.useRef({ prod: null, uat: null });           // logic reads this (no stale closure)
  const applyAuth = (v) => { authRef.current = v; setAuthState(v); };
  const [authOpen, setAuthOpen] = useState(false);
  const [authTab, setAuthTab] = useState("prod");                    // which side's fields the modal shows
  const [authForm, setAuthForm] = useState({ prod: { ...BLANK_CRED }, uat: { ...BLANK_CRED } });

  // saved sites: the user's reusable list of Prod/UAT pairs (+ per-side creds), persisted to
  // localStorage via the data module (survives sessions). A picker fills the form in one click;
  // a manage modal adds/edits/deletes. `siteDraft` is the add/edit form (id=null → adding).
  const [sites, setSites] = useState(() => loadSites());
  const [sitesOpen, setSitesOpen] = useState(false);
  const blankDraft = () => ({ id: null, name: "", prod: "", uat: "", prodAuth: { ...BLANK_CRED }, uatAuth: { ...BLANK_CRED } });
  const [siteDraft, setSiteDraft] = useState(blankDraft);
  React.useEffect(() => { saveSites(sites); }, [sites]);

  // direction decides which side is source-of-truth (sitemap origin) vs target
  const srcBase = (dir === "p2u" ? prod : uat).trim();
  const tgtBase = (dir === "p2u" ? uat : prod).trim();
  const srcShort = dir === "p2u" ? "PROD" : "UAT";
  const tgtShort = dir === "p2u" ? "UAT" : "PROD";

  // sitemaps are derived automatically from the base URLs (no manual field)
  const prodSitemap = prod.trim() ? sitemapFor(prod.trim()) : "";
  const uatSitemap = uat.trim() ? sitemapFor(uat.trim()) : "";

  // cache key captures everything that changes the COVERAGE result → input/dir/auth edits
  // auto-invalidate (incl. auth: changing either side's credentials must invalidate so a re-auth'd
  // run isn't masked). Deep settings are deliberately NOT folded in (see makeSig) so raising the
  // deep limit reuses coverage + already-fetched pages — the per-path `deep` map handles the rest.
  const authSig = authSigOf(authRef.current);
  const sigOf = (d) => makeSig(d, prod, uat, authSig);
  const curSig = sigOf(dir);
  const cached = res && resSig === curSig;                 // showing a cached/fresh result for current inputs
  const stale = !!(res && resSig && resSig !== curSig);    // inputs changed since this result → re-run

  // Persist the small view bundle (inputs) cheaply on every edit; the heavy results are written
  // separately, only when the cache actually changes (cacheVer) or the pair result does.
  React.useEffect(() => {
    saveJSON(VIEW_KEY, { mode, prod, uat, dir, deep, deepLimit: Number(deepLimit) || 5, pageA, pageB });
  }, [mode, prod, uat, dir, deep, deepLimit, pageA, pageB]);
  React.useEffect(() => {
    saveJSON(CACHE_KEY, { entries: [...cacheRef.current.entries()], pairRes });
  }, [cacheVer, pairRes]);

  const resetDeep = () => { deepRunRef.current++; if (deepAbortRef.current) deepAbortRef.current.abort(); setDeepData({}); setDeepTargets(new Set()); setDeepProg(null); };
  // stop deep streaming but keep whatever rows already came back
  const cancelDeep = () => { deepRunRef.current++; if (deepAbortRef.current) deepAbortRef.current.abort(); setDeepProg(null); setDeepTargets(new Set()); };
  // stop the coverage stream but keep the rows already probed (and stop the backend's outbound work)
  const cancelCov = () => { covRunRef.current++; if (abortRef.current) abortRef.current.abort(); setCovProg(null); setBusy(false); };

  const setDirection = (d) => {
    setDir(d); setFilter("all"); setQ(""); setOpen(new Set()); resetDeep();
    const hit = cacheRef.current.get(sigOf(d));            // reuse prior run for that direction
    setRes(hit ? hit.res : null);
    setResSig(hit ? sigOf(d) : null);
    if (hit) setDeepData(hit.deep || {});
  };

  const clearCache = () => { cacheRef.current.clear(); bumpCache(); resetDeep(); setRes(null); setResSig(null); };

  // Stream deep results in batches so no single request hits the proxy timeout. INCREMENTAL: it
  // keeps every page already deep-compared for these inputs (the entry's authoritative `deep` map)
  // and fetches ONLY the pages up to `deepLimit` that aren't done yet — so raising 5→20 fetches the
  // 15 new ones instead of restarting. Re-runnable as a "deep more" action (no coverage re-probe).
  const runDeep = async (coverage, sig) => {
    const limit = Math.max(1, Math.min(500, Number(deepLimit) || 5));
    const wanted = coverage.items.filter(it => it.state === "match" || it.state === "redirect").slice(0, limit);
    const have = { ...(cacheRef.current.get(sig)?.deep || {}) };   // authoritative store (refs are sync + current)
    const targets = wanted.filter(it => !have[it.path]);           // only the missing pages
    if (!targets.length) { toast(t("compare.toast.deepNoNew"), "ok"); return; }
    const myRun = ++deepRunRef.current;
    const ctrl = new AbortController(); deepAbortRef.current = ctrl;  // Cancel aborts the live batch
    // src side = prodBase param, tgt side = uatBase param; map creds to the right host
    const a = authRef.current || {};
    const srcCreds = dir === "p2u" ? a.prod : a.uat;
    const tgtCreds = dir === "p2u" ? a.uat : a.prod;
    const authParams = { ...(srcCreds ? { prodAuth: srcCreds } : {}), ...(tgtCreds ? { uatAuth: tgtCreds } : {}) };
    const data = { ...have };   // start from what we already have; merge new results in
    setDeepData({ ...data });
    setDeepTargets(new Set(targets.map(it => it.path)));
    setDeepProg({ done: 0, total: targets.length });
    for (let i = 0; i < targets.length; i += DEEP_BATCH) {
      if (myRun !== deepRunRef.current) return;             // a newer run/toggle/cancel superseded us
      const chunk = targets.slice(i, i + DEEP_BATCH);
      try {
        const out = await compareDeep({ pairs: chunk.map(it => ({ src: it.prodUrl, tgt: it.uatUrl })), ...authParams }, ctrl.signal);
        chunk.forEach((it, k) => { data[it.path] = out.results[k]; });
      } catch (e) {
        if (e.name === "AbortError" || myRun !== deepRunRef.current) return;       // cancelled → leave rows as-is
        chunk.forEach(it => { data[it.path] = { deepState: "unfetchable" }; });   // real error → don't hang the row
      }
      if (myRun !== deepRunRef.current) return;
      setDeepData({ ...data });
      setDeepTargets(new Set(targets.slice(i + DEEP_BATCH).map(it => it.path)));
      setDeepProg({ done: Math.min(i + DEEP_BATCH, targets.length), total: targets.length });
      // persist progress each batch so a reload mid-stream keeps the pages already fetched
      const cur = cacheRef.current.get(sig);
      if (cur) { cacheRef.current.set(sig, { ...cur, deep: { ...data } }); bumpCache(); }
    }
    setDeepProg(null);
    // notify with CUMULATIVE totals (existing + newly fetched), and how many differ
    const diffN = Object.values(data).filter(x => x && !["identical", "unfetchable"].includes(x.deepState)).length;
    toast(t("compare.toast.deepDone", { n: Object.keys(data).length, diff: diffN }), "ok");
  };

  // which side(s) a coverage run hit a login wall on (401/403). src/tgt are the
  // probed columns; they map back to the real Production/UAT sides via direction.
  const loginWall = (cov) => {
    let src = false, tgt = false;
    cov.items.forEach(it => { if ([401, 403].includes(it.prodStatus)) src = true; if ([401, 403].includes(it.uatStatus)) tgt = true; });
    return { src, tgt };
  };
  const toForm = (c) => c ? { username: c.username || "", password: c.password || "", headerName: c.headerName || "", headerValue: c.headerValue || "" } : { ...BLANK_CRED };
  const credFromForm = (f) => (f.username.trim() || (f.headerName.trim() && f.headerValue.trim()))
    ? { username: f.username.trim() || null, password: f.password || null, headerName: f.headerName.trim() || null, headerValue: f.headerValue.trim() || null }
    : null;

  const run = async () => {
    if (!prod.trim() || !uat.trim()) { setErr(t("compare.needUrls")); return; }
    setErr(""); setBusy(true); setRes(null); setResSig(null); setFilter("all"); setQ(""); setOpen(new Set()); resetDeep(); setCovProg(null);
    const myRun = ++covRunRef.current;                            // a newer run/cancel supersedes this one
    const ctrl = new AbortController(); abortRef.current = ctrl;   // Cancel button aborts this
    const h = window.uiLoading && window.uiLoading({ title: t("compare.running"), message: srcBase, cancelText: t("compare.cancel"), onCancel: () => { covRunRef.current++; ctrl.abort(); } });
    // src side = srcBase host (→ backend prodAuth), tgt side = tgtBase host (→ backend uatAuth)
    const a = authRef.current || {};
    const srcCreds = dir === "p2u" ? a.prod : a.uat;
    const tgtCreds = dir === "p2u" ? a.uat : a.prod;
    const authParams = { ...(srcCreds ? { prodAuth: srcCreds } : {}), ...(tgtCreds ? { uatAuth: tgtCreds } : {}) };

    // step 1: read the sitemap → URL pairs to probe (fast; never deep here)
    let plan;
    try {
      plan = await coveragePlan({
        prodBase: srcBase, uatBase: tgtBase,
        sitemapUrl: sitemapFor(srcBase), uatSitemapUrl: sitemapFor(tgtBase),
      }, ctrl.signal);
    } catch (e) {
      setBusy(false); h && h.close();
      if (e.name === "AbortError") { setErr(""); return; }
      const msg = errMessage(e, t); setErr(msg);
      try { window.uiAlert && window.uiAlert({ title: t("compare.failed"), message: msg, danger: true }); } catch (_) { }
      return;
    }

    // plan is back — close the blocking loader so the table can fill LIVE; from here an
    // inline progress bar (covProg) shows batches arriving, with its own Cancel.
    h && h.close();
    // step 2: probe the pairs in batches so no single request hits the proxy timeout;
    // fill the table live as each batch returns.
    const pairs = plan.pairs;
    const extra = (plan.extraOnUat || []).length;
    const items = [];
    const shell = () => ({
      prodBase: plan.prodBase, uatBase: plan.uatBase, sitemapUrl: plan.sitemapUrl,
      generatedAt: plan.generatedAt, items: [...items], extraOnUat: plan.extraOnUat || [],
      summary: tallySummary(items, pairs.length, extra),
    });
    setRes(shell()); setResSig(curSig);
    setCovProg({ done: 0, total: pairs.length });
    try {
      for (let i = 0; i < pairs.length; i += COV_BATCH) {
        if (myRun !== covRunRef.current) { setBusy(false); h && h.close(); setCovProg(null); return; }  // superseded/cancelled
        const out = await coverageBatch({ pairs: pairs.slice(i, i + COV_BATCH), ...authParams }, ctrl.signal);
        items.push(...out.results);
        setRes(shell());
        setCovProg({ done: Math.min(i + COV_BATCH, pairs.length), total: pairs.length });
      }
    } catch (e) {
      setBusy(false); h && h.close(); setCovProg(null);
      if (e.name === "AbortError" || myRun !== covRunRef.current) { setErr(""); return; }  // cancelled → keep partial
      const msg = errMessage(e, t); setErr(msg);
      try { window.uiAlert && window.uiAlert({ title: t("compare.failed"), message: msg, danger: true }); } catch (_) { }
      return;
    }
    setBusy(false); h && h.close(); setCovProg(null);
    const coverage = shell();
    // re-running the SAME inputs keeps deep already done (paths are stable) so it's never wasted;
    // editing a URL changes curSig → no prior entry → prevDeep is {} (a genuinely fresh run).
    const prevDeep = cacheRef.current.get(curSig)?.deep || {};
    cacheRef.current.set(curSig, { res: coverage, deep: prevDeep });
    bumpCache();
    setRes(coverage);
    if (Object.keys(prevDeep).length) setDeepData(prevDeep);
    // login-gated side detected and we have no credentials for it yet → prompt (focused on
    // the failing side); submit re-runs. src/tgt map to the real prod/uat sides by direction.
    const wall = loginWall(coverage);
    const srcSide = dir === "p2u" ? "prod" : "uat";
    const tgtSide = dir === "p2u" ? "uat" : "prod";
    const needSide = (wall.src && !a[srcSide]) ? srcSide : (wall.tgt && !a[tgtSide]) ? tgtSide : null;
    if (needSide) { openAuth(needSide); return; }
    const cs = coverage.summary;   // bottom-right "done" notification with the headline numbers
    toast(t("compare.toast.covDone", { n: cs.total, ok: cs.match + cs.redirect, miss: cs.missing_on_uat, tgt: tgtShort }), "ok");
    if (deep) runDeep(coverage, curSig);   // fire-and-forget streamed deep pass
  };

  // popup → save per-side credentials (in memory, via authRef so a re-run isn't a stale
  // closure) and re-run both sides. Either side, or both, may be filled.
  const submitAuth = () => {
    const next = { prod: credFromForm(authForm.prod), uat: credFromForm(authForm.uat) };
    applyAuth(next);
    setAuthOpen(false);
    cacheRef.current.clear(); bumpCache(); // results under different creds are stale now
    setRes(null); setResSig(null); resetDeep(); setPairRes(null);
    // re-run whichever mode is active (Two-pages vs Whole-site) with the new credentials
    if (next.prod || next.uat) setTimeout(mode === "pair" ? runPair : run, 0);
  };
  const clearAuth = () => { applyAuth({ prod: null, uat: null }); cacheRef.current.clear(); bumpCache(); setRes(null); setResSig(null); resetDeep(); };
  const openAuth = (focus) => {
    const a = authRef.current || {};
    setAuthForm({ prod: toForm(a.prod), uat: toForm(a.uat) });
    if (focus === "prod" || focus === "uat") setAuthTab(focus);
    setAuthOpen(true);
  };

  // --- direct two-page compare (no sitemap, no path-matching): deep-diff the exact pair ---
  const hostOf = (u) => { try { return new URL(u).host.replace(/^www\./, ""); } catch (e) { return u; } };

  // --- saved sites (the reusable Prod/UAT + creds list) ---
  const siteOptions = sites.map(s => ({ value: s.id, label: s.name || hostOf(s.prod) }));
  // load a saved entry into the form + apply its creds; clear the cache (inputs changed)
  const applySite = (id) => {
    const s = sites.find(x => x.id === id);
    if (!s) return;
    setProd(s.prod || ""); setUat(s.uat || ""); setErr("");
    applyAuth({ prod: s.prodAuth || null, uat: s.uatAuth || null });
    cacheRef.current.clear(); bumpCache(); setRes(null); setResSig(null); resetDeep(); setPairRes(null);
    toast(t("compare.sites.applied", { name: s.name || hostOf(s.prod) }), "ok");
  };
  // open the manage modal; `seed` pre-fills the add form from the CURRENT inputs (the "Save current" path)
  const openSites = (seed) => {
    const a = authRef.current || {};
    setSiteDraft(seed
      ? { id: null, name: hostOf(prod) || "", prod: prod.trim(), uat: uat.trim(), prodAuth: toForm(a.prod), uatAuth: toForm(a.uat) }
      : blankDraft());
    setSitesOpen(true);
  };
  const editSite = (s) => setSiteDraft({ id: s.id, name: s.name || "", prod: s.prod || "", uat: s.uat || "", prodAuth: toForm(s.prodAuth), uatAuth: toForm(s.uatAuth) });
  const deleteSite = async (s) => {
    const name = s.name || hostOf(s.prod);
    const ok = window.uiConfirm ? await window.uiConfirm({ title: t("compare.sites.delTitle"), message: t("compare.sites.delMsg", { name }), danger: true }) : true;
    if (!ok) return;
    setSites(list => list.filter(x => x.id !== s.id));
    if (siteDraft.id === s.id) setSiteDraft(blankDraft());
  };
  // commit the draft — insert (id=null) or update; creds via the existing credFromForm (empty → null)
  const saveDraft = () => {
    if (!siteDraft.prod.trim() || !siteDraft.uat.trim()) { setErr(t("compare.needUrls")); return; }
    const entry = {
      id: siteDraft.id || newSiteId(),
      name: (siteDraft.name || hostOf(siteDraft.prod)).trim(),
      prod: siteDraft.prod.trim(), uat: siteDraft.uat.trim(),
      prodAuth: credFromForm(siteDraft.prodAuth), uatAuth: credFromForm(siteDraft.uatAuth),
    };
    setSites(list => siteDraft.id ? list.map(x => (x.id === entry.id ? entry : x)) : [entry, ...list]);
    setSiteDraft(blankDraft());
    toast(t("compare.sites.saved"), "ok");
  };
  const draftCred = (side, k) => (e) => setSiteDraft(d => ({ ...d, [side]: { ...d[side], [k]: e.target.value } }));

  const runPair = async () => {
    if (!pageA.trim() || !pageB.trim()) { setErr(t("compare.needUrls")); return; }
    setErr(""); setBusy(true); setPairRes(null);
    const ctrl = new AbortController(); abortRef.current = ctrl;
    const h = window.uiLoading && window.uiLoading({ title: t("compare.running"), message: pageA.trim(), cancelText: t("compare.cancel"), onCancel: () => ctrl.abort() });
    const a = authRef.current || {};   // prodAuth → A's host, uatAuth → B's host (deep_batch maps by first pair)
    let result;
    try {
      const out = await compareDeep({
        pairs: [{ src: pageA.trim(), tgt: pageB.trim() }],
        ...(a.prod ? { prodAuth: a.prod } : {}), ...(a.uat ? { uatAuth: a.uat } : {}),
      }, ctrl.signal);
      result = out.results[0];
      setPairRes(result);
    } catch (e) {
      setBusy(false); h && h.close();
      if (e.name === "AbortError") { setErr(""); return; }
      const msg = errMessage(e, t);
      setErr(msg);
      try { window.uiAlert && window.uiAlert({ title: t("compare.failed"), message: msg, danger: true }); } catch (_) { }
      return;
    }
    setBusy(false); h && h.close();
    // a login-gated side (401/403) with no creds yet → prompt instead of dead-ending on
    // "unfetchable". Page A maps to the prod tab, Page B to the uat tab; submit re-runs.
    if (result && result.deepState === "unfetchable") {
      const aWall = [401, 403].includes(result.srcStatus) && !a.prod;
      const bWall = [401, 403].includes(result.tgtStatus) && !a.uat;
      const side = aWall ? "prod" : bWall ? "uat" : null;
      if (side) { openAuth(side); return; }
    }
    // notify the verdict (identical vs differs / unfetchable)
    if (result) {
      const same = result.deepState === "identical";
      toast(t(same ? "compare.toast.pairSame" : "compare.toast.pairDiff"), same ? "ok" : "err");
    }
  };

  // deep-compare ONE coverage row on demand (the per-row 🔬 button) — independent of the bulk pass
  const deepOne = async (it) => {
    if (deepData[it.path] || deepTargets.has(it.path)) return;
    setDeepTargets(s => new Set(s).add(it.path));
    let result;
    try {
      const a = authRef.current || {};
      const srcCreds = dir === "p2u" ? a.prod : a.uat;
      const tgtCreds = dir === "p2u" ? a.uat : a.prod;
      const out = await compareDeep({ pairs: [{ src: it.prodUrl, tgt: it.uatUrl }], ...(srcCreds ? { prodAuth: srcCreds } : {}), ...(tgtCreds ? { uatAuth: tgtCreds } : {}) });
      result = out.results[0];
    } catch (e) {
      result = { deepState: "unfetchable" };
    }
    setDeepData(prev => ({ ...prev, [it.path]: result }));
    setDeepTargets(s => { const n = new Set(s); n.delete(it.path); return n; });
    // persist into the per-direction cache — create the entry if the coverage stream
    // hasn't finished yet (so a deep clicked DURING "Checking pages" isn't lost on re-sort/flip)
    const cur = cacheRef.current.get(curSig) || { res, deep: {} };
    cacheRef.current.set(curSig, { ...cur, deep: { ...cur.deep, [it.path]: result } });
    bumpCache();
  };

  const sm = res ? res.summary : null;
  const matchedCount = sm ? sm.match + sm.redirect : null;   // deep can only run on matched/redirect pages
  const deepVals = Object.values(deepData);
  const deepDone = deepVals.length;
  const deepDiff = deepVals.filter(x => x && x.deepState !== "identical").length;
  const chips = sm ? [
    ["total", sm.total, t("compare.total")],
    ["match", sm.match, t("compare.match")],
    ["redirect", sm.redirect, t("compare.redirect")],
    ["missing", sm.missing_on_uat, t("compare.missing", { env: tgtShort })],
    ["broken", sm.broken_on_uat, t("compare.broken", { env: tgtShort })],
    ["error", sm.prod_error + sm.error, t("compare.error")],
    ["extra", sm.extra_on_uat, t("compare.extra", { env: tgtShort })],
    ...(deepDone ? [
      ["deepc", deepDone, t("compare.deep.compared")],
      ["deepd", deepDiff, t("compare.deep.diff")],
    ] : []),
  ] : [];
  const cats = sm ? [
    ["all", t("compare.cat.all"), sm.total],
    ["match", t("compare.match"), sm.match],
    ["redirect", t("compare.redirect"), sm.redirect],
    ["missing", t("compare.missing", { env: tgtShort }), sm.missing_on_uat],
    ["broken", t("compare.broken", { env: tgtShort }), sm.broken_on_uat],
    ["other", t("compare.cat.other"), sm.prod_error + sm.error],
  ] : [];
  const ql = q.trim().toLowerCase();
  // "differences first": deep-content differs (0) > coverage unmatch incl REDIRECT (1) > clean match (2)
  const diffRank = (it) => {
    const dd = deepData[it.path] || it.deep;
    if (dd && dd.deepState && dd.deepState !== "identical" && dd.deepState !== "unfetchable") return 0;
    if (it.state !== "match") return 1;   // redirect / missing / broken / error all count as "unmatch"
    return 2;
  };
  const sorters = {
    diff: (a, b) => diffRank(a) - diffRank(b) || a.path.localeCompare(b.path),
    path: (a, b) => a.path.localeCompare(b.path),
    status: (a, b) => a.state.localeCompare(b.state) || a.path.localeCompare(b.path),
  };
  const shown = res ? res.items.filter(it =>
    (filter === "all" || catOf(it.state) === filter) && (!ql || it.path.toLowerCase().includes(ql))
  ).sort(sorters[sort] || sorters.diff) : [];

  // direction-aware state badge label (prod_error → "<source> error")
  const stateLabel = (s) => s === "prod_error" ? t("compare.state.prod_error", { env: srcShort }) : t("compare.state." + s);

  const thCell = { padding: "8px 14px", textAlign: "left", color: "var(--ink-3)", fontSize: 11, fontWeight: 600, borderBottom: "1px solid var(--line)", whiteSpace: "nowrap" };
  const tdCell = { padding: "10px 14px", verticalAlign: "top", borderTop: "1px solid var(--line-soft)" };

  return (
    <div className="content-pad fade-in">
      <PageHead kicker={t("compare.kicker")} title={t("compare.title")} tag="local"
        desc={t("compare.desc")} />

      <Panel title={t("compare.inputs")} en="INPUTS" icon="🔀">
        <div className="col" style={{ gap: 14 }}>
          <div className="bf"><label className="bf-label">{t("compare.mode.label")}</label>
            <div className="seg-toggle">
              <button type="button" className={mode === "coverage" ? "on" : ""} onClick={() => setMode("coverage")}>{t("compare.mode.coverage")}</button>
              <button type="button" className={mode === "pair" ? "on" : ""} onClick={() => setMode("pair")}>{t("compare.mode.pair")}</button>
            </div>
            <div className="qei-note">{mode === "coverage" ? t("compare.mode.coverageNote") : t("compare.mode.pairNote")}</div>
          </div>

          {mode === "pair" && (<>
            <div className="bf"><label className="bf-label">{t("compare.f.pageA")}</label>
              <input className="bf-input" value={pageA} onChange={e => setPageA(e.target.value)} placeholder={t("compare.f.pagePh")} /></div>
            <div className="bf"><label className="bf-label">{t("compare.f.pageB")}</label>
              <input className="bf-input" value={pageB} onChange={e => setPageB(e.target.value)} placeholder={t("compare.f.pagePh")} /></div>
          </>)}

          {mode === "coverage" && (<>
          <div className="bf"><label className="bf-label">{t("compare.sites.label")}</label>
            <div className="row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              {sites.length > 0
                ? <Select minWidth={220} placeholder={t("compare.sites.pick")} options={siteOptions} value="" onChange={applySite} />
                : <span className="qei-note" style={{ margin: 0 }}>{t("compare.sites.empty")}</span>}
              <Btn kind="ghost" sm icon="💾" onClick={() => openSites(true)}>{t("compare.sites.save")}</Btn>
              <Btn kind="ghost" sm icon="📁" onClick={() => openSites(false)}>{t("compare.sites.manage")}{sites.length ? ` (${sites.length})` : ""}</Btn>
            </div>
          </div>
          <div className="bf"><label className="bf-label">{t("compare.f.prod")}</label>
            <input className="bf-input" value={prod} onChange={e => setProd(e.target.value)} placeholder={t("compare.f.prodPh")} /></div>
          <div className="bf"><label className="bf-label">{t("compare.f.uat")}</label>
            <input className="bf-input" value={uat} onChange={e => setUat(e.target.value)} placeholder={t("compare.f.uatPh")} /></div>

          <div className="bf"><label className="bf-label">{t("compare.dir.label")}</label>
            <div className="seg-toggle">
              <button type="button" className={dir === "p2u" ? "on" : ""} onClick={() => setDirection("p2u")}>{t("compare.dir.p2u")}</button>
              <button type="button" className={dir === "u2p" ? "on" : ""} onClick={() => setDirection("u2p")}>{t("compare.dir.u2p")}</button>
            </div>
            <div className="qei-note">{t("compare.dir.note", { src: srcShort, tgt: tgtShort })}</div>
          </div>

          <div className="bf">
            <div className="row" style={{ gap: 12, alignItems: "center", flexWrap: "wrap" }}>
              <Switch checked={deep} onChange={setDeep} label={t("compare.deep.toggle")} />
              {deep && (
                <span className="row" style={{ gap: 6, alignItems: "center" }}>
                  <span className="bf-label" style={{ margin: 0 }}>{t("compare.deep.limit")}</span>
                  <input className="bf-input" type="number" min={1} max={matchedCount || 500} value={deepLimit}
                    onChange={e => setDeepLimit(e.target.value)} style={{ width: 90, height: 32 }} />
                  {matchedCount != null && (
                    <span className="mono faint" style={{ fontSize: 11 }}>{t("compare.deep.avail", { n: matchedCount })}</span>
                  )}
                  {/* incremental: fetch deep for the pages up to the (raised) limit that aren't done yet —
                      no coverage re-probe, keeps the ones already fetched (the "don't start over" fix) */}
                  {res && matchedCount > 0 && (
                    <Btn kind="ghost" sm icon="🔬"
                      style={{ opacity: deepProg ? .5 : 1, pointerEvents: deepProg ? "none" : "auto" }}
                      onClick={() => runDeep(res, curSig)}>
                      {t("compare.deep.more", { done: deepDone, want: Math.min(Number(deepLimit) || 5, matchedCount) })}
                    </Btn>
                  )}
                </span>
              )}
            </div>
            <div className="qei-note">{t("compare.deep.note")}</div>
          </div>

          {(prodSitemap || uatSitemap) && (
            <div className="bf">
              <label className="bf-label">{t("compare.autoSitemap")}</label>
              <div className="qei-note mono" style={{ fontSize: 11 }}>
                {prodSitemap && <div>PROD → {prodSitemap}{srcShort === "PROD" ? "  ★" : ""}</div>}
                {uatSitemap && <div>UAT → {uatSitemap}{srcShort === "UAT" ? "  ★" : ""}</div>}
              </div>
            </div>
          )}
          </>)}
          {err && <div className="qei-note" style={{ color: "var(--crimson)" }}>{err}</div>}
          {stale && <div className="qei-note" style={{ color: "var(--gold)" }}>⚠ {t("compare.cache.stale")}</div>}
          <div className="row" style={{ gap: 10, flexWrap: "wrap", alignItems: "center" }}>
            <Btn kind="gold" icon="🔀" onClick={mode === "pair" ? runPair : run} style={{ opacity: busy ? .5 : 1, pointerEvents: busy ? "none" : "auto" }}>
              {busy ? t("compare.running") : t("compare.run")}
            </Btn>
            {mode === "coverage" && <span className="mono faint" style={{ fontSize: 12 }}>{srcShort} → {tgtShort}</span>}
            {mode === "coverage" && cached && <span className="mono" style={{ fontSize: 12, color: "var(--emerald)" }}>● {t("compare.cache.cached")}</span>}
            {(auth.prod || auth.uat) ? (
              <span className="row" style={{ gap: 6, alignItems: "center" }}>
                <span className="mono" style={{ fontSize: 12, color: "var(--emerald)" }}>🔑 {t("compare.auth.set")} ({[auth.prod && "PROD", auth.uat && "UAT"].filter(Boolean).join("+")})</span>
                <Btn kind="ghost" sm onClick={() => openAuth()}>{t("compare.auth.edit")}</Btn>
                <Btn kind="ghost" sm onClick={clearAuth}>{t("compare.auth.clear")}</Btn>
              </span>
            ) : (
              <Btn kind="ghost" sm icon="🔑" onClick={() => openAuth()}>{t("compare.auth.manual")}</Btn>
            )}
            {cacheRef.current.size > 0 && (
              <Btn kind="ghost" sm icon="🗑" style={{ marginLeft: "auto" }} onClick={clearCache}>
                {t("compare.cache.clear")} ({cacheRef.current.size})
              </Btn>
            )}
          </div>
        </div>
      </Panel>

      {mode === "pair" && pairRes && (
        <Panel title={t("compare.pair.title")} en="DIFF" icon="🔀" style={{ marginTop: 18 }}>
          <div className="col" style={{ gap: 12 }}>
            <div className="mono faint" style={{ fontSize: 11 }}>
              <div>A · {pageA.trim()}</div>
              <div>B · {pageB.trim()}</div>
            </div>
            <DeepDetail d={pairRes} srcUrl={pageA.trim()} tgtUrl={pageB.trim()} srcShort={hostOf(pageA)} tgtShort={hostOf(pageB)} t={t} />
          </div>
        </Panel>
      )}

      {mode === "coverage" && res && (
        <>
          <div className="grid cols-4 stagger" style={{ margin: "18px 0" }}>
            {chips.map(([k, n, label]) => <StatTile key={k} label={label} value={n} />)}
          </div>

          {covProg && (
            <div style={{ margin: "0 0 14px" }}>
              <div className="row" style={{ gap: 8, alignItems: "center", marginBottom: 5 }}>
                <span className="typing-bubble" style={{ display: "inline-flex" }}><span /><span /><span /></span>
                <span className="mono faint" style={{ fontSize: 12 }}>{t("compare.cov.loading", { done: covProg.done, total: covProg.total, src: hostOf(srcBase) || srcShort, tgt: hostOf(tgtBase) || tgtShort })}</span>
                <Btn kind="ghost" sm icon="✕" style={{ marginLeft: "auto" }} onClick={cancelCov}>{t("compare.cancel")}</Btn>
              </div>
              <div className="task-prog-track"><div className="task-prog-fill" style={{ width: Math.round(covProg.done / Math.max(1, covProg.total) * 100) + "%" }} /></div>
            </div>
          )}

          {deepProg && (
            <div style={{ margin: "0 0 14px" }}>
              <div className="row" style={{ gap: 8, alignItems: "center", marginBottom: 5 }}>
                <span className="typing-bubble" style={{ display: "inline-flex" }}><span /><span /><span /></span>
                <span className="mono faint" style={{ fontSize: 12 }}>{t("compare.deep.loading", { done: deepProg.done, total: deepProg.total })}</span>
                <Btn kind="ghost" sm icon="✕" style={{ marginLeft: "auto" }} onClick={cancelDeep}>{t("compare.cancel")}</Btn>
              </div>
              <div className="task-prog-track"><div className="task-prog-fill" style={{ width: Math.round(deepProg.done / deepProg.total * 100) + "%" }} /></div>
            </div>
          )}

          <Panel title={t("compare.results")} en="COVERAGE" icon="📋" bodyPad={false}
            right={<span className="mono faint" style={{ fontSize: 11 }}>{shown.length}/{res.items.length}</span>}>
            {res.items.length === 0
              ? <div style={{ padding: 16 }}><Empty icon="🔀" title={t("compare.empty.title")} sub={t("compare.empty.sub")} /></div>
              : (
                <>
                  <div className="cmp-filterbar" style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", padding: "12px 14px" }}>
                    {cats.map(([k, label, n]) => (
                      <button key={k} className={`tab-pill ${filter === k ? "on" : ""}`} disabled={n === 0 && k !== "all"} onClick={() => setFilter(k)}>
                        {label} <span className="mono faint">{n}</span>
                      </button>
                    ))}
                    <div className="row" style={{ marginLeft: "auto", gap: 6, alignItems: "center" }}>
                      <span className="mono faint" style={{ fontSize: 11 }}>{t("compare.sort.label")}</span>
                      <div className="seg-toggle">
                        <button type="button" className={sort === "diff" ? "on" : ""} onClick={() => setSort("diff")}>{t("compare.sort.diff")}</button>
                        <button type="button" className={sort === "path" ? "on" : ""} onClick={() => setSort("path")}>{t("compare.sort.path")}</button>
                        <button type="button" className={sort === "status" ? "on" : ""} onClick={() => setSort("status")}>{t("compare.sort.status")}</button>
                      </div>
                    </div>
                    <div className="cmp-search" style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span className="rs-ic">🔍</span>
                      <input className="bf-input" style={{ height: 30, width: 190 }} value={q} onChange={e => setQ(e.target.value)} placeholder={t("compare.searchPh")} />
                      {q && <button className="rs-clear" onClick={() => setQ("")}>✕</button>}
                    </div>
                  </div>
                  {shown.length === 0
                    ? <div style={{ padding: 16 }}><Empty icon="🔍" title={t("compare.noMatch")} sub={t("compare.noMatchSub")} /></div>
                    : (
                      <div style={{ overflowX: "auto" }}>
                        <table className="cmp-table" style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                          <thead>
                            <tr>
                              <th style={thCell}>{t("compare.col.state")}</th>
                              <th style={thCell}>{t("compare.col.path")}</th>
                              <th style={{ ...thCell, textAlign: "center" }}>{srcShort}</th>
                              <th style={{ ...thCell, textAlign: "center" }}>{tgtShort}</th>
                              <th style={thCell}>{t("compare.col.deep")}</th>
                              <th style={thCell}>{t("compare.col.note")}</th>
                              <th style={thCell} />
                            </tr>
                          </thead>
                          <tbody>
                            {shown.map((it) => {
                              const d = deepData[it.path] || it.deep;
                              const loading = deepTargets.has(it.path) && !d;
                              const isOpen = open.has(it.path);
                              const deepable = it.state === "match" || it.state === "redirect";
                              return (
                              <React.Fragment key={it.path}>
                              <tr className={`${d ? "is-row" : ""} ${isOpen ? "is-open" : ""}`} style={{ cursor: d ? "pointer" : "default", opacity: loading ? .5 : 1 }} onClick={d ? () => toggleRow(it.path) : undefined}>
                                <td style={tdCell}>
                                  <span className={`badge ${STATE_TONE[it.state] || "idle"}`} style={{ whiteSpace: "nowrap" }} title={t("compare.statusHint")}>
                                    <span className="dot" />{stateLabel(it.state)}
                                  </span>
                                  {/* coverage "match" = URL reachable on both; CONTENT may still differ → say so when deep found diffs */}
                                  {it.state === "match" && d && d.deepState && !["identical", "unfetchable"].includes(d.deepState) && (
                                    <div className="mono" style={{ fontSize: 10, color: "var(--crimson)", marginTop: 3 }}>≠ {t("compare.contentDiffers")}</div>
                                  )}
                                </td>
                                <td style={{ ...tdCell, fontFamily: "var(--font-mono)", wordBreak: "break-all" }}>{it.path}</td>
                                <td style={{ ...tdCell, textAlign: "center", fontFamily: "var(--font-mono)", color: "var(--ink-2)" }}>{it.prodStatus ?? "—"}</td>
                                <td style={{ ...tdCell, textAlign: "center", fontFamily: "var(--font-mono)", color: "var(--ink-2)" }}>{it.uatStatus ?? "—"}</td>
                                <td style={{ ...tdCell, whiteSpace: "nowrap" }}>
                                  {loading ? (
                                    <span className="cmp-skel" title={t("compare.deep.loadingRow")} />
                                  ) : d ? (
                                    <span className={`badge ${DEEP_TONE[d.deepState] || "idle"}`} title={t("compare.deep.expand")}>
                                      <span className="dot" />{t("compare.deep.state." + d.deepState)} <span className={`cmp-chev ${isOpen ? "is-open" : ""}`}>▸</span>
                                    </span>
                                  ) : deepable ? (
                                    <Btn kind="ghost" sm icon="🔬" onClick={(e) => { e.stopPropagation(); deepOne(it); }}>{t("compare.deep.one")}</Btn>
                                  ) : <span className="mono faint">—</span>}
                                </td>
                                <td style={{ ...tdCell, color: "var(--ink-3)", fontSize: 12 }}>{it.note || ""}</td>
                                <td style={{ ...tdCell, whiteSpace: "nowrap" }}>
                                  <a className="cmp-link mono" href={it.uatUrl} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()}>{tgtShort} ↗</a>
                                </td>
                              </tr>
                              {d && isOpen && (
                                <tr className="cmp-detail">
                                  <td colSpan={7} style={{ padding: "12px 16px 18px" }}>
                                    <div className="cmp-grow"><div className="cmp-clip">
                                      <DeepDetail d={d} srcUrl={it.prodUrl} tgtUrl={it.uatUrl} srcShort={srcShort} tgtShort={tgtShort} t={t} />
                                    </div></div>
                                  </td>
                                </tr>
                              )}
                              </React.Fragment>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}
                </>
              )}
          </Panel>

          {res.extraOnUat && res.extraOnUat.length > 0 && (
            <Panel title={t("compare.extraTitle", { env: tgtShort, src: srcShort })} en={tgtShort + "-ONLY"} icon="➕" style={{ marginTop: 18 }}>
              <div className="col" style={{ gap: 5 }}>
                {res.extraOnUat.map((u, i) => <div key={i} className="mono" style={{ fontSize: 12, color: "var(--ink-2)" }}>{u}</div>)}
              </div>
            </Panel>
          )}
        </>
      )}

      <Modal open={authOpen} onClose={() => setAuthOpen(false)} title={"🔑 " + t("compare.auth.title")}
        footer={<>
          <Btn kind="ghost" onClick={() => setAuthOpen(false)}>{t("compare.auth.cancel")}</Btn>
          <Btn kind="gold" onClick={submitAuth}>{t("compare.auth.submit")}</Btn>
        </>}>
        {(() => {
          const af = authForm[authTab];
          const sf = (k) => (e) => setAuthForm(f => ({ ...f, [authTab]: { ...f[authTab], [k]: e.target.value } }));
          const filled = (side) => !!credFromForm(authForm[side]);
          return (
            <div className="col" style={{ gap: 12 }}>
              <div className="qei-note">{mode === "pair"
                ? t("compare.auth.detectedPair")
                : t("compare.auth.detected", { n: res ? res.items.filter(it => [401, 403].includes(it.prodStatus) || [401, 403].includes(it.uatStatus)).length : 0 })}</div>
              <div className="seg-toggle">
                <button type="button" className={authTab === "prod" ? "on" : ""} onClick={() => setAuthTab("prod")}>{t("compare.auth.tabProd")}{filled("prod") ? " ●" : ""}</button>
                <button type="button" className={authTab === "uat" ? "on" : ""} onClick={() => setAuthTab("uat")}>{t("compare.auth.tabUat")}{filled("uat") ? " ●" : ""}</button>
              </div>
              <Field label={t("compare.auth.user")} value={af.username} autoComplete="off"
                placeholder={t("compare.auth.userPh")} onChange={sf("username")} />
              <Field label={t("compare.auth.pass")} type="password" value={af.password} autoComplete="off" onChange={sf("password")} />
              <div className="row" style={{ gap: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
                <div style={{ flex: "1 1 150px" }}>
                  <Field label={t("compare.auth.headerName")} value={af.headerName}
                    placeholder={t("compare.auth.headerNamePh")} onChange={sf("headerName")} />
                </div>
                <div style={{ flex: "2 1 220px" }}>
                  <Field label={t("compare.auth.headerValue")} value={af.headerValue}
                    placeholder={t("compare.auth.headerValuePh")} onChange={sf("headerValue")} />
                </div>
              </div>
              <div className="qei-note" style={{ fontSize: 11 }}>{t("compare.auth.bothHint")} · {t("compare.auth.hint")}</div>
            </div>
          );
        })()}
      </Modal>

      {/* Saved sites — reusable Prod/UAT + creds list (localStorage). List on top, add/edit form below. */}
      <Modal open={sitesOpen} onClose={() => setSitesOpen(false)} title={"📁 " + t("compare.sites.title")}
        footer={<Btn kind="ghost" onClick={() => setSitesOpen(false)}>{t("compare.auth.cancel")}</Btn>}>
        <div className="col" style={{ gap: 14 }}>
          {sites.length === 0
            ? <div className="qei-note">{t("compare.sites.empty")}</div>
            : <div className="col" style={{ gap: 6 }}>
                {sites.map(s => (
                  <div key={s.id} className="row" style={{ gap: 8, alignItems: "center", padding: "6px 8px", border: "1px solid var(--line-soft)", borderRadius: 8 }}>
                    <div className="col" style={{ gap: 1, minWidth: 0, flex: 1 }}>
                      <b style={{ fontSize: 13 }}>{s.name || hostOf(s.prod)}{(s.prodAuth || s.uatAuth) ? " 🔑" : ""}</b>
                      <span className="mono faint" style={{ fontSize: 11, wordBreak: "break-all" }}>{hostOf(s.prod)} → {hostOf(s.uat)}</span>
                    </div>
                    <Btn kind="ghost" sm onClick={() => { applySite(s.id); setSitesOpen(false); }}>{t("compare.sites.use")}</Btn>
                    <Btn kind="ghost" sm onClick={() => editSite(s)}>{t("compare.auth.edit")}</Btn>
                    <Btn kind="ghost" sm icon="🗑" onClick={() => deleteSite(s)}>{t("compare.sites.del")}</Btn>
                  </div>
                ))}
              </div>}

          <div style={{ height: 1, background: "var(--line)", margin: "2px 0" }} />

          <div className="col" style={{ gap: 10 }}>
            <div className="bf-label" style={{ margin: 0 }}>{siteDraft.id ? t("compare.sites.editEntry") : t("compare.sites.newEntry")}</div>
            <Field label={t("compare.sites.name")} value={siteDraft.name} placeholder={t("compare.sites.namePh")}
              onChange={e => setSiteDraft(d => ({ ...d, name: e.target.value }))} />
            <Field label={t("compare.f.prod")} value={siteDraft.prod} placeholder={t("compare.f.prodPh")}
              onChange={e => setSiteDraft(d => ({ ...d, prod: e.target.value }))} />
            <Field label={t("compare.f.uat")} value={siteDraft.uat} placeholder={t("compare.f.uatPh")}
              onChange={e => setSiteDraft(d => ({ ...d, uat: e.target.value }))} />
            <div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
              <div className="col" style={{ gap: 6, flex: "1 1 240px" }}>
                <div className="mono faint" style={{ fontSize: 11 }}>PROD 🔑 <span className="faint">({t("compare.sites.optional")})</span></div>
                <Field label={t("compare.auth.user")} value={siteDraft.prodAuth.username} autoComplete="off" onChange={draftCred("prodAuth", "username")} />
                <Field label={t("compare.auth.pass")} type="password" value={siteDraft.prodAuth.password} autoComplete="off" onChange={draftCred("prodAuth", "password")} />
              </div>
              <div className="col" style={{ gap: 6, flex: "1 1 240px" }}>
                <div className="mono faint" style={{ fontSize: 11 }}>UAT 🔑 <span className="faint">({t("compare.sites.optional")})</span></div>
                <Field label={t("compare.auth.user")} value={siteDraft.uatAuth.username} autoComplete="off" onChange={draftCred("uatAuth", "username")} />
                <Field label={t("compare.auth.pass")} type="password" value={siteDraft.uatAuth.password} autoComplete="off" onChange={draftCred("uatAuth", "password")} />
              </div>
            </div>
            <div className="qei-note" style={{ fontSize: 11 }}>{t("compare.sites.credNote")}</div>
            <div className="row" style={{ gap: 8 }}>
              <Btn kind="gold" onClick={saveDraft}>{siteDraft.id ? t("compare.sites.update") : t("compare.sites.add")}</Btn>
              {siteDraft.id && <Btn kind="ghost" onClick={() => setSiteDraft(blankDraft())}>{t("compare.sites.newBtn")}</Btn>}
            </div>
          </div>
        </div>
      </Modal>
    </div>
  );
}

export { Compare };
