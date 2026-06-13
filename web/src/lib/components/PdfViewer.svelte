<script lang="ts">
  // PdfViewer — PDF.js-backed PDF viewer for the LaTeX compile
  // artifact. Replaces the older `<embed type="application/pdf">`
  // for two reasons :
  //
  //   1. Backward SyncTeX (T5b) : the embed element doesn't expose
  //      click coordinates. PDF.js renders each page to a <canvas>,
  //      so a click handler can compute (page, x, y) in PDF points
  //      and ask the server to map back to (source, line).
  //
  //   2. Future deltas : annotation overlays, custom find-in-PDF,
  //      thumbnail strip — all need PDF.js APIs.
  //
  // The .worker.mjs sidecar is loaded as a separate chunk by Vite ;
  // we tell PDF.js where to find it via GlobalWorkerOptions.

  import { onDestroy } from 'svelte';

  interface Props {
    src: string;                       // /api/projects/<p>/compile/<id>/artifact
    onClickPage?: (page: number, x: number, y: number) => void;
  }
  let { src, onClickPage }: Props = $props();

  let container: HTMLDivElement;
  let pages: { canvas: HTMLCanvasElement; viewport: any; pageNum: number }[] = [];
  let status = $state<'loading' | 'ready' | 'error'>('loading');
  let errMsg = $state('');
  let pageCount = $state(0);
  // Track the live PDF.js document so we can destroy it before
  // loading a new src (or on component teardown). Without this the
  // previous doc leaks its worker resources + canvases.
  let currentDoc: { destroy: () => Promise<void> } | null = null;

  // PDF.js wants a worker URL ; resolve it via Vite's `?url` import
  // (Vite hashes + serves the worker as a separate chunk).
  async function loadWorker() {
    const mod = await import('pdfjs-dist');
    // Vite serves the worker module from node_modules ; the URL gets
    // hashed into the build. Importing `?worker&url` builds it as a
    // worker chunk.
    const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
    mod.GlobalWorkerOptions.workerSrc = workerUrl;
    return mod;
  }

  async function load() {
    status = 'loading';
    try {
      const pdfjs = await loadWorker();
      await currentDoc?.destroy();
      currentDoc = null;
      const task = pdfjs.getDocument({ url: src });
      const doc = await task.promise;
      currentDoc = doc;
      pageCount = doc.numPages;
      pages = [];
      container.innerHTML = '';
      const scale = 1.25;
      for (let p = 1; p <= doc.numPages; p++) {
        const page = await doc.getPage(p);
        const viewport = page.getViewport({ scale });
        const canvas = document.createElement('canvas');
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        canvas.className = 'pdf-page';
        canvas.dataset.page = String(p);
        canvas.style.width = '100%';
        canvas.style.maxWidth = (viewport.width / scale) * 1.4 + 'px';
        canvas.style.height = 'auto';
        canvas.style.display = 'block';
        canvas.style.margin = '0 auto 12px';
        canvas.style.boxShadow = '0 1px 4px rgba(0,0,0,0.2)';
        canvas.style.cursor = 'crosshair';
        canvas.addEventListener('click', (e) => {
          // Compute click position in PDF user-space points.
          // PDF.js viewport has methods to convert canvas → PDF.
          const rect = canvas.getBoundingClientRect();
          const xCss = e.clientX - rect.left;
          const yCss = e.clientY - rect.top;
          // Canvas might be CSS-scaled ; project to canvas pixel coords.
          const xPx = xCss * (canvas.width / rect.width);
          const yPx = yCss * (canvas.height / rect.height);
          // Convert canvas px → PDF user-space points (viewport coords).
          const inv = viewport.convertToPdfPoint(xPx, yPx);
          const xPt = inv[0];
          const yPt = inv[1];
          // SyncTeX records use scaled points (1 pt = 65536 sp).
          const xSp = Math.round(xPt * 65536);
          const ySp = Math.round(yPt * 65536);
          onClickPage?.(p, xSp, ySp);
        });
        container.appendChild(canvas);
        await page.render({ canvasContext: canvas.getContext('2d')!, viewport, canvas }).promise;
        pages.push({ canvas, viewport, pageNum: p });
      }
      status = 'ready';
    } catch (e) {
      status = 'error';
      errMsg = e instanceof Error ? e.message : String(e);
    }
  }

  // Honour `#page=N` fragments the SyncTeX-forward path sets on
  // src ; scroll the canvas for page N into view after render.
  function scrollToPageFromFragment() {
    const m = /#page=(\d+)/.exec(src);
    if (!m) return;
    const target = pages.find(p => p.pageNum === Number(m[1]));
    if (target) target.canvas.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  $effect(() => {
    src;
    if (container) {
      void load().then(scrollToPageFromFragment);
    }
  });

  onDestroy(() => {
    void currentDoc?.destroy();
    currentDoc = null;
  });
</script>

<div class="pdf-viewer-wrap" data-testid="pdf-viewer">
  {#if status === 'loading'}
    <div class="opacity-60 text-xs p-4">Rendering PDF…</div>
  {:else if status === 'error'}
    <div class="text-error text-xs p-4">PDF render failed : {errMsg}</div>
  {/if}
  <div class="opacity-50 text-[10px] px-3 py-1 border-b border-base-300 bg-base-200/60">
    {pageCount} page{pageCount === 1 ? '' : 's'} · click on the PDF to jump back to the source line
  </div>
  <div bind:this={container} class="pdf-pages"></div>
</div>

<style>
  .pdf-viewer-wrap {
    display: flex;
    flex-direction: column;
    flex: 1;
    overflow: hidden;
    background: #2b2b2b;
  }
  .pdf-pages {
    flex: 1;
    overflow-y: auto;
    padding: 12px;
  }
</style>
