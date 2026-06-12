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
  }

  let {
    project,
    language,
    onSwitch,
    onLanguageChange,
    switcherOpen = $bindable(false),
  }: Props = $props();
</script>

<div class="navbar bg-base-100 border-base-300 border-b shadow-sm min-h-0 py-1">
  <div class="flex-1"></div>
  <div class="flex-none gap-2 flex items-center">
    <ProjectSwitcher current={project} {onSwitch} bind:open={switcherOpen} />
    <SyncBadge {project} />
    <LanguageSwitcher current={language} onChange={onLanguageChange} />
    <!-- Collaborator avatars live in the dedicated
         CollaboratorsSidebar (right-column accordion) ; surfacing
         them twice (navbar + sidebar) was redundant and ate
         horizontal space on narrow viewports. -->
    <div class="divider divider-horizontal mx-0"></div>
    <ThemeSwitcher />
  </div>
</div>
