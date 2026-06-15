// projectTemplates.ts — multi-file PROJECT templates (V0.11+ client-side
// catalogue). Where lib/templates.ts is per-FILE (single body, single
// path-suggestion), this module bundles several files into one logical
// "starter" : main document + bibliography + (sometimes) chapter
// sub-files or a CV photo placeholder.
//
// Used by ProjectTemplatesGallery.svelte : the user picks a card,
// supplies a project name, and the gallery PUTs every file via
// writeFile() — the backend auto-creates the project on first PUT.
//
// The article / beamer skeletons are intentionally INLINED here
// rather than imported from lib/templates.ts. Two reasons :
//   1. Vite handles `.ts` extension-less imports fine, but the
//      node --test runner (which exercises this module in CI)
//      doesn't resolve them ; inlining keeps the test pure-JS.
//   2. The per-file lib/templates.ts entries can evolve independently
//      from the project-template starters (different defaults are
//      sometimes appropriate). Keep the strings local.
//
// Conventions :
//   - Each `files[].path` is RELATIVE to the project root.
//   - The FIRST entry in `files` is the entry-point — the gallery
//     opens it in the editor after the project is created. Always
//     put main.tex / cv.tex first.
//   - Keep contents minimal-but-functional : enough to compile +
//     show a sensible render, not so much that the user has to
//     delete boilerplate before they can start.
//   - Empty refs.bib files are deliberate ; they exist so \\bibliography
//     references in main.tex don't break the first compile.
//   - "Photo placeholder" for the CV is a 1×1 transparent PNG written
//     as a literal byte sequence. moderncv accepts any image ; the
//     user replaces it after the project opens.

export interface ProjectTemplate {
  id: string;
  name: string;
  description: string;
  emoji: string;
  /** List of files to seed when this template is used. Each path
   *  is relative to the project root. */
  files: Array<{ path: string; content: string }>;
}

// ---- Article (mirrors lib/templates.ts latex-article) ------------
const ARTICLE_TEX = `\\documentclass[a4paper,11pt]{article}
\\usepackage[utf8]{inputenc}
\\usepackage[T1]{fontenc}
\\usepackage{amsmath, amssymb}
\\usepackage{hyperref}

\\title{Article title}
\\author{Author name}
\\date{\\today}

\\begin{document}
\\maketitle

\\begin{abstract}
A short summary of the article.
\\end{abstract}

\\section{Introduction}
Lorem ipsum dolor sit amet, with inline math \\(a^2 + b^2 = c^2\\)
and a display equation :
\\[
\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}
\\]

\\section{Method}
\\textbf{Bold}, \\emph{italic}, a list :
\\begin{itemize}
  \\item one
  \\item two
  \\item three
\\end{itemize}

\\section{Conclusion}
Wrap-up paragraph.

\\bibliographystyle{plain}
\\bibliography{refs}

\\end{document}
`;

// ---- Beamer (mirrors lib/templates.ts latex-beamer) --------------
const BEAMER_TEX = `\\documentclass{beamer}
\\usepackage[utf8]{inputenc}
\\usepackage[T1]{fontenc}
\\usepackage{amsmath, amssymb}

\\usetheme{Madrid}
\\usecolortheme{seahorse}

\\title{Presentation title}
\\subtitle{Optional subtitle}
\\author{Author name}
\\institute{Institute}
\\date{\\today}

\\begin{document}

\\frame{\\titlepage}

\\begin{frame}{Outline}
  \\tableofcontents
\\end{frame}

\\section{Introduction}

\\begin{frame}{Motivation}
  \\begin{itemize}
    \\item First point with inline math \\(E = mc^2\\)
    \\item Second point
    \\item Third point
  \\end{itemize}
\\end{frame}

\\section{Key idea}

\\begin{frame}{Equation}
  Display math centred on the slide :
  \\[
    \\int_{0}^{\\infty} e^{-x^2} \\, dx = \\frac{\\sqrt{\\pi}}{2}
  \\]
\\end{frame}

\\section{Conclusion}

\\begin{frame}{Take-aways}
  \\begin{enumerate}
    \\item Recap point one
    \\item Recap point two
  \\end{enumerate}
\\end{frame}

\\begin{frame}{}
  \\centering
  \\Huge Thank you!
\\end{frame}

\\end{document}
`;

// ---- Report ------------------------------------------------------
// Book class with \chapter ; main.tex \include's chapter files so
// the user sees the multi-file layout immediately. \bibliography
// references refs.bib (empty by default).
const REPORT_MAIN_TEX = `\\documentclass[a4paper,11pt]{book}
\\usepackage[utf8]{inputenc}
\\usepackage[T1]{fontenc}
\\usepackage{amsmath, amssymb}
\\usepackage{graphicx}
\\usepackage{hyperref}

\\title{Report title}
\\author{Author name}
\\date{\\today}

\\begin{document}
\\frontmatter
\\maketitle
\\tableofcontents

\\mainmatter
\\include{chapters/intro}
\\include{chapters/method}

\\backmatter
\\bibliographystyle{plain}
\\bibliography{refs}

\\end{document}
`;

