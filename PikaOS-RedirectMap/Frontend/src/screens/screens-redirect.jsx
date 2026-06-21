/* URL Redirect Map — the one screen this standalone ships.
   The table holds just the mappings the user controls: Symbol · old URL · new URL (each URL
   openable in a new tab). Status / note / check-result are NOT manual columns — the system fills
   them: Verify probes both sides and sets each row's status+note, which surface in the summary
   tiles and the Excel export. "web.config" turns the rows into an IIS URL-Rewrite file; Discover
   pulls the old site's sitemap; CSV import + .xlsx export round-trip the central checklist. No nav,
   no login, no other modules. Rows are in-memory (cleared on F5) with a manual Save/Load snapshot;
   probe credentials are in-memory only — never persisted. */
import React from 'react';
const { useState, useEffect, useRef, useMemo } = React;
import { PageHead, Panel, Btn, Empty, StatTile } from '../components/components.jsx';
import { discoverUrls, verifyRows, genWebConfig, exportXlsx } from '../lib/api.js';
import { loadRows, saveRows, newRow, parseCsv, STATUSES, newCred } from '../data/redirect-rows.jsx';

// bilingual labels — this screen is self-contained, so it keeps its strings local (EN + TH)
const T = {
  en: {
    kicker: "Migration · old site → new site", title: "URL Redirect Map",
    desc: "Map each old-site URL to its new-site target, verify both sides, then generate an IIS web.config to set up the 301 redirects.",
    verify: "Verify all", verifying: "Verifying…", cancel: "Cancel", add: "+ Row", importCsv: "Import CSV",
    webconfig: "web.config", exportCsv: "Export Excel", clear: "Clear",
    btnSave: "Save", btnLoad: "Load",
    saved: "Saved {n} rows (this browser)", loaded: "Loaded {n} rows",
    saveEmpty: "Nothing to save", loadEmpty: "No saved data", loadConfirm: "Replace the current table with the saved data?",
    exported: "Exported {n} rows to Excel", exportEmpty: "Nothing to export",
    cTotal: "Rows", cPending: "Pending", cDone: "Done", cProblem: "Problem", cSkip: "No redirect",
    hNo: "#", hSym: "Symbol", hOld: "Old URL", hNew: "New URL", hMatch: "Match", hCheck: "Check", hStatus: "Status", hNote: "Note", open: "Open in a new tab",
    notePh: "e.g. new URL has no page, path changed, awaiting target confirmation",
    emptyT: "No mappings yet", emptyS: "Discover from the old site's sitemap, or import the checklist CSV.",
    old: "old", neu: "new", already: "↪ already set", ready: "ready",
    opts: "web.config options", type: "Redirect", appendQs: "Keep query string", trailing: "Match trailing slash",
    importErr: "Could not read that CSV", verified: "Verified {n} rows", imported: "Imported {n} rows", wcDone: "Generated {n} rules" ,
    canceled: "Canceled", netErr: "Backend unreachable — is it running?", skipped: "{n} row(s) skipped (missing URL)",
    statusBlank: "— set status —", confirmClear: "Clear all rows?",
    // merged pull + compare panel (many old sites/URLs → one new site)
    discTitle: "Pull + compare URLs", discSym: "Symbol", discSymPh: "e.g. WHA-UP",
    discNew: "New site (base URL)", discNewPh: "e.g. https://www.example.com",
    discOldList: "Old sites / URLs (add several)", discAddOld: "+ add old",
    phSym: "e.g. ABC", phOld: "e.g. https://old.example.com", phNew: "e.g. https://www.example.com/page",
    discSitemap: "Sitemap URL (optional)", discSitemapPh: "default: <old base>/sitemap.xml",
    discBusy: "Pulling…", discRun: "Pull sitemaps + verify",
    discHint: "Pull the sitemap of EACH old site → match every page onto the one new site → verify. Each run REPLACES the table with the new results (the old rows are cleared).",
    discNeed: "No URLs found in the sitemap — check the old-site URL / sitemap", discDone: "Added {n} URLs from the sitemap", discNone: "No new URLs (already in the table)",
    discNeedAll: "Fill Symbol, the new base URL, and at least one old URL/site", reqStar: "required",
    discSitemapErr: "Could not read the sitemap — check the URL is reachable and valid XML",
    // HTTP Basic Auth — sites behind a browser "Sign in" dialog (often UAT)
    authTitle: "Sites that need a login (Basic Auth)",
    authHint: "Just run verify — any site that answers 401 is added here automatically; you only fill in username + password. Or add one yourself: the host is pre-filled from the URLs you typed above. Matched by host; stored in this browser only.",
    authHostPh: "host, e.g. site.uat.example.com", authUserPh: "username", authPassPh: "password", authAdd: "+ add login",
    foundLogin: "Verified {n} rows · found {m} site(s) that need a login — fill in username/password below, then verify again",
    foundLoginSitemap: "That sitemap needs a login (401/403) — added the site below; fill in username/password and run again",
    verifyProg: "Verifying {done}/{total}…", canceledAt: "Canceled at {done}/{total}",
    fOld: "old", fNew: "new",
    // per-row file + body check (filled by Verify) — table columns + their cell text
    hFiles: "Files", hBody: "Body",
    fNoFiles: "no files", fSame: "same ({n})", fDiff: "differ", fSpa: "WAF/JS",
    fGone: "missing on new", fAdded: "added on new",
    bodyHas: "has content", bodyEmpty: "empty", bodyH1Only: "H1 only", bodySpa: "WAF/JS — open in browser",
    // expandable per-page detail
    dtNone: "Verify first to see page details", dtDetails: "details",
    dtOld: "Old page", dtNew: "New page", dtFiles: "Files", dtVerdict: "Verdict",
    dtHttp: "HTTP", dtRedir: "→ redirects to", dtFinal: "→ final URL", dtReach: "· reachable",
    dtH1yes: "present", dtH1no: "none", dtThinFlag: "H1 only — empty body",
    candTitle: "Close matches", candChosen: "✓ chosen",
    dtCounts: "count", dtMatched: "on both", dtMissing: "missing on new", dtAdded: "added on new",
    dtAlready: "old already 301s to the new URL", dtFallback: "fallback target",
    dtNoUrl: "no URL on this side", dtContent: "Content",
    httpOk: "reachable", httpRedir: "redirect", httpErr: "error", httpDead: "unreachable",
    mRemove: "remove",
    // filter / sort bar over the table
    fltSearch: "Search URL, Symbol or note", fltAll: "All statuses", fltSort: "Sort",
    fltSeverity: "Problems first", fltMatch: "Lowest match first", fltOrder: "Table order",
    fltShowing: "Showing", fltClear: "Clear filter", fltNoMatch: "No rows match the filter",
    // deep-check (v0.2) issue filter — only shown once rows have been deep-verified
    fltIssueAll: "Deep check: any", fltIssueAny: "Has an issue", fltIssueFiles: "Files differ",
    fltIssueThin: "New page empty / thin", fltIssueError: "Error page", fltIssueLogin: "Needs login (401)",
  },
  th: {
    kicker: "ย้ายเว็บ · เว็บเดิม → เว็บใหม่", title: "URL Redirect Map",
    desc: "แมพ URL เว็บเดิมไปเว็บใหม่ทีละตัว ตรวจทั้งสองฝั่ง แล้ว gen ไฟล์ IIS web.config ไปตั้ง 301 redirect.",
    verify: "ตรวจทั้งหมด", verifying: "กำลังตรวจ…", cancel: "ยกเลิก", add: "+ แถว", importCsv: "นำเข้า CSV",
    webconfig: "web.config", exportCsv: "ส่งออก Excel", clear: "ล้าง",
    btnSave: "บันทึก", btnLoad: "โหลด",
    saved: "บันทึก {n} แถวแล้ว (ในเครื่องนี้)", loaded: "โหลด {n} แถวแล้ว",
    saveEmpty: "ไม่มีข้อมูลให้บันทึก", loadEmpty: "ไม่มีข้อมูลที่บันทึกไว้", loadConfirm: "แทนที่ตารางปัจจุบันด้วยข้อมูลที่บันทึกไว้?",
    exported: "ส่งออก {n} แถว เป็น Excel", exportEmpty: "ไม่มีข้อมูลให้ส่งออก",
    cTotal: "ทั้งหมด", cPending: "รอดำเนินการ", cDone: "ดำเนินการแล้ว", cProblem: "ติดปัญหา", cSkip: "ไม่ต้อง Redirect",
    hNo: "#", hSym: "Symbol", hOld: "URL เดิม", hNew: "URL ใหม่", hMatch: "ใกล้เคียง", hCheck: "ผลตรวจ", hStatus: "สถานะ", hNote: "Note", open: "เปิดลิงก์ (แท็บใหม่)",
    notePh: "เช่น URL ใหม่ยังไม่มีหน้า, Path เปลี่ยน, ต้องรอยืนยันปลายทาง",
    emptyT: "ยังไม่มี mapping", emptyS: "ดึงจาก sitemap เว็บเดิม หรือ นำเข้า CSV.",
    old: "เดิม", neu: "ใหม่", already: "↪ ตั้งแล้ว", ready: "พร้อม",
    opts: "ตัวเลือก web.config", type: "Redirect", appendQs: "เก็บ query string", trailing: "match ทั้งมี/ไม่มี /",
    importErr: "อ่าน CSV ไม่ได้", verified: "ตรวจแล้ว {n} แถว", imported: "นำเข้า {n} แถว", wcDone: "สร้าง {n} rule",
    canceled: "ยกเลิกแล้ว", netErr: "ต่อ backend ไม่ได้ — รันอยู่ไหม?", skipped: "ข้าม {n} แถว (URL ไม่ครบ)",
    statusBlank: "— เลือกสถานะ —", confirmClear: "ล้างทุกแถว?",
    // merged pull + compare panel (เว็บเก่าหลายเว็บ/URL → เว็บใหม่ 1 เว็บ)
    discTitle: "ดึง + เปรียบเทียบ URL", discSym: "Symbol", discSymPh: "เช่น WHA-UP",
    discNew: "เว็บใหม่ (base URL)", discNewPh: "ตัวอย่าง: https://www.example.com",
    discOldList: "เว็บเก่า / URL เก่า (เพิ่มได้หลายอัน)", discAddOld: "+ เพิ่มเว็บเก่า",
    phSym: "ตัวอย่าง: ABC", phOld: "ตัวอย่าง: https://old.example.com", phNew: "ตัวอย่าง: https://www.example.com/page",
    discSitemap: "Sitemap URL (ไม่บังคับ)", discSitemapPh: "ค่าเริ่มต้น: <เว็บเก่า>/sitemap.xml",
    discBusy: "กำลังดึง…", discRun: "ดึง sitemap + ตรวจ",
    discHint: "ดึง sitemap ของเว็บเก่าแต่ละเว็บ → จับคู่ทุกหน้าไปเว็บใหม่เว็บเดียว → ตรวจ. กดแต่ละครั้งจะล้างตารางเดิมแล้วแสดงผลรอบใหม่.",
    discNeed: "ไม่พบ URL จาก sitemap — ตรวจ URL เว็บเก่า/sitemap อีกที", discDone: "เพิ่ม {n} URL จาก sitemap", discNone: "ไม่มี URL ใหม่ (มีในตารางแล้ว)",
    discNeedAll: "กรอก Symbol, เว็บใหม่ (base URL) และ เว็บเก่า/URL เก่า อย่างน้อย 1", reqStar: "บังคับกรอก",
    discSitemapErr: "อ่าน sitemap ไม่ได้ — ตรวจว่า URL เข้าถึงได้และเป็น XML ที่ถูกต้อง",
    // HTTP Basic Auth — เว็บที่เด้ง dialog ให้ล็อกอิน (มักเป็น UAT)
    authTitle: "เว็บที่ต้องล็อกอิน (Basic Auth)",
    authHint: "แค่กดตรวจ — เว็บไหนตอบ 401 ระบบเพิ่ม host ให้อัตโนมัติ คุณแค่กรอก username/password. หรือกดเพิ่มเอง host จะดึงจาก URL ที่พิมพ์ไว้ด้านบนมาใส่ให้. จับคู่ด้วย host; เก็บในเบราว์เซอร์นี้เท่านั้น.",
    authHostPh: "host เช่น site.uat.example.com", authUserPh: "username", authPassPh: "password", authAdd: "+ เพิ่มล็อกอิน",
    foundLogin: "ตรวจแล้ว {n} แถว · พบ {m} เว็บที่ต้องล็อกอิน — กรอก username/password ด้านล่าง แล้วกดตรวจอีกครั้ง",
    foundLoginSitemap: "Sitemap ต้องล็อกอิน (401/403) — เพิ่มเว็บให้ด้านล่างแล้ว กรอก username/password แล้วกดใหม่",
    verifyProg: "กำลังตรวจ {done}/{total}…", canceledAt: "ยกเลิกที่ {done}/{total}",
    fOld: "เก่า", fNew: "ใหม่",
    // per-row file + body check (filled by Verify) — table columns + their cell text
    hFiles: "ไฟล์", hBody: "Body",
    fNoFiles: "ไม่มีไฟล์", fSame: "เหมือน ({n})", fDiff: "ต่างกัน", fSpa: "กันบอต/JS",
    fGone: "หายบนใหม่", fAdded: "เพิ่มบนใหม่",
    bodyHas: "มีเนื้อหา", bodyEmpty: "ว่าง", bodyH1Only: "H1 ลอย", bodySpa: "กันบอต/JS — เปิดในเบราว์เซอร์",
    // expandable per-page detail
    dtNone: "กด Verify ก่อนเพื่อดูรายละเอียดหน้า", dtDetails: "รายละเอียด",
    dtOld: "หน้าเก่า", dtNew: "หน้าใหม่", dtFiles: "ไฟล์", dtVerdict: "สรุป",
    dtHttp: "HTTP", dtRedir: "→ redirect ไป", dtFinal: "→ ปลายทางจริง", dtReach: "· เข้าถึงได้",
    dtH1yes: "มี", dtH1no: "ไม่มี", dtThinFlag: "มีแค่ H1 — body ว่าง",
    candTitle: "URL ใกล้เคียง", candChosen: "✓ เลือกไว้",
    dtCounts: "จำนวน", dtMatched: "มีทั้ง 2", dtMissing: "หายบนใหม่", dtAdded: "เพิ่มบนใหม่",
    dtAlready: "เก่า 301 ไปใหม่แล้ว", dtFallback: "ปลายทางสำรอง",
    dtNoUrl: "ฝั่งนี้ไม่มี URL", dtContent: "เนื้อหา",
    httpOk: "ใช้งานได้", httpRedir: "redirect", httpErr: "error", httpDead: "เข้าถึงไม่ได้",
    mRemove: "ลบ",
    // filter / sort bar over the table
    fltSearch: "ค้นหา URL, Symbol หรือ note", fltAll: "ทุกสถานะ", fltSort: "เรียง",
    fltSeverity: "ปัญหาก่อน (ไล่ระดับ)", fltMatch: "Match น้อยสุดก่อน", fltOrder: "ตามลำดับตาราง",
    fltShowing: "แสดง", fltClear: "ล้างตัวกรอง", fltNoMatch: "ไม่มีแถวตรงตัวกรอง",
    // ตัวกรองผลตรวจเชิงลึก (v0.2) — โชว์เมื่อมีแถวที่ตรวจ deep แล้ว
    fltIssueAll: "ผลตรวจเชิงลึก: ทั้งหมด", fltIssueAny: "มีปัญหา", fltIssueFiles: "ไฟล์ไม่ตรงกัน",
    fltIssueThin: "หน้าใหม่ว่าง/เนื้อหาน้อย", fltIssueError: "หน้าเป็น error", fltIssueLogin: "ต้องล็อกอิน (401)",
  },
};

