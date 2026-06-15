package server

// api_project_templates.go : multi-file project scaffolds. Beyond
// the per-file template catalogue in web/src/lib/templates.ts,
// V0.11 lets a user drop a whole directory layout into their
// project with one click — "PhD thesis" produces main.tex +
// chapter1.tex + chapter2.tex + refs.bib + README.md, all wired up.
//
// Wire shape :
//   GET  /api/project-templates           → { items: [{id,name,description,files:[{path,size}]}] }
//   POST /api/projects/{name}/scaffold    body: { template_id, force? }
//                                          → 200 { written: ["path", …] }
//                                            409 if any target exists + force=false

import (
	"bytes"
	"encoding/json"
	"net/http"
	"strings"

	"github.com/openweft/weft-loom-server/internal/auth"
	"github.com/openweft/weft-loom-server/internal/eventbus"
)

// scaffoldFile is one entry in a template's file list.
type scaffoldFile struct {
	Path    string `json:"path"`
	Content string `json:"-"`
	Size    int    `json:"size"`
}

// projectTemplate is a curated scaffold the SPA surfaces in the
// "New project from template" picker.
type projectTemplate struct {
	ID          string         `json:"id"`
	Name        string         `json:"name"`
	Description string         `json:"description"`
	Language    string         `json:"language"`
	Files       []scaffoldFile `json:"files"`
}

