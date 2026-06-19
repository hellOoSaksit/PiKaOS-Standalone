/* URL Redirect Map — the one screen this standalone ships.
   The table holds just the mappings the user controls: Symbol · old URL · new URL (each URL
   openable in a new tab). Status / note / check-result are NOT manual columns — the system fills
   them: Verify probes both sides and sets each row's status+note, which surface in the summary
   tiles and the Excel export. "web.config" turns the rows into an IIS URL-Rewrite file; Discover
   pulls the old site's sitemap; CSV import + .xlsx export round-trip the central checklist. No nav,
   no login, no other modules. Rows live in this browser (localStorage). */
import React from 'react';
const { useState, useEffect, useRef, useMemo } = React;
import { PageHead, Panel, Btn, Empty, StatTile } from '../components/components.jsx';
import { discoverUrls, verifyRows, genWebConfig, exportXlsx, scanFiles } from '../lib/api.js';
import { loadRows, saveRows, newRow, parseCsv, STATUSES } from '../data/redirect-rows.jsx';

// bilingual labels — this screen is self-contained, so it keeps its strings local (EN + TH)
const T = {
  en: {
    kicker: "Migration · old site → new site", title: "URL Redirect Map",
    desc: "Map each old-site URL to its new-site target, verify both sides, then generate an IIS web.config to set up the 301 redirects.",
    verify: "Verify all", verifying: "Verifying…", cancel: "Cancel", add: "+ Row", importCsv: "Import CSV",
    webconfig: "web.config", exportCsv: "Export Excel", clear: "Clear",
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
    // discover-from-sitemap panel
    discTitle: "Discover from sitemap", discSym: "Symbol", discSymPh: "e.g. ABC",
    discOld: "Old site (base URL)", discOldPh: "e.g. https://old.example.com",
    discNew: "New site (base URL)", discNewPh: "e.g. https://www.example.com",
    phSym: "e.g. ABC", phOld: "e.g. https://old.example.com/page", phNew: "e.g. https://www.example.com/page",
    discSitemap: "Sitemap URL (optional)", discSitemapPh: "default: <old base>/sitemap.xml",
    discBtn: "Pull all URLs", discBusy: "Pulling…", discRun: "Discover + Verify",
    discHint: "One click: reads BOTH sitemaps (old + new), matches each old URL to the closest real new URL by path similarity (shown as a Match %), then verifies each new URL has a real page.",
    discNeed: "Enter the old + new base URLs first", discDone: "Added {n} URLs from the sitemap", discNone: "No new URLs (already in the table)",
    discSitemapErr: "Could not read the sitemap — check the URL is reachable and valid XML",
    verifyProg: "Verifying {done}/{total}…", canceledAt: "Canceled at {done}/{total}",
    scanFiles: "Check files", scanningFiles: "Scanning files…", filesNeed: "Fill the old + new base URLs above first",
    filesTitle: "Downloadable files — old vs new", fMatched: "On both sites", fOnlyOld: "Old only (gone)", fOnlyNew: "New only (added)",
    fOld: "Old", fNew: "New", fPages: "pages", fFiles: "files", filesNone: "No files found on the crawled pages", filesDone: "File check done",
    fileTag: "📎 File:", filesAdded: "Added {n} files to the table",
    // filter / sort bar over the table
    fltSearch: "Search URL or Symbol — e.g. th", fltAll: "All statuses", fltSort: "Sort",
    fltSeverity: "Problems first", fltMatch: "Lowest match first", fltOrder: "Table order",
    fltShowing: "Showing", fltClear: "Clear filter", fltNoMatch: "No rows match the filter",
  },
  th: {
    kicker: "ย้ายเว็บ · เว็บเดิม → เว็บใหม่", title: "URL Redirect Map",
    desc: "แมพ URL เว็บเดิมไปเว็บใหม่ทีละตัว ตรวจทั้งสองฝั่ง แล้ว gen ไฟล์ IIS web.config ไปตั้ง 301 redirect.",
    verify: "ตรวจทั้งหมด", verifying: "กำลังตรวจ…", cancel: "ยกเลิก", add: "+ แถว", importCsv: "นำเข้า CSV",
    webconfig: "web.config", exportCsv: "ส่งออก Excel", clear: "ล้าง",
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
    // discover-from-sitemap panel
    discTitle: "ดึงจาก Sitemap", discSym: "Symbol", discSymPh: "ตัวอย่าง: ABC",
    discOld: "เว็บเดิม (base URL)", discOldPh: "ตัวอย่าง: https://old.example.com",
    discNew: "เว็บใหม่ (base URL)", discNewPh: "ตัวอย่าง: https://www.example.com",
    phSym: "ตัวอย่าง: ABC", phOld: "ตัวอย่าง: https://old.example.com/page", phNew: "ตัวอย่าง: https://www.example.com/page",
    discSitemap: "Sitemap URL (ไม่บังคับ)", discSitemapPh: "ค่าเริ่มต้น: <เว็บเดิม>/sitemap.xml",
    discBtn: "ดึง URL ทั้งหมด", discBusy: "กำลังดึง…", discRun: "ดึง + ตรวจ",
    discHint: "กดทีเดียว: อ่าน sitemap ทั้ง 2 เว็บ (เก่า+ใหม่) → จับคู่ URL เก่ากับ URL ใหม่จริงที่ path ใกล้สุด (โชว์ % ใกล้เคียง) → ตรวจว่า URL ใหม่มีหน้าจริงไหม",
    discNeed: "กรอก base URL เว็บเดิม + ใหม่ ก่อน", discDone: "เพิ่ม {n} URL จาก sitemap", discNone: "ไม่มี URL ใหม่ (มีในตารางแล้ว)",
    discSitemapErr: "อ่าน sitemap ไม่ได้ — ตรวจว่า URL เข้าถึงได้และเป็น XML ที่ถูกต้อง",
    verifyProg: "กำลังตรวจ {done}/{total}…", canceledAt: "ยกเลิกที่ {done}/{total}",
    scanFiles: "ตรวจไฟล์", scanningFiles: "กำลังตรวจไฟล์…", filesNeed: "กรอก base URL เก่า+ใหม่ ด้านบนก่อน",
    filesTitle: "ไฟล์ดาวน์โหลด — เก่า vs ใหม่", fMatched: "มีทั้ง 2 เว็บ", fOnlyOld: "เฉพาะเก่า (หาย)", fOnlyNew: "เฉพาะใหม่ (เพิ่ม)",
    fOld: "เก่า", fNew: "ใหม่", fPages: "หน้า", fFiles: "ไฟล์", filesNone: "ไม่พบไฟล์ในหน้าที่ crawl", filesDone: "ตรวจไฟล์เสร็จ",
    fileTag: "📎 ไฟล์:", filesAdded: "เพิ่ม {n} ไฟล์ลงตาราง",
    // filter / sort bar over the table
    fltSearch: "ค้นหา URL หรือ Symbol — เช่น th", fltAll: "ทุกสถานะ", fltSort: "เรียง",
    fltSeverity: "ปัญหาก่อน (ไล่ระดับ)", fltMatch: "Match น้อยสุดก่อน", fltOrder: "ตามลำดับตาราง",
    fltShowing: "แสดง", fltClear: "ล้างตัวกรอง", fltNoMatch: "ไม่มีแถวตรงตัวกรอง",
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
  const [rows, setRows] = useState(() => loadRows());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);                // { text, tone }
  const [opts, setOpts] = useState({ redirectType: "Permanent", appendQueryString: false, matchTrailingSlash: true });
  const [disc, setDisc] = useState({ symbol: "", oldBase: "", newBase: "", sitemapUrl: "" });
  const [discBusy, setDiscBusy] = useState(false);
  const [filesBusy, setFilesBusy] = useState(false);
  const abortRef = useRef(null);
  const fileRef = useRef(null);

  useEffect(() => { saveRows(rows); }, [rows]);

  const counts = useMemo(() => {
    const c = { total: rows.length, "รอดำเนินการ": 0, "ดำเนินการแล้ว": 0, "ติดปัญหา": 0, "ไม่ต้อง Redirect": 0 };
    rows.forEach((r) => { if (c[r.status] != null) c[r.status]++; });
    return c;
  }, [rows]);

  // filter + sort the table view (display only — never mutates `rows`, so Verify / web.config /
  // export still operate on the full set). Each item keeps its original 1-based number (`no`).
  const [filter, setFilter] = useState({ q: "", status: "", sort: "severity" });
  const view = useMemo(() => {
    const q = filter.q.trim().toLowerCase();
    let list = rows.map((r, i) => ({ r, no: i + 1 }));
    if (q) list = list.filter(({ r }) =>
      (r.symbol || "").toLowerCase().includes(q) ||
      (r.oldUrl || "").toLowerCase().includes(q) ||
      (r.newUrl || "").toLowerCase().includes(q));
    if (filter.status) list = list.filter(({ r }) => r.status === filter.status);
    if (filter.sort === "severity")
      list = list.slice().sort((a, b) => severityRank(a.r.status) - severityRank(b.r.status) || a.no - b.no);
    else if (filter.sort === "match") {
      const ms = (x) => (x.r.matchScore == null ? 101 : x.r.matchScore);   // worst (lowest) match first, blanks last
      list = list.slice().sort((a, b) => ms(a) - ms(b) || a.no - b.no);
    }
    return list;
  }, [rows, filter]);
  const setStatusFilter = (s) => setFilter((f) => ({ ...f, status: f.status === s ? "" : s }));
  const filterActive = filter.q.trim() || filter.status;

  const notice = (text, tone = "ok") => setMsg({ text, tone });
  const fill = (tpl, n) => tpl.replace("{n}", n);
  const fill2 = (tpl, done, total) => tpl.replace("{done}", done).replace("{total}", total);
  const strip = (r) => ({ symbol: r.symbol, oldUrl: r.oldUrl, newUrl: r.newUrl, status: r.status, note: r.note });

  const delRow = (id) => setRows((rs) => rs.filter((r) => r.id !== id));
  const clearAll = async () => {
    if (window.uiConfirm && !(await window.uiConfirm({ title: L.confirmClear, danger: true }))) return;
    setRows([]);
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
    let done = 0;
    for (let i = 0; i < targetRows.length; i += CHUNK) {
      const chunk = targetRows.slice(i, i + CHUNK);
      const out = await verifyRows({ rows: chunk.map(strip) }, ctrl.signal);
      setRows((rs) => rs.map((r) => {
        const idx = chunk.findIndex((c) => c.id === r.id);
        const v = idx >= 0 ? out.results[idx] : null;
        return v ? { ...r, status: v.suggestedStatus, note: v.suggestedNote } : r;
      }));
      done += chunk.length;
      if (done < targetRows.length) notice(fill2(L.verifyProg, done, targetRows.length), "ok");
    }
    return done;
  };

  // ONE button: pull the old site's sitemap (when the base URLs are filled) → domain-swap onto the
  // new base, then verify every row. Discover + Verify in a single click. Re-running re-verifies all
  // rows and adds any new sitemap URLs.
  const doRun = async () => {
    if (busy || discBusy) return;
    const ctrl = new AbortController(); abortRef.current = ctrl;
    let allRows = rows;
    try {
      if (disc.oldBase.trim() && disc.newBase.trim()) {
        setDiscBusy(true); notice(L.discBusy, "ok");
        const body = { oldBase: disc.oldBase.trim(), newBase: disc.newBase.trim(), symbol: disc.symbol.trim() };
        if (disc.sitemapUrl.trim()) body.sitemapUrl = disc.sitemapUrl.trim();
        const out = await discoverUrls(body, ctrl.signal);
        const keyOf = (r) => (r.oldUrl ? "O:" + r.oldUrl : "N:" + r.newUrl);   // new-only rows key by new URL
        const have = new Set(rows.map(keyOf));
        const add = (out.rows || []).filter((r) => (r.oldUrl || r.newUrl) && !have.has(keyOf(r)))
          .map((r) => newRow({ symbol: r.symbol, oldUrl: r.oldUrl, newUrl: r.newUrl, matchScore: r.matchScore }));
        allRows = [...rows, ...add];
        setRows(allRows);
        setDiscBusy(false);
      }
      if (!allRows.length) { notice(L.discNeed, "warn"); abortRef.current = null; return; }
      setBusy(true);
      const done = await verifyList(allRows, ctrl);
      notice(fill(L.verified, done));
    } catch (err) {
      if (err && err.name === "AbortError") notice(L.canceled, "warn");
      else if (err && err.status === 0) notice(L.netErr, "err");
      else if (err && err.status === 502) notice(L.discSitemapErr, "err");
      else notice((err && err.message) || L.netErr, "err");
    } finally { setBusy(false); setDiscBusy(false); abortRef.current = null; }
  };

  // crawl both sites' pages → compare downloadable files (PDF/DOC/…). Heavier, so it's its own
  // button. Results are folded straight into the main table as file rows (kind:"file"), mapped onto
  // the same 4 statuses as the page rows so they filter / sort / export / web.config the same way:
  //   on both → รอดำเนินการ (ready to redirect old→new) · old only → ติดปัญหา (gone on new)
  //   · new only → ไม่ต้อง Redirect (no old URL to send anywhere)
  const doScanFiles = async () => {
    if (busy || discBusy || filesBusy) return;
    if (!disc.oldBase.trim() || !disc.newBase.trim()) { notice(L.filesNeed, "warn"); return; }
    setFilesBusy(true); notice(L.scanningFiles, "ok");
    const ctrl = new AbortController(); abortRef.current = ctrl;
    try {
      const body = { oldBase: disc.oldBase.trim(), newBase: disc.newBase.trim() };
      if (disc.sitemapUrl.trim()) body.sitemapUrl = disc.sitemapUrl.trim();
      const out = await scanFiles(body, ctrl.signal);
      const sym = disc.symbol.trim();
      const fileRows = [
        ...out.matched.map((f) => ({ symbol: sym, oldUrl: f.oldUrl, newUrl: f.newUrl, status: "รอดำเนินการ", note: `${L.fileTag} ${L.fMatched}`, kind: "file" })),
        ...out.onlyOld.map((f) => ({ symbol: sym, oldUrl: f.oldUrl, newUrl: "", status: "ติดปัญหา", note: `${L.fileTag} ${L.fOnlyOld}`, kind: "file" })),
        ...out.onlyNew.map((f) => ({ symbol: sym, oldUrl: "", newUrl: f.newUrl, status: "ไม่ต้อง Redirect", note: `${L.fileTag} ${L.fOnlyNew}`, kind: "file" })),
      ];
      const keyOf = (r) => (r.oldUrl ? "O:" + r.oldUrl : "N:" + r.newUrl);
      const have = new Set(rows.map(keyOf));
      const add = fileRows.filter((r) => (r.oldUrl || r.newUrl) && !have.has(keyOf(r))).map((r) => newRow(r));
      if (add.length) setRows((rs) => [...rs, ...add]);
      notice(add.length ? fill(L.filesAdded, add.length) : L.filesNone, add.length ? "ok" : "warn");
    } catch (err) {
      if (err && err.name === "AbortError") notice(L.canceled, "warn");
      else if (err && err.status === 0) notice(L.netErr, "err");
      else if (err && err.status === 502) notice(L.discSitemapErr, "err");
      else notice((err && err.message) || L.netErr, "err");
    } finally { setFilesBusy(false); abortRef.current = null; }
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

  const doExport = async () => {
    if (!rows.length) { notice(L.exportEmpty, "warn"); return; }
    try {
      const blob = await exportXlsx({ rows: rows.map(strip) });
      downloadBlob("redirect-checklist.xlsx", blob);
      notice(fill(L.exported, rows.length));
    } catch (err) {
      if (err && err.status === 0) notice(L.netErr, "err");
      else notice((err && err.message) || L.netErr, "err");
    }
  };

  const td = { padding: "12px 16px", borderBottom: "1px solid var(--line)", verticalAlign: "middle", fontSize: 13 };
  const th = { ...td, textAlign: "left", color: "var(--ink-3)", fontSize: 11.5, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".04em", position: "sticky", top: 0, background: "var(--bg-1)", zIndex: 1 };
  const cellInput = { width: "100%", border: "1px solid var(--line)", borderRadius: 8, padding: "9px 11px", background: "var(--bg)", color: "var(--ink)", fontSize: 13, fontFamily: "inherit" };
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
        {filesBusy
          ? <Btn kind="ghost" sm onClick={cancelRun}>{L.scanningFiles} · {L.cancel}</Btn>
          : <Btn kind="ghost" sm icon="📎" onClick={doScanFiles}>{L.scanFiles}</Btn>}
        <span style={{ flex: 1 }} />
        <Btn kind="ghost" sm icon="🗑" onClick={clearAll}>{L.clear}</Btn>
      </div>

      {msg && (
        <div style={{ margin: "0 0 12px", padding: "8px 12px", borderRadius: 8, fontSize: 13, border: `1px solid ${msgTone[msg.tone] || msgTone.ok}55`, background: `${msgTone[msg.tone] || msgTone.ok}14`, color: msgTone[msg.tone] || msgTone.ok }}>
          {msg.text}
        </div>
      )}

      <Panel title={L.discTitle} icon="🧭">
        <div style={{ display: "grid", gridTemplateColumns: "130px 1fr 1fr", gap: 10 }}>
          <label style={fieldL}><span style={fieldT}>{L.discSym}</span>
            <input value={disc.symbol} placeholder={L.discSymPh} onChange={(e) => setDisc({ ...disc, symbol: e.target.value })} style={cellInput} /></label>
          <label style={fieldL}><span style={fieldT}>{L.discOld}</span>
            <input value={disc.oldBase} placeholder={L.discOldPh} onChange={(e) => setDisc({ ...disc, oldBase: e.target.value })} style={cellInput} /></label>
          <label style={fieldL}><span style={fieldT}>{L.discNew}</span>
            <input value={disc.newBase} placeholder={L.discNewPh} onChange={(e) => setDisc({ ...disc, newBase: e.target.value })} style={cellInput} /></label>
        </div>
        <div className="row" style={{ gap: 10, marginTop: 10, alignItems: "flex-end" }}>
          <label style={{ ...fieldL, flex: 1 }}><span style={fieldT}>{L.discSitemap}</span>
            <input value={disc.sitemapUrl} placeholder={L.discSitemapPh} onChange={(e) => setDisc({ ...disc, sitemapUrl: e.target.value })} style={cellInput} /></label>
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
          {filterActive && <Btn kind="ghost" sm icon="✕" onClick={() => setFilter({ q: "", status: "", sort: filter.sort })}>{L.fltClear}</Btn>}
        </div>
      )}

      <div style={{ marginTop: rows.length > 0 ? 12 : 24 }}>
        {rows.length === 0 ? (
          <Empty icon="🔗" title={L.emptyT} sub={L.emptyS} />
        ) : (
          <div style={{ overflowX: "auto", border: "1px solid var(--line)", borderRadius: 12 }}>
            <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 1160 }}>
              <thead>
                <tr>
                  <th style={{ ...th, width: 34 }}>{L.hNo}</th>
                  <th style={{ ...th, width: 110 }}>{L.hSym}</th>
                  <th style={th}>{L.hOld}</th>
                  <th style={th}>{L.hNew}</th>
                  <th style={{ ...th, width: 84 }}>{L.hMatch}</th>
                  <th style={{ ...th, width: 132 }}>{L.hStatus}</th>
                  <th style={{ ...th, width: 280 }}>{L.hNote}</th>
                  <th style={{ ...th, width: 34 }}></th>
                </tr>
              </thead>
              <tbody>
                {view.length === 0 && (
                  <tr><td colSpan={8} style={{ ...td, textAlign: "center", color: "var(--ink-4)" }}>{L.fltNoMatch}</td></tr>
                )}
                {view.map(({ r, no }) => (
                  <tr key={r.id}>
                    <td style={{ ...td, color: "var(--ink-4)", fontSize: 12 }}>{no}</td>
                    {/* whole row is read-only: Symbol + URLs come from Discover/Import; status + note
                        are filled by Verify — nothing here is hand-edited (delete the row to drop it) */}
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
                    <td style={td}><StatusBadge status={r.status} /></td>
                    <td style={{ ...td, color: "var(--ink-2)", fontSize: 12.5, lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{r.note || "—"}</td>
                    <td style={td}>
                      <button onClick={() => delRow(r.id)} title="Remove" style={{ border: "none", background: "transparent", cursor: "pointer", color: "var(--ink-4)", fontSize: 14 }}>✕</button>
                    </td>
                  </tr>
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
