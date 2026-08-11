<script lang="ts">
  // CompilerSelector — two-dropdown toolbar pinning the LaTeX engine
  // + bibliography processor for the current project. Persists via
  // the compilerChoices store (per-project localStorage) and feeds
  // CompileLogPanel's startCompile body so the backend dispatcher
  // invokes the matching binary inside the workspace μVM.
  //
  // Surfaces only for LaTeX projects — the parent (CompileLogPanel)
  // controls visibility via the `visible` prop. Keeping the gating
  // in the parent avoids a `language` prop redundancy : the parent
  // already knows the active language.
  import { compilerChoices, type LatexEngine, type BibEngine } from '../settings.svelte';

  interface Props {
    project: string;
  }

  let { project }: Props = $props();

  // $derived so the dropdowns re-bind when the project changes
  // (project-switcher click) without unmounting the component.
  const choice = $derived(compilerChoices.get(project));

  const ENGINES: LatexEngine[] = ['pdflatex', 'lualatex', 'xelatex', 'gotex'];
  const BIBS: BibEngine[] = ['bibtex', 'biber'];

  function onEngine(ev: Event) {
    const v = (ev.target as HTMLSelectElement).value as LatexEngine;
    compilerChoices.setEngine(project, v);
  }

  function onBib(ev: Event) {
    const v = (ev.target as HTMLSelectElement).value as BibEngine;
    compilerChoices.setBib(project, v);
  }
</script>

<div class="flex items-center gap-2 text-[10px] opacity-80" data-testid="compiler-selector">
  <label class="flex items-center gap-1">
    <span class="opacity-70">Engine</span>
    <select
      class="select select-xs select-bordered text-[10px] min-h-0 h-6 py-0"
      value={choice.engine}
      onchange={onEngine}
      title="LaTeX engine — pdflatex (default), lualatex (Lua + modern fonts), xelatex (Unicode + system fonts), gotex (pure-Go, WASM-capable)"
      data-testid="compiler-engine"
    >
      {#each ENGINES as e}
        <option value={e}>{e}</option>
      {/each}
    </select>
  </label>
  <label class="flex items-center gap-1">
    <span class="opacity-70">Bib</span>
    <select
      class="select select-xs select-bordered text-[10px] min-h-0 h-6 py-0"
      value={choice.bib}
      onchange={onBib}
      title="Bibliography processor — bibtex (classic) or biber (biblatex backend)"
      data-testid="compiler-bib"
    >
      {#each BIBS as b}
        <option value={b}>{b}</option>
      {/each}
    </select>
  </label>
</div>