const STATUS_TONE = {
  "รอดำเนินการ": { bg: "#f59e0b22", fg: "#b45309", bd: "#f59e0b66" },
  "ดำเนินการแล้ว": { bg: "#10b98122", fg: "#047857", bd: "#10b98166" },
  "ติดปัญหา": { bg: "#ef444422", fg: "#b91c1c", bd: "#ef444466" },
  "ไม่ต้อง Redirect": { bg: "#6b728022", fg: "#4b5563", bd: "#6b728066" },
};

// "Problems first" sort order — most-attention-needed status floats to the top; unverified
// (blank status) sinks to the bottom. Used by the filter bar's default sort.
const SEVERITY = { "ติดปัญหา": 0, "รอดำเนินการ": 1, "ดำเนินการแล้ว": 2, "ไม่ต้อง Redirect": 3 };
const severityRank = (s) => (s in SEVERITY ? SEVERITY[s] : 4);

// Deep-check issues Verify found on a row (the v0.2 findings: file-set diff, empty/thin new page,
// soft-error body, auth wall) → tags that power the "deep check" filter. Empty when the row wasn't
// deep-verified or came back clean. `c` is r.check (the per-row verdict).
const ISSUE_KINDS = ["files", "thin", "error", "login"];
function rowIssues(c) {
  if (!c || !c.bodyChecked) return [];
  const out = [];
  if (c.filesSame === false) out.push("files");                       // linked file set differs
  if (c.newBodyThin || (c.newOk && !c.newHasBody)) out.push("thin");  // new page is H1-only / empty
  if (c.newError || c.oldError) out.push("error");                    // 200-but-error / maintenance body
  if (c.newStatus === 401 || c.oldStatus === 401) out.push("login");  // behind HTTP Basic Auth
  return out;
}

