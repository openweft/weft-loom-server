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
  // For text formats, `content` is the literal file body. For binary
  // formats (ODT, ODS), `mode` tells NewFileDialog which writer to
  // run before PUT-ing. RTF is intentionally text-mode — the
  // WysiwygEditor reads raw RTF source.
  mode?: 'text' | 'odt' | 'ods';
  // ODS templates seed the writer via a static sheets array
  // (defined alongside the template) rather than an HTML body.
  odsSheets?: () => { name: string; cells: { display: string; value: string | number | boolean; type: string; formula?: string }[][] }[];
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

  // ---- HTML / CSS / JSON / YAML / TOML / HCL ----------------------
  {
    id: 'html-page',
    name: 'HTML page',
    language: 'html',
    suggestedExtension: '.html',
    description: 'Minimal HTML5 document with viewport + UTF-8.',
    content: `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Page title</title>
  </head>
  <body>
    <h1>Hello</h1>
  </body>
</html>
`,
  },
  {
    id: 'css-stylesheet',
    name: 'CSS stylesheet',
    language: 'css',
    suggestedExtension: '.css',
    description: 'Base reset + body font + variables.',
    content: `:root {
  --fg: #111;
  --bg: #fff;
}

* { box-sizing: border-box; margin: 0; padding: 0; }

body {
  font-family: ui-sans-serif, system-ui, sans-serif;
  color: var(--fg);
  background: var(--bg);
  line-height: 1.5;
}
`,
  },
  {
    id: 'json-object',
    name: 'JSON object',
    language: 'json',
    suggestedExtension: '.json',
    description: 'Empty JSON object.',
    content: `{
  "name": "",
  "version": "0.1.0"
}
`,
  },
  {
    id: 'yaml-doc',
    name: 'YAML document',
    language: 'yaml',
    suggestedExtension: '.yaml',
    description: 'YAML document with a single root mapping.',
    content: `name: example
version: 0.1.0
items:
  - first
  - second
`,
  },
  {
    id: 'toml-config',
    name: 'TOML config',
    language: 'toml',
    suggestedExtension: '.toml',
    description: 'TOML configuration skeleton.',
    content: `title = "Example"

[owner]
name = ""
email = ""

[database]
server = "localhost"
ports = [8001, 8001, 8002]
`,
  },
  {
    id: 'hcl-terraform',
    name: 'Terraform HCL',
    language: 'hcl',
    suggestedExtension: '.tf',
    description: 'Terraform skeleton : terraform + provider + resource.',
    content: `terraform {
  required_version = ">= 1.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = "us-east-1"
}

resource "aws_s3_bucket" "example" {
  bucket = "my-unique-bucket-name"
}
`,
  },
  {
    id: 'hcl2-dynamic',
    name: 'Terraform HCL2 (dynamic blocks)',
    language: 'hcl',
    suggestedExtension: '.tf',
    description: 'HCL2 idioms : for_each, dynamic blocks, for-expressions.',
    content: `variable "ports" {
  type    = list(number)
  default = [80, 443, 8080]
}

resource "aws_security_group" "web" {
  name = "web-sg"

  dynamic "ingress" {
    for_each = var.ports
    content {
      from_port   = ingress.value
      to_port     = ingress.value
      protocol    = "tcp"
      cidr_blocks = ["0.0.0.0/0"]
    }
  }
}

output "open_ports" {
  value = [for p in var.ports : "tcp/\${p}"]
}
`,
  },
  {
    id: 'packer-hcl2',
    name: 'Packer HCL2 build',
    language: 'hcl',
    suggestedExtension: '.pkr.hcl',
    description: 'Packer HCL2 build : packer + source + build blocks.',
    content: `packer {
  required_plugins {
    qemu = {
      source  = "github.com/hashicorp/qemu"
      version = "~> 1.0"
    }
  }
}

source "qemu" "debian" {
  iso_url   = "https://cdimage.debian.org/debian-cd/current/amd64/iso-cd/debian-12-netinst-amd64.iso"
  iso_checksum = "file:https://cdimage.debian.org/debian-cd/current/amd64/iso-cd/SHA256SUMS"
  output_directory = "build/debian"
  disk_size = "10G"
  format    = "qcow2"
  ssh_username = "root"
  ssh_password = "packer"
}

build {
  sources = ["source.qemu.debian"]

  provisioner "shell" {
    inline = ["apt-get update", "apt-get install -y nginx"]
  }
}
`,
  },
  {
    id: 'nomad-hcl2',
    name: 'Nomad HCL2 job',
    language: 'hcl',
    suggestedExtension: '.nomad',
    description: 'Nomad job spec : job + group + task with docker driver.',
    content: `job "web" {
  datacenters = ["dc1"]
  type        = "service"

  group "frontend" {
    count = 3

    network {
      port "http" { to = 80 }
    }

    service {
      name = "frontend"
      port = "http"
      check {
        type     = "http"
        path     = "/health"
        interval = "10s"
        timeout  = "2s"
      }
    }

    task "nginx" {
      driver = "docker"
      config {
        image = "nginx:1.27-alpine"
        ports = ["http"]
      }
      resources {
        cpu    = 200
        memory = 128
      }
    }
  }
}
`,
  },
  // ---- Ruby / Perl / Shell / Zig ----------------------------------
  {
    id: 'ruby-script',
    name: 'Ruby script',
    language: 'ruby',
    suggestedExtension: '.rb',
    description: 'Ruby script with a shebang line.',
    content: `#!/usr/bin/env ruby

puts "Hello from Ruby"
`,
  },
  {
    id: 'perl-script',
    name: 'Perl script',
    language: 'perl',
    suggestedExtension: '.pl',
    description: 'Perl 5 script with strict + warnings.',
    content: `#!/usr/bin/env perl
use strict;
use warnings;

print "Hello from Perl\\n";
`,
  },
  {
    id: 'shell-script',
    name: 'Shell script',
    language: 'shell',
    suggestedExtension: '.sh',
    description: 'POSIX shell script with set -eu.',
    content: `#!/bin/sh
set -eu

echo "Hello from shell"
`,
  },
  {
    id: 'zig-program',
    name: 'Zig program',
    language: 'zig',
    suggestedExtension: '.zig',
    description: 'Zig "hello world" program.',
    content: `const std = @import("std");

pub fn main() !void {
    const stdout = std.io.getStdOut().writer();
    try stdout.print("Hello from Zig\\n", .{});
}
`,
  },
  // ---- JS / TS / Svelte -------------------------------------------
  {
    id: 'js-module',
    name: 'JavaScript module',
    language: 'javascript',
    suggestedExtension: '.js',
    description: 'ESM module with a default export.',
    content: `export function hello(name) {
  return 'Hello, ' + name;
}

console.log(hello('weft-loom'));
`,
  },
  {
    id: 'ts-module',
    name: 'TypeScript module',
    language: 'typescript',
    suggestedExtension: '.ts',
    description: 'TS module with a typed function.',
    content: `export function hello(name: string): string {
  return 'Hello, ' + name;
}

console.log(hello('weft-loom'));
`,
  },
  {
    id: 'svelte-component',
    name: 'Svelte 5 component',
    language: 'svelte',
    suggestedExtension: '.svelte',
    description: 'Svelte 5 component with runes ($state, $derived, $props).',
    content: `<script lang="ts">
  interface Props {
    name?: string;
  }
  let { name = 'world' }: Props = $props();
  let count = $state(0);
  const doubled = $derived(count * 2);
</script>

<h1>Hello {name}!</h1>
<button onclick={() => count++}>
  clicked {count} times (× 2 = {doubled})
</button>

<style>
  h1 { color: var(--p, #2563eb); }
  button { padding: 0.5em 1em; }
</style>
`,
  },
  {
    id: 'svelte-runes-ts',
    name: 'Svelte runes module (.svelte.ts)',
    language: 'typescript',
    suggestedExtension: '.svelte.ts',
    description: 'TypeScript module with Svelte 5 runes ($state outside components).',
    content: `// Module-scope runes : use the .svelte.ts extension so Vite's
// Svelte plugin processes the file (regular .ts can't host runes).

class Store {
  count = $state(0);
  doubled = $derived(this.count * 2);
}

export const store = new Store();
`,
  },

  {
    id: 'rtf-doc',
    name: 'RTF document',
    language: 'rtf',
    suggestedExtension: '.rtf',
    description: 'Minimal Rich Text Format document — opens in Preview as rendered text.',
    content: `{\\rtf1\\ansi\\ansicpg1252\\deff0
{\\fonttbl{\\f0 Helvetica;}}
{\\info{\\title weft-loom RTF demo}{\\author Sovereign Collaborative Edition}}
\\f0\\fs24
\\b weft-loom RTF demo\\b0\\par
\\par
This is a minimal RTF document. \\i Italic\\i0  + \\b bold\\b0  + \\ul underlined\\ulnone .\\par
\\par
Open the Preview pane to see this rendered.
}
`,
  },

  // ---- ODT (OpenDocument Text) ----------------------------------
  // Content is HTML the WysiwygEditor would render — NewFileDialog
  // runs it through writeODT() at create time. Inline styles, named
  // styles, paragraph alignment, font choices all round-trip via
  // the V1.0 plumbing.
  {
    id: 'odt-blank',
    name: 'ODT blank',
    language: 'odt',
    suggestedExtension: '.odt',
    description: 'Empty word-processing document — opens in the WYSIWYG editor.',
    mode: 'odt',
    content: '<p><br></p>',
  },
  {
    id: 'odt-cv',
    name: 'ODT — Curriculum Vitae',
    language: 'odt',
    suggestedExtension: '.odt',
    description: 'CV / résumé scaffold with sections, dates, bullets, contact strip.',
    mode: 'odt',
    content: `<h1 style="text-align: center;">Your Name</h1>
<p style="text-align: center;"><span style="font-size: 10pt;">Email · Phone · City · linkedin.com/in/you · github.com/you</span></p>
<h2>Profile</h2>
<p>One- or two-sentence pitch : the role you want + the value you bring. Numbers if you have them.</p>
<h2>Experience</h2>
<p><b>Senior Role · Company</b> &nbsp;&nbsp; <span style="color: #666;"><i>Jan 2024 – present</i></span></p>
<ul>
<li>Led a team of N engineers to ship X, which drove Y by Z%.</li>
<li>Owned migration from A to B in Q1 ; reduced infra cost by N%.</li>
<li>Mentored M junior engineers ; two promoted within the year.</li>
</ul>
<p><b>Earlier Role · Previous Company</b> &nbsp;&nbsp; <span style="color: #666;"><i>Jul 2021 – Dec 2023</i></span></p>
<ul>
<li>Bullet point that highlights an impact, not a duty.</li>
<li>Bullet point with a quantified outcome.</li>
</ul>
<h2>Education</h2>
<p><b>M.Sc. in Field</b> · University, Year</p>
<p><b>B.Sc. in Field</b> · University, Year</p>
<h2>Skills</h2>
<p>Languages: …  ·  Frameworks: …  ·  Tools: …  ·  Languages spoken: …</p>
<h2>Selected projects</h2>
<ul>
<li><b>Project name</b> — one line of what + outcome. <a href="https://github.com/you/project">link</a></li>
<li><b>Project name</b> — one line of what + outcome.</li>
</ul>
`,
  },
  {
    id: 'odt-letter',
    name: 'ODT — Formal letter',
    language: 'odt',
    suggestedExtension: '.odt',
    description: 'Block-format business letter with addresses, date, salutation, signature.',
    mode: 'odt',
    content: `<p>Your Name</p>
<p>Your Street Address</p>
<p>Your City, Postcode</p>
<p>your@email</p>
<p><br></p>
<p style="text-align: right;">\${date}</p>
<p><br></p>
<p><b>Recipient Name</b></p>
<p>Recipient Title</p>
<p>Recipient Organisation</p>
<p>Street Address</p>
<p>City, Postcode</p>
<p><br></p>
<p><b>Subject:</b> One-line subject of the letter.</p>
<p><br></p>
<p>Dear Mr./Ms. Surname,</p>
<p><br></p>
<p>Opening paragraph stating who you are + why you're writing.</p>
<p><br></p>
<p>Middle paragraph(s) developing the request, claim, or proposal. Be specific. If you're asking for something, say exactly what.</p>
<p><br></p>
<p>Closing paragraph with the next step you're proposing + a clear call to action. Mention any enclosed documents.</p>
<p><br></p>
<p>Yours sincerely,</p>
<p><br></p>
<p><br></p>
<p>Your Name</p>
`,
  },
  {
    id: 'odt-report',
    name: 'ODT — Report',
    language: 'odt',
    suggestedExtension: '.odt',
    description: 'Technical / project report with TOC slot, sections, figures, table.',
    mode: 'odt',
    content: `<h1 style="text-align: center;">Report title</h1>
<p style="text-align: center;"><i>Subtitle · Author · \${date}</i></p>
<p><br></p>
<h2>Executive summary</h2>
<p>One paragraph synthesising the problem, the approach, and the headline result.</p>
<h2>1. Context</h2>
<p>What problem motivated the work. Reference prior art + previous attempts.</p>
<h2>2. Approach</h2>
<p>What you did and why. Architecture diagrams + decision rationale.</p>
<h2>3. Results</h2>
<p>Findings. A table to summarise the numbers :</p>
<table><tbody>
<tr><th>Metric</th><th>Baseline</th><th>This work</th><th>Δ</th></tr>
<tr><td>Throughput (req/s)</td><td>—</td><td>—</td><td>—</td></tr>
<tr><td>P99 latency (ms)</td><td>—</td><td>—</td><td>—</td></tr>
<tr><td>Cost ($/month)</td><td>—</td><td>—</td><td>—</td></tr>
</tbody></table>
<h2>4. Discussion</h2>
<p>What the results mean. Caveats. Failure modes encountered.</p>
<h2>5. Next steps</h2>
<ul>
<li>Action 1 — owner, deadline.</li>
<li>Action 2 — owner, deadline.</li>
</ul>
<h2>References</h2>
<ol>
<li>Author, “Title,” <i>Venue</i>, Year.</li>
<li>Author, “Title,” <i>Venue</i>, Year.</li>
</ol>
`,
  },
  {
    id: 'odt-meeting',
    name: 'ODT — Meeting notes',
    language: 'odt',
    suggestedExtension: '.odt',
    description: 'Meeting agenda + decisions + action items, in the canonical shape.',
    mode: 'odt',
    content: `<h1>Meeting — \${title}</h1>
<p><b>Date:</b> \${date} &nbsp;·&nbsp; <b>Time:</b> HH:MM–HH:MM &nbsp;·&nbsp; <b>Location:</b> …</p>
<p><b>Attendees:</b> N1, N2, N3</p>
<p><b>Absent:</b> —</p>
<h2>Agenda</h2>
<ol>
<li>Topic 1 (owner, 15 min)</li>
<li>Topic 2 (owner, 10 min)</li>
<li>Topic 3 (owner, 15 min)</li>
<li>AOB + actions review (5 min)</li>
</ol>
<h2>Discussion</h2>
<h3>Topic 1</h3>
<p>Notes…</p>
<h3>Topic 2</h3>
<p>Notes…</p>
<h2>Decisions</h2>
<ul>
<li><b>D1:</b> what was decided + rationale.</li>
<li><b>D2:</b> what was decided + rationale.</li>
</ul>
<h2>Action items</h2>
<table><tbody>
<tr><th>#</th><th>Action</th><th>Owner</th><th>Due</th></tr>
<tr><td>A1</td><td>…</td><td>N1</td><td>YYYY-MM-DD</td></tr>
<tr><td>A2</td><td>…</td><td>N2</td><td>YYYY-MM-DD</td></tr>
</tbody></table>
<h2>Next meeting</h2>
<p>Date · Topics carried over.</p>
`,
  },
  {
    id: 'odt-thesis-chapter',
    name: 'ODT — Thesis chapter',
    language: 'odt',
    suggestedExtension: '.odt',
    description: 'Single thesis chapter with abstract, sections, footnote pattern, references.',
    mode: 'odt',
    content: `<h1>Chapter N — Title</h1>
<h2>Abstract</h2>
<p>A short summary of the chapter’s argument + main results.</p>
<h2>N.1 Introduction</h2>
<p>Motivation ; what this chapter contributes to the dissertation argument.<sup class="footnote" data-id="ftn1" data-body="A footnote ; replace this body with a citation or a side note.">1</sup></p>
<h2>N.2 Background</h2>
<p>Relevant prior work, in chronological or thematic order.</p>
<h2>N.3 Method</h2>
<p>What was done, step by step ; reproducible enough that a peer could re-run it.</p>
<h2>N.4 Results</h2>
<p>Findings, with the appropriate amount of skepticism + statistical context.</p>
<h2>N.5 Discussion</h2>
<p>What the results mean for the dissertation’s claims. Acknowledge limitations.</p>
<h2>N.6 Conclusion</h2>
<p>What the chapter establishes ; what the next chapter builds on.</p>
`,
  },

  // ---- ODS (OpenDocument Spreadsheet) ----------------------------
  {
    id: 'ods-blank',
    name: 'ODS blank',
    language: 'ods',
    suggestedExtension: '.ods',
    description: 'Empty spreadsheet — opens in the grid editor.',
    mode: 'ods',
    content: '',
    odsSheets: () => [{
      name: 'Sheet1',
      cells: Array.from({ length: 20 }, () =>
        Array.from({ length: 10 }, () => ({
          display: '', value: '', type: 'string',
        })),
      ),
    }],
  },
  {
    id: 'ods-budget',
    name: 'ODS — Budget tracker',
    language: 'ods',
    suggestedExtension: '.ods',
    description: 'Monthly income / expense / balance with running totals + a quarterly summary.',
    mode: 'ods',
    content: '',
    odsSheets: () => {
      const header = ['Month', 'Income', 'Expense', 'Balance'];
      const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      const cells: { display: string; value: string | number | boolean; type: string; formula?: string }[][] = [
        header.map(h => ({ display: h, value: h, type: 'string' })),
      ];
      for (let i = 0; i < months.length; i++) {
        const r = i + 2; // row 1 in spreadsheet terms (after header on row 1, this is row 2)
        cells.push([
          { display: months[i], value: months[i], type: 'string' },
          { display: '0', value: 0, type: 'float' },
          { display: '0', value: 0, type: 'float' },
          { display: '', value: '=B' + r + '-C' + r, type: 'float', formula: 'of:=B' + r + '-C' + r },
        ]);
      }
      cells.push([
        { display: 'Total', value: 'Total', type: 'string' },
        { display: '', value: '=SUM(B2:B13)', type: 'float', formula: 'of:=SUM(B2:B13)' },
        { display: '', value: '=SUM(C2:C13)', type: 'float', formula: 'of:=SUM(C2:C13)' },
        { display: '', value: '=SUM(D2:D13)', type: 'float', formula: 'of:=SUM(D2:D13)' },
      ]);
      return [{ name: 'Budget', cells }];
    },
  },
  {
    id: 'ods-timesheet',
    name: 'ODS — Time sheet',
    language: 'ods',
    suggestedExtension: '.ods',
    description: 'Weekly time-tracking with totals + billable hours.',
    mode: 'ods',
    content: '',
    odsSheets: () => {
      const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
      const cells: { display: string; value: string | number | boolean; type: string; formula?: string }[][] = [
        [
          { display: 'Day',       value: 'Day',       type: 'string' },
          { display: 'Project',   value: 'Project',   type: 'string' },
          { display: 'Hours',     value: 'Hours',     type: 'float'  },
          { display: 'Billable',  value: 'Billable',  type: 'boolean' },
        ],
      ];
      for (let i = 0; i < days.length; i++) {
        cells.push([
          { display: days[i], value: days[i], type: 'string' },
          { display: '', value: '', type: 'string' },
          { display: '0', value: 0, type: 'float' },
          { display: 'true', value: true, type: 'boolean' },
        ]);
      }
      cells.push([
        { display: 'Total', value: 'Total', type: 'string' },
        { display: '', value: '', type: 'string' },
        { display: '', value: '=SUM(C2:C8)', type: 'float', formula: 'of:=SUM(C2:C8)' },
        { display: '', value: '', type: 'string' },
      ]);
      return [{ name: 'Hours', cells }];
    },
  },
  {
    id: 'ods-roster',
    name: 'ODS — Roster / contact list',
    language: 'ods',
    suggestedExtension: '.ods',
    description: 'Name / Email / Phone / Role contact catalogue with sortable columns.',
    mode: 'ods',
    content: '',
    odsSheets: () => {
      const header = ['Name', 'Email', 'Phone', 'Role'];
      const rows = [
        ['Jane Smith',  'jane@example.org',  '+33 1 02 03 04 05', 'PM'],
        ['John Doe',    'john@example.org',  '+33 6 07 08 09 10', 'Engineer'],
        ['Marie Curie', 'marie@example.org', '+33 1 23 45 67 89', 'Researcher'],
      ];
      const cells: { display: string; value: string | number | boolean; type: string; formula?: string }[][] = [
        header.map(h => ({ display: h, value: h, type: 'string' })),
        ...rows.map(r => r.map(v => ({ display: v, value: v, type: 'string' }))),
      ];
      return [{ name: 'Roster', cells }];
    },
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
