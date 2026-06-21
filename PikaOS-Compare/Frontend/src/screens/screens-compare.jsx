/* For human — Website Compare (UAT vs Production), the one screen this standalone ships. This file is
   the orchestrator: it owns the state (inputs, the per-direction session cache, auth, saved sites) and
   the actions (streamed coverage, streamed/incremental deep, two-page compare, login prompt), then
   composes the inputs panel + results. The presentational pieces live in ./compare/ (helpers ·
   DeepDetail · CoverageTable · AuthModal · SitesModal). The SOURCE side's sitemap is the source of
   truth; each URL is domain-swapped onto the TARGET base and both sides are probed. All text is t("compare.*"). */
import React from 'react';
const { useState } = React;
import { Btn, PageHead, Panel, StatTile } from '../components/components.jsx';
import Switch from '../components/ui/Switch.jsx';
import Select from '../components/ui/Dropdown.jsx';
import { compareDeep, coverageBatch, coveragePlan } from '../lib/api.js';
import { useToast } from '../components/ui/Toast.jsx';
import { loadSites, saveSites, newSiteId } from '../data/compare-sites.jsx';
import {
  VIEW_KEY, CACHE_KEY, loadJSON, saveJSON, authSigOf, makeSig, tallySummary,
  errMessage, sitemapFor, catOf,
} from './compare/helpers.js';
import { DeepDetail } from './compare/DeepDetail.jsx';
import { CoverageTable } from './compare/CoverageTable.jsx';
import { AuthModal } from './compare/AuthModal.jsx';
import { SitesModal } from './compare/SitesModal.jsx';

const DEEP_BATCH = 2;    // pages deep-compared per streamed request — small so even a SLOW, WAF-throttled
                         // site (PROD pages ~15s each + throttled probes) finishes a batch under the proxy timeout
const COV_BATCH = 30;    // coverage URLs probed per streamed request (a big sitemap can't run in one shot)

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

          <CoverageTable
            t={t} res={res} shown={shown} cats={cats} filter={filter} setFilter={setFilter}
            sort={sort} setSort={setSort} q={q} setQ={setQ} srcShort={srcShort} tgtShort={tgtShort}
            deepData={deepData} deepTargets={deepTargets} open={open} toggleRow={toggleRow}
            deepOne={deepOne} stateLabel={stateLabel}
          />

          {res.extraOnUat && res.extraOnUat.length > 0 && (
            <Panel title={t("compare.extraTitle", { env: tgtShort, src: srcShort })} en={tgtShort + "-ONLY"} icon="➕" style={{ marginTop: 18 }}>
              <div className="col" style={{ gap: 5 }}>
                {res.extraOnUat.map((u, i) => <div key={i} className="mono" style={{ fontSize: 12, color: "var(--ink-2)" }}>{u}</div>)}
              </div>
            </Panel>
          )}
        </>
      )}

      <AuthModal
        open={authOpen} onClose={() => setAuthOpen(false)} t={t} mode={mode} res={res}
        authTab={authTab} setAuthTab={setAuthTab} authForm={authForm} setAuthForm={setAuthForm}
        onSubmit={submitAuth} credFromForm={credFromForm}
      />

      <SitesModal
        open={sitesOpen} onClose={() => setSitesOpen(false)} t={t} sites={sites}
        siteDraft={siteDraft} setSiteDraft={setSiteDraft} blankDraft={blankDraft} draftCred={draftCred}
        applySite={applySite} editSite={editSite} deleteSite={deleteSite} saveDraft={saveDraft} hostOf={hostOf}
      />
    </div>
  );
}

export { Compare };
