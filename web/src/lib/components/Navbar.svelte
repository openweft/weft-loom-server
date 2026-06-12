<script lang="ts">
  import type { Awareness } from 'y-protocols/awareness';
  import ProjectSwitcher from './ProjectSwitcher.svelte';
  import LanguageSwitcher from './LanguageSwitcher.svelte';
  import ThemeSwitcher from './ThemeSwitcher.svelte';
  import SyncBadge from './SyncBadge.svelte';
  import type { Identity } from '../identity';

  interface Props {
    project: string;
    language: string;
    connectionStatus: 'connecting' | 'connected' | 'disconnected';
    ytextTick: number;
    awareness: Awareness | undefined;
    identity: Identity;
    onToggleAI: () => void;
    onToggleCollab: () => void;
    onToggleShell: () => void;
    onToggleChat: () => void;
    onSwitch: (name: string, language: string) => void;
    onLanguageChange: (language: string) => void;
    onRename: (identity: Identity) => void;
    // Bindable so the MenuBar can pop the dropdown from the
    // "Switch project…" command without owning state.
    switcherOpen?: boolean;
  }

  let {
    project,
    language,
    connectionStatus,
    ytextTick,
    awareness,
    identity,
    onToggleAI,
    onToggleCollab,
    onToggleShell,
    onToggleChat,
    onSwitch,
    onLanguageChange,
    onRename,
    switcherOpen = $bindable(false),
  }: Props = $props();

  const statusBadge = $derived(
    connectionStatus === 'connected'
      ? 'badge-success'
      : connectionStatus === 'connecting'
        ? 'badge-warning'
        : 'badge-error',
  );
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
