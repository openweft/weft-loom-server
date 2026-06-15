<script lang="ts">
  // WordCountPanel — daily-writing-goals floating panel. Modelled
  // after BibliographyPanel + LatexSymbolPalette : a small FAB on
  // the right edge of the editor area + a popover with stats.
  //
  // What it surfaces :
  //   - live word count (already computed by the editor's cursor
  //     stats hook ; we just read from App.svelte via a prop)
  //   - "today's progress" : words ADDED to this file today,
  //     persisted per (project, file) in localStorage so the
  //     count survives refreshes
  //   - configurable daily goal with a progress bar
  //   - on-track / behind / done indicator
  //
  // Beats Overleaf : Overleaf shows a static word count in the
  // toolbar but doesn't track day-over-day progress or expose a
  // goal. Academic writers love a target.

  interface Props {
    project: string;
    file: string;
    // Live word count fed from Editor.svelte via App.svelte.
    // Undefined while loading or for files with no editor (binary,
    // ipynb, ods, etc.).
    wordCount: number | undefined;
    selectionLen: number;
    // visible : the panel only renders for files where word count
    // makes sense (markdown / latex / plain text). App.svelte
    // computes this based on the language.
    visible: boolean;
  }
  let { project, file, wordCount, selectionLen, visible }: Props = $props();

  let open = $state(false);

  // Persisted daily goal (words/day). Same across all files of the
  // same project — the user typically has ONE writing rhythm.
  let goal = $state<number>(500);
  // Today's anchor : the word count at the START of today for this
  // file. Diff against the live count = words written today.
  // Stored per (project, file) so switching files keeps a per-file
  // anchor + we don't conflate today's progress across documents.
  let todayAnchor = $state<number | undefined>(undefined);
  let todayKey = $state<string>('');

  function ymdKey(): string {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + dd;
  }

  function storageKey(): string {
    return 'weft-loom-words:' + project + ':' + file;
  }

  function loadGoal() {
    try {
      const v = Number(localStorage.getItem('weft-loom-words-goal'));
      if (!Number.isNaN(v) && v > 0) goal = v;
    } catch { /* localStorage may be blocked */ }
  }

  function saveGoal() {
    try { localStorage.setItem('weft-loom-words-goal', String(goal)); } catch {}
  }

  // Pull today's anchor from localStorage when available (carries
  // progress across reloads). Returns true when an anchor was found,
  // false when we still need to seed once the live count arrives.
  function loadAnchorIfStored(): boolean {
    const k = storageKey();
    const today = ymdKey();
    try {
      const raw = localStorage.getItem(k);
      if (raw) {
        const parsed = JSON.parse(raw) as { date: string; anchor: number };
        if (parsed.date === today) {
          todayAnchor = parsed.anchor;
          todayKey = today;
          return true;
        }
      }
    } catch { /* corrupt JSON or storage blocked */ }
    return false;
  }

  function persistAnchor() {
    try {
      localStorage.setItem(storageKey(), JSON.stringify({
        date: todayKey,
        anchor: todayAnchor ?? 0,
      }));
    } catch {}
  }

  // Today's added words = current - anchor, clamped at 0 (so a
  // delete-spree doesn't go negative). Returns 0 while the anchor
  // is still pending (before the editor publishes the first live
  // count, or briefly between a file-change and the seed-on-first
  // -count effect firing) — avoids a flash where wroteToday shows
  // the total because anchor defaulted to 0.
  const wroteToday = $derived(
    todayAnchor === undefined
      ? 0
      : Math.max(0, (wordCount ?? 0) - todayAnchor),
  );
  const pct = $derived(goal > 0 ? Math.min(100, Math.round((wroteToday / goal) * 100)) : 0);
  const achieved = $derived(goal > 0 && wroteToday >= goal);

  // file/project change : load goal + try to load today's anchor
  // from localStorage. If nothing's stored for today, leave the
  // anchor undefined ; a separate effect below seeds it the FIRST
  // moment we get a real word count from the editor (avoids a race
  // where the anchor seeds at 0 before the editor publishes).
  $effect(() => {
    void file; void project;
    todayAnchor = undefined;
    todayKey = ymdKey();
    loadGoal();
    loadAnchorIfStored();
  });

  // Seed-on-first-nonzero : when wordCount transitions from undefined
  // OR 0 to a positive value (i.e. the editor finally published the
  // real loaded count after seed-from-disk completed), anchor it.
  // Avoids the race where the editor mounts + publishes 0 BEFORE the
  // doc loads, which would otherwise leave today's progress reading
  // as the entire file. For empty docs the anchor stays undefined ;
  // wroteToday gates on `todayAnchor === undefined ? 0 : …` so the
  // panel correctly shows 0 until the user types their first word.
  $effect(() => {
    if (todayAnchor !== undefined) return;
    if (wordCount === undefined || wordCount <= 0) return;
    if (loadAnchorIfStored()) return;
    todayAnchor = wordCount;
    todayKey = ymdKey();
    persistAnchor();
  });

  function onGoalChange(v: number) {
    if (!Number.isFinite(v) || v < 1) return;
    goal = Math.floor(v);
    saveGoal();
  }

  function resetToday() {
    todayAnchor = wordCount ?? 0;
    todayKey = ymdKey();
    persistAnchor();
  }
