/* For human — the results table: one read-only row per mapping (Symbol + URLs from Discover/Import/
   manual; Match/Files/Body/Status/Note filled by Verify) with an expandable detail. Display only —
   it renders the already filtered+sorted `view`; the screen owns the data and the callbacks. */
import React from 'react';
import { StatusBadge, MatchBadge, FilesCell, BodyCell, OpenLink, td, th, urlCell, urlText } from './cells.jsx';
import { RowDetail } from './RowDetail.jsx';

export function RedirectTable({ L, view, expanded, onToggle, onDelete }) {
  return (
    /* No min-width + auto layout: the table fits the container so it never scrolls sideways, while
       the browser still grows each column to its content (the nowrap status/file chips don't get
       clipped). The two URL columns wrap (break-all) into whatever width is left. containerType lets
       the expandable detail size to the visible width (100cqw). */
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
                <button type="button" onClick={() => onToggle(r.id)} title={L.dtDetails}
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
              <td style={td}><FilesCell L={L} c={r.check} /></td>
              <td style={td}><BodyCell L={L} c={r.check} /></td>
              <td style={td}><StatusBadge status={r.status} /></td>
              <td style={{ ...td, color: "var(--ink-2)", fontSize: 12.5, lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{r.note || "—"}</td>
              <td style={td}>
                <button onClick={() => onDelete(r.id)} title="Remove" style={{ border: "none", background: "transparent", cursor: "pointer", color: "var(--ink-4)", fontSize: 14 }}>✕</button>
              </td>
            </tr>
            {expanded[r.id] && (
              <tr>
                <td colSpan={10} style={{ ...td, background: "var(--bg-1)", padding: 0 }}>
                  {/* sticky + 100cqw pins the detail to the viewport's left edge at the visible width,
                      so the side-by-side OLD/NEW cards stay fully on screen without a horizontal
                      scroll even while the wide table scrolls underneath. */}
                  <div style={{ position: "sticky", left: 0, width: "100cqw", boxSizing: "border-box", padding: "12px 18px 14px" }}>
                    <RowDetail L={L} row={r} />
                  </div>
                </td>
              </tr>
            )}
            </React.Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}