// projectTemplates is the curated set. Each file's Content is
// inlined here so the catalogue is self-contained — no extra
// disk reads at request time. The Size field is filled in once at
// boot for the GET response so the SPA can show "5 files, 6.2 KB"
// without re-stringifying.
var projectTemplates = func() []projectTemplate {
	t := []projectTemplate{
		{
			ID:          "latex-article-bib",
			Name:        "LaTeX article with bibliography",
			Description: "Single-file main.tex + refs.bib + figures/ folder. Good starting point for a conference paper.",
			Language:    "latex",
			Files: []scaffoldFile{
				{Path: "main.tex", Content: `\documentclass[11pt]{article}
\usepackage[utf8]{inputenc}
\usepackage[T1]{fontenc}
\usepackage{lmodern}
\usepackage{graphicx}
\usepackage{hyperref}
\usepackage{cite}

\title{Article Title}
\author{Your Name}
\date{\today}

\begin{document}
\maketitle

\begin{abstract}
A short abstract describing the paper.
\end{abstract}

\section{Introduction}

Background + motivation. Cite related work like~\cite{example2024}.

\section{Method}

Describe the approach.

\section{Results}

Tables, plots, numbers. See Figure~\ref{fig:overview}.

\begin{figure}[h]
  \centering
  % \includegraphics[width=0.6\textwidth]{figures/overview.png}
  \caption{Caption}
  \label{fig:overview}
\end{figure}

\section{Conclusion}

Wrap up.

\bibliographystyle{plain}
\bibliography{refs}

\end{document}
`},
				{Path: "refs.bib", Content: `@article{example2024,
  title  = {An Example Reference},
  author = {Smith, J. and Doe, A.},
  journal = {Journal of Examples},
  year   = {2024},
  volume = {1},
  pages  = {1--10},
}
`},
				{Path: "figures/.gitkeep", Content: ""},
			},
		},
		{
			ID:          "latex-phd-thesis",
			Name:        "LaTeX PhD thesis",
			Description: "Multi-chapter thesis skeleton with frontmatter, chapters/, refs.bib, and a Makefile-equivalent README.",
			Language:    "latex",
			Files: []scaffoldFile{
				{Path: "main.tex", Content: `\documentclass[11pt,a4paper,twoside]{report}
\usepackage[utf8]{inputenc}
\usepackage[T1]{fontenc}
\usepackage{lmodern}
\usepackage{graphicx}
\usepackage{hyperref}
\usepackage{cite}
\usepackage{xcolor}

\title{Thesis Title}
\author{Your Name}
\date{\today}

\begin{document}
\frontmatter
\maketitle
\tableofcontents
% \input{frontmatter/abstract}
% \input{frontmatter/acknowledgements}

\mainmatter
\input{chapters/01-introduction}
\input{chapters/02-background}
\input{chapters/03-conclusion}

\backmatter
\bibliographystyle{plain}
\bibliography{refs}
\end{document}
`},
				{Path: "chapters/01-introduction.tex", Content: `\chapter{Introduction}
\label{ch:intro}

Motivation + research questions.
`},
				{Path: "chapters/02-background.tex", Content: `\chapter{Background}
\label{ch:bg}

Prior work + theoretical foundations.
`},
				{Path: "chapters/03-conclusion.tex", Content: `\chapter{Conclusion}
\label{ch:concl}

Summary + future work.
`},
				{Path: "refs.bib", Content: `@book{example-book,
  title     = {An Example Book},
  author    = {Surname, Author},
  year      = {2020},
  publisher = {Example Press},
}
`},
				{Path: "README.md", Content: "# Thesis title\n\nThis thesis is built with `pdflatex main.tex && bibtex main && pdflatex main && pdflatex main`. In loom you can just click Compile (Cmd+Enter) — the toolchain runs in the workspace μVM.\n"},
			},
		},
		{
			ID:          "latex-beamer",
			Name:        "Beamer presentation",
			Description: "LaTeX Beamer slide deck. \\frame per slide, \\section section dividers, ready for the Madrid theme.",
			Language:    "latex",
			Files: []scaffoldFile{
				{Path: "main.tex", Content: `\documentclass[aspectratio=169]{beamer}
\usetheme{Madrid}
\usecolortheme{default}
\usepackage[utf8]{inputenc}
\usepackage[T1]{fontenc}
\usepackage{lmodern}

\title{Presentation Title}
\author{Your Name}
\institute{Affiliation}
\date{\today}

\begin{document}

\begin{frame}
  \titlepage
\end{frame}

\section{Introduction}

\begin{frame}{Introduction}
  \begin{itemize}
    \item First point
    \item Second point
    \item Third point
  \end{itemize}
\end{frame}

\section{Main}

\begin{frame}{A figure}
  \begin{center}
    % \includegraphics[width=0.6\textwidth]{figures/diagram.png}
    Placeholder for an image
  \end{center}
\end{frame}

\section{Conclusion}

\begin{frame}{Conclusion}
  Thanks for your attention!
\end{frame}

\end{document}
`},
				{Path: "figures/.gitkeep", Content: ""},
			},
		},
		{
			ID:          "marp-deck",
			Name:        "Marp Markdown slide deck",
			Description: "Markdown-based slides via Marp. One file, YAML front-matter picks the theme — compiles to HTML/PDF.",
			Language:    "markdown",
			Files: []scaffoldFile{
				{Path: "slides.md", Content: "---\nmarp: true\ntheme: default\npaginate: true\n---\n\n# Slide deck title\n\nYour name · today's date\n\n---\n\n## Overview\n\n- First point\n- Second point\n- Third point\n\n---\n\n## A figure\n\n![bg right:50% 80%](figures/diagram.png)\n\nDescription of the diagram.\n\n---\n\n## Thank you\n\nQuestions ?\n"},
				{Path: "figures/.gitkeep", Content: ""},
			},
		},
		{
			ID:          "markdown-book",
			Name:        "Multi-chapter Markdown book",
			Description: "Long-form documentation / book layout. chapters/01.md … chapters/03.md + a README index.",
			Language:    "markdown",
			Files: []scaffoldFile{
				{Path: "README.md", Content: "# Book title\n\nLong-form documentation. Each chapter lives under `chapters/`. Compile-on-save renders any chapter individually ; the README knits them together as an index.\n\n- [Chapter 1 — Introduction](chapters/01-introduction.md)\n- [Chapter 2 — Background](chapters/02-background.md)\n- [Chapter 3 — Conclusion](chapters/03-conclusion.md)\n"},
				{Path: "chapters/01-introduction.md", Content: "# Introduction\n\nWelcome to the book.\n"},
				{Path: "chapters/02-background.md", Content: "# Background\n\nContext + prior work.\n"},
				{Path: "chapters/03-conclusion.md", Content: "# Conclusion\n\nSummary + further reading.\n"},
			},
		},
		{
			ID:          "odt-letter-bundle",
			Name:        "ODT formal letter bundle",
			Description: "Two paired ODT files : letter.odt (the body) + envelope.odt (the address block). Use as a starting point for any official correspondence.",
			Language:    "odt",
			Files: []scaffoldFile{
				// Note : ODT is a zipped XML container — a real
				// scaffold would emit pre-zipped bytes. V0.1 ships
				// plain-text placeholders that the WYSIWYG editor
				// happily reads as an empty doc + the user fills
				// in. The ODT round-trip work handles the rest.
				{Path: "letter.odt", Content: ""},
				{Path: "envelope.odt", Content: ""},
				{Path: "README.md", Content: "# Formal letter bundle\n\n- `letter.odt` : the body of the correspondence.\n- `envelope.odt` : the recipient address block (printed on a separate sheet).\n\nOpen each in the WYSIWYG editor (loom auto-detects .odt) and use Cmd+S to save back to disk.\n"},
			},
		},
	}
	for i := range t {
		for j := range t[i].Files {
			t[i].Files[j].Size = len(t[i].Files[j].Content)
		}
	}
	return t
}()

