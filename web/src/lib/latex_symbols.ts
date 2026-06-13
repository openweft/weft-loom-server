// latex_symbols.ts — canonical catalogue of LaTeX symbols + math
// structures the palette surfaces. Each entry carries :
//   - label  : what the button shows (often the rendered glyph)
//   - cmd    : the LaTeX source to insert
//   - cursor : optional caret offset within `cmd` after insert ;
//              useful for structures with a stub the user must fill
//              (e.g. \\frac{|}{} parks at the numerator).
// Categories are flat strings the palette uses as tab labels.

export interface SymbolEntry {
  label: string;
  cmd: string;
  cursor?: number;
  // tip is shown on hover when the visible label is just the glyph
  // (so the user can recognise the command).
  tip?: string;
}

export interface SymbolCategory {
  id: string;
  name: string;
  cols: number;
  entries: SymbolEntry[];
}

// Greek letters — lowercase + uppercase rows.
const GREEK: SymbolEntry[] = [
  // lowercase
  { label: 'α', cmd: '\\alpha', tip: '\\alpha' },
  { label: 'β', cmd: '\\beta',  tip: '\\beta' },
  { label: 'γ', cmd: '\\gamma', tip: '\\gamma' },
  { label: 'δ', cmd: '\\delta', tip: '\\delta' },
  { label: 'ε', cmd: '\\epsilon', tip: '\\epsilon' },
  { label: 'ζ', cmd: '\\zeta', tip: '\\zeta' },
  { label: 'η', cmd: '\\eta', tip: '\\eta' },
  { label: 'θ', cmd: '\\theta', tip: '\\theta' },
  { label: 'ι', cmd: '\\iota', tip: '\\iota' },
  { label: 'κ', cmd: '\\kappa', tip: '\\kappa' },
  { label: 'λ', cmd: '\\lambda', tip: '\\lambda' },
  { label: 'μ', cmd: '\\mu', tip: '\\mu' },
  { label: 'ν', cmd: '\\nu', tip: '\\nu' },
  { label: 'ξ', cmd: '\\xi', tip: '\\xi' },
  { label: 'π', cmd: '\\pi', tip: '\\pi' },
  { label: 'ρ', cmd: '\\rho', tip: '\\rho' },
  { label: 'σ', cmd: '\\sigma', tip: '\\sigma' },
  { label: 'τ', cmd: '\\tau', tip: '\\tau' },
  { label: 'υ', cmd: '\\upsilon', tip: '\\upsilon' },
  { label: 'φ', cmd: '\\phi', tip: '\\phi' },
  { label: 'χ', cmd: '\\chi', tip: '\\chi' },
  { label: 'ψ', cmd: '\\psi', tip: '\\psi' },
  { label: 'ω', cmd: '\\omega', tip: '\\omega' },
  // uppercase
  { label: 'Γ', cmd: '\\Gamma', tip: '\\Gamma' },
  { label: 'Δ', cmd: '\\Delta', tip: '\\Delta' },
  { label: 'Θ', cmd: '\\Theta', tip: '\\Theta' },
  { label: 'Λ', cmd: '\\Lambda', tip: '\\Lambda' },
  { label: 'Ξ', cmd: '\\Xi', tip: '\\Xi' },
  { label: 'Π', cmd: '\\Pi', tip: '\\Pi' },
  { label: 'Σ', cmd: '\\Sigma', tip: '\\Sigma' },
  { label: 'Υ', cmd: '\\Upsilon', tip: '\\Upsilon' },
  { label: 'Φ', cmd: '\\Phi', tip: '\\Phi' },
  { label: 'Ψ', cmd: '\\Psi', tip: '\\Psi' },
  { label: 'Ω', cmd: '\\Omega', tip: '\\Omega' },
];

const OPERATORS: SymbolEntry[] = [
  { label: '±', cmd: '\\pm', tip: '\\pm' },
  { label: '∓', cmd: '\\mp', tip: '\\mp' },
  { label: '×', cmd: '\\times', tip: '\\times' },
  { label: '÷', cmd: '\\div', tip: '\\div' },
  { label: '·', cmd: '\\cdot', tip: '\\cdot' },
  { label: '∘', cmd: '\\circ', tip: '\\circ' },
  { label: '∗', cmd: '\\ast', tip: '\\ast' },
  { label: '⋆', cmd: '\\star', tip: '\\star' },
  { label: '⊕', cmd: '\\oplus', tip: '\\oplus' },
  { label: '⊖', cmd: '\\ominus', tip: '\\ominus' },
  { label: '⊗', cmd: '\\otimes', tip: '\\otimes' },
  { label: '⊙', cmd: '\\odot', tip: '\\odot' },
  { label: '∩', cmd: '\\cap', tip: '\\cap' },
  { label: '∪', cmd: '\\cup', tip: '\\cup' },
  { label: '⊓', cmd: '\\sqcap', tip: '\\sqcap' },
  { label: '⊔', cmd: '\\sqcup', tip: '\\sqcup' },
  { label: '∧', cmd: '\\wedge', tip: '\\wedge' },
  { label: '∨', cmd: '\\vee', tip: '\\vee' },
  { label: '∑', cmd: '\\sum_{}^{}', tip: '\\sum_{lower}^{upper}', cursor: 6 },
  { label: '∏', cmd: '\\prod_{}^{}', tip: '\\prod_{}^{}', cursor: 7 },
  { label: '∫', cmd: '\\int_{}^{}', tip: '\\int_{}^{}', cursor: 6 },
  { label: '∮', cmd: '\\oint_{}^{}', tip: '\\oint_{}^{}', cursor: 7 },
  { label: '∂', cmd: '\\partial', tip: '\\partial' },
  { label: '∇', cmd: '\\nabla', tip: '\\nabla' },
  { label: '∞', cmd: '\\infty', tip: '\\infty' },
  { label: '∅', cmd: '\\emptyset', tip: '\\emptyset' },
];

