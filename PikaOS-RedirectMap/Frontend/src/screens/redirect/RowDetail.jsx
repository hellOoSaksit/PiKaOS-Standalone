/* For human — the expandable per-row detail: a side-by-side OLD vs NEW comparison (HTTP, body state,
   redirect/final URL, files, verdict) plus the read-only "close matches" list. Pure presentation,
   driven by the row's verify result (row.check) and Discover candidates — nothing here mutates state. */
import React from 'react';
import { OpenLink, bodyState, BigHttp } from './cells.jsx';

// read-only "close matches" list (from Discover's fuzzy ranking) — helps decide whether the chosen
// new URL is right; each is openable, nothing is changed.
export function Candidates({ L, row }) {
  const list = row.candidates || [];
  if (!list.length) return <span className="muted" style={{ fontSize: 12 }}>—</span>;
  return (
    <div>
      <div style={{ fontSize: 11, fontWeight: 700, color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: ".04em", marginBottom: 6 }}>{L.candTitle}</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {list.map((c, i) => {
          const chosen = c.url === row.newUrl;
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
}

export function RowDetail({ L, row }) {
  const c = row.check;
  if (!c || !c.bodyChecked) return <span className="muted" style={{ fontSize: 12 }}>{L.dtNone}</span>;
  const mono = { fontFamily: "var(--font-mono)", fontSize: 11.5, color: "var(--ink-2)", wordBreak: "break-all" };
  const dRow = (k, v) => (v == null || v === "" ? null : (
    <div style={{ display: "flex", gap: 10, alignItems: "baseline", padding: "3px 0" }}>
      <span style={{ minWidth: 70, flexShrink: 0, color: "var(--ink-3)", fontSize: 11.5 }}>{k}</span>
      <span style={{ fontSize: 12, color: "var(--ink-2)", wordBreak: "break-all", flex: 1 }}>{v}</span>
    </div>
  ));
  const bodyPill = (hasBody, thin, error, spa) => {
    const s = bodyState(L, hasBody, thin, error, spa);
    return <span style={{ display: "inline-flex", alignItems: "center", gap: 6, color: s.c, fontSize: 12 }}>
      <span style={{ width: 7, height: 7, borderRadius: 999, background: s.c, flexShrink: 0 }} />{s.t}</span>;
  };
  const sideCard = (title, url, status, body) => (
    <div style={{ flex: "1 1 320px", minWidth: 268, border: "1px solid var(--line)", borderRadius: 10, padding: "11px 13px", background: "var(--bg)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <span style={{ fontWeight: 700, fontSize: 12.5, color: "var(--ink)" }}>{title}</span>
        <BigHttp L={L} code={status} />
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
        {sideCard(L.dtOld, row.oldUrl, c.oldStatus, <>
          {dRow(L.dtContent, bodyPill(c.oldHasBody, c.oldBodyThin, c.oldError, c.oldSpa))}
          {dRow("H1", c.oldHasH1 ? L.dtH1yes : L.dtH1no)}
          {c.oldRedirectsTo && dRow(L.dtRedir, <span style={mono}>{c.oldRedirectsTo}</span>)}
        </>)}
        {sideCard(L.dtNew, row.newUrl, c.newStatus, <>
          {dRow(L.dtContent, bodyPill(c.newHasBody, c.newBodyThin, c.newError, c.newSpa))}
          {dRow("H1", c.newHasH1 ? L.dtH1yes : L.dtH1no)}
          {c.newFinalUrl && c.newFinalUrl !== row.newUrl && dRow(L.dtFinal, <span style={mono}>{c.newFinalUrl}</span>)}
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
      {row.candidates && row.candidates.length > 1 && (
        <div style={{ padding: "4px 2px 0" }}><Candidates L={L} row={row} /></div>
      )}
    </div>
  );
}