func (s *Server) handleProjectTemplatesList(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"items": projectTemplates})
}

func (s *Server) handleProjectScaffold(w http.ResponseWriter, r *http.Request) {
	ident, _ := auth.IdentityFrom(r.Context())
	proj := projectName(r)
	var body struct {
		TemplateID string `json:"template_id"`
		Force      bool   `json:"force,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
		return
	}
	var tmpl *projectTemplate
	for i := range projectTemplates {
		if projectTemplates[i].ID == body.TemplateID {
			tmpl = &projectTemplates[i]
			break
		}
	}
	if tmpl == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "unknown template_id : " + body.TemplateID})
		return
	}

	// Conflict pre-flight : refuse if ANY target path already
	// exists in the project unless force=true. Saves the user from
	// silently clobbering hand-written content.
	if !body.Force {
		files, err := s.opts.Projects.ListFiles(r.Context(), ident, proj)
		if err == nil {
			existing := map[string]struct{}{}
			for _, f := range files {
				existing[f.Path] = struct{}{}
			}
			var clashes []string
			for _, f := range tmpl.Files {
				if _, ok := existing[f.Path]; ok {
					clashes = append(clashes, f.Path)
				}
			}
			if len(clashes) > 0 {
				writeJSON(w, http.StatusConflict, map[string]any{
					"error":   "target paths exist (pass force=true to overwrite)",
					"clashes": clashes,
				})
				return
			}
		}
	}

	written := make([]string, 0, len(tmpl.Files))
	for _, f := range tmpl.Files {
		// .gitkeep files create the directory without an actual
		// keep-content artefact — most stores honour zero-byte
		// writes so the directory becomes browsable.
		body := strings.NewReader(f.Content)
		if werr := s.opts.Projects.WriteFile(r.Context(), ident, proj, f.Path, body); werr != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]any{
				"error":   "write " + f.Path + " : " + werr.Error(),
				"written": written,
			})
			return
		}
		written = append(written, f.Path)
	}

	s.events.Publish(eventbus.Event{
		Source: "server", Component: "scaffold", Verb: "applied",
		Project: proj,
		Fields:  map[string]any{"template": tmpl.ID, "files": len(written)},
	})
	// Open the entry-point file in the response so the SPA can
	// auto-focus it after scaffolding. main.tex / slides.md /
	// README.md in that priority order.
	var entry string
	priority := []string{"main.tex", "slides.md", "README.md"}
	for _, p := range priority {
		for _, f := range tmpl.Files {
			if f.Path == p {
				entry = p
				break
			}
		}
		if entry != "" {
			break
		}
	}
	if entry == "" && len(written) > 0 {
		entry = written[0]
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"written": written,
		"entry":   entry,
	})
	_ = bytes.NewBuffer(nil) // keep import for future preview bodies
}