const RELATIONS: SymbolEntry[] = [
  { label: '≤', cmd: '\\leq', tip: '\\leq' },
  { label: '≥', cmd: '\\geq', tip: '\\geq' },
  { label: '≠', cmd: '\\neq', tip: '\\neq' },
  { label: '≈', cmd: '\\approx', tip: '\\approx' },
  { label: '≡', cmd: '\\equiv', tip: '\\equiv' },
  { label: '∼', cmd: '\\sim', tip: '\\sim' },
  { label: '≃', cmd: '\\simeq', tip: '\\simeq' },
  { label: '≅', cmd: '\\cong', tip: '\\cong' },
  { label: '∝', cmd: '\\propto', tip: '\\propto' },
  { label: '⊂', cmd: '\\subset', tip: '\\subset' },
  { label: '⊃', cmd: '\\supset', tip: '\\supset' },
  { label: '⊆', cmd: '\\subseteq', tip: '\\subseteq' },
  { label: '⊇', cmd: '\\supseteq', tip: '\\supseteq' },
  { label: '∈', cmd: '\\in', tip: '\\in' },
  { label: '∉', cmd: '\\notin', tip: '\\notin' },
  { label: '∋', cmd: '\\ni', tip: '\\ni' },
  { label: '⊥', cmd: '\\perp', tip: '\\perp' },
  { label: '∥', cmd: '\\parallel', tip: '\\parallel' },
  { label: '≪', cmd: '\\ll', tip: '\\ll' },
  { label: '≫', cmd: '\\gg', tip: '\\gg' },
];

const ARROWS: SymbolEntry[] = [
  { label: '←', cmd: '\\leftarrow', tip: '\\leftarrow' },
  { label: '→', cmd: '\\rightarrow', tip: '\\rightarrow' },
  { label: '↑', cmd: '\\uparrow', tip: '\\uparrow' },
  { label: '↓', cmd: '\\downarrow', tip: '\\downarrow' },
  { label: '↔', cmd: '\\leftrightarrow', tip: '\\leftrightarrow' },
  { label: '⇐', cmd: '\\Leftarrow', tip: '\\Leftarrow' },
  { label: '⇒', cmd: '\\Rightarrow', tip: '\\Rightarrow' },
  { label: '⇑', cmd: '\\Uparrow', tip: '\\Uparrow' },
  { label: '⇓', cmd: '\\Downarrow', tip: '\\Downarrow' },
  { label: '⇔', cmd: '\\Leftrightarrow', tip: '\\Leftrightarrow' },
  { label: '↦', cmd: '\\mapsto', tip: '\\mapsto' },
  { label: '⟼', cmd: '\\longmapsto', tip: '\\longmapsto' },
  { label: '↪', cmd: '\\hookrightarrow', tip: '\\hookrightarrow' },
  { label: '↩', cmd: '\\hookleftarrow', tip: '\\hookleftarrow' },
  { label: '⇌', cmd: '\\rightleftharpoons', tip: '\\rightleftharpoons' },
  { label: '⟶', cmd: '\\longrightarrow', tip: '\\longrightarrow' },
];

const BRACKETS: SymbolEntry[] = [
  { label: '⟨ ⟩', cmd: '\\langle  \\rangle', tip: '\\langle … \\rangle', cursor: 8 },
  { label: '⌈ ⌉', cmd: '\\lceil  \\rceil', tip: '\\lceil … \\rceil', cursor: 7 },
  { label: '⌊ ⌋', cmd: '\\lfloor  \\rfloor', tip: '\\lfloor … \\rfloor', cursor: 8 },
  { label: '‖  ‖', cmd: '\\| \\|', tip: '\\| … \\|', cursor: 3 },
  { label: '( )', cmd: '\\left(  \\right)', tip: '\\left( … \\right)', cursor: 7 },
  { label: '[ ]', cmd: '\\left[  \\right]', tip: '\\left[ … \\right]', cursor: 7 },
  { label: '{ }', cmd: '\\left\\{  \\right\\}', tip: '\\left\\{ … \\right\\}', cursor: 8 },
  { label: '| |', cmd: '\\left|  \\right|', tip: '\\left| … \\right|', cursor: 7 },
];

