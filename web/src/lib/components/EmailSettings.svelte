<script lang="ts">
  // EmailSettings — read-only status card for the operator's SMTP
  // wiring. Lives inside AdminPanel.svelte (caller composes it ; this
  // component does not modify AdminPanel itself).
  //
  // Fetches /api/admin/email/config and renders one of two states :
  //
  //   * configured  → "Email notifications: configured" + From address
  //   * unconfigured → muted "not configured" hint + env-var docs
  //
  // There is no edit affordance : runtime config swap is unsupported
  // (operator updates env + restarts weft-loom). The card surfaces
  // enough information that end users can identify the sender they
  // should whitelist in their own inbox.

  import { getEmailConfig, type EmailConfig } from '../api';

  let config = $state<EmailConfig | null>(null);
  let loading = $state(false);
  let err = $state<string | null>(null);

  async function refresh() {
    loading = true;
    err = null;
    try {
      config = await getEmailConfig();
    } catch (e) {
      err = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    refresh();
  });
</script>

<section class="border border-base-300 rounded p-4 bg-base-100">
  <header class="flex items-center gap-2 mb-3">
    <!-- mail icon -->
    <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">
      <path d="M1.75 2.5h12.5c.69 0 1.25.56 1.25 1.25v8.5c0 .69-.56 1.25-1.25 1.25H1.75c-.69 0-1.25-.56-1.25-1.25v-8.5C.5 3.06 1.06 2.5 1.75 2.5zM1.5 4.04v.32l6.5 4.06 6.5-4.06v-.32c0-.137-.113-.25-.25-.25H1.75c-.137 0-.25.113-.25.25zm0 1.84v6.37c0 .137.113.25.25.25h12.5c.137 0 .25-.113.25-.25v-6.37L8 9.93 1.5 5.88z"/>
    </svg>
    <h4 class="text-sm font-semibold">Email notifications</h4>
    <button
      class="ml-auto btn btn-ghost btn-xs"
      onclick={refresh}
      disabled={loading}
      title="Re-read /api/admin/email/config">
      {#if loading}<span class="loading loading-spinner loading-xs"></span>{:else}↻{/if}
    </button>
  </header>

  {#if err}
    <div class="alert alert-error text-xs">{err}</div>
  {:else if config === null}
    <p class="text-xs opacity-60 italic">Loading…</p>
  {:else if config.configured}
    <div class="flex items-center gap-2">
      <span class="badge badge-xs badge-success">configured</span>
      <span class="text-xs">
        Outbound mail relay is wired. Mentions + comment notifications
        will be delivered.
      </span>
    </div>
    {#if config.from}
      <p class="text-xs mt-2 opacity-80">
        <span class="opacity-60">From: </span>
        <code class="font-mono">{config.from}</code>
        <span class="opacity-50">— whitelist this address in your inbox.</span>
      </p>
    {/if}
  {:else}
    <div class="flex items-center gap-2">
      <span class="badge badge-xs badge-ghost">not configured</span>
      <span class="text-xs opacity-70">
        SMTP is not wired. Mentions + comment notifications will be
        logged server-side but not delivered.
      </span>
    </div>
    <div class="alert alert-warning text-xs mt-3">
      <span>
        Operators : set <code class="font-mono">WEFT_LOOM_SMTP_HOST</code>,
        <code class="font-mono">_PORT</code>,
        <code class="font-mono">_USER</code>,
        <code class="font-mono">_PASS</code>,
        <code class="font-mono">_FROM</code>
        in the service environment and restart weft-loom.
        Runtime swap is not supported.
      </span>
    </div>
  {/if}
</section>
