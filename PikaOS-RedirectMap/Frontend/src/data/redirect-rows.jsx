/* For human — Redirect-map rows: the working set of mappings (old URL → new URL per Symbol).
   Rows live in memory in the screen (a refresh starts empty); saveRows/loadRows below are the
   MANUAL "Save/Load snapshot" the user triggers from the toolbar — the ONLY thing written to
   localStorage. NO seed / mock data: the real set comes from Discover (read the old site's
   sitemap), CSV import, or typing rows. */

const KEY = "pikaos.redirectmap.rows.v2";   // v2: drop the old seeded sample row from earlier builds

// the 4 checklist statuses (Thai) — must match the backend STATUS_* vocabulary
export const STATUSES = ["รอดำเนินการ", "ดำเนินการแล้ว", "ติดปัญหา", "ไม่ต้อง Redirect"];

export function newRow(extra = {}) {
  const rnd = Math.random().toString(36).slice(2, 8);
  return { id: `r_${Date.now().toString(36)}_${rnd}`, symbol: "", oldUrl: "", newUrl: "", status: "", note: "", ...extra };
}

// --- manual snapshot (the only persistence) ---------------------------------
// For human — Save writes the current rows to localStorage; Load reads them back. Nothing here runs
// automatically; a refresh (F5) starts from an empty table, so the user decides what is kept.
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
// For human — some sites (usually a UAT/staging env) sit behind a browser "Sign in" dialog (HTTP
// Basic Auth); a bare probe just gets a 401. The user adds host + username + password and verify/
// discover then authenticate. Credentials are kept IN MEMORY ONLY (in the screen's React state) and
// ride on the request — never written to localStorage, never stored server-side; a refresh clears
// them. newCred() just makes one blank entry.
export function newCred(extra = {}) {
  const rnd = Math.random().toString(36).slice(2, 8);
  return { id: `c_${Date.now().toString(36)}_${rnd}`, host: "", username: "", password: "", ...extra };
}

// --- CSV import -------------------------------------------------------------
// For human — the central checklist is a spreadsheet; CSV is the lingua franca for getting rows IN.
// (The export goes OUT as .xlsx via the backend, not from here.) Import detects columns by header
// keyword (Thai + English) so the template's extra columns don't break it.

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