const REPORT_INTRO_TEX = `\\chapter{Introduction}
\\label{ch:intro}

This chapter motivates the work and lays out the structure of the
report. Inline math : \\(a^2 + b^2 = c^2\\). Display math :
\\[
\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}
\\]

\\section{Background}
Prior art, in chronological or thematic order.

\\section{Contributions}
A short summary of what this report establishes.
`;

const REPORT_METHOD_TEX = `\\chapter{Method}
\\label{ch:method}

\\section{Approach}
Describe the approach. Be specific enough that a peer could
reproduce the work from this chapter alone.

\\section{Implementation}
Architecture diagrams, decision rationale, design trade-offs.

\\section{Evaluation}
Metrics + baseline + protocol.
`;

// ---- CV ---------------------------------------------------------
// moderncv classic style ; user replaces \photo path + fields.
// "photo.png" is a 1×1 transparent PNG so the document compiles on
// first try even before the user uploads a real headshot.
const CV_TEX = `\\documentclass[11pt,a4paper,sans]{moderncv}
\\moderncvstyle{classic}
\\moderncvcolor{blue}
\\usepackage[scale=0.8]{geometry}

\\name{First}{Last}
\\title{Job title}
\\address{Street}{Postcode City}{Country}
\\phone[mobile]{+33~6~00~00~00~00}
\\email{you@example.org}
\\homepage{example.org}
\\social[linkedin]{your-handle}
\\social[github]{your-handle}
\\photo[64pt][0.4pt]{photo}

\\begin{document}
\\makecvtitle

\\section{Profile}
\\cvitem{}{One- or two-sentence pitch : the role you want and the value you bring.}

\\section{Experience}
\\cventry{Jan 2024 -- present}{Senior Role}{Company}{City}{}{%
  \\begin{itemize}
    \\item Led a team of N engineers to ship X, which drove Y by Z\\%.
    \\item Owned migration from A to B in Q1 ; reduced infra cost by N\\%.
    \\item Mentored M junior engineers ; two promoted within the year.
  \\end{itemize}}
\\cventry{Jul 2021 -- Dec 2023}{Earlier Role}{Previous Company}{City}{}{%
  Bullet point that highlights an impact, not a duty.}

\\section{Education}
\\cventry{Year}{M.Sc. in Field}{University}{City}{}{}
\\cventry{Year}{B.Sc. in Field}{University}{City}{}{}

\\section{Skills}
\\cvitem{Languages}{...}
\\cvitem{Frameworks}{...}
\\cvitem{Tools}{...}

\\section{Languages}
\\cvitemwithcomment{English}{Fluent}{}
\\cvitemwithcomment{French}{Native}{}

\\end{document}
`;

// 1×1 transparent PNG (67 bytes) encoded as a Latin-1 string. Written
// as a literal byte sequence so the writeFile path stays text-mode ;
// the bytes are valid PNG and moderncv reads it without complaint.
// Generated once : `printf '%s' "$(base64 -d <<< 'iVBORw0…')"` then
// rewritten as escape sequences. Keep verbatim — do NOT re-format.
const CV_PHOTO_PNG_BYTES =
  '\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01' +
  '\x08\x06\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\rIDATx\x9cc\x00' +
  '\x01\x00\x00\x05\x00\x01\r\n-\xb4\x00\x00\x00\x00IEND\xaeB`\x82';

// ---- arXiv preprint ---------------------------------------------
// Article skeleton with the four packages an arXiv preprint usually
// pulls in : amsmath / amsthm / hyperref / cleveref. \input the
// abstract from a separate file so the author can iterate on it
// independently (common workflow on long-form preprints).
const ARXIV_MAIN_TEX = `\\documentclass[11pt]{article}
\\usepackage[utf8]{inputenc}
\\usepackage[T1]{fontenc}
\\usepackage[margin=1in]{geometry}
\\usepackage{amsmath, amssymb, amsthm}
\\usepackage{graphicx}
\\usepackage{hyperref}
\\usepackage{cleveref}

\\newtheorem{theorem}{Theorem}
\\newtheorem{lemma}[theorem]{Lemma}
\\newtheorem{proposition}[theorem]{Proposition}
\\newtheorem{corollary}[theorem]{Corollary}
\\theoremstyle{definition}
\\newtheorem{definition}[theorem]{Definition}
\\theoremstyle{remark}
\\newtheorem{remark}[theorem]{Remark}

\\title{Paper title}
\\author{Author One\\thanks{Affiliation One. \\texttt{one@example.org}} \\and
        Author Two\\thanks{Affiliation Two. \\texttt{two@example.org}}}
\\date{\\today}

\\begin{document}
\\maketitle

\\begin{abstract}
\\input{abstract}
\\end{abstract}

\\section{Introduction}
\\label{sec:intro}
Motivation and contributions. See \\cref{thm:main} for the headline
result.

\\section{Preliminaries}
\\label{sec:prelim}
\\begin{definition}
A short definition.
\\end{definition}

\\section{Main result}
\\label{sec:main}
\\begin{theorem}
\\label{thm:main}
Statement of the main theorem.
\\end{theorem}
\\begin{proof}
Sketch of the proof.
\\end{proof}

\\section{Conclusion}
\\label{sec:conclusion}
Closing remarks and future work.

\\bibliographystyle{plain}
\\bibliography{refs}

\\end{document}
`;

