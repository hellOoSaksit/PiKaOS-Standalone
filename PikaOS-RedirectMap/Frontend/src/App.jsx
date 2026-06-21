/* PiKaOs-RedirectMap (standalone) — URL Redirect Map v0.2.1.
   A single-feature build: just the redirect-map screen. NO sidebar nav, NO login, NO other
   modules. A slim top bar carries the title/version, theme (day/night) + language (EN/TH);
   the rest of the page is the screen itself. The imperative modal/loading hosts and the toast
   provider are mounted here so window.uiConfirm/uiLoading + toasts work as in the full app. */
import React from 'react';
const { useState, useEffect } = React;
import { Redirect } from './screens/screens-redirect.jsx';
import { ToastProvider } from './components/ui/Toast.jsx';
import { UILoadingHost, UIModalHost } from './lib/ui-modal.jsx';

export const VERSION = "0.2.1";
export const PRODUCT = "URL Redirect Map";

function App() {
  const [theme, setThemeState] = useState(() => {
    const t = localStorage.getItem("guild-theme");
    return (t === "pro" || t === "pro-dark") ? t : "pro";
  });
  const [lang, setLangState] = useState(() => localStorage.getItem("redirectmap-lang") || "th");

  useEffect(() => { document.documentElement.setAttribute("data-theme", theme); }, [theme]);
  const setTheme = (t) => { setThemeState(t); try { localStorage.setItem("guild-theme", t); } catch (e) {} };
  const setLang = (l) => { setLangState(l); try { localStorage.setItem("redirectmap-lang", l); } catch (e) {} };

  const bar = {
    display: "flex", alignItems: "center", gap: 14, padding: "12px 22px",
    borderBottom: "1px solid var(--line)", background: "var(--bg-1)", zIndex: 50, flexShrink: 0,
  };
  const seg = { display: "inline-flex", border: "1px solid var(--line)", borderRadius: 8, overflow: "hidden" };
  const segBtn = (on) => ({
    padding: "5px 11px", fontSize: 12.5, cursor: "pointer", border: "none",
    background: on ? "var(--gold)" : "transparent", color: on ? "#fff" : "var(--ink-2)",
  });

  return (
    <ToastProvider>
      <div style={{ height: "100vh", display: "flex", flexDirection: "column", background: "var(--bg)", color: "var(--ink)" }}>
        <header style={bar}>
          <span style={{ fontSize: 20 }}>↪️</span>
          <div style={{ display: "flex", flexDirection: "column", lineHeight: 1.15 }}>
            <strong style={{ fontSize: 15 }}>{PRODUCT}</strong>
            <span className="mono faint" style={{ fontSize: 10.5 }}>old site → new site · standalone</span>
          </div>
          <span className="mono" style={{ fontSize: 11, padding: "2px 8px", borderRadius: 999, border: "1px solid var(--line)", color: "var(--gold)" }}>
            v{VERSION}
          </span>
          <span style={{ flex: 1 }} />
          <div style={seg}>
            <button style={segBtn(lang === "en")} onClick={() => setLang("en")} title="English">EN</button>
            <button style={segBtn(lang === "th")} onClick={() => setLang("th")} title="ไทย">ไทย</button>
          </div>
          <div style={seg}>
            <button style={segBtn(theme === "pro")} onClick={() => setTheme("pro")} title="Day">☀️</button>
            <button style={segBtn(theme === "pro-dark")} onClick={() => setTheme("pro-dark")} title="Night">🌙</button>
          </div>
        </header>

        <div className="content">
          <Redirect lang={lang} />
        </div>
      </div>
      <UIModalHost />
      <UILoadingHost />
    </ToastProvider>
  );
}

export default App;
