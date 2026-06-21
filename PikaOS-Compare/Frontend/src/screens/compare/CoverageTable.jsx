/* For human — the coverage results panel: category filter + sort + search bar over the URL table,
   one row per checked path (state · src/tgt status · deep verdict · note · open-target), with an
   expandable DeepDetail per row. Display only — it renders the already filtered+sorted `shown`; the
   screen owns the data, the deep cache, and the callbacks. */
import React from 'react';
import { Btn, Empty, Panel } from '../../components/components.jsx';
import { DEEP_TONE, STATE_TONE } from './helpers.js';
import { DeepDetail } from './DeepDetail.jsx';

const thCell = { padding: "8px 14px", textAlign: "left", color: "var(--ink-3)", fontSize: 11, fontWeight: 600, borderBottom: "1px solid var(--line)", whiteSpace: "nowrap" };
const tdCell = { padding: "10px 14px", verticalAlign: "top", borderTop: "1px solid var(--line-soft)" };

export function CoverageTable({
  t, res, shown, cats, filter, setFilter, sort, setSort, q, setQ,
  srcShort, tgtShort, deepData, deepTargets, open, toggleRow, deepOne, stateLabel,
}) {
  return (
    <Panel title={t("compare.results")} en="COVERAGE" icon="📋" bodyPad={false}
      right={<span className="mono faint" style={{ fontSize: 11 }}>{shown.length}/{res.items.length}</span>}>
      {res.items.length === 0
        ? <div style={{ padding: 16 }}><Empty icon="🔀" title={t("compare.empty.title")} sub={t("compare.empty.sub")} /></div>
        : (
          <>
            <div className="cmp-filterbar" style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", padding: "12px 14px" }}>
              {cats.map(([k, label, n]) => (
                <button key={k} className={`tab-pill ${filter === k ? "on" : ""}`} disabled={n === 0 && k !== "all"} onClick={() => setFilter(k)}>
                  {label} <span className="mono faint">{n}</span>
                </button>
              ))}
              <div className="row" style={{ marginLeft: "auto", gap: 6, alignItems: "center" }}>
                <span className="mono faint" style={{ fontSize: 11 }}>{t("compare.sort.label")}</span>
                <div className="seg-toggle">
                  <button type="button" className={sort === "diff" ? "on" : ""} onClick={() => setSort("diff")}>{t("compare.sort.diff")}</button>
                  <button type="button" className={sort === "path" ? "on" : ""} onClick={() => setSort("path")}>{t("compare.sort.path")}</button>
                  <button type="button" className={sort === "status" ? "on" : ""} onClick={() => setSort("status")}>{t("compare.sort.status")}</button>
                </div>
              </div>
              <div className="cmp-search" style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span className="rs-ic">🔍</span>
                <input className="bf-input" style={{ height: 30, width: 190 }} value={q} onChange={e => setQ(e.target.value)} placeholder={t("compare.searchPh")} />
                {q && <button className="rs-clear" onClick={() => setQ("")}>✕</button>}
              </div>
            </div>
            {shown.length === 0
              ? <div style={{ padding: 16 }}><Empty icon="🔍" title={t("compare.noMatch")} sub={t("compare.noMatchSub")} /></div>
              : (
                <div style={{ overflowX: "auto" }}>
                  <table className="cmp-table" style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                    <thead>
                      <tr>
                        <th style={thCell}>{t("compare.col.state")}</th>
                        <th style={thCell}>{t("compare.col.path")}</th>
                        <th style={{ ...thCell, textAlign: "center" }}>{srcShort}</th>
                        <th style={{ ...thCell, textAlign: "center" }}>{tgtShort}</th>
                        <th style={thCell}>{t("compare.col.deep")}</th>
                        <th style={thCell}>{t("compare.col.note")}</th>
                        <th style={thCell} />
                      </tr>
                    </thead>
                    <tbody>
                      {shown.map((it) => {
                        const d = deepData[it.path] || it.deep;
                        const loading = deepTargets.has(it.path) && !d;
                        const isOpen = open.has(it.path);
                        const deepable = it.state === "match" || it.state === "redirect";
                        return (
                        <React.Fragment key={it.path}>
                        <tr className={`${d ? "is-row" : ""} ${isOpen ? "is-open" : ""}`} style={{ cursor: d ? "pointer" : "default", opacity: loading ? .5 : 1 }} onClick={d ? () => toggleRow(it.path) : undefined}>
                          <td style={tdCell}>
                            <span className={`badge ${STATE_TONE[it.state] || "idle"}`} style={{ whiteSpace: "nowrap" }} title={t("compare.statusHint")}>
                              <span className="dot" />{stateLabel(it.state)}
                            </span>
                            {/* coverage "match" = URL reachable on both; CONTENT may still differ → say so when deep found diffs */}
                            {it.state === "match" && d && d.deepState && !["identical", "unfetchable"].includes(d.deepState) && (
                              <div className="mono" style={{ fontSize: 10, color: "var(--crimson)", marginTop: 3 }}>≠ {t("compare.contentDiffers")}</div>
                            )}
                          </td>
                          <td style={{ ...tdCell, fontFamily: "var(--font-mono)", wordBreak: "break-all" }}>{it.path}</td>
                          <td style={{ ...tdCell, textAlign: "center", fontFamily: "var(--font-mono)", color: "var(--ink-2)" }}>{it.prodStatus ?? "—"}</td>
                          <td style={{ ...tdCell, textAlign: "center", fontFamily: "var(--font-mono)", color: "var(--ink-2)" }}>{it.uatStatus ?? "—"}</td>
                          <td style={{ ...tdCell, whiteSpace: "nowrap" }}>
                            {loading ? (
                              <span className="cmp-skel" title={t("compare.deep.loadingRow")} />
                            ) : d ? (
                              <span className={`badge ${DEEP_TONE[d.deepState] || "idle"}`} title={t("compare.deep.expand")}>
                                <span className="dot" />{t("compare.deep.state." + d.deepState)} <span className={`cmp-chev ${isOpen ? "is-open" : ""}`}>▸</span>
                              </span>
                            ) : deepable ? (
                              <Btn kind="ghost" sm icon="🔬" onClick={(e) => { e.stopPropagation(); deepOne(it); }}>{t("compare.deep.one")}</Btn>
                            ) : <span className="mono faint">—</span>}
                          </td>
                          <td style={{ ...tdCell, color: "var(--ink-3)", fontSize: 12 }}>{it.note || ""}</td>
                          <td style={{ ...tdCell, whiteSpace: "nowrap" }}>
                            <a className="cmp-link mono" href={it.uatUrl} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()}>{tgtShort} ↗</a>
                          </td>
                        </tr>
                        {d && isOpen && (
                          <tr className="cmp-detail">
                            <td colSpan={7} style={{ padding: "12px 16px 18px" }}>
                              <div className="cmp-grow"><div className="cmp-clip">
                                <DeepDetail d={d} srcUrl={it.prodUrl} tgtUrl={it.uatUrl} srcShort={srcShort} tgtShort={tgtShort} t={t} />
                              </div></div>
                            </td>
                          </tr>
                        )}
                        </React.Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
          </>
        )}
    </Panel>
  );
}
