<script lang="ts">
  // SourceGraph — VSCode-style commit history pane. Renders a flat
  // lane graph of the most recent ~200 commits ; each row shows :
  //
  //   [lane dots + connecting lines]  subject · author · age
  //
  // Lane assignment is greedy + stable :
  //   - HEAD takes lane 0.
  //   - Each parent that's a merge-second-parent takes a new lane.
  //   - Single-parent chains stay on their child's lane.
  //
  // We don't try to be as pretty as gitk's vertical-cubic curves —
  // straight verticals + a small horizontal connector at branch /
  // merge points carry the same information with much less SVG.

  import { onMount, onDestroy } from 'svelte';
  import { getLog, type LogEntry, type LogResponse } from '../git';
  import { i18n } from '../i18n.svelte';

  interface Props {
    project: string;
  }
  let { project }: Props = $props();

  let log = $state<LogResponse | null>(null);
  let err = $state<string | null>(null);
  let loading = $state(false);
  let poll: ReturnType<typeof setInterval> | undefined;

  async function refresh() {
    loading = true;
    err = null;
    try {
      log = await getLog(project);
    } catch (e) {
      err = String(e);
    } finally {
      loading = false;
    }
  }
  onMount(() => {
    poll = setInterval(refresh, 30_000);
  });
  onDestroy(() => {
    if (poll) clearInterval(poll);
  });
  $effect(() => {
    project;
    refresh();
  });

  // Lane assignment : `lanes` is the live set of active SHAs we
  // expect to see next. For each commit we pick the lane that
  // expects it ; its parents take over that lane (first parent) +
  // a fresh lane (second parent of a merge).
  interface Row {
    entry: LogEntry;
    lane: number;
    parents: number[]; // lanes the parents will occupy
    width: number;     // highest lane index seen so far + 1
  }
  const rows = $derived.by(() => {
    if (!log || !log.entries) return [] as Row[];
    const result: Row[] = [];
    let lanes: (string | null)[] = [];
    for (const e of log.entries) {
      // Defensive — Go's `nil` parent slice marshals to JSON null,
      // an older server build might send that ; treat as a root
      // commit so we don't crash the reducer.
      if (!e.parents) e.parents = [];
      // Find the lane assigned to this commit ; first row picks 0.
      let lane = lanes.findIndex((s) => s === e.sha);
      if (lane === -1) {
        lane = lanes.findIndex((s) => s === null);
        if (lane === -1) {
          lane = lanes.length;
          lanes.push(null);
        }
      }
      // Clear any other lanes still pointing at this sha (merge
      // collapse).
      lanes = lanes.map((s) => (s === e.sha ? null : s));
      // Assign parents : first reuses current lane, additional
      // parents fork off into fresh lanes.
      const parentLanes: number[] = [];
      for (let pi = 0; pi < e.parents.length; pi++) {
        if (pi === 0) {
          lanes[lane] = e.parents[0];
          parentLanes.push(lane);
        } else {
          let pl = lanes.findIndex((s) => s === null);
          if (pl === -1) {
            pl = lanes.length;
            lanes.push(e.parents[pi]);
          } else {
            lanes[pl] = e.parents[pi];
          }
          parentLanes.push(pl);
        }
      }
      if (e.parents.length === 0) {
        // Root commit — empty parents means the lane goes idle.
        lanes[lane] = null;
      }
      // Trim trailing nulls so width stays minimal.
      while (lanes.length > 0 && lanes[lanes.length - 1] === null) {
        lanes.pop();
      }
      result.push({ entry: e, lane, parents: parentLanes, width: Math.max(1, lanes.length) });
    }
    return result;
  });

  // Lane colour cycle — daisyUI semantic tokens so the graph adapts
  // to the active theme.
  const LANE_COLOURS = [
    '#0ea5e9', '#22c55e', '#eab308', '#ef4444',
    '#a855f7', '#06b6d4', '#f97316', '#ec4899',
  ];
  function laneColour(lane: number): string {
    return LANE_COLOURS[lane % LANE_COLOURS.length];
  }

  function age(unix: number): string {
    const diff = Date.now() / 1000 - unix;
    if (diff < 60) return Math.floor(diff) + 's';
    if (diff < 3600) return Math.floor(diff / 60) + 'm';
    if (diff < 86_400) return Math.floor(diff / 3600) + 'h';
    if (diff < 86_400 * 30) return Math.floor(diff / 86_400) + 'd';
    if (diff < 86_400 * 365) return Math.floor(diff / 86_400 / 30) + 'mo';
    return Math.floor(diff / 86_400 / 365) + 'y';
  }

  const LANE_W = 14;
  const ROW_H = 22;
