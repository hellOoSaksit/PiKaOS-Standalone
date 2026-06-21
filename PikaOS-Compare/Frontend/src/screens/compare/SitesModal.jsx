/* For human — the "saved sites" manager modal: the reusable list of Production/UAT pairs (+ optional
   per-side creds) on top, an add/edit form below. Pure UI: the screen owns the `sites` list (persisted
   to localStorage via the data module) and all the handlers. SECURITY: saved creds are plaintext in
   localStorage by explicit user opt-in — local/internal tool only (see data/compare-sites.jsx). */
import React from 'react';
import { Btn } from '../../components/components.jsx';
import Modal from '../../components/ui/Modal.jsx';
import Field from '../../components/ui/Input.jsx';

export function SitesModal({
  open, onClose, t, sites, siteDraft, setSiteDraft, blankDraft, draftCred,
  applySite, editSite, deleteSite, saveDraft, hostOf,
}) {
  return (
    <Modal open={open} onClose={onClose} title={"📁 " + t("compare.sites.title")}
      footer={<Btn kind="ghost" onClick={onClose}>{t("compare.auth.cancel")}</Btn>}>
      <div className="col" style={{ gap: 14 }}>
        {sites.length === 0
          ? <div className="qei-note">{t("compare.sites.empty")}</div>
          : <div className="col" style={{ gap: 6 }}>
              {sites.map(s => (
                <div key={s.id} className="row" style={{ gap: 8, alignItems: "center", padding: "6px 8px", border: "1px solid var(--line-soft)", borderRadius: 8 }}>
                  <div className="col" style={{ gap: 1, minWidth: 0, flex: 1 }}>
                    <b style={{ fontSize: 13 }}>{s.name || hostOf(s.prod)}{(s.prodAuth || s.uatAuth) ? " 🔑" : ""}</b>
                    <span className="mono faint" style={{ fontSize: 11, wordBreak: "break-all" }}>{hostOf(s.prod)} → {hostOf(s.uat)}</span>
                  </div>
                  <Btn kind="ghost" sm onClick={() => { applySite(s.id); onClose(); }}>{t("compare.sites.use")}</Btn>
                  <Btn kind="ghost" sm onClick={() => editSite(s)}>{t("compare.auth.edit")}</Btn>
                  <Btn kind="ghost" sm icon="🗑" onClick={() => deleteSite(s)}>{t("compare.sites.del")}</Btn>
                </div>
              ))}
            </div>}

        <div style={{ height: 1, background: "var(--line)", margin: "2px 0" }} />

        <div className="col" style={{ gap: 10 }}>
          <div className="bf-label" style={{ margin: 0 }}>{siteDraft.id ? t("compare.sites.editEntry") : t("compare.sites.newEntry")}</div>
          <Field label={t("compare.sites.name")} value={siteDraft.name} placeholder={t("compare.sites.namePh")}
            onChange={e => setSiteDraft(d => ({ ...d, name: e.target.value }))} />
          <Field label={t("compare.f.prod")} value={siteDraft.prod} placeholder={t("compare.f.prodPh")}
            onChange={e => setSiteDraft(d => ({ ...d, prod: e.target.value }))} />
          <Field label={t("compare.f.uat")} value={siteDraft.uat} placeholder={t("compare.f.uatPh")}
            onChange={e => setSiteDraft(d => ({ ...d, uat: e.target.value }))} />
          <div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
            <div className="col" style={{ gap: 6, flex: "1 1 240px" }}>
              <div className="mono faint" style={{ fontSize: 11 }}>PROD 🔑 <span className="faint">({t("compare.sites.optional")})</span></div>
              <Field label={t("compare.auth.user")} value={siteDraft.prodAuth.username} autoComplete="off" onChange={draftCred("prodAuth", "username")} />
              <Field label={t("compare.auth.pass")} type="password" value={siteDraft.prodAuth.password} autoComplete="off" onChange={draftCred("prodAuth", "password")} />
            </div>
            <div className="col" style={{ gap: 6, flex: "1 1 240px" }}>
              <div className="mono faint" style={{ fontSize: 11 }}>UAT 🔑 <span className="faint">({t("compare.sites.optional")})</span></div>
              <Field label={t("compare.auth.user")} value={siteDraft.uatAuth.username} autoComplete="off" onChange={draftCred("uatAuth", "username")} />
              <Field label={t("compare.auth.pass")} type="password" value={siteDraft.uatAuth.password} autoComplete="off" onChange={draftCred("uatAuth", "password")} />
            </div>
          </div>
          <div className="qei-note" style={{ fontSize: 11 }}>{t("compare.sites.credNote")}</div>
          <div className="row" style={{ gap: 8 }}>
            <Btn kind="gold" onClick={saveDraft}>{siteDraft.id ? t("compare.sites.update") : t("compare.sites.add")}</Btn>
            {siteDraft.id && <Btn kind="ghost" onClick={() => setSiteDraft(blankDraft())}>{t("compare.sites.newBtn")}</Btn>}
          </div>
        </div>
      </div>
    </Modal>
  );
}
