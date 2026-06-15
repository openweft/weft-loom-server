// MathLive web component lazy-loader. Side-effect import registers
// the <math-field> custom element on first call. Subsequent calls
// are no-ops.

let loaded = false;

export async function loadMathLive(): Promise<void> {
  if (loaded) return;
  loaded = true;
  // mathlive auto-registers the custom element on import.
  await import('mathlive');
}

export interface MathFieldElement extends HTMLElement {
  value: string;
  setValue(latex: string): void;
}