</script>

<div class="flex flex-col h-full text-xs">
  <header class="flex items-center px-3 h-9 border-b border-base-300 bg-base-200 gap-1">
    <!-- codicon `git-commit` — three-dot vertical commit graph, the
         classic VSCode source-control glyph. -->
    <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">
      <path d="M10.94 7.5a3 3 0 0 0-5.88 0H1.5a.5.5 0 0 0 0 1h3.56a3 3 0 0 0 5.88 0h3.56a.5.5 0 0 0 0-1h-3.56zM8 10a2 2 0 1 1 0-4 2 2 0 0 1 0 4z"/>
    </svg>
    <span class="font-semibold text-sm">{i18n.t('scm.history')}</span>
    {#if log}
      <span class="ml-2 badge badge-ghost badge-xs">{log.entries.length}</span>
    {/if}
    <button
      class="ml-auto btn btn-ghost btn-xs"
      onclick={refresh}
      disabled={loading}
      title="Reload"
    >
      {#if loading}<span class="loading loading-spinner loading-xs"></span>{:else}⟳{/if}
    </button>
  </header>

  {#if err}
    <div class="m-1 alert alert-error text-xs">{err}</div>
  {:else if !log || log.entries.length === 0}
    <p class="p-3 text-xs opacity-60 italic">{loading ? i18n.t('common.loading') : 'No commits.'}</p>
  {:else}
    <div class="overflow-auto">
      <ul class="text-xs">
        {#each rows as row (row.entry.sha)}
          {@const e = row.entry}
          <li class="flex items-center hover:bg-base-200 px-1" style="height: {ROW_H}px">
            <!-- Lane graphic : one SVG per row, painted with the
                 commit dot on `row.lane` + the connecting line down
                 to parent lanes. Width adapts to the current fan-out. -->
            <svg
              width={row.width * LANE_W}
              height={ROW_H}
              viewBox="0 0 {row.width * LANE_W} {ROW_H}"
              class="flex-none"
              aria-hidden="true"
            >
              <!-- Continuing lines through this row : draw straight
                   vertical for every active lane EXCEPT the commit
                   one (we'll draw a half-line for that one). -->
              {#each Array(row.width) as _, l (l)}
                <line
                  x1={l * LANE_W + LANE_W / 2}
                  x2={l * LANE_W + LANE_W / 2}
                  y1={l === row.lane ? ROW_H / 2 : 0}
                  y2={ROW_H}
                  stroke={laneColour(l)}
                  stroke-width="1.5"
                  opacity="0.55"
                />
              {/each}
              <!-- Top half-line for the commit's lane -->
              <line
                x1={row.lane * LANE_W + LANE_W / 2}
                x2={row.lane * LANE_W + LANE_W / 2}
                y1={0}
                y2={ROW_H / 2}
                stroke={laneColour(row.lane)}
                stroke-width="1.5"
                opacity="0.55"
              />
              <!-- Horizontal arms to merge parents -->
              {#each row.parents as pl}
                {#if pl !== row.lane}
                  <line
                    x1={row.lane * LANE_W + LANE_W / 2}
                    x2={pl * LANE_W + LANE_W / 2}
                    y1={ROW_H / 2}
                    y2={ROW_H / 2}
                    stroke={laneColour(pl)}
                    stroke-width="1.5"
                    opacity="0.55"
                  />
                {/if}
              {/each}
              <!-- Commit dot -->
              <circle
                cx={row.lane * LANE_W + LANE_W / 2}
                cy={ROW_H / 2}
                r="4"
                fill={laneColour(row.lane)}
              />
            </svg>

            <span class="ml-2 truncate font-mono opacity-50 w-14">{e.sha.slice(0, 7)}</span>
            {#each e.ref_names ?? [] as ref}
              <span class="badge badge-ghost badge-xs mr-1 font-mono">{ref}</span>
            {/each}
            <span class="truncate flex-1" title={e.subject}>{e.subject}</span>
            <span class="opacity-60 ml-2 truncate hidden md:inline">{e.author}</span>
            <span class="opacity-50 ml-2 font-mono">{age(e.unix_time)}</span>
          </li>
        {/each}
      </ul>
    </div>
  {/if}
</div>
