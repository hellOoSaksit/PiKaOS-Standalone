/* For human — small presentational pieces + pure helpers shared by the Redirect screen and its
   panels: status/match badges, the Files & Body table cells, the HTTP verdict pill, the
   open-in-new-tab link, blob download, and the shared table/input style objects. Kept in one module
   so the screen stays an orchestrator and these aren't redefined on every render. */
import React from 'react';

// status chip palette, keyed by the tool's Thai status
export const STATUS_TONE = {
  "รอดำเนินการ": { bg: "#f59e0b22", fg: "#b45309", bd: "#f59e0b66" },
  "ดำเนินการแล้ว": { bg: "#10b98122", fg: "#047857", bd: "#10b98166" },
  "ติดปัญหา": { bg: "#ef444422", fg: "#b91c1c", bd: "#ef444466" },
  "ไม่ต้อง Redirect": { bg: "#6b728022", fg: "#4b5563", bd: "#6b728066" },
};

// "Problems first" sort order — most-attention-needed status floats up; unverified (blank) sinks.
export const SEVERITY = { "ติดปัญหา": 0, "รอดำเนินการ": 1, "ดำเนินการแล้ว": 2, "ไม่ต้อง Redirect": 3 };
export const severityRank = (s) => (s in SEVERITY ? SEVERITY[s] : 4);

// Deep-check issues Verify found on a row (file-set diff, empty/thin new page, soft-error body, auth
// wall) → tags that power the "deep check" filter. Empty when not deep-verified or clean. `c` = r.check.
export const ISSUE_KINDS = ["files", "thin", "error", "login"];
export function rowIssues(c) {
  if (!c || !c.bodyChecked) return [];
  const out = [];
  if (c.filesSame === false) out.push("files");                       // linked file set differs
  if (c.newBodyThin || (c.newOk && !c.newHasBody)) out.push("thin");  // new page is H1-only / empty
  if (c.newError || c.oldError) out.push("error");                    // 200-but-error / maintenance body
  if (c.newStatus === 401 || c.oldStatus === 401) out.push("login");  // behind HTTP Basic Auth
  return out;
}

// small pill used by the file/body cells
export const chip = (color) => ({ fontSize: 11, padding: "2px 7px", borderRadius: 999, color, border: `1px solid ${color}55`, background: `${color}14`, whiteSpace: "nowrap" });

export function downloadBlob(name, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}
export function download(name, text, mime) { downloadBlob(name, new Blob([text], { type: mime })); }

// open a URL (old or new) in a new tab — renders nothing when the cell has no value
export function OpenLink({ url, title }) {
  const u = (url || "").trim();
  if (!u) return null;
  const href = /^https?:\/\//i.test(u) ? u : `https://${u}`;
  return (
    <a href={href} target="_blank" rel="noreferrer" title={title}
       style={{ flexShrink: 0, textDecoration: "none", color: "var(--gold)", fontSize: 15, lineHeight: 1, padding: "0 3px" }}>↗</a>
  );
}

export function StatusBadge({ status }) {
  if (!status) return <span className="muted" style={{ fontSize: 11.5 }}>—</span>;
  const tn = STATUS_TONE[status] || STATUS_TONE["ไม่ต้อง Redirect"];
  return (
    <span style={{ fontSize: 11.5, padding: "2px 8px", borderRadius: 999, background: tn.bg, color: tn.fg, border: `1px solid ${tn.bd}`, whiteSpace: "nowrap" }}>
      {status}
    </span>
  );
}

// path-similarity % between the old URL and the matched real new URL (Discover, reading both sitemaps).
// 100 = exact path on the new site; lower = closest fuzzy match; "—" = no new sitemap.
export function MatchBadge({ score }) {
  if (score == null) return <span className="muted" style={{ fontSize: 11 }}>—</span>;
  const tone = score >= 90 ? "#10b981" : score >= 60 ? "#f59e0b" : "#ef4444";
  return (
    <span style={{ fontSize: 11.5, fontWeight: 700, padding: "2px 8px", borderRadius: 999, color: tone, border: `1px solid ${tone}55`, background: `${tone}14`, whiteSpace: "nowrap" }}>
      {score}%
    </span>
  );
}

// content state of one side's body: error screen (200-but-broken) → SPA → H1-only → real content → empty
export function bodyState(L, hasBody, thin, error, spa) {
  if (error) return { c: "#ef4444", t: `✖ ${error}` };       // soft-error page (e.g. "500")
  if (spa) return { c: "#3b82f6", t: L.bodySpa };            // browser-only (WAF/JS) — unreadable server-side
  if (thin) return { c: "#f59e0b", t: L.bodyH1Only };        // H1 only, no body
  if (hasBody) return { c: "#10b981", t: L.bodyHas };        // real content
  return { c: "#6b7280", t: L.bodyEmpty };                   // nothing
}

