<script lang="ts">
  // Avatar — circular profile picture for a peer (self or remote).
  // Renders the photo URL when one is set ; falls back to a colored
  // circle with the user's initials over their HSL color. Same
  // component used in the CollaboratorsSidebar list, the cursor
  // pill (future), and any "edit profile" surface.
  import { initials } from '../identity';

  interface Props {
    name: string;
    color: string;
    avatar?: string;
    size?: number;
    title?: string;
  }

  let { name, color, avatar, size = 24, title }: Props = $props();

  const display = $derived(initials(name));
  // Auto-pick a text colour the eye picks out on both light and dark
  // backgrounds — daisyUI base classes can't help here because the
  // background colour comes from the user.color, not from a theme
  // token. Heuristic : whitish text on most HSL hues at 50 % lum,
  // dark text only on yellows / greens / cyans where the perceptual
  // luminance overpowers the 50 % lightness.
  function textColorFor(c: string): string {
    const m = c.match(/^hsla?\(\s*(\d+(?:\.\d+)?)/);
    if (!m) return 'white';
    const h = parseFloat(m[1]);
    return (h >= 40 && h <= 200) ? '#111' : 'white';
  }
  const textColor = $derived(textColorFor(color));
</script>

{#if avatar}
  <img
    src={avatar}
    alt="{name} avatar"
    {title}
    class="rounded-full border border-base-300 object-cover flex-none"
    style="width: {size}px; height: {size}px"
    loading="lazy"
  />
{:else}
  <span
    {title}
    class="inline-flex items-center justify-center rounded-full font-semibold select-none flex-none border border-base-300"
    style="width: {size}px; height: {size}px; background-color: {color}; color: {textColor}; font-size: {Math.round(size * 0.42)}px"
    aria-label="{name} avatar"
  >
    {display}
  </span>
{/if}
