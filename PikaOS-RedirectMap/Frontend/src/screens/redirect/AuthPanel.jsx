/* For human — the collapsible "sites that need a login (Basic Auth)" block inside the Discover panel.
   Lists the per-host credential rows the user fills in (host + username + password). It's pure UI:
   the screen owns the `creds` state + the handlers and the host autocomplete source. Credentials are
   in-memory only (the screen never persists them); a `password` input is used so the value is masked. */
import React from 'react';
import { chip, cellInput } from './cells.jsx';

export function AuthPanel({ L, creds, setCredField, addCred, delCred, enteredHosts, credPayload, showAuth, setShowAuth }) {
  const ready = credPayload().length;   // complete entries (host + username) — shown as a count badge
  return (
    <div style={{ marginTop: 12, borderTop: "1px solid var(--line)", paddingTop: 12 }}>
      <button type="button" onClick={() => setShowAuth((s) => !s)}
        style={{ border: "none", background: "transparent", cursor: "pointer", color: "var(--ink-2)", fontSize: 12.5, padding: 0, display: "inline-flex", alignItems: "center", gap: 6 }}>
        <span style={{ color: "var(--ink-3)", fontSize: 11 }}>{showAuth ? "▾" : "▸"}</span>
        🔒 {L.authTitle}{ready ? <span style={chip("#a855f7")}>{ready}</span> : null}
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
  );
}
