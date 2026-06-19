// Tiny fetch wrapper for the standalone URL Redirect-Map backend.
// This build has NO login — the endpoints are open — so it drops the token / refresh-on-401
// logic the full PiKaOs app carries. Just JSON + an AbortSignal passthrough (so the UI can
// cancel a long verify run, which the backend detects to stop its outbound probes).

const BASE = (import.meta.env.VITE_API_BASE || "/api").replace(/\/$/, "");

export class ApiError extends Error {
  constructor(status, data) {
    super((data && data.detail) || `HTTP ${status}`);
    this.status = status;
    this.data = data;
  }
}

async function raw(path, { method = "GET", body, signal } = {}) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";

  let res;
  try {
    res = await fetch(BASE + path, {
      method,
      headers,
      signal,                                  // lets callers abort (cancel) the request
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    if (e && e.name === "AbortError") throw e;   // caller-initiated cancel — propagate as-is
    throw new ApiError(0, { detail: "network" });
  }

  let data = null;
  const text = await res.text();
  if (text) { try { data = JSON.parse(text); } catch (e) { data = text; } }
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

// --- Redirect-map API (each takes an optional AbortSignal) ---
// POST /api/redirect/discover  → read the old site's sitemap → proposed old→new mapping rows.
export async function discoverUrls(body, signal) { return raw("/redirect/discover", { method: "POST", body, signal }); }
// POST /api/redirect/verify    → probe each row (old + new side) → suggested status/note.
export async function verifyRows(body, signal) { return raw("/redirect/verify", { method: "POST", body, signal }); }
// POST /api/redirect/files     → crawl both sites' pages → compare downloadable files (PDF/DOC/…).
export async function scanFiles(body, signal) { return raw("/redirect/files", { method: "POST", body, signal }); }
// POST /api/redirect/webconfig → rows → IIS URL-Rewrite web.config text (pure transform).
export async function genWebConfig(body, signal) { return raw("/redirect/webconfig", { method: "POST", body, signal }); }
// POST /api/redirect/export → rows → .xlsx checklist (binary). Returns a Blob to download.
export async function exportXlsx(body, signal) {
  let res;
  try {
    res = await fetch(BASE + "/redirect/export", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body), signal,
    });
  } catch (e) {
    if (e && e.name === "AbortError") throw e;
    throw new ApiError(0, { detail: "network" });
  }
  if (!res.ok) {
    let data = null; const t = await res.text();
    if (t) { try { data = JSON.parse(t); } catch (e) { data = t; } }
    throw new ApiError(res.status, data);
  }
  return await res.blob();
}
