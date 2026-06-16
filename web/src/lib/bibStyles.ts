// bibStyles.ts — canonical catalogue of BibTeX bibliography styles
// the BibStylePicker surfaces. Each entry carries :
//   - name        : the `\bibliographystyle{...}` argument
//   - label       : a slightly nicer human-facing label
//   - description : 1-line "what this looks like" hint
//   - family      : grouping bucket the picker uses to categorise
//
// The list is curated : core BibTeX standards (plain/abbrv/alpha/
// unsrt), the natbib author-year siblings (apalike/plainnat/...), the
// publisher-shipped styles (acm/ieeetr/IEEEtran/ACM-Reference-Format),
// and the harvard/agsm/dcu/chicago/nature/science extras most LaTeX
// distros ship by default.

export type BibStyleFamily = 'plain' | 'natbib' | 'ieee' | 'acm' | 'chicago' | 'other';

export interface BibStyle {
  name: string;
  label: string;
  description: string;
  family: BibStyleFamily;
}

export const BIB_STYLES: BibStyle[] = [
  // ─── Core BibTeX standards ──────────────────────────────────────
  { name: 'plain',    label: 'plain',    family: 'plain',
    description: 'Numeric labels, entries sorted alphabetically by author.' },
  { name: 'abbrv',    label: 'abbrv',    family: 'plain',
    description: 'Like plain, but first names + months + journals abbreviated.' },
  { name: 'alpha',    label: 'alpha',    family: 'plain',
    description: 'Alphabetic labels (e.g. [Knu86]), sorted by author.' },
  { name: 'unsrt',    label: 'unsrt',    family: 'plain',
    description: 'Numeric labels, entries in citation order (unsorted).' },
  { name: 'abstract', label: 'abstract', family: 'plain',
    description: 'Like plain but also prints the abstract field.' },

  // ─── natbib author-year siblings ────────────────────────────────
  { name: 'apalike',   label: 'apalike',   family: 'natbib',
    description: 'APA-style author-year, no natbib required.' },
  { name: 'abbrvnat',  label: 'abbrvnat',  family: 'natbib',
    description: 'natbib variant of abbrv (author-year + abbreviated names).' },
  { name: 'plainnat',  label: 'plainnat',  family: 'natbib',
    description: 'natbib variant of plain (author-year, full names).' },
  { name: 'unsrtnat',  label: 'unsrtnat',  family: 'natbib',
    description: 'natbib variant of unsrt (author-year, citation order).' },

  // ─── IEEE ───────────────────────────────────────────────────────
  { name: 'ieeetr',    label: 'ieeetr',    family: 'ieee',
    description: 'Classic IEEE transactions numeric style.' },
  { name: 'IEEEtran',  label: 'IEEEtran',  family: 'ieee',
    description: 'Modern IEEEtran package style ; pairs with IEEEtran.cls.' },

  // ─── ACM ────────────────────────────────────────────────────────
  { name: 'acm',                    label: 'acm',                    family: 'acm',
    description: 'Original ACM numeric style.' },
  { name: 'ACM-Reference-Format',   label: 'ACM-Reference-Format',   family: 'acm',
    description: 'ACM modern reference format ; pairs with acmart.cls.' },

  // ─── Chicago / Harvard ──────────────────────────────────────────
  { name: 'chicago',  label: 'chicago',  family: 'chicago',
    description: 'Chicago author-date.' },
  { name: 'harvard',  label: 'harvard',  family: 'chicago',
    description: 'Harvard author-year (requires harvard.sty).' },
  { name: 'agsm',     label: 'agsm',     family: 'chicago',
    description: 'Australian Government Style Manual harvard variant.' },
  { name: 'dcu',      label: 'dcu',      family: 'chicago',
    description: 'Design Council UK harvard variant.' },

  // ─── Other ──────────────────────────────────────────────────────
  { name: 'siam',    label: 'siam',    family: 'other',
    description: 'Society for Industrial and Applied Mathematics.' },
  { name: 'apsr',    label: 'apsr',    family: 'other',
    description: 'American Political Science Review.' },
  { name: 'asaetr', label: 'asaetr',  family: 'other',
    description: 'ASAE (American Society of Agricultural Engineers).' },
  { name: 'nature', label: 'nature',  family: 'other',
    description: 'Nature journal numeric style.' },
  { name: 'science', label: 'science', family: 'other',
    description: 'Science journal numeric style.' },
];

// formatBibliographystyleLine returns the LaTeX line that selects a
// style. Newline-terminated so callers can splice it as a single line
// (or trim() if they need to inline).
export function formatBibliographystyleLine(name: string): string {
  return '\\bibliographystyle{' + name + '}\n';
}