// per-row Files cell (filled by Verify's deep check; "—" until verified)
export function FilesCell({ L, c }) {
  if (!c || !c.bodyChecked) return <span className="muted" style={{ fontSize: 11.5 }}>—</span>;
  // browser-only page (WAF challenge / JS-injected links) — the server-side file list isn't reliable
  if (c.newSpa || c.oldSpa) return <span style={chip("#3b82f6")}>{L.fSpa}</span>;
  if (c.filesSame == null) return <span className="muted" style={{ fontSize: 11 }}>{L.fNoFiles}</span>;
  if (c.filesSame) return <span style={chip("#10b981")}>✓ {L.fSame.replace("{n}", c.oldFileCount)}</span>;
  const parts = [];
  if (c.filesOnlyOld && c.filesOnlyOld.length) parts.push(`${L.fGone}: ${c.filesOnlyOld.join(", ")}`);
  if (c.filesOnlyNew && c.filesOnlyNew.length) parts.push(`${L.fAdded}: ${c.filesOnlyNew.join(", ")}`);
  const title = `${L.fOld} ${c.oldFileCount} · ${L.fNew} ${c.newFileCount}${parts.length ? " · " + parts.join(" · ") : ""}`;
  return <span title={title} style={chip("#ef4444")}>✗ {L.fDiff} ({c.oldFileCount}/{c.newFileCount})</span>;
}

// per-row Body cell — old + new content state stacked
export function BodyCell({ L, c }) {
  if (!c || !c.bodyChecked) return <span className="muted" style={{ fontSize: 11.5 }}>—</span>;
  const o = bodyState(L, c.oldHasBody, c.oldBodyThin, c.oldError, c.oldSpa);
  const n = bodyState(L, c.newHasBody, c.newBodyThin, c.newError, c.newSpa);
  return (
    <span style={{ display: "inline-flex", flexDirection: "column", gap: 3 }}>
      <span style={{ ...chip(o.c), fontSize: 10.5 }}>{L.fOld}: {o.t}</span>
      <span style={{ ...chip(n.c), fontSize: 10.5 }}>{L.fNew}: {n.t}</span>
    </span>
  );
}

// HTTP status → verdict color + word; BigHttp is the pill shown in the detail panel
export function httpVerdict(L, code) {
  return code == null ? { c: "#6b7280", w: L.httpDead }
    : code >= 200 && code < 300 ? { c: "#10b981", w: L.httpOk }
    : code >= 300 && code < 400 ? { c: "#f59e0b", w: L.httpRedir }
    : { c: "#ef4444", w: L.httpErr };
}
export function BigHttp({ L, code }) {
  const v = httpVerdict(L, code);
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12.5, fontWeight: 700, color: v.c, border: `1px solid ${v.c}55`, background: `${v.c}14`, borderRadius: 999, padding: "3px 11px", whiteSpace: "nowrap" }}>
      {code == null ? "—" : code}<span style={{ fontWeight: 500, fontSize: 11 }}>{v.w}</span>
    </span>
  );
}

// --- shared style objects (static; imported by the screen, table + panels) ---
export const td = { padding: "12px 16px", borderBottom: "1px solid var(--line)", verticalAlign: "middle", fontSize: 13 };
export const th = { ...td, textAlign: "left", color: "var(--ink-3)", fontSize: 11.5, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".04em", position: "sticky", top: 0, background: "var(--bg-1)", zIndex: 1 };
export const cellInput = { width: "100%", border: "1px solid var(--line)", borderRadius: 8, padding: "9px 11px", background: "var(--bg)", color: "var(--ink)", fontSize: 13, fontFamily: "inherit" };
export const cellInputErr = { ...cellInput, borderColor: "#ef4444", boxShadow: "0 0 0 2px #ef444422" };   // red border while a required field is flagged empty
export const reqStar = { color: "#ef4444", fontWeight: 700 };
export const urlText = { flex: 1, minWidth: 0, fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--ink-2)", wordBreak: "break-all", lineHeight: 1.45 };
export const fieldL = { display: "flex", flexDirection: "column", gap: 4 };
export const fieldT = { fontSize: 11.5, color: "var(--ink-3)" };
export const urlCell = { display: "flex", gap: 6, alignItems: "flex-start" };
