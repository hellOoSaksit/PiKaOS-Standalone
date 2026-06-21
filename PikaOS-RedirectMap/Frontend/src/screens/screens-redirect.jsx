/* For human — URL Redirect Map, the one screen this standalone ships. This file is the orchestrator:
   it owns the state (rows, the Discover form, credentials, filter) and the actions (discover + verify,
   web.config, Excel export, CSV import, manual Save/Load snapshot), then composes the panels + table.
   The presentational pieces live next to it in ./redirect/ (cells · DiscoverPanel · AuthPanel ·
   RedirectTable · RowDetail · labels). The table is read-only: Symbol + URLs come from Discover/
   Import/manual; status/note/files/body are filled by Verify. No nav, no login, no other modules.
   Rows are in-memory (cleared on F5) with a manual Save/Load snapshot; credentials are in-memory only. */
import React from 'react';
const { useState, useMemo, useRef } = React;
import { PageHead, Panel, Btn, Empty, StatTile } from '../components/components.jsx';
import { discoverUrls, verifyRows, genWebConfig, exportXlsx } from '../lib/api.js';
import { loadRows, saveRows, newRow, parseCsv, STATUSES, newCred } from '../data/redirect-rows.jsx';
import { severityRank, ISSUE_KINDS, rowIssues, download, downloadBlob, cellInput } from './redirect/cells.jsx';
import { DiscoverPanel } from './redirect/DiscoverPanel.jsx';
import { RedirectTable } from './redirect/RedirectTable.jsx';
import { T } from './redirect/labels.jsx';

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
          oldSpa: v.oldSpa, newSpa: v.newSpa,
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

      <DiscoverPanel
        L={L} disc={disc} setDiscField={setDiscField} setOldUrl={setOldUrl} addOld={addOld} delOld={delOld}
        oldList={oldList} discErr={discErr} busy={busy} discBusy={discBusy} onRun={doRun} onCancel={cancelRun}
        auth={{ creds, setCredField, addCred, delCred, enteredHosts, credPayload, showAuth, setShowAuth }}
      />

      <div style={{ height: 18 }} />

      <Panel title={L.opts} icon="⚙️">
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
        {rows.length === 0
          ? <Empty icon="🔗" title={L.emptyT} sub={L.emptyS} />
          : <RedirectTable L={L} view={view} expanded={expanded} onToggle={toggleExpand} onDelete={delRow} />}
      </div>
    </div>
  );
}

export default Redirect;
