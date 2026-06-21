/* Redirect-map rows — the working set of mappings (old URL → new URL per Symbol).
   Persisted in THIS browser only (localStorage). NO seed / mock data: the table starts empty;
   the real set comes from Discover (read the old site's sitemap), CSV import, or typing rows. */

const KEY = "pikaos.redirectmap.rows.v2";   // v2: drop the old seeded sample row from earlier builds

// the 4 checklist statuses (Thai) — must match the backend STATUS_* vocabulary
export const STATUSES = ["รอดำเนินการ", "ดำเนินการแล้ว", "ติดปัญหา", "ไม่ต้อง Redirect"];

export function newRow(extra = {}) {
  const rnd = Math.random().toString(36).slice(2, 8);
  return { id: `r_${Date.now().toString(36)}_${rnd}`, symbol: "", oldUrl: "", newUrl: "", status: "", note: "", ...extra };
}

export function loadRows() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) return arr.map((r) => ({ ...newRow(), ...r }));
    }
  } catch (e) {}
  return [];                 // start empty — use Discover / Import / + Row
}

export function saveRows(rows) {
  try { localStorage.setItem(KEY, JSON.stringify(rows)); } catch (e) {}
}

// --- HTTP Basic Auth credentials (per host) ---------------------------------
// Some sites — usually a UAT/staging env — sit behind a browser "Sign in" dialog (HTTP Basic
// Auth); a probe just gets 401. The user adds host + username + password here so verify/discover
// can authenticate. Kept in THIS browser only (localStorage), like the rows — the tool is stateless
// and these are sent on the request, never stored server-side. Plaintext in localStorage: fine for
// an internal tool, but don't reuse a sensitive personal password.

const CRED_KEY = "pikaos.redirectmap.creds.v1";

export function newCred(extra = {}) {
  const rnd = Math.random().toString(36).slice(2, 8);
  return { id: `c_${Date.now().toString(36)}_${rnd}`, host: "", username: "", password: "", ...extra };
}

export function loadCreds() {
  try {
    const raw = localStorage.getItem(CRED_KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) return arr.map((c) => ({ ...newCred(), ...c }));
    }
  } catch (e) {}
  return [];
}

export function saveCreds(creds) {
  try { localStorage.setItem(CRED_KEY, JSON.stringify(creds)); } catch (e) {}
}

// --- CSV import / export ----------------------------------------------------
// The central checklist is a spreadsheet; CSV is the lingua franca. Import detects columns by
// header keyword (Thai + English) so the extra columns in the template don't break it. Export
// writes the columns the checklist expects back.

function parseCsvGrid(text) {
  // minimal RFC4180 parser: handles quoted fields, embedded commas/quotes/newlines
  const rows = [];
  let row = [], field = "", inQ = false;
  const s = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQ) {
      if (c === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

export function parseCsv(text) {
  const grid = parseCsvGrid(text).filter((r) => r.some((c) => (c || "").trim() !== ""));
  if (!grid.length) return [];
  // find the header row (first row that mentions "symbol")
  let h = grid.findIndex((r) => r.some((c) => /symbol/i.test(c)));
  if (h < 0) h = 0;
  const header = grid[h].map((c) => (c || "").toLowerCase());
  const find = (...keys) => header.findIndex((c) => keys.some((k) => c.includes(k)));
  const iSym = find("symbol");
  const iOld = find("เดิม", "old", "from");
  const iNew = find("ใหม่", "new", "target", "to");
  const iSt = find("สถานะ", "status");
  const iNote = find("note", "หมายเหตุ");

  const out = [];
  for (let r = h + 1; r < grid.length; r++) {
    const cells = grid[r];
    const at = (i) => (i >= 0 && i < cells.length ? (cells[i] || "").trim() : "");
    const symbol = at(iSym), oldUrl = at(iOld), newUrl = at(iNew);
    if (!symbol && !oldUrl && !newUrl) continue;          // skip blank/numbering-only rows
    out.push(newRow({ symbol, oldUrl, newUrl, status: at(iSt), note: at(iNote) }));
  }
  return out;
}

function csvCell(v) {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows) {
  const head = ["No.", "Symbol", "URL เว็บไซต์เดิม", "URL เว็บไซต์ใหม่", "สถานะ", "Note"];
  const lines = [head.map(csvCell).join(",")];
  rows.forEach((r, i) => {
    lines.push([i + 1, r.symbol, r.oldUrl, r.newUrl, r.status, r.note].map(csvCell).join(","));
  });
  return "﻿" + lines.join("\r\n");   // BOM so Excel reads Thai (UTF-8) correctly
}
