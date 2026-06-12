<script lang="ts">
  // ColorPickerPopover — small grid of preset HSL swatches anchored
  // BELOW the trigger (the user's color dot in CollaboratorsSidebar).
  // The native <input type="color"> opens the OS picker which we
  // can't position cross-platform ; this popover is fully
  // controlled so it always lands right under the dot.
  //
  // Bottom row keeps the native picker as an escape hatch for
  // operators who want a custom hue not on the preset grid.
  import { clickOutside } from '../actions';
  import { hslToHex } from '../identity';

  interface Props {
    open: boolean;
    currentColor: string;
    onPick: (color: string) => void;
    onClose: () => void;
  }

  let { open = $bindable(), currentColor, onPick, onClose }: Props = $props();

  // 24-slot palette : 12 hues × 2 luminosities. Tuned to be readable
  // as both cursor + selection-bg-tint on light + dark themes.
  const HUES = [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330];
  const PRESETS = [
    ...HUES.map((h) => `hsl(${h}, 70%, 45%)`),
    ...HUES.map((h) => `hsl(${h}, 65%, 65%)`),
  ];

  function pick(c: string) {
    onPick(c);
    open = false;
  }
</script>

{#if open}
  <div
    role="dialog"
    aria-label="Pick a colour"
    class="absolute top-full left-0 mt-1 z-50 bg-base-100 border border-base-300 rounded-box shadow-lg p-2 w-48"
    use:clickOutside={() => { open = false; onClose(); }}
  >
    <div class="grid grid-cols-6 gap-1">
      {#each PRESETS as c}
        <button
          type="button"
          class="w-6 h-6 rounded border border-base-300 hover:scale-110 transition-transform"
          class:ring-2={c === currentColor}
          class:ring-primary={c === currentColor}
          style="background-color: {c}"
          title={c}
          onclick={() => pick(c)}
          aria-label={c}
        ></button>
      {/each}
    </div>

    <!-- Custom picker fallback — the OS native dialog, useful when
         the preset grid doesn't match what the user wants. The
         opacity-0 overlay over the visible button keeps the styling
         while delegating the trigger to the browser. -->
    <div class="mt-2 pt-2 border-t border-base-300">
      <label class="btn btn-ghost btn-xs w-full justify-between relative overflow-hidden">
        Custom…
        <span
          class="inline-block w-4 h-4 rounded border border-base-300"
          style="background-color: {currentColor}"
        ></span>
        <input
          type="color"
          class="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
          value={hslToHex(currentColor)}
          oninput={(e) => pick((e.currentTarget as HTMLInputElement).value)}
        />
      </label>
    </div>
  </div>
{/if}