</script>

{#if visible}
  <div class="words-panel">
    <button
      type="button"
      class="words-fab btn btn-circle btn-info"
      title="Word count + writing goal"
      onclick={() => (open = !open)}
      aria-label="Open word count panel"
      data-testid="words-toggle"
    >
      <span class="text-xl">📊</span>
      {#if achieved}
        <span class="absolute -top-1 -right-1 badge badge-xs badge-success" data-testid="words-achieved-badge">✓</span>
      {/if}
    </button>
    {#if open}
      <div class="words-popover card bg-base-200 shadow-xl border border-base-300" data-testid="words-panel">
        <div class="card-body p-3">
          <div class="flex items-center justify-between mb-2">
            <div class="text-sm font-semibold">Words</div>
            <button class="btn btn-ghost btn-xs" onclick={() => (open = false)} aria-label="Close">×</button>
          </div>

          <div class="words-stats">
            <div class="words-stat-row">
              <span class="words-stat-label">Total</span>
              <span class="words-stat-value" data-testid="words-total">{wordCount ?? '—'}</span>
            </div>
            {#if selectionLen > 0}
              <div class="words-stat-row">
                <span class="words-stat-label">Selection</span>
                <span class="words-stat-value">{selectionLen} chars</span>
              </div>
            {/if}
            <div class="words-stat-row">
              <span class="words-stat-label">Today</span>
              <span class="words-stat-value" data-testid="words-today">{wroteToday}</span>
            </div>
          </div>

          <div class="words-divider"></div>

          <label class="text-xs opacity-70 mt-1" for="words-goal-input">Daily goal</label>
          <div class="flex items-center gap-2">
            <input
              id="words-goal-input"
              type="number"
              min="1"
              step="50"
              class="input input-bordered input-xs flex-1"
              value={goal}
              onchange={(e) => onGoalChange(Number(e.currentTarget.value))}
              data-testid="words-goal-input"
            />
            <span class="text-xs opacity-60">words</span>
          </div>

          <div class="words-progress" role="progressbar" aria-valuemin="0" aria-valuemax={goal} aria-valuenow={wroteToday}>
            <div class="words-progress-bar" class:words-progress-done={achieved} style="width: {pct}%" data-testid="words-progress"></div>
            <span class="words-progress-text">
              {#if achieved}
                Goal reached — {wroteToday}/{goal} ✓
              {:else}
                {wroteToday}/{goal} · {pct}%
              {/if}
            </span>
          </div>

          <div class="flex justify-end mt-2">
            <button
              type="button"
              class="btn btn-ghost btn-xs"
              onclick={resetToday}
              data-testid="words-reset-today"
              title="Reset today's progress baseline to the current word count"
            >Reset today</button>
          </div>
        </div>
      </div>
    {/if}
  </div>
{/if}

<style>
  .words-panel {
    position: absolute;
    right: 1.5rem;
    bottom: 13.5rem; /* sits above comments / bib / palette stack */
    z-index: 30;
  }
  .words-fab {
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.2);
    position: relative;
  }
  .words-popover {
    position: absolute;
    right: 0;
    bottom: 4rem;
    width: 22rem;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }
  .words-popover :global(.card-body) {
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }
  .words-stats {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }
  .words-stat-row {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    padding: 0.25rem 0.4rem;
    border-radius: 0.3rem;
    background: rgba(0, 0, 0, 0.03);
  }
  .words-stat-label {
    font-size: 0.75rem;
    opacity: 0.7;
  }
  .words-stat-value {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 0.9rem;
    font-weight: 600;
  }
  .words-divider {
    border-top: 1px solid rgba(0, 0, 0, 0.1);
    margin: 0.5rem 0;
  }
  .words-progress {
    position: relative;
    height: 1.4rem;
    background: rgba(0, 0, 0, 0.08);
    border-radius: 0.3rem;
    overflow: hidden;
    margin-top: 0.4rem;
  }
  .words-progress-bar {
    position: absolute;
    inset: 0 auto 0 0;
    background: var(--info, #0ea5e9);
    transition: width 200ms ease-out;
  }
  .words-progress-bar.words-progress-done {
    background: var(--success, #10b981);
  }
  .words-progress-text {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 0.75rem;
    font-weight: 600;
    text-shadow: 0 0 2px rgba(255, 255, 255, 0.6);
    color: rgb(20, 30, 40);
  }
</style>