function StatusBadge({ status }) {
  if (!status) return <span className="muted" style={{ fontSize: 11.5 }}>—</span>;
  const tn = STATUS_TONE[status] || STATUS_TONE["ไม่ต้อง Redirect"];
  return (
    <span style={{ fontSize: 11.5, padding: "2px 8px", borderRadius: 999, background: tn.bg, color: tn.fg, border: `1px solid ${tn.bd}`, whiteSpace: "nowrap" }}>
      {status}
    </span>
  );
}

// path-similarity % between the old URL and the matched real new URL (from Discover reading both
// sitemaps). 100 = exact path on the new site; lower = closest fuzzy match; "—" = no new sitemap.
function MatchBadge({ score }) {
  if (score == null) return <span className="muted" style={{ fontSize: 11 }}>—</span>;
  const tone = score >= 90 ? "#10b981" : score >= 60 ? "#f59e0b" : "#ef4444";
  return (
    <span style={{ fontSize: 11.5, fontWeight: 700, padding: "2px 8px", borderRadius: 999, color: tone, border: `1px solid ${tone}55`, background: `${tone}14`, whiteSpace: "nowrap" }}>
      {score}%
    </span>
  );
}

// small pill used by the file/body cells
const chip = (color) => ({ fontSize: 11, padding: "2px 7px", borderRadius: 999, color, border: `1px solid ${color}55`, background: `${color}14`, whiteSpace: "nowrap" });

function downloadBlob(name, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}
function download(name, text, mime) { downloadBlob(name, new Blob([text], { type: mime })); }

// open a URL (old or new) in a new tab — only rendered when the cell has a value
function OpenLink({ url, title }) {
  const u = (url || "").trim();
  if (!u) return null;
  const href = /^https?:\/\//i.test(u) ? u : `https://${u}`;
  return (
    <a href={href} target="_blank" rel="noreferrer" title={title}
       style={{ flexShrink: 0, textDecoration: "none", color: "var(--gold)", fontSize: 15, lineHeight: 1, padding: "0 3px" }}>↗</a>
  );
}