const STRUCTURES: SymbolEntry[] = [
  // Cursor places caret in the most useful stub. Offsets account for
  // every backslash + brace.
  { label: 'a/b',       cmd: '\\frac{}{}',       tip: '\\frac{num}{denom}',   cursor: 6 },
  { label: '√',         cmd: '\\sqrt{}',         tip: '\\sqrt{x}',            cursor: 6 },
  { label: 'ⁿ√',        cmd: '\\sqrt[n]{}',      tip: '\\sqrt[n]{x}',         cursor: 7 },
  { label: 'aⁿ',        cmd: '^{}',              tip: 'a^{exponent}',         cursor: 2 },
  { label: 'aₙ',        cmd: '_{}',              tip: 'a_{subscript}',        cursor: 2 },
  { label: 'â',         cmd: '\\hat{}',          tip: '\\hat{x}',             cursor: 5 },
  { label: 'ā',         cmd: '\\bar{}',          tip: '\\bar{x}',             cursor: 5 },
  { label: 'ã',         cmd: '\\tilde{}',        tip: '\\tilde{x}',           cursor: 7 },
  { label: 'ȧ',         cmd: '\\dot{}',          tip: '\\dot{x}',             cursor: 5 },
  { label: 'ä',         cmd: '\\ddot{}',         tip: '\\ddot{x}',            cursor: 6 },
  { label: 'â⃗',         cmd: '\\vec{}',          tip: '\\vec{x}',             cursor: 5 },
  { label: 'lim',       cmd: '\\lim_{ \\to }',   tip: '\\lim_{x \\to a}',     cursor: 6 },
  { label: 'sup',       cmd: '\\sup_{}',         tip: '\\sup_{x \\in S}',     cursor: 6 },
  { label: 'inf',       cmd: '\\inf_{}',         tip: '\\inf_{x \\in S}',     cursor: 6 },
];

const ENVIRONMENTS: SymbolEntry[] = [
  { label: 'equation',  cmd: '\\begin{equation}\n  \n\\end{equation}\n', tip: 'numbered equation', cursor: 20 },
  { label: 'align',     cmd: '\\begin{align}\n   & \n\\end{align}\n', tip: 'multi-line aligned equations', cursor: 17 },
  { label: 'gather',    cmd: '\\begin{gather}\n  \n\\end{gather}\n', tip: 'centred multi-line equations', cursor: 18 },
  { label: 'matrix',    cmd: '\\begin{pmatrix}\n  a & b \\\\\n  c & d\n\\end{pmatrix}\n', tip: 'parenthesised matrix' },
  { label: 'bmatrix',   cmd: '\\begin{bmatrix}\n  a & b \\\\\n  c & d\n\\end{bmatrix}\n', tip: 'square-bracket matrix' },
  { label: 'vmatrix',   cmd: '\\begin{vmatrix}\n  a & b \\\\\n  c & d\n\\end{vmatrix}\n', tip: 'determinant matrix' },
  { label: 'cases',     cmd: '\\begin{cases}\n  a, & x \\geq 0 \\\\\n  b, & x < 0\n\\end{cases}\n', tip: 'piecewise definition' },
  { label: 'theorem',   cmd: '\\begin{theorem}\n  \n\\end{theorem}\n', tip: '\\newtheorem-defined block', cursor: 19 },
  { label: 'proof',     cmd: '\\begin{proof}\n  \n\\end{proof}\n', tip: 'proof environment', cursor: 16 },
  { label: 'figure',    cmd: '\\begin{figure}[ht]\n  \\centering\n  \\includegraphics[width=.6\\textwidth]{}\n  \\caption{}\n  \\label{fig:}\n\\end{figure}\n', tip: 'figure with caption + label' },
  { label: 'table',     cmd: '\\begin{table}[ht]\n  \\centering\n  \\begin{tabular}{lcc}\n    \\toprule\n    Header & A & B \\\\\n    \\midrule\n    Row & 1 & 2 \\\\\n    \\bottomrule\n  \\end{tabular}\n  \\caption{}\n  \\label{tab:}\n\\end{table}\n', tip: 'table with booktabs + caption' },
];

export const CATEGORIES: SymbolCategory[] = [
  { id: 'greek',        name: 'Greek',         cols: 6, entries: GREEK },
  { id: 'operators',    name: 'Operators',     cols: 6, entries: OPERATORS },
  { id: 'relations',    name: 'Relations',     cols: 6, entries: RELATIONS },
  { id: 'arrows',       name: 'Arrows',        cols: 6, entries: ARROWS },
  { id: 'brackets',     name: 'Brackets',      cols: 4, entries: BRACKETS },
  { id: 'structures',   name: 'Structures',    cols: 4, entries: STRUCTURES },
  { id: 'environments', name: 'Environments',  cols: 3, entries: ENVIRONMENTS },
];

export function flatSymbolCount(): number {
  return CATEGORIES.reduce((n, c) => n + c.entries.length, 0);
}
