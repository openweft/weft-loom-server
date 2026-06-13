// marp_template.ts — generates the Marp markdown deck for the
// "Marp slides" template, parameterised by (theme, language).
//
// The Marp catalogue (marp.ts) decides which `theme:` value lands
// in the YAML front-matter ; this module localises the slide copy
// + injects the institutional cover-page anchor when an
// institutional theme is picked, so the resulting deck looks
// adapted out-of-the-box without forcing the user to translate
// every label.

import { MARP_THEMES } from './marp';

export type MarpLang = 'en' | 'fr' | 'de' | 'es' | 'it' | 'ja' | 'zh';

export interface MarpLangSpec {
  id: MarpLang;
  label: string;        // human label for the picker
  outline: string;
  intro: string;
  method: string;
  results: string;
  conclusion: string;
  math: string;
  lists: string;
  code: string;
  thanks: string;
  title: string;        // placeholder slide title
  author: string;       // "Author" word
  inlineMath: string;   // "Inline:" prefix for the math slide
  displayMath: string;  // "Display:" prefix
  bulletOne: string;
  bulletTwo: string;
  nested: string;
  enumerated: string;
  items: string;
}

export const MARP_LANGS: MarpLangSpec[] = [
  {
    id: 'en', label: 'English',
    title: 'Presentation title', author: 'Author',
    outline: 'Outline', intro: 'Introduction', method: 'Method',
    results: 'Results', conclusion: 'Conclusion',
    math: 'Math', lists: 'Lists', code: 'Code', thanks: 'Thank you',
    inlineMath: 'Inline', displayMath: 'Display',
    bulletOne: 'Bullet one', bulletTwo: 'Bullet two',
    nested: 'nested', enumerated: 'enumerated', items: 'items',
  },
  {
    id: 'fr', label: 'Français',
    title: 'Titre de la présentation', author: 'Auteur',
    outline: 'Plan', intro: 'Introduction', method: 'Méthode',
    results: 'Résultats', conclusion: 'Conclusion',
    math: 'Mathématiques', lists: 'Listes', code: 'Code', thanks: 'Merci',
    inlineMath: 'En ligne', displayMath: 'Affichée',
    bulletOne: 'Premier point', bulletTwo: 'Deuxième point',
    nested: 'imbriqué', enumerated: 'numérotés', items: 'éléments',
  },
  {
    id: 'de', label: 'Deutsch',
    title: 'Vortragstitel', author: 'Autor',
    outline: 'Übersicht', intro: 'Einleitung', method: 'Methode',
    results: 'Ergebnisse', conclusion: 'Schlussfolgerung',
    math: 'Mathematik', lists: 'Listen', code: 'Code', thanks: 'Vielen Dank',
    inlineMath: 'Inline', displayMath: 'Anzeige',
    bulletOne: 'Erster Punkt', bulletTwo: 'Zweiter Punkt',
    nested: 'verschachtelt', enumerated: 'nummeriert', items: 'Elemente',
  },
  {
    id: 'es', label: 'Español',
    title: 'Título de la presentación', author: 'Autor',
    outline: 'Esquema', intro: 'Introducción', method: 'Método',
    results: 'Resultados', conclusion: 'Conclusión',
    math: 'Matemáticas', lists: 'Listas', code: 'Código', thanks: 'Gracias',
    inlineMath: 'En línea', displayMath: 'En bloque',
    bulletOne: 'Primer punto', bulletTwo: 'Segundo punto',
    nested: 'anidado', enumerated: 'numerados', items: 'elementos',
  },
  {
    id: 'it', label: 'Italiano',
    title: 'Titolo della presentazione', author: 'Autore',
    outline: 'Sommario', intro: 'Introduzione', method: 'Metodo',
    results: 'Risultati', conclusion: 'Conclusione',
    math: 'Matematica', lists: 'Elenchi', code: 'Codice', thanks: 'Grazie',
    inlineMath: 'In linea', displayMath: 'In blocco',
    bulletOne: 'Primo punto', bulletTwo: 'Secondo punto',
    nested: 'annidato', enumerated: 'numerati', items: 'elementi',
  },
  {
    id: 'ja', label: '日本語',
    title: 'プレゼンテーションのタイトル', author: '著者',
    outline: '目次', intro: 'はじめに', method: '手法',
    results: '結果', conclusion: 'まとめ',
    math: '数式', lists: 'リスト', code: 'コード', thanks: 'ありがとうございました',
    inlineMath: 'インライン', displayMath: 'ディスプレイ',
    bulletOne: '項目1', bulletTwo: '項目2',
    nested: 'ネスト', enumerated: '番号付き', items: '項目',
  },
  {
    id: 'zh', label: '中文',
    title: '演讲标题', author: '作者',
    outline: '目录', intro: '引言', method: '方法',
    results: '结果', conclusion: '结论',
    math: '数学', lists: '列表', code: '代码', thanks: '谢谢',
    inlineMath: '行内', displayMath: '行间',
    bulletOne: '第一点', bulletTwo: '第二点',
    nested: '嵌套', enumerated: '编号', items: '项',
  },
];

export function findLang(id: string): MarpLangSpec {
  return MARP_LANGS.find(l => l.id === id) ?? MARP_LANGS[0];
}

// renderMarpDeck : produce the markdown body of a Marp deck for the
// given theme + language. The institutional themes get a cover-page
// background-image hook (`_class: lead`) + the brand wordmark as a
// CSS variable the openweft Marp themes (weft-loom-theme-*) consume
// at compile time.
//
// Locale-specific date format : we leave ${ new Date()... } in the
// content because the in-window preview AND the V0.1.4 server-side
// `compile/template.go` know how to evaluate it. The author line
// uses the localised "Author" word so the placeholder reads right.
export function renderMarpDeck(themeId: string, langId: MarpLang): string {
  const L = findLang(langId);
  const theme = MARP_THEMES.find(t => t.id === themeId) ?? MARP_THEMES[0];
  // Locale tag for the `lang:` YAML front-matter so screen readers +
  // hyphenation engines pick the right language.
  const localeTag = ({
    en: 'en-US', fr: 'fr-FR', de: 'de-DE', es: 'es-ES',
    it: 'it-IT', ja: 'ja-JP', zh: 'zh-CN',
  } as const)[langId] ?? 'en-US';
  // Institutional themes get a "lead" cover-page class their CSS
  // recognises ; falls back to a normal first slide for non-
  // institutional themes.
  const institutionalIds = new Set([
    'polytechnique', 'ip-paris', 'cnrs', 'dinum', 'paris-saclay', 'ihes',
  ]);
  const isInstitutional = institutionalIds.has(theme.id);
  const coverHeader = isInstitutional
    ? `<!-- _class: lead -->\n`
    : '';
  return `---
marp: true
theme: ${theme.id}
paginate: true
size: 16:9
lang: ${localeTag}
---

${coverHeader}# ${L.title}

${L.author} · \${ new Date().getFullYear() }

---

## ${L.outline}

- ${L.intro}
- ${L.method}
- ${L.results}
- ${L.conclusion}

---

## ${L.math}

${L.inlineMath} : $E = mc^2$

${L.displayMath} :

$$
\\int_{0}^{\\infty} e^{-x^2} \\, dx = \\frac{\\sqrt{\\pi}}{2}
$$

---

## ${L.lists}

- ${L.bulletOne}
- ${L.bulletTwo}
  - ${L.nested}

1. ${L.enumerated}
2. ${L.items}

---

## ${L.code}

\`\`\`go
func main() {
    fmt.Println("Marp + weft-loom")
}
\`\`\`

---

# ${L.thanks}
`;
}