export function Redirect({ lang = "en" }) {
  const L = T[lang] || T.en;
  // In-memory by default: a refresh (F5) clears the table — data is NOT auto-persisted. The user
  // explicitly saves/loads a snapshot via the toolbar (saveRows/loadRows). hasSnapshot drives the
  // "Load" button's enabled state.
  const [rows, setRows] = useState([]);
  const [hasSnapshot, setHasSnapshot] = useState(() => loadRows().length > 0);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);                // { text, tone }
  const [opts, setOpts] = useState({ redirectType: "Permanent", appendQueryString: false, matchTrailingSlash: true });
  // ONE merged panel: many OLD sites/URLs → one NEW site. `olds` is a list (sitemap source per old
  // site, or a specific old URL); `newBase` is the single consolidated new site everything maps to.
  const [disc, setDisc] = useState({ symbol: "", newBase: "", olds: [""], sitemapUrl: "" });
  const [discBusy, setDiscBusy] = useState(false);
  const [discErr, setDiscErr] = useState({});          // { symbol, newBase, olds } flagged empty on submit
  const [expanded, setExpanded] = useState({});        // { [rowId]: true } — rows whose page-detail is open
  // HTTP Basic Auth per host (sites behind a login). In-memory only — credentials (passwords) are
  // never persisted; a refresh clears them.
  const [creds, setCreds] = useState([]);
  const [showAuth, setShowAuth] = useState(false);
  const abortRef = useRef(null);
  const fileRef = useRef(null);

  const counts = useMemo(() => {
    const c = { total: rows.length, "รอดำเนินการ": 0, "ดำเนินการแล้ว": 0, "ติดปัญหา": 0, "ไม่ต้อง Redirect": 0 };
    rows.forEach((r) => { if (c[r.status] != null) c[r.status]++; });
    return c;
  }, [rows]);

  // filter + sort the table view (display only — never mutates `rows`, so Verify / web.config /
  // export still operate on the full set). Each item keeps its original 1-based number (`no`).
  const [filter, setFilter] = useState({ q: "", status: "", issue: "", sort: "severity" });
  // how many rows carry each deep-check issue (drives the issue dropdown counts + whether to show it)
  const issueCounts = useMemo(() => {
    const c = { any: 0, files: 0, thin: 0, error: 0, login: 0, checked: 0 };
    rows.forEach((r) => {
      if (r.check && r.check.bodyChecked) c.checked++;
      const tags = rowIssues(r.check);
      if (tags.length) c.any++;
      tags.forEach((t) => { c[t]++; });
    });
    return c;
  }, [rows]);
  const view = useMemo(() => {
    const q = filter.q.trim().toLowerCase();
    let list = rows.map((r, i) => ({ r, no: i + 1 }));
    if (q) list = list.filter(({ r }) =>
      (r.symbol || "").toLowerCase().includes(q) ||
      (r.oldUrl || "").toLowerCase().includes(q) ||
      (r.newUrl || "").toLowerCase().includes(q) ||
      (r.note || "").toLowerCase().includes(q));
    if (filter.status) list = list.filter(({ r }) => r.status === filter.status);
    if (filter.issue) list = list.filter(({ r }) => {
      const tags = rowIssues(r.check);
      return filter.issue === "any" ? tags.length > 0 : tags.includes(filter.issue);
    });
    if (filter.sort === "severity")
      list = list.slice().sort((a, b) => severityRank(a.r.status) - severityRank(b.r.status) || a.no - b.no);
    else if (filter.sort === "match") {
      const ms = (x) => (x.r.matchScore == null ? 101 : x.r.matchScore);   // worst (lowest) match first, blanks last
      list = list.slice().sort((a, b) => ms(a) - ms(b) || a.no - b.no);
    }
    return list;
  }, [rows, filter]);
  const setStatusFilter = (s) => setFilter((f) => ({ ...f, status: f.status === s ? "" : s }));
  const filterActive = filter.q.trim() || filter.status || filter.issue;

  const toggleExpand = (id) => setExpanded((e) => ({ ...e, [id]: !e[id] }));
  const notice = (text, tone = "ok") => setMsg({ text, tone });
  const fill = (tpl, n) => tpl.replace("{n}", n);
  const fill2 = (tpl, done, total) => tpl.replace("{done}", done).replace("{total}", total);
  const fillNM = (tpl, n, m) => tpl.replace("{n}", n).replace("{m}", m);
  // matchScore is sent so verify can warn when the matched new URL's path is far from the old one
  const strip = (r) => ({ symbol: r.symbol, oldUrl: r.oldUrl, newUrl: r.newUrl, status: r.status, note: r.note, matchScore: r.matchScore == null ? null : r.matchScore, candidates: r.candidates || [], collision: !!r.collision });
  // export row = the mapping + ALL the verify findings (flattened from r.check) so the Excel
  // "Verify Detail" sheet carries everything: HTTP per side, body state, files, match %.
  const exportRow = (r) => {
    const c = r.check || {};
    return {
      symbol: r.symbol, oldUrl: r.oldUrl, newUrl: r.newUrl, status: r.status, note: r.note,
      matchScore: r.matchScore == null ? null : r.matchScore,
      candidates: r.candidates || [], collision: !!r.collision,
      oldStatus: c.oldStatus == null ? null : c.oldStatus, oldRedirectsTo: c.oldRedirectsTo || null, oldReachable: !!c.oldReachable,
      newStatus: c.newStatus == null ? null : c.newStatus, newFinalUrl: c.newFinalUrl || null, newOk: !!c.newOk,
      alreadyRedirected: !!c.alreadyRedirected, suggestedTarget: c.suggestedTarget || null,
      oldHasBody: !!c.oldHasBody, newHasBody: !!c.newHasBody, oldBodyThin: !!c.oldBodyThin, newBodyThin: !!c.newBodyThin,
      oldHasH1: !!c.oldHasH1, newHasH1: !!c.newHasH1, oldError: c.oldError || "", newError: c.newError || "",
      oldSpa: !!c.oldSpa, newSpa: !!c.newSpa,
      bodyChecked: !!c.bodyChecked,
      oldFileCount: c.oldFileCount || 0, newFileCount: c.newFileCount || 0, filesSame: c.filesSame == null ? null : c.filesSame,
      filesMatched: c.filesMatched || [], filesOnlyOld: c.filesOnlyOld || [], filesOnlyNew: c.filesOnlyNew || [],
    };
  };

  // Symbol + the new base + at least one old are REQUIRED. Update a single field and clear its error
  // so the red border drops as the user types.
  const setDiscField = (k, v) => { setDisc((d) => ({ ...d, [k]: v })); setDiscErr((x) => (x[k] ? { ...x, [k]: false } : x)); };
  // old-site list handlers
  const setOldUrl = (i, v) => { setDisc((d) => { const arr = d.olds.slice(); arr[i] = v; return { ...d, olds: arr }; }); setDiscErr((x) => (x.olds ? { ...x, olds: false } : x)); };
  const addOld = () => setDisc((d) => ({ ...d, olds: [...d.olds, ""] }));
  const delOld = (i) => setDisc((d) => { const arr = d.olds.filter((_, j) => j !== i); return { ...d, olds: arr.length ? arr : [""] }; });
  const oldList = () => disc.olds.map((u) => u.trim()).filter(Boolean);   // non-empty old entries
  const validateDisc = () => {
    const err = { symbol: !disc.symbol.trim(), newBase: !disc.newBase.trim(), olds: !oldList().length };
    setDiscErr(err);
    return !err.symbol && !err.newBase && !err.olds;
  };

  // HTTP Basic Auth credentials (per host) — sent with discover + verify so a gated (UAT) site
  // probes through its 401 instead of being reported as blocked.
  const hostOf = (url) => {                       // hostname of a URL or bare host, lowercased ("" if none)
    const v = (url || "").trim();
    if (!v) return "";
    try { return new URL(/^https?:\/\//i.test(v) ? v : `https://${v}`).hostname.toLowerCase(); } catch (e) { return ""; }
  };
  // hosts the user already typed in the discover panel (new base + old sites) — the source we
  // prefill a new login row from, so the host doesn't have to be retyped.
  const enteredHosts = () => [...new Set([disc.newBase, ...disc.olds].map(hostOf).filter(Boolean))];
  const credHostSet = () => new Set(creds.map((c) => hostOf(c.host)).filter(Boolean));

  const setCredField = (i, k, v) => setCreds((cs) => { const arr = cs.slice(); arr[i] = { ...arr[i], [k]: v }; return arr; });
  // + add login: prefill the host with the first typed-but-not-yet-credentialed site (else blank)
  const addCred = () => {
    const have = credHostSet();
    const cand = enteredHosts().find((h) => !have.has(h)) || "";
    setCreds((cs) => [...cs, newCred({ host: cand })]);
    setShowAuth(true);
  };
  const delCred = (i) => setCreds((cs) => cs.filter((_, j) => j !== i));
  // auto-add hosts the system found to need a login (probed 401) — empty user/pass for the user to
  // fill. Opens the Login section. Returns how many NEW hosts were added.
  const addLoginHosts = (hosts) => {
    const have = credHostSet();
    const fresh = [...new Set(hosts.map(hostOf).filter(Boolean))].filter((h) => !have.has(h));
    if (fresh.length) { setCreds((cs) => [...cs, ...fresh.map((h) => newCred({ host: h }))]); setShowAuth(true); }
    return fresh.length;
  };
  // only complete entries (host + username) go on the wire; backend matches by host (full URL ok)
  const credPayload = () => creds
    .map((c) => ({ host: c.host.trim(), username: c.username, password: c.password }))
    .filter((c) => c.host && c.username);

  // per-row file / body cells (filled by Verify's deep check; "—" until verified)
  const renderFiles = (c) => {
    if (!c || !c.bodyChecked) return <span className="muted" style={{ fontSize: 11.5 }}>—</span>;
    // browser-only page (WAF challenge / JS-injected links) — the server-side file list isn't reliable
    if (c.newSpa || c.oldSpa) return <span style={chip("#3b82f6")}>{L.fSpa}</span>;
    if (c.filesSame == null) return <span className="muted" style={{ fontSize: 11 }}>{L.fNoFiles}</span>;
    if (c.filesSame) return <span style={chip("#10b981")}>✓ {fill(L.fSame, c.oldFileCount)}</span>;
    const parts = [];
    if (c.filesOnlyOld && c.filesOnlyOld.length) parts.push(`${L.fGone}: ${c.filesOnlyOld.join(", ")}`);
    if (c.filesOnlyNew && c.filesOnlyNew.length) parts.push(`${L.fAdded}: ${c.filesOnlyNew.join(", ")}`);
    const title = `${L.fOld} ${c.oldFileCount} · ${L.fNew} ${c.newFileCount}${parts.length ? " · " + parts.join(" · ") : ""}`;
    return <span title={title} style={chip("#ef4444")}>✗ {L.fDiff} ({c.oldFileCount}/{c.newFileCount})</span>;
  };
  // content state of one side's body: error screen (200-but-broken) → H1-only → real content → empty
  const bodyState = (hasBody, thin, error, spa) => {
    if (error) return { c: "#ef4444", t: `✖ ${error}` };       // soft-error page (e.g. "500")
    if (spa) return { c: "#3b82f6", t: L.bodySpa };            // browser-only (WAF/JS) — unreadable server-side
    if (thin) return { c: "#f59e0b", t: L.bodyH1Only };        // H1 only, no body
    if (hasBody) return { c: "#10b981", t: L.bodyHas };        // real content
    return { c: "#6b7280", t: L.bodyEmpty };                   // nothing
  };
  const renderBody = (c) => {
    if (!c || !c.bodyChecked) return <span className="muted" style={{ fontSize: 11.5 }}>—</span>;
    const o = bodyState(c.oldHasBody, c.oldBodyThin, c.oldError, c.oldSpa);
    const n = bodyState(c.newHasBody, c.newBodyThin, c.newError, c.newSpa);
    return (
      <span style={{ display: "inline-flex", flexDirection: "column", gap: 3 }}>
        <span style={{ ...chip(o.c), fontSize: 10.5 }}>{L.fOld}: {o.t}</span>
        <span style={{ ...chip(n.c), fontSize: 10.5 }}>{L.fNew}: {n.t}</span>
      </span>
    );
  };

  // expandable per-page detail — a clean side-by-side OLD vs NEW comparison (the full HTTP / body /
  // file info Verify gathered). Each side is a card; files + verdict sit full-width below.
  const httpVerdict = (code) =>
    code == null ? { c: "#6b7280", w: L.httpDead }
    : code >= 200 && code < 300 ? { c: "#10b981", w: L.httpOk }
    : code >= 300 && code < 400 ? { c: "#f59e0b", w: L.httpRedir }
    : { c: "#ef4444", w: L.httpErr };
  const bigHttp = (code) => {
    const v = httpVerdict(code);
    return (
      <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12.5, fontWeight: 700, color: v.c, border: `1px solid ${v.c}55`, background: `${v.c}14`, borderRadius: 999, padding: "3px 11px", whiteSpace: "nowrap" }}>
        {code == null ? "—" : code}<span style={{ fontWeight: 500, fontSize: 11 }}>{v.w}</span>
      </span>
    );
  };
  const renderDetail = (r) => {
    const c = r.check;
    if (!c || !c.bodyChecked) return <span className="muted" style={{ fontSize: 12 }}>{L.dtNone}</span>;
    const mono = { fontFamily: "var(--font-mono)", fontSize: 11.5, color: "var(--ink-2)", wordBreak: "break-all" };
    const dRow = (k, v) => (v == null || v === "" ? null : (
      <div style={{ display: "flex", gap: 10, alignItems: "baseline", padding: "3px 0" }}>
        <span style={{ minWidth: 70, flexShrink: 0, color: "var(--ink-3)", fontSize: 11.5 }}>{k}</span>
        <span style={{ fontSize: 12, color: "var(--ink-2)", wordBreak: "break-all", flex: 1 }}>{v}</span>
      </div>
    ));
    const bodyPill = (hasBody, thin, error, spa) => {
      const s = bodyState(hasBody, thin, error, spa);
      return <span style={{ display: "inline-flex", alignItems: "center", gap: 6, color: s.c, fontSize: 12 }}>
        <span style={{ width: 7, height: 7, borderRadius: 999, background: s.c, flexShrink: 0 }} />{s.t}</span>;
    };
    const sideCard = (title, url, status, body) => (
      <div style={{ flex: "1 1 320px", minWidth: 268, border: "1px solid var(--line)", borderRadius: 10, padding: "11px 13px", background: "var(--bg)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginBottom: 8 }}>
          <span style={{ fontWeight: 700, fontSize: 12.5, color: "var(--ink)" }}>{title}</span>
          {bigHttp(status)}
        </div>
        {url
          ? <div style={{ ...mono, marginBottom: 6, display: "flex", gap: 6, alignItems: "flex-start" }}><span style={{ flex: 1 }}>{url}</span><OpenLink url={url} title={L.open} /></div>
          : <div className="muted" style={{ fontSize: 11.5, marginBottom: 6 }}>{L.dtNoUrl}</div>}
        {body}
      </div>
    );
    const fileLine = (label, arr, color) => (arr && arr.length ? (
      <div style={{ display: "flex", gap: 8, alignItems: "baseline", padding: "2px 0" }}>
        <span style={{ minWidth: 92, flexShrink: 0, color, fontSize: 11.5 }}>{label}</span>
        <span style={mono}>{arr.join(", ")}</span>
      </div>
    ) : null);
    const hasFiles = c.oldFileCount || c.newFileCount;
    const hasVerdict = c.alreadyRedirected || c.suggestedTarget;
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
          {sideCard(L.dtOld, r.oldUrl, c.oldStatus, <>
            {dRow(L.dtContent, bodyPill(c.oldHasBody, c.oldBodyThin, c.oldError, c.oldSpa))}
            {dRow("H1", c.oldHasH1 ? L.dtH1yes : L.dtH1no)}
            {c.oldRedirectsTo && dRow(L.dtRedir, <span style={mono}>{c.oldRedirectsTo}</span>)}
          </>)}
          {sideCard(L.dtNew, r.newUrl, c.newStatus, <>
            {dRow(L.dtContent, bodyPill(c.newHasBody, c.newBodyThin, c.newError, c.newSpa))}
            {dRow("H1", c.newHasH1 ? L.dtH1yes : L.dtH1no)}
            {c.newFinalUrl && c.newFinalUrl !== r.newUrl && dRow(L.dtFinal, <span style={mono}>{c.newFinalUrl}</span>)}
          </>)}
        </div>
        {(hasFiles || hasVerdict) && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 24, padding: "2px 2px 0" }}>
            {hasFiles ? (
              <div style={{ flex: "1 1 320px", minWidth: 268 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: ".04em", marginBottom: 4 }}>{L.dtFiles}</div>
                {dRow(L.dtCounts, `${L.fOld} ${c.oldFileCount} · ${L.fNew} ${c.newFileCount}`)}
                {fileLine(L.dtMatched, c.filesMatched, "#047857")}
                {fileLine(L.dtMissing, c.filesOnlyOld, "#b91c1c")}
                {fileLine(L.dtAdded, c.filesOnlyNew, "#b45309")}
              </div>
            ) : null}
            {hasVerdict ? (
              <div style={{ flex: "1 1 280px", minWidth: 240 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: ".04em", marginBottom: 4 }}>{L.dtVerdict}</div>
                {c.alreadyRedirected && <div style={{ color: "#047857", fontSize: 12, padding: "2px 0" }}>✓ {L.dtAlready}</div>}
                {c.suggestedTarget && dRow(L.dtFallback, <span style={mono}>{c.suggestedTarget}</span>)}
              </div>
            ) : null}
          </div>
        )}
        {r.candidates && r.candidates.length > 1 && (
          <div style={{ padding: "4px 2px 0" }}>{renderCandidates(r)}</div>
        )}
      </div>
    );
  };

  // read-only "close matches" list (from Discover's fuzzy ranking) — shown in the page-detail panel.
  // Helps decide whether the chosen new URL is right; each is openable, nothing is changed.
  const renderCandidates = (r) => {
    const list = r.candidates || [];
    if (!list.length) return <span className="muted" style={{ fontSize: 12 }}>—</span>;
    return (
      <div>
        <div style={{ fontSize: 11, fontWeight: 700, color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: ".04em", marginBottom: 6 }}>{L.candTitle}</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {list.map((c, i) => {
            const chosen = c.url === r.newUrl;
            const tone = c.score >= 90 ? "#10b981" : c.score >= 60 ? "#f59e0b" : "#ef4444";
            return (
              <div key={i} style={{ display: "flex", gap: 10, alignItems: "baseline", padding: "2px 0" }}>
                <span style={{ minWidth: 46, flexShrink: 0, fontSize: 11.5, fontWeight: 700, color: tone }}>{c.score}%</span>
                <span style={{ flex: 1, fontFamily: "var(--font-mono)", fontSize: 11.5, color: "var(--ink-2)", wordBreak: "break-all" }}>
                  {c.url}
                  {chosen && <span style={{ marginLeft: 6, fontSize: 10, fontWeight: 700, color: "#10b981" }}>{L.candChosen}</span>}
                </span>
                <OpenLink url={c.url} title={L.open} />
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  const delRow = (id) => setRows((rs) => rs.filter((r) => r.id !== id));
  const clearAll = async () => {
    if (window.uiConfirm && !(await window.uiConfirm({ title: L.confirmClear, danger: true }))) return;
    setRows([]);
  };

  // Manual snapshot (the only persistence): Save writes the current rows to localStorage; Load
  // restores them. A refresh starts empty, so the user decides what is kept.
  const doSaveSnapshot = () => {
    if (!rows.length) { notice(L.saveEmpty, "warn"); return; }
    saveRows(rows);
    setHasSnapshot(true);
    notice(fill(L.saved, rows.length));
  };
  const doLoadSnapshot = async () => {
    const loaded = loadRows();
    if (!loaded.length) { notice(L.loadEmpty, "warn"); return; }
    if (rows.length && window.uiConfirm && !(await window.uiConfirm({ title: L.loadConfirm }))) return;
    setRows(loaded);
    notice(fill(L.loaded, loaded.length));
  };

  const onImport = (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = parseCsv(String(reader.result || ""));
        if (!parsed.length) throw new Error("empty");
        setRows(parsed);
        notice(fill(L.imported, parsed.length));
      } catch (err) { notice(L.importErr, "err"); }
    };
    reader.readAsText(f, "utf-8");
    e.target.value = "";   // allow re-importing the same file
  };

  // verify a list of rows in chunks → fills status+note live (streamed like Compare so a whole
  // sitemap of hundreds of rows fills progressively and never overruns the dev-proxy timeout)
  const verifyList = async (targetRows, ctrl) => {
    const CHUNK = 25;
    const credentials = credPayload();   // same Basic-Auth set for every chunk
    const needLogin = new Set();         // hosts that answered 401 → the system surfaces them for login
    let done = 0;
    for (let i = 0; i < targetRows.length; i += CHUNK) {
      const chunk = targetRows.slice(i, i + CHUNK);
      const out = await verifyRows({ rows: chunk.map(strip), credentials }, ctrl.signal);
      (out.results || []).forEach((v, k) => {
        if (!v) return;
        if (v.oldStatus === 401) needLogin.add(hostOf(chunk[k].oldUrl));
        if (v.newStatus === 401) needLogin.add(hostOf(chunk[k].newUrl));
      });
      setRows((rs) => rs.map((r) => {
        const idx = chunk.findIndex((c) => c.id === r.id);
        const v = idx >= 0 ? out.results[idx] : null;
        if (!v) return r;
        const check = {
          bodyChecked: v.bodyChecked,
          filesSame: v.filesSame, oldFileCount: v.oldFileCount, newFileCount: v.newFileCount,
          filesMatched: v.filesMatched, filesOnlyOld: v.filesOnlyOld, filesOnlyNew: v.filesOnlyNew,
          oldBodyThin: v.oldBodyThin, newBodyThin: v.newBodyThin, oldHasH1: v.oldHasH1, newHasH1: v.newHasH1,
          oldHasBody: v.oldHasBody, newHasBody: v.newHasBody, oldError: v.oldError, newError: v.newError,
          // HTTP probe detail (per page) — surfaced in the expandable row detail
          oldStatus: v.oldStatus, oldRedirectsTo: v.oldRedirectsTo, oldReachable: v.oldReachable,
          newStatus: v.newStatus, newFinalUrl: v.newFinalUrl, newOk: v.newOk,
          alreadyRedirected: v.alreadyRedirected, suggestedTarget: v.suggestedTarget,
        };
        return { ...r, status: v.suggestedStatus, note: v.suggestedNote, check };
      }));
      done += chunk.length;
      if (done < targetRows.length) notice(fill2(L.verifyProg, done, targetRows.length), "ok");
    }
    return { done, needLogin: [...needLogin].filter(Boolean) };
  };

  // "Pull sitemaps + verify": for EACH old site, read its sitemap → domain-swap onto the single new
  // base → collect rows; then verify the whole set. Many old sites → one new site, in one click.
  const doRun = async () => {
    if (busy || discBusy) return;
    if (!validateDisc()) { notice(L.discNeedAll, "warn"); return; }
    const ctrl = new AbortController(); abortRef.current = ctrl;
    const newBase = disc.newBase.trim(), symbol = disc.symbol.trim();
    const olds = oldList();
    const credentials = credPayload();   // Basic Auth for any gated old/new site (or its sitemap)
    // each run starts FRESH — pressing 🚀 replaces the whole table with this run's results (the old
    // rows are cleared). On an error mid-discover we never reach setRows, so the old table is kept.
    let allRows = [];
    try {
      setDiscBusy(true); notice(L.discBusy, "ok");
      const keyOf = (r) => (r.oldUrl ? "O:" + r.oldUrl : "N:" + r.newUrl);   // dedup within this run
      const have = new Set(allRows.map(keyOf));
      for (const oldBase of olds) {
        const body = { oldBase, newBase, symbol, credentials };
        if (olds.length === 1 && disc.sitemapUrl.trim()) body.sitemapUrl = disc.sitemapUrl.trim();
        const out = await discoverUrls(body, ctrl.signal);
        const add = (out.rows || []).filter((r) => (r.oldUrl || r.newUrl) && !have.has(keyOf(r)))
          .map((r) => newRow({ symbol: r.symbol || symbol, oldUrl: r.oldUrl, newUrl: r.newUrl, matchScore: r.matchScore, candidates: r.candidates || [], collision: !!r.collision }));
        add.forEach((r) => have.add(keyOf(r)));
        allRows = [...allRows, ...add];
      }
      setRows(allRows);
      setDiscBusy(false);
      if (!allRows.length) { notice(L.discNeed, "warn"); abortRef.current = null; return; }
      setBusy(true);
      const { done, needLogin } = await verifyList(allRows, ctrl);
      const added = needLogin.length ? addLoginHosts(needLogin) : 0;
      if (added) notice(fillNM(L.foundLogin, done, added), "warn");
      else notice(fill(L.verified, done));
    } catch (err) {
      if (err && err.name === "AbortError") notice(L.canceled, "warn");
      else if (err && err.status === 0) notice(L.netErr, "err");
      else if (err && err.status === 502) {
        // a gated sitemap (401/403) is also a "needs login" signal — pull the host out of the
        // error's URL and surface it for login instead of a dead-end "couldn't read sitemap".
        const detail = (err.data && err.data.detail) || err.message || "";
        const m = /HTTP (401|403)/.test(detail) ? detail.match(/https?:\/\/\S+/) : null;
        const added = m ? addLoginHosts([hostOf(m[0])]) : 0;
        notice(added ? L.foundLoginSitemap : L.discSitemapErr, added ? "warn" : "err");
      }
      else notice((err && err.message) || L.netErr, "err");
    } finally { setBusy(false); setDiscBusy(false); abortRef.current = null; }
  };

  const cancelRun = () => abortRef.current && abortRef.current.abort();

  const doWebConfig = async () => {
    try {
      const payload = { rows: rows.map((r) => ({ symbol: r.symbol, oldUrl: r.oldUrl, newUrl: r.newUrl })), ...opts };
      const out = await genWebConfig(payload);
      download("web.config", out.xml, "application/xml");
      let m = fill(L.wcDone, out.ruleCount);
      if (out.skipped && out.skipped.length) m += " · " + fill(L.skipped, out.skipped.length);
      notice(m);
    } catch (err) { notice((err && err.message) || L.netErr, "err"); }
  };

  // Export filename: "{Symbol} - Redirectmap - {YYYYMMDD}.xlsx". Symbol is taken from the first
  // tagged row (one export is normally one site); the number is today's date. Both are sanitized so
  // the name is filesystem-safe; falls back to "Redirect" when no row carries a Symbol.
  const exportFilename = () => {
    const tagged = rows.find((r) => r.symbol && r.symbol.trim());
    const name = (tagged ? tagged.symbol : "Redirect").trim().replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, " ").trim();
    const d = new Date();
    const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
    return `${name} - Redirectmap - ${ymd}.xlsx`;
  };
  const doExport = async () => {
    if (!rows.length) { notice(L.exportEmpty, "warn"); return; }
    try {
      const blob = await exportXlsx({ rows: rows.map(exportRow) });
      downloadBlob(exportFilename(), blob);
      notice(fill(L.exported, rows.length));
    } catch (err) {
      if (err && err.status === 0) notice(L.netErr, "err");
      else notice((err && err.message) || L.netErr, "err");
    }
  };

  const td = { padding: "12px 16px", borderBottom: "1px solid var(--line)", verticalAlign: "middle", fontSize: 13 };
  const th = { ...td, textAlign: "left", color: "var(--ink-3)", fontSize: 11.5, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".04em", position: "sticky", top: 0, background: "var(--bg-1)", zIndex: 1 };
  const cellInput = { width: "100%", border: "1px solid var(--line)", borderRadius: 8, padding: "9px 11px", background: "var(--bg)", color: "var(--ink)", fontSize: 13, fontFamily: "inherit" };
  const cellInputErr = { ...cellInput, borderColor: "#ef4444", boxShadow: "0 0 0 2px #ef444422" };
  const dInput = (k) => (discErr[k] ? cellInputErr : cellInput);   // red border while a required field is flagged empty
  const reqStar = { color: "#ef4444", fontWeight: 700 };
  // read-only URL text — shown in full (wraps), monospace, with an open-in-new-tab affordance
  const urlText = { flex: 1, minWidth: 0, fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--ink-2)", wordBreak: "break-all", lineHeight: 1.45 };
  const fieldL = { display: "flex", flexDirection: "column", gap: 4 };
  const fieldT = { fontSize: 11.5, color: "var(--ink-3)" };
  const urlCell = { display: "flex", gap: 6, alignItems: "flex-start" };

  const msgTone = { ok: "#10b981", warn: "#f59e0b", err: "#ef4444" };

  return (
    <div style={{ maxWidth: 1280, margin: "0 auto", padding: "18px 22px 60px" }}>
      <PageHead kicker={L.kicker} title={L.title} desc={L.desc} tag="local" />

      {/* tiles double as a one-click status filter — click "ติดปัญหา" to see only the problem rows */}
      <div className="row" style={{ gap: 10, flexWrap: "wrap", margin: "6px 0 16px" }}>
        <StatTile label={L.cTotal} value={counts.total} icon="🔗" onClick={() => setFilter((f) => ({ ...f, status: "" }))} active={!filter.status} />
        <StatTile label={L.cPending} value={counts["รอดำเนินการ"]} icon="⏳" onClick={() => setStatusFilter("รอดำเนินการ")} active={filter.status === "รอดำเนินการ"} />
        <StatTile label={L.cDone} value={counts["ดำเนินการแล้ว"]} icon="✅" onClick={() => setStatusFilter("ดำเนินการแล้ว")} active={filter.status === "ดำเนินการแล้ว"} />
        <StatTile label={L.cProblem} value={counts["ติดปัญหา"]} icon="⚠️" onClick={() => setStatusFilter("ติดปัญหา")} active={filter.status === "ติดปัญหา"} />
        <StatTile label={L.cSkip} value={counts["ไม่ต้อง Redirect"]} icon="🚫" onClick={() => setStatusFilter("ไม่ต้อง Redirect")} active={filter.status === "ไม่ต้อง Redirect"} />
      </div>

      <div className="row" style={{ gap: 8, flexWrap: "wrap", marginBottom: 12, alignItems: "center" }}>
        <Btn kind="ghost" sm icon="📥" onClick={() => fileRef.current && fileRef.current.click()}>{L.importCsv}</Btn>
        <input ref={fileRef} type="file" accept=".csv,text/csv" onChange={onImport} style={{ display: "none" }} />
        <Btn kind="ghost" sm icon="📊" onClick={doExport}>{L.exportCsv}</Btn>
        <Btn kind="gold" sm icon="⚙️" onClick={doWebConfig}>{L.webconfig}</Btn>
        <span style={{ flex: 1 }} />
        {/* manual snapshot — the only persistence (F5 starts empty) */}
        <Btn kind="ghost" sm icon="💾" onClick={doSaveSnapshot}>{L.btnSave}</Btn>
        <Btn kind="ghost" sm icon="📂" onClick={doLoadSnapshot} disabled={!hasSnapshot}>{L.btnLoad}</Btn>
        <Btn kind="ghost" sm icon="🗑" onClick={clearAll}>{L.clear}</Btn>
      </div>

      {msg && (
        <div style={{ margin: "0 0 12px", padding: "8px 12px", borderRadius: 8, fontSize: 13, border: `1px solid ${msgTone[msg.tone] || msgTone.ok}55`, background: `${msgTone[msg.tone] || msgTone.ok}14`, color: msgTone[msg.tone] || msgTone.ok }}>
          {msg.text}
        </div>
      )}

      {/* ONE merged panel — many OLD sites/URLs → one NEW site. 'Pull sitemaps' discovers per old
          site; 'Add as rows' maps each old URL straight to the new base. Both end with verify. */}
      <Panel title={L.discTitle} icon="🧭">
        <div style={{ display: "grid", gridTemplateColumns: "220px 1fr", gap: 10 }}>
          <label style={fieldL}><span style={fieldT}>{L.discSym} <span style={reqStar} title={L.reqStar}>*</span></span>
            <input value={disc.symbol} placeholder={L.discSymPh} onChange={(e) => setDiscField("symbol", e.target.value)} style={dInput("symbol")} /></label>
          <label style={fieldL}><span style={fieldT}>{L.discNew} <span style={reqStar} title={L.reqStar}>*</span></span>
            <input value={disc.newBase} placeholder={L.discNewPh} onChange={(e) => setDiscField("newBase", e.target.value)} style={dInput("newBase")} /></label>
        </div>

        {/* old side = a list (several old sites or URLs), all mapping to the one new site above */}
        <div style={{ ...fieldL, marginTop: 12 }}>
          <span style={fieldT}>{L.discOldList} <span style={reqStar} title={L.reqStar}>*</span></span>
          {disc.olds.map((u, i) => (
            <div key={i} className="row" style={{ gap: 6, alignItems: "center" }}>
              <input value={u} placeholder={L.phOld} onChange={(e) => setOldUrl(i, e.target.value)}
                style={{ ...(discErr.olds && i === 0 ? cellInputErr : cellInput), flex: 1, fontFamily: "var(--font-mono)", fontSize: 12 }} />
              {disc.olds.length > 1 && (
                <button type="button" onClick={() => delOld(i)} title={L.mRemove}
                  style={{ border: "none", background: "transparent", color: "var(--ink-4)", cursor: "pointer", fontSize: 14, padding: "0 4px" }}>✕</button>
              )}
            </div>
          ))}
          <button type="button" onClick={addOld}
            style={{ alignSelf: "flex-start", border: "1px dashed var(--line)", background: "transparent", color: "var(--ink-3)", borderRadius: 8, padding: "5px 10px", fontSize: 12, cursor: "pointer" }}>
            {L.discAddOld}
          </button>
        </div>

        {oldList().length <= 1 && (
          <label style={{ ...fieldL, marginTop: 10, maxWidth: 520 }}><span style={fieldT}>{L.discSitemap}</span>
            <input value={disc.sitemapUrl} placeholder={L.discSitemapPh} onChange={(e) => setDisc({ ...disc, sitemapUrl: e.target.value })} style={cellInput} /></label>
        )}

        {/* optional: sites behind HTTP Basic Auth (a browser "Sign in" dialog — often UAT). Collapsed
            by default; auto-open when creds already exist. Matched to a probed URL by host. */}
        <div style={{ marginTop: 12, borderTop: "1px solid var(--line)", paddingTop: 12 }}>
          <button type="button" onClick={() => setShowAuth((s) => !s)}
            style={{ border: "none", background: "transparent", cursor: "pointer", color: "var(--ink-2)", fontSize: 12.5, padding: 0, display: "inline-flex", alignItems: "center", gap: 6 }}>
            <span style={{ color: "var(--ink-3)", fontSize: 11 }}>{showAuth ? "▾" : "▸"}</span>
            🔒 {L.authTitle}{credPayload().length ? <span style={chip("#a855f7")}>{credPayload().length}</span> : null}
          </button>
          {showAuth && (
            <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
              <div className="muted" style={{ fontSize: 11.5 }}>{L.authHint}</div>
              {/* autocomplete the host from the URLs already typed in this panel */}
              <datalist id="redirect-login-hosts">{enteredHosts().map((h) => <option key={h} value={h} />)}</datalist>
              {creds.map((c, i) => (
                <div key={c.id} className="row" style={{ gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                  <input value={c.host} placeholder={L.authHostPh} list="redirect-login-hosts" onChange={(e) => setCredField(i, "host", e.target.value)}
                    style={{ ...cellInput, flex: "2 1 240px", minWidth: 200, fontFamily: "var(--font-mono)", fontSize: 12 }} />
                  <input value={c.username} placeholder={L.authUserPh} autoComplete="off" onChange={(e) => setCredField(i, "username", e.target.value)}
                    style={{ ...cellInput, flex: "1 1 130px", minWidth: 110 }} />
                  <input type="password" value={c.password} placeholder={L.authPassPh} autoComplete="new-password" onChange={(e) => setCredField(i, "password", e.target.value)}
                    style={{ ...cellInput, flex: "1 1 130px", minWidth: 110 }} />
                  <button type="button" onClick={() => delCred(i)} title={L.mRemove}
                    style={{ border: "none", background: "transparent", color: "var(--ink-4)", cursor: "pointer", fontSize: 14, padding: "0 4px" }}>✕</button>
                </div>
              ))}
              <button type="button" onClick={addCred}
                style={{ alignSelf: "flex-start", border: "1px dashed var(--line)", background: "transparent", color: "var(--ink-3)", borderRadius: 8, padding: "5px 10px", fontSize: 12, cursor: "pointer" }}>
                {L.authAdd}
              </button>
            </div>
          )}
        </div>

        <div className="row" style={{ gap: 10, marginTop: 12, alignItems: "center", flexWrap: "wrap" }}>
          {(busy || discBusy)
            ? <Btn kind="ghost" onClick={cancelRun}>{(busy ? L.verifying : L.discBusy)} · {L.cancel}</Btn>
            : <Btn kind="gold" icon="🚀" onClick={doRun}>{L.discRun}</Btn>}
        </div>
        <div className="muted" style={{ fontSize: 11.5, marginTop: 8 }}>{L.discHint}</div>
      </Panel>

      <div style={{ height: 18 }} />

      <Panel title={L.opts} icon="⚙️" className="" >
        <div className="row" style={{ gap: 18, flexWrap: "wrap", alignItems: "center", fontSize: 13 }}>
          <label className="row" style={{ gap: 6, alignItems: "center" }}>
            <span className="muted">{L.type}:</span>
            <select value={opts.redirectType} onChange={(e) => setOpts({ ...opts, redirectType: e.target.value })} style={cellInput}>
              <option value="Permanent">301 Permanent</option>
              <option value="Found">302 Found</option>
              <option value="Temporary">307 Temporary</option>
            </select>
          </label>
          <label className="row" style={{ gap: 6, alignItems: "center", cursor: "pointer" }}>
            <input type="checkbox" checked={opts.appendQueryString} onChange={(e) => setOpts({ ...opts, appendQueryString: e.target.checked })} />
            <span>{L.appendQs}</span>
          </label>
          <label className="row" style={{ gap: 6, alignItems: "center", cursor: "pointer" }}>
            <input type="checkbox" checked={opts.matchTrailingSlash} onChange={(e) => setOpts({ ...opts, matchTrailingSlash: e.target.checked })} />
            <span>{L.trailing}</span>
          </label>
        </div>
      </Panel>

      {rows.length > 0 && (
        <div className="row" style={{ gap: 10, flexWrap: "wrap", alignItems: "center", marginTop: 24 }}>
          <input value={filter.q} placeholder={L.fltSearch} onChange={(e) => setFilter({ ...filter, q: e.target.value })}
            style={{ ...cellInput, width: 280, flex: "0 1 280px" }} />
          <select value={filter.status} onChange={(e) => setFilter({ ...filter, status: e.target.value })} style={{ ...cellInput, width: "auto" }}>
            <option value="">{L.fltAll}</option>
            {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          {/* deep-check issue filter — only once at least one row has been deep-verified, so it
              doesn't show an all-zero dropdown before Verify runs */}
          {issueCounts.checked > 0 && (
            <select value={filter.issue} onChange={(e) => setFilter({ ...filter, issue: e.target.value })} style={{ ...cellInput, width: "auto" }}>
              <option value="">{L.fltIssueAll}</option>
              <option value="any">⚠ {L.fltIssueAny} ({issueCounts.any})</option>
              {ISSUE_KINDS.map((k) => (
                <option key={k} value={k} disabled={issueCounts[k] === 0}>
                  {L["fltIssue" + k.charAt(0).toUpperCase() + k.slice(1)]} ({issueCounts[k]})
                </option>
              ))}
            </select>
          )}
          <label className="row" style={{ gap: 6, alignItems: "center", fontSize: 13 }}>
            <span className="muted">{L.fltSort}:</span>
            <select value={filter.sort} onChange={(e) => setFilter({ ...filter, sort: e.target.value })} style={{ ...cellInput, width: "auto" }}>
              <option value="severity">{L.fltSeverity}</option>
              <option value="match">{L.fltMatch}</option>
              <option value="none">{L.fltOrder}</option>
            </select>
          </label>
          <span style={{ flex: 1 }} />
          <span className="muted" style={{ fontSize: 12.5 }}>{L.fltShowing} {view.length}/{rows.length}</span>
          {filterActive && <Btn kind="ghost" sm icon="✕" onClick={() => setFilter({ q: "", status: "", issue: "", sort: filter.sort })}>{L.fltClear}</Btn>}
        </div>
      )}

      <div style={{ marginTop: rows.length > 0 ? 12 : 24 }}>
        {rows.length === 0 ? (
          <Empty icon="🔗" title={L.emptyT} sub={L.emptyS} />
        ) : (
          /* No min-width + auto layout: the table fits the container so it never scrolls sideways,
             while the browser still grows each column to its content (the nowrap status/file chips
             don't get clipped). The two URL columns wrap (break-all) into whatever width is left.
             containerType lets the expandable detail size to the visible width (100cqw). */
          <div style={{ overflowX: "auto", border: "1px solid var(--line)", borderRadius: 12, containerType: "inline-size" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={{ ...th, width: 34 }}>{L.hNo}</th>
                  <th style={{ ...th, width: 92 }}>{L.hSym}</th>
                  <th style={th}>{L.hOld}</th>
                  <th style={th}>{L.hNew}</th>
                  <th style={{ ...th, width: 64 }}>{L.hMatch}</th>
                  <th style={{ ...th, width: 110 }}>{L.hFiles}</th>
                  <th style={{ ...th, width: 130 }}>{L.hBody}</th>
                  <th style={{ ...th, width: 132 }}>{L.hStatus}</th>
                  <th style={{ ...th, width: 220 }}>{L.hNote}</th>
                  <th style={{ ...th, width: 36 }}></th>
                </tr>
              </thead>
              <tbody>
                {view.length === 0 && (
                  <tr><td colSpan={10} style={{ ...td, textAlign: "center", color: "var(--ink-4)" }}>{L.fltNoMatch}</td></tr>
                )}
                {view.map(({ r, no }) => (
                  <React.Fragment key={r.id}>
                  <tr>
                    <td style={{ ...td, color: "var(--ink-4)", fontSize: 12, whiteSpace: "nowrap" }}>
                      <button type="button" onClick={() => toggleExpand(r.id)} title={L.dtDetails}
                        style={{ border: "none", background: "transparent", cursor: "pointer", color: "var(--ink-3)", fontSize: 11, marginRight: 3 }}>
                        {expanded[r.id] ? "▾" : "▸"}
                      </button>{no}
                    </td>
                    {/* whole row is read-only: Symbol + URLs come from manual-add/Discover/Import;
                        status + note + files + body are filled by Verify (delete the row to drop it) */}
                    <td style={{ ...td, fontWeight: 600 }}>{r.symbol || "—"}</td>
                    <td style={td}>
                      <div style={urlCell}>
                        <span style={urlText} title={r.oldUrl}>{r.oldUrl || "—"}</span>
                        <OpenLink url={r.oldUrl} title={L.open} />
                      </div>
                    </td>
                    <td style={td}>
                      <div style={urlCell}>
                        <span style={urlText} title={r.newUrl}>{r.newUrl || "—"}</span>
                        <OpenLink url={r.newUrl} title={L.open} />
                      </div>
                    </td>
                    <td style={td}><MatchBadge score={r.matchScore} /></td>
                    <td style={td}>{renderFiles(r.check)}</td>
                    <td style={td}>{renderBody(r.check)}</td>
                    <td style={td}><StatusBadge status={r.status} /></td>
                    <td style={{ ...td, color: "var(--ink-2)", fontSize: 12.5, lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{r.note || "—"}</td>
                    <td style={td}>
                      <button onClick={() => delRow(r.id)} title="Remove" style={{ border: "none", background: "transparent", cursor: "pointer", color: "var(--ink-4)", fontSize: 14 }}>✕</button>
                    </td>
                  </tr>
                  {expanded[r.id] && (
                    <tr>
                      <td colSpan={10} style={{ ...td, background: "var(--bg-1)", padding: 0 }}>
                        {/* sticky + 100cqw pins the detail to the viewport's left edge at the visible
                            width, so the side-by-side OLD/NEW cards stay fully on screen without a
                            horizontal scroll even while the wide table scrolls underneath. */}
                        <div style={{ position: "sticky", left: 0, width: "100cqw", boxSizing: "border-box", padding: "12px 18px 14px" }}>
                          {renderDetail(r)}
                        </div>
                      </td>
                    </tr>
                  )}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

export default Redirect;
