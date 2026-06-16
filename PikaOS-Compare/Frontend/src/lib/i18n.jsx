/* PiKaOs — KEY-BASED i18n ENGINE (Language + Lexicon architecture, fully data-driven).
   localization file = src/data/i18n/<lang>-<lexicon>.json — รูปแบบ:
   {
     "languageCode": "en", "languageName": "English",
     "lexiconCode": "formal", "lexiconName": "Formal",
     "isDefaultLanguage": true, "isDefaultLexicon": true,
     "translations": { "head.title": "Sitemap Match", "common.save": "Save", ... }
   }
   1 ไฟล์ = 1 ภาษา + 1 lexicon (รูปแบบคำศัพท์) + 1 ชุดคำแปล · เพิ่มไฟล์ = ค้นพบอัตโนมัติ ไม่ต้องแก้โค้ด
   โค้ดหน้าจอเรียก t("some.key", { var }) เท่านั้น — ไม่มี hardcode ข้อความ

   FALLBACK 4 ชั้น: ภาษา+lexicon ที่เลือก → ภาษา+default-lexicon → default-lang+lexicon → default-lang+default-lexicon → ตัวคีย์
   default ทั้งภาษาและ lexicon มาจาก flag isDefaultLanguage/isDefaultLexicon ในไฟล์ (English + Formal) — ไม่ hardcode */
import React from 'react';

/* ---- scan localization files (Vite glob — the preview bundler inlines this) ---- */
const _i18nModules = import.meta.glob('../data/i18n/*.json', { eager: true });
const _i18nFiles = Object.values(_i18nModules).map(m => (m && m.default) ? m.default : m).filter(Boolean);

/* ---- registry I18N_PACKS[languageCode][lexiconCode] = translations ---- */
const I18N_PACKS = {};
const _langName = {};                 // languageCode -> languageName
const _lexName = {};                  // `${lang}:${lex}` -> lexiconName
let DEFAULT_LANG = null, DEFAULT_STYLE = null;

for (const f of _i18nFiles) {
  const lang = f.languageCode, lex = f.lexiconCode;
  if (!lang || !lex) continue;
  (I18N_PACKS[lang] = I18N_PACKS[lang] || {})[lex] = f.translations || {};
  if (!_langName[lang]) _langName[lang] = f.languageName || lang;
  _lexName[lang + ":" + lex] = f.lexiconName || lex;
  if (f.isDefaultLanguage) DEFAULT_LANG = lang;
  if (f.isDefaultLanguage && f.isDefaultLexicon) DEFAULT_STYLE = lex;   // master = en + formal
}
DEFAULT_LANG = DEFAULT_LANG || Object.keys(I18N_PACKS)[0] || "en";
DEFAULT_STYLE = DEFAULT_STYLE || Object.keys(I18N_PACKS[DEFAULT_LANG] || {})[0] || "formal";

/* ---- discovery (driven entirely by the files) ----
   I18N_LANGUAGES = ภาษาแบบไม่ซ้ำ · lexiconsForLanguage(code) = ทุก lexicon ของภาษานั้น */
const I18N_LANGUAGES = Object.keys(I18N_PACKS).map(code => ({ code, name: _langName[code] }));
function lexiconsForLanguage(code) {
  return Object.keys(I18N_PACKS[code] || {}).map(lex => ({ code: lex, name: _lexName[code + ":" + lex] }));
}

function _pack(lang, style) { return (I18N_PACKS[lang] && I18N_PACKS[lang][style]) || null; }

/* ---- interpolate {name} placeholders ---- */
function _interp(str, vars) {
  if (!vars || typeof str !== "string") return str;
  return str.replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? String(vars[k]) : m));
}

/* ---- resolve one key through the 4-level fallback chain ---- */
function resolveKey(lang, style, key) {
  const chain = [
    _pack(lang, style),
    _pack(lang, DEFAULT_STYLE),
    _pack(DEFAULT_LANG, style),
    _pack(DEFAULT_LANG, DEFAULT_STYLE),
  ];
  for (const p of chain) {
    if (p && Object.prototype.hasOwnProperty.call(p, key)) return p[key];
  }
  return null;
}

/* ---- makeT(lang, style) → t(key, vars) bound to the active selection ---- */
function makeT(lang, style) {
  const L = lang || DEFAULT_LANG;
  const S = style || DEFAULT_STYLE;
  const t = (key, vars) => {
    const hit = resolveKey(L, S, key);
    return _interp(hit != null ? hit : key, vars);   // never show a blank — fall back to the key
  };
  t.lang = L; t.style = S;
  t.has = (key) => resolveKey(L, S, key) != null;
  return t;
}

/* ---- PACK REGISTRY (display metadata for the settings picker) ----
   built from each file's `meta` block — replaces the old lexicon registry.
   each pack = 1 file = 1 language + 1 vocabulary style, with display fields. */
const LEX_PACKS = _i18nFiles.map(f => {
  const m = f.meta || {};
  const styleLabel = m.title || f.lexiconName || f.lexiconCode;
  return {
    id: m.id || (f.languageCode + "-" + f.lexiconCode),
    lang: f.languageCode,
    styleKey: f.lexiconCode,                 // i18n lexiconCode (drives t())
    formal: !!m.formal,
    // language display
    langLabel: m.langLabel || f.languageName || f.languageCode,
    langEn: m.langEn || f.languageName || f.languageCode,
    langSample: m.langSample || m.sample || "",
    langOrder: m.langOrder != null ? m.langOrder : 99,
    // style display
    icon: m.icon || "", type: m.type || "",
    title: styleLabel, styleLabel,
    en: m.en || f.lexiconName || "", styleEn: m.en || f.lexiconName || "",
    sample: m.sample || "", desc: m.desc || "",
    order: m.order != null ? m.order : 99,
  };
}).sort((a, b) => (a.order || 99) - (b.order || 99));

function packById(id) { return LEX_PACKS.find(p => p.id === id) || null; }
function defaultPack() {
  return LEX_PACKS.find(p => p.lang === DEFAULT_LANG && p.styleKey === DEFAULT_STYLE) || LEX_PACKS[0] || null;
}

/* language registry: group packs by language, dedupe display, keep all styles */
const _langMap = new Map();
for (const p of LEX_PACKS) {
  if (!_langMap.has(p.lang)) {
    _langMap.set(p.lang, { code: p.lang, label: p.langLabel, en: p.langEn, sample: p.langSample, order: p.langOrder, styles: [] });
  }
  _langMap.get(p.lang).styles.push(p);
}
const LEX_LANGS = [..._langMap.values()]
  .map(l => ({ ...l, styles: l.styles.slice().sort((a, b) => (a.order || 99) - (b.order || 99)) }))
  .sort((a, b) => (a.order || 99) - (b.order || 99));

function langByCode(code) { return LEX_LANGS.find(l => l.code === code) || LEX_LANGS[0] || null; }
function stylesForLang(code) { const l = langByCode(code); return l ? l.styles : []; }
function defaultPackForLang(code) { const s = stylesForLang(code); return s[0] || defaultPack(); }

window.makeT = makeT;
window.i18nPacks = I18N_PACKS;
window.i18nLanguages = I18N_LANGUAGES;
window.langPacks = LEX_PACKS;

export {
  I18N_PACKS, I18N_LANGUAGES, lexiconsForLanguage,
  makeT, resolveKey, DEFAULT_LANG, DEFAULT_STYLE,
  LEX_PACKS, LEX_LANGS,
  packById, defaultPack, defaultPackForLang, langByCode, stylesForLang,
};
