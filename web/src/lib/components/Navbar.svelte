<script lang="ts">
  import type { Awareness } from 'y-protocols/awareness';
  import ProjectSwitcher from './ProjectSwitcher.svelte';
  import LanguageSwitcher from './LanguageSwitcher.svelte';
  import ThemeSwitcher from './ThemeSwitcher.svelte';
  import CollaboratorList from './CollaboratorList.svelte';
  import type { Identity } from '../identity';

  interface Props {
    project: string;
    language: string;
    connectionStatus: 'connecting' | 'connected' | 'disconnected';
    awareness: Awareness | undefined;
    identity: Identity;
    onCompile: () => void;
    onSwitch: (name: string, language: string) => void;
    onLanguageChange: (language: string) => void;
    onRename: (identity: Identity) => void;
  }

  let {
    project,
    language,
    connectionStatus,
    awareness,
    identity,
    onCompile,
    onSwitch,
    onLanguageChange,
    onRename,
  }: Props = $props();

  const statusBadge = $derived(
    connectionStatus === 'connected'
      ? 'badge-success'
      : connectionStatus === 'connecting'
        ? 'badge-warning'
        : 'badge-error',
  );
</script>

<div class="navbar bg-base-100 border-base-300 border-b shadow-sm">
  <div class="flex-1">
    <span class="btn btn-ghost text-xl normal-case">
      weft-loom
      <span class="ml-2 text-xs opacity-60 font-normal">collaborative editor</span>
    </span>
  </div>
  <div class="flex-none gap-2 flex items-center">
    <CollaboratorList {awareness} self={identity} {onRename} />
    <div class="divider divider-horizontal mx-0"></div>
    <ProjectSwitcher current={project} {onSwitch} />
    <LanguageSwitcher current={language} onChange={onLanguageChange} />
    <div class="divider divider-horizontal mx-0"></div>
    <ThemeSwitcher />
    <div class="divider divider-horizontal mx-0"></div>
    <div class="badge {statusBadge} badge-sm gap-1">
      <span class="status status-sm"></span>
      {connectionStatus}
    </div>
    <button class="btn btn-primary btn-sm" onclick={onCompile}>
      Compile
    </button>
  </div>
</div>
