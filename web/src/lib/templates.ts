// templates.ts — canned starting documents per language. The
// NewFileDialog modal lets the user pick one when creating a file ;
// FileExplorer's "+ New file" button surfaces them.
//
// The patterns mirror the smallest valid document for each ecosystem
// so the user immediately sees a useful render in the PreviewPane :
//   - article : the standard LaTeX article skeleton
//   - beamer  : LaTeX Beamer slides (compiled to PDF slideshow)
//   - markdown plain : GFM with math
//   - marp    : Marp markdown slides (YAML front-matter + slide breaks)
//
// Template ids are stable strings. New entries here surface
// automatically in the dropdown ; no other code change required.

export interface Template {
  id: string;
  name: string;
  language: string;
  // suggestedExtension is what NewFileDialog autofills when the user
  // picks this template ; the user can edit the path freely.
  suggestedExtension: string;
  description: string;
  content: string;
}

export const TEMPLATES: Template[] = [
  // ---- LaTeX -----------------------------------------------------
  {
    id: 'latex-article',
    name: 'LaTeX article',
    language: 'latex',
    suggestedExtension: '.tex',
    description: 'Plain article skeleton with title, abstract, sections.',
    content: `\\documentclass[a4paper,11pt]{article}
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

\\end{document}
`,
  },
  {
    id: 'latex-beamer',
    name: 'LaTeX Beamer slides',
    language: 'latex',
    suggestedExtension: '.tex',
    description: 'Slide deck with title page, sections, lists, math.',
    content: `\\documentclass{beamer}
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
`,
  },

  // ---- Markdown --------------------------------------------------
  {
    id: 'markdown-plain',
    name: 'Markdown',
    language: 'markdown',
    suggestedExtension: '.md',
    description: 'GitHub-Flavored Markdown with inline + block math.',
    content: `# Document title

A short introductory paragraph with **bold**, *italic*, and \`inline code\`.

## Section

Inline math : $a^2 + b^2 = c^2$.

Display math :
$$
\\int_{0}^{\\infty} e^{-x^2} \\, dx = \\frac{\\sqrt{\\pi}}{2}
$$

### Lists

- bullet 1
- bullet 2
  - nested

1. first
2. second

### Code block

\`\`\`go
func main() {
    fmt.Println("hello, weft-loom")
}
\`\`\`

> Blockquote.

| Col A | Col B |
|-------|-------|
| 1     | 2     |
| 3     | 4     |
`,
  },
  {
    id: 'markdown-marp',
    name: 'Marp slides (Markdown)',
    language: 'markdown',
    suggestedExtension: '.md',
    description:
      'Slide deck using Marp YAML front-matter ; one slide per "---" rule.',
    content: `---
marp: true
theme: default
paginate: true
size: 16:9
---

# Presentation title

Author name · \${ new Date().getFullYear() }

---

## Outline

- Introduction
- Method
- Results
- Conclusion

---

## Math

Inline : $E = mc^2$

Display :

$$
\\int_{0}^{\\infty} e^{-x^2} \\, dx = \\frac{\\sqrt{\\pi}}{2}
$$

---

## Lists

- Bullet one
- Bullet two
  - nested

1. enumerated
2. items

---

## Code

\`\`\`go
func main() {
    fmt.Println("Marp + weft-loom")
}
\`\`\`

---

# Thank you
`,
  },

  // ---- Plain code starters ---------------------------------------
  {
    id: 'go-main',
    name: 'Go (main package)',
    language: 'go',
    suggestedExtension: '.go',
    description: 'Hello-world main.go.',
    content: `package main

import "fmt"

func main() {
\tfmt.Println("hello, weft-loom")
}
`,
  },
  {
    id: 'python-main',
    name: 'Python script',
    language: 'python',
    suggestedExtension: '.py',
    description: 'Minimal Python entry point.',
    content: `def main() -> None:
    print("hello, weft-loom")


if __name__ == "__main__":
    main()
`,
  },
  {
    id: 'rust-main',
    name: 'Rust (binary)',
    language: 'rust',
    suggestedExtension: '.rs',
    description: 'Cargo-shaped main.rs.',
    content: `fn main() {
    println!("hello, weft-loom");
}
`,
  },
  {
    id: 'cpp-main',
    name: 'C++ (hello world)',
    language: 'cpp',
    suggestedExtension: '.cpp',
    description: 'iostream hello-world.',
    content: `#include <iostream>

int main() {
    std::cout << "hello, weft-loom\\n";
    return 0;
}
`,
  },
  // ---- YAML / build files ---------------------------------------
  {
    id: 'taskfile-yaml',
    name: 'Taskfile.yaml',
    language: 'yaml',
    suggestedExtension: '.yaml',
    description:
      'go-task/task build file. Conventional name : Taskfile.yaml at the project root.',
    content: `version: '3'

vars:
  APP: weft

tasks:
  default:
    desc: List available tasks
    cmds:
      - task --list-all
    silent: true

  build:
    desc: Build the binary
    cmds:
      - go build -o bin/{{.APP}} ./cmd/{{.APP}}

  test:
    desc: Run the test suite
    cmds:
      - go test ./...

  fmt:
    desc: Format Go source
    cmds:
      - gofmt -w -s .

  lint:
    desc: Run static analysis
    deps: [fmt]
    cmds:
      - go vet ./...

  clean:
    desc: Remove build artefacts
    cmds:
      - rm -rf bin/
`,
  },

  {
    id: 'blank',
    name: 'Blank',
    language: 'markdown',
    suggestedExtension: '',
    description: 'Empty file. You pick the language afterwards.',
    content: '',
  },
];

export function findTemplate(id: string): Template | undefined {
  return TEMPLATES.find((t) => t.id === id);
}
