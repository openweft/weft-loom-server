<script lang="ts">
  // Navbar — top bar with project switcher + sync badge + language
  // picker + UI theme toggle. The collaborator chip cluster used to
  // live here too ; it moved to CollaboratorsSidebar so the props
  // it consumed (ytextTick, awareness, identity, onRename) are gone
  // along with the toggle callbacks the now-removed ActivityBar
  // toolbar used.
  import ProjectSwitcher from './ProjectSwitcher.svelte';
  import LanguageSwitcher from './LanguageSwitcher.svelte';
  import ThemeSwitcher from './ThemeSwitcher.svelte';
  import SyncBadge from './SyncBadge.svelte';

  interface Props {
    project: string;
    language: string;
    onSwitch: (name: string, language: string) => void;
    onLanguageChange: (language: string) => void;
    // Bindable so the MenuBar can pop the dropdown from the
    // "Switch project…" command without owning state.
    switcherOpen?: boolean;
    // Mobile-only : hamburger toggle for the slide-over sidebar.
    // Optional — desktop callers don't pass it ; the button is
    // hidden ≥ md so the prop's absence is invisible to those.
    onToggleMobileSidebar?: () => void;
  }

  let {
    project,
    language,
    onSwitch,
    onLanguageChange,
    switcherOpen = $bindable(false),
    onToggleMobileSidebar,
  }: Props = $props();
</script>

<div class="navbar bg-base-100 border-base-300 border-b shadow-sm min-h-0 py-1">
  <!-- Mobile hamburger — only visible below md. Toggles the
       slide-over sidebar that hosts the ActivityBar + FileExplorer
       on narrow viewports. Tap target = 44 × 44 px via the global
       [data-mobile-touch] CSS so finger-tapping doesn't miss. -->
  <button
    type="button"
    class="md:hidden btn btn-ghost btn-sm px-2"
    aria-label="Toggle sidebar"
    title="Toggle sidebar"
    data-mobile-touch
    onclick={() => onToggleMobileSidebar?.()}
  >
    <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true">
      <path d="M3 6h18v2H3V6zm0 5h18v2H3v-2zm0 5h18v2H3v-2z"/>
    </svg>
  </button>
  <div class="flex-1"></div>
  <div class="flex-none gap-1 sm:gap-2 flex items-center">
    <ProjectSwitcher current={project} {onSwitch} bind:open={switcherOpen} />
    <SyncBadge {project} />
    <!-- Language switcher is desktop-only — on phones the user
         doesn't usually flip locales mid-edit and the picker eats
         scarce horizontal room. -->
    <span class="hidden sm:inline-flex">
      <LanguageSwitcher current={language} onChange={onLanguageChange} />
    </span>
    <!-- Collaborator avatars live in the dedicated
         CollaboratorsSidebar (right-column accordion) ; surfacing
         them twice (navbar + sidebar) was redundant and ate
         horizontal space on narrow viewports. -->
    <div class="divider divider-horizontal mx-0 hidden sm:flex"></div>
    <ThemeSwitcher />
  </div>
</div>
