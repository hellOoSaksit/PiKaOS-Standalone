/* For human — the per-side login (Basic Auth / custom header) modal. Auto-opens when a run hits a
   401/403; the user fills Production and/or UAT credentials, submit re-runs. Pure UI: the screen owns
   the in-memory credential state + the submit logic. Credentials are never persisted from here. */
import React from 'react';
import { Btn } from '../../components/components.jsx';
import Modal from '../../components/ui/Modal.jsx';
import Field from '../../components/ui/Input.jsx';

export function AuthModal({ open, onClose, t, mode, res, authTab, setAuthTab, authForm, setAuthForm, onSubmit, credFromForm }) {
  const af = authForm[authTab];
  const sf = (k) => (e) => setAuthForm(f => ({ ...f, [authTab]: { ...f[authTab], [k]: e.target.value } }));
  const filled = (side) => !!credFromForm(authForm[side]);
  const wallCount = res ? res.items.filter(it => [401, 403].includes(it.prodStatus) || [401, 403].includes(it.uatStatus)).length : 0;
  return (
    <Modal open={open} onClose={onClose} title={"🔑 " + t("compare.auth.title")}
      footer={<>
        <Btn kind="ghost" onClick={onClose}>{t("compare.auth.cancel")}</Btn>
        <Btn kind="gold" onClick={onSubmit}>{t("compare.auth.submit")}</Btn>
      </>}>
      <div className="col" style={{ gap: 12 }}>
        <div className="qei-note">{mode === "pair"
          ? t("compare.auth.detectedPair")
          : t("compare.auth.detected", { n: wallCount })}</div>
        <div className="seg-toggle">
          <button type="button" className={authTab === "prod" ? "on" : ""} onClick={() => setAuthTab("prod")}>{t("compare.auth.tabProd")}{filled("prod") ? " ●" : ""}</button>
          <button type="button" className={authTab === "uat" ? "on" : ""} onClick={() => setAuthTab("uat")}>{t("compare.auth.tabUat")}{filled("uat") ? " ●" : ""}</button>
        </div>
        <Field label={t("compare.auth.user")} value={af.username} autoComplete="off"
          placeholder={t("compare.auth.userPh")} onChange={sf("username")} />
        <Field label={t("compare.auth.pass")} type="password" value={af.password} autoComplete="off" onChange={sf("password")} />
        <div className="row" style={{ gap: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
          <div style={{ flex: "1 1 150px" }}>
            <Field label={t("compare.auth.headerName")} value={af.headerName}
              placeholder={t("compare.auth.headerNamePh")} onChange={sf("headerName")} />
          </div>
          <div style={{ flex: "2 1 220px" }}>
            <Field label={t("compare.auth.headerValue")} value={af.headerValue}
              placeholder={t("compare.auth.headerValuePh")} onChange={sf("headerValue")} />
          </div>
        </div>
        <div className="qei-note" style={{ fontSize: 11 }}>{t("compare.auth.bothHint")} · {t("compare.auth.hint")}</div>
      </div>
    </Modal>
  );
}
