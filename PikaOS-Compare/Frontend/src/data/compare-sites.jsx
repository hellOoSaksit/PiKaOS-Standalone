/* Saved compare sites — the user's list of Production/UAT pairs (+ optional per-side credentials)
   so a frequent comparison is one click instead of re-typing the URLs and logins. Owns its own
   localStorage store (guildos.compare.sites.v1) per CLAUDE.md §5 — screens call load/save here,
   never touch localStorage directly. Persisted in localStorage (survives across sessions), unlike
   the per-run coverage cache in screens-compare.jsx which is sessionStorage (ephemeral).

   SECURITY NOTE: by explicit user request this store keeps credentials — INCLUDING PASSWORDS — in
   PLAINTEXT in the browser's localStorage. That's acceptable only because PiKaOs is a local
   dev/internal tool: never sync this store off the machine, and don't mirror the pattern for a real
   end-user app. (Compare's *live* auth is still in-memory only — this is opt-in, save-it-yourself
   convenience storage.) Entry shape:
     { id, name, prod, uat, prodAuth: cred|null, uatAuth: cred|null }
   where cred = { username, password, headerName, headerValue } (nulls allowed) — the same shape the
   compare screen already uses for live auth, so a saved entry feeds straight into applyAuth(). */

const KEY = "guildos.compare.sites.v1";

export function loadSites() {
  try {
    const raw = localStorage.getItem(KEY);
    const v = raw ? JSON.parse(raw) : [];
    return Array.isArray(v) ? v : [];
  } catch (e) {
    return [];
  }
}

export function saveSites(list) {
  try {
    localStorage.setItem(KEY, JSON.stringify(Array.isArray(list) ? list : []));
  } catch (e) {
    /* quota / private mode — the list just won't persist */
  }
}

// short, collision-resistant id for a new entry (FE-only; Date.now/Math.random are fine here)
export function newSiteId() {
  return "site_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}
