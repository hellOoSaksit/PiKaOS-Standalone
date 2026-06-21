/* For human — pure helpers + constants for the Compare screen and its panels: the session-cache
   persistence, cache-signature builders, the coverage tally, error-message mapping, sitemap URL
   derivation, and the word/block LCS diffs the deep view renders. No React, no JSX — just data in,
   data out — so they're trivially testable and shared without re-creating them on every render. */
import { ApiError } from '../../lib/api.js';

// Session cache persisted across reloads (Layer 2). sessionStorage survives F5 but clears when the
// tab closes — right for ephemeral compare data. It NEVER holds credentials: auth is in-memory only,
// the cache KEY folds just the username + header NAME (see credSig), never secrets, and the cached
// results carry no creds. Best-effort: a quota/parse error just means "no persisted cache", never throws.
export const VIEW_KEY = "guildos.compare.view.v1";    // small: the inputs (re-saved cheaply on every edit)
export const CACHE_KEY = "guildos.compare.cache.v1";  // heavy: coverage + deep results (+ the pair result)
export function loadJSON(key) { try { const r = sessionStorage.getItem(key); return r ? JSON.parse(r) : null; } catch (e) { return null; } }
export function saveJSON(key, val) { try { sessionStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* quota / private mode: just don't persist */ } }

// Cache-signature builders, shared by render AND the reload-restore path so the key format can't drift.
// Deep settings are intentionally NOT in the key — coverage is identical no matter how many pages we
// deep-compare, and deep results live per-path in the entry's `deep` map, so raising the deep limit
// reuses the coverage + already-fetched pages instead of restarting (Layer 1, incremental deep).
export const credSig = (c) => c ? (c.username || "") + ":" + (c.headerName || "") : "";
export const authSigOf = (a) => "P" + credSig((a || {}).prod) + "U" + credSig((a || {}).uat);
export const makeSig = (dir, prod, uat, authSig) => `${dir}|${(prod || "").trim()}|${(uat || "").trim()}|${authSig}`;

// recount the coverage summary from the items collected so far (streamed coverage fills
// the table batch by batch; `total`/`extra` come from the plan so chips are right from t=0)
export function tallySummary(items, total, extra) {
  const s = { total, match: 0, redirect: 0, missing_on_uat: 0, broken_on_uat: 0, prod_error: 0, error: 0, extra_on_uat: extra, deep_compared: 0, deep_diff: 0 };
  items.forEach(it => { if (s[it.state] != null) s[it.state] += 1; });
  return s;
}

export const DEEP_TONE = {
  identical: "on", content_diff: "warn", meta_diff: "info", headings_diff: "info",
  images_missing: "warn", links_broken: "warn", docs_diff: "warn", mixed: "warn", unfetchable: "busy",
};

export const STATE_TONE = {
  match: "on", redirect: "info", missing_on_uat: "warn",
  broken_on_uat: "warn", prod_error: "busy", error: "warn",
};

/* Map a thrown error (usually ApiError) to a friendly, localized message. */
export function errMessage(e, t) {
  if (e instanceof ApiError) {
    if (e.status === 0) return t("compare.err.network");       // backend unreachable / timed out
    if (e.status === 401 || e.status === 403) return t("compare.err.auth");
    if (e.status === 502) return e.message || t("compare.err.sitemap");  // backend detail
    if (e.status === 422 || e.status === 400) return t("compare.err.input");
    return e.message || t("compare.failed");
  }
  return (e && e.message) || t("compare.failed");
}

/* Build the sitemap URL for `base`. Sitemaps are derived automatically from each base URL — no
   manual field. Defaults to <base>/sitemap.xml; `field` is an optional override (full URL or bare
   path) kept for flexibility. */
export function sitemapFor(base, field) {
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
export function catOf(state) {
  if (state === "missing_on_uat") return "missing";
  if (state === "broken_on_uat") return "broken";
  if (state === "match" || state === "redirect") return state;
  return "other";   // prod_error · error
}

/* Percent-encoded URLs (e.g. Thai slugs) are unreadable and unbreakable — decode
   for display; callers keep it on one line so iframe columns stay aligned. */
export function decodeUrl(u) { try { return decodeURIComponent(u); } catch (e) { return u; } }

/* Build a scroll-to-text-fragment URL (`https://… #:~:text=…`) so opening it in a modern browser
   (Chromium/Edge/Safari) auto-scrolls to AND highlights this exact text on the LIVE page — no JS,
   no dependency. Long blocks use a `textStart,textEnd` range (whole passage highlights + a unique
   match); short ones match whole. encodeURIComponent already encodes the reserved `,`/`&`; `-` (the
   prefix/suffix delimiter) isn't, so we encode it too. Browsers without the feature (Firefox) just
   open the page with no scroll — graceful. */
export const encFrag = (s) => encodeURIComponent(s).replace(/-/g, "%2D");
export function textFragmentUrl(baseUrl, text) {
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
export function wordDiff(src, tgt) {
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
export function blockDiff(aIn, bIn) {
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