const ARXIV_ABSTRACT_TEX = `We present a short, self-contained abstract of the paper. State the
problem in one sentence, the contribution in one or two, and the
headline result with a number if you have one. Avoid forward
references to undefined symbols ; the abstract should be readable
without the paper.
`;

// ---- IEEE conference --------------------------------------------
// IEEEtran two-column conference template. Kept separate from the
// arXiv preprint because the macros + abstract/keywords convention
// are different (\IEEEpeerreviewmaketitle, \IEEEkeywords, etc.).
const IEEE_MAIN_TEX = `\\documentclass[conference]{IEEEtran}
\\IEEEoverridecommandlockouts
\\usepackage{cite}
\\usepackage{amsmath,amssymb,amsfonts}
\\usepackage{algorithmic}
\\usepackage{graphicx}
\\usepackage{textcomp}
\\usepackage{xcolor}
\\def\\BibTeX{{\\rm B\\kern-.05em{\\sc i\\kern-.025em b}\\kern-.08em
    T\\kern-.1667em\\lower.7ex\\hbox{E}\\kern-.125emX}}

\\begin{document}

\\title{Paper title}

\\author{
\\IEEEauthorblockN{First Author}
\\IEEEauthorblockA{Affiliation \\\\
City, Country \\\\
first@example.org}
\\and
\\IEEEauthorblockN{Second Author}
\\IEEEauthorblockA{Affiliation \\\\
City, Country \\\\
second@example.org}
}

\\maketitle

\\begin{abstract}
One paragraph stating the problem, approach, and contribution. Avoid
acronyms in the first line.
\\end{abstract}

\\begin{IEEEkeywords}
keyword1, keyword2, keyword3
\\end{IEEEkeywords}

\\section{Introduction}
\\label{sec:intro}
Motivation, prior art, contributions.

\\section{Approach}
\\label{sec:approach}
Method, with display math :
\\begin{equation}
E = mc^2
\\end{equation}

\\section{Evaluation}
\\label{sec:eval}
Experimental protocol, baselines, results.

\\section{Conclusion}
\\label{sec:conclusion}
Wrap-up + future work.

\\bibliographystyle{IEEEtran}
\\bibliography{refs}

\\end{document}
`;

export const PROJECT_TEMPLATES: ProjectTemplate[] = [
  {
    id: 'article',
    name: 'LaTeX article',
    description: 'Single-file LaTeX article with a refs.bib bibliography.',
    emoji: 'A',
    files: [
      { path: 'main.tex', content: ARTICLE_TEX },
      { path: 'refs.bib', content: '' },
    ],
  },
  {
    id: 'beamer',
    name: 'Beamer slides',
    description: 'Slide deck with title page, sections, lists, math.',
    emoji: 'B',
    files: [
      { path: 'main.tex', content: BEAMER_TEX },
      { path: 'refs.bib', content: '' },
    ],
  },
  {
    id: 'report',
    name: 'Report (book class)',
    description: 'Multi-chapter report : main.tex + chapters/{intro,method}.tex + refs.bib.',
    emoji: 'R',
    files: [
      { path: 'main.tex', content: REPORT_MAIN_TEX },
      { path: 'chapters/intro.tex', content: REPORT_INTRO_TEX },
      { path: 'chapters/method.tex', content: REPORT_METHOD_TEX },
      { path: 'refs.bib', content: '' },
    ],
  },
  {
    id: 'cv',
    name: 'Curriculum vitae',
    description: 'moderncv classic — cv.tex + placeholder headshot (replace photo.png).',
    emoji: 'CV',
    files: [
      { path: 'cv.tex', content: CV_TEX },
      { path: 'photo.png', content: CV_PHOTO_PNG_BYTES },
    ],
  },
  {
    id: 'ieee',
    name: 'IEEE conference paper',
    description: 'IEEEtran two-column conference template with refs.bib.',
    emoji: 'IEEE',
    files: [
      { path: 'main.tex', content: IEEE_MAIN_TEX },
      { path: 'refs.bib', content: '' },
    ],
  },
  {
    id: 'arxiv',
    name: 'arXiv preprint',
    description: 'Article + amsmath/amsthm/cleveref/hyperref preamble + separate abstract.tex.',
    emoji: 'arX',
    files: [
      { path: 'main.tex', content: ARXIV_MAIN_TEX },
      { path: 'abstract.tex', content: ARXIV_ABSTRACT_TEX },
      { path: 'refs.bib', content: '' },
    ],
  },
];

export function findProjectTemplate(id: string): ProjectTemplate | undefined {
  return PROJECT_TEMPLATES.find((t) => t.id === id);
}
