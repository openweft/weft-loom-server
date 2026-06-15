// uploadImage.ts — drag-drop + clipboard-paste helper for the
// LaTeX WYSIWYG surface.
//
// Two pieces :
//   - uploadImageFile : measures the image's natural dimensions
//     (via URL.createObjectURL + a hidden <img>), generates a
//     collision-resistant filename under figs/, PUTs the File
//     blob via writeFile(), then returns { path, width, height }.
//   - wireImageDrop : attaches dragover + drop listeners to a
//     contenteditable host, filters by file.type starting with
//     "image/", and invokes onInsert with the upload result + the
//     original DragEvent so the caller can place an <img> at the
//     drop point.
//
// The split is deliberate : the consumer (LatexWysiwygEditor)
// decides what HTML node to insert, this module only owns the
// upload + dimension-measurement plumbing.

import { writeFile } from './api';

export interface UploadImageResult {
  /** Path inside the project, suitable for \includegraphics{<path>}.
   *  E.g. "figs/dropped-1697045210.png". */
  path: string;
  /** Width × height in pixels of the uploaded image. Useful so the
   *  caller can emit \includegraphics[width=Xpx]{path} or similar. */
  width: number;
  height: number;
}

// Map MIME types to file extensions for files dropped without a
// usable filename (clipboard paste, e.g.). Falls back to .bin
// for the obscure cases — the caller can still display the file,
// the server doesn't sniff by extension.
const MIME_TO_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/svg+xml': '.svg',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

function extFromFile(file: File): string {
  const name = file.name ?? '';
  const dot = name.lastIndexOf('.');
  // Guard against ".hidden" files where the dot is the first char
  // — that's not an extension, that's a hidden file.
  if (dot > 0 && dot < name.length - 1) {
    return name.slice(dot).toLowerCase();
  }
  return MIME_TO_EXT[file.type] ?? '.bin';
}

// Measure image natural dimensions via a hidden <img>. We can't
// just trust width/height attributes — the browser only knows
// once it's actually decoded the blob.
function measureImage(file: File): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const w = img.naturalWidth || img.width || 0;
      const h = img.naturalHeight || img.height || 0;
      URL.revokeObjectURL(url);
      resolve({ width: w, height: h });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('failed to decode image for dimension measurement'));
    };
    img.src = url;
  });
}

export async function uploadImageFile(
  project: string,
  file: File,
): Promise<UploadImageResult> {
  const ext = extFromFile(file);
  // Date.now() alone collides on rapid double-drops (same ms) ;
  // the 4-char random suffix gives us ~1.7M combinations — plenty
  // for user-paced drag-drop in a single session.
  const rand = Math.random().toString(36).slice(2, 6);
  const path = `figs/dropped-${Date.now()}-${rand}${ext}`;

  // Measure FIRST so the result carries dimensions even if the
  // caller wants to emit \includegraphics[width=...] inline. The
  // PUT can't fail in a way that leaves us holding measurements
  // we can't use — failed PUT throws, the caller never sees them.
  const { width, height } = await measureImage(file);

  // File extends Blob, so writeFile's Blob path accepts it as-is.
  // contentType comes from the File itself ; the server stores
  // bytes opaquely so this is mostly for the response Content-Type
  // when figures get fetched back.
  await writeFile(project, path, file, file.type || 'application/octet-stream');

  return { path, width, height };
}

export function wireImageDrop(
  host: HTMLElement,
  project: string,
  onInsert: (result: UploadImageResult, dropEvent: DragEvent) => void,
): () => void {
  // dragover : preventDefault is REQUIRED for the drop event to
  // fire at all. Without it the browser falls back to its
  // default "navigate to the dropped file" behavior.
  function onDragOver(e: DragEvent) {
    // Only signal we accept the drop if the payload looks like
    // files — saves us from intercepting text drags from other
    // parts of the page.
    if (e.dataTransfer?.types.includes('Files')) {
      e.preventDefault();
    }
  }

  function onDrop(e: DragEvent) {
    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return;
    // Filter to image MIME types ; non-image drops (text, links,
    // arbitrary files) pass through to whatever else handles
    // them — we don't want to swallow a .tex drop, e.g.
    const images: File[] = [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      if (f && f.type && f.type.startsWith('image/')) images.push(f);
    }
    if (images.length === 0) return;
    e.preventDefault();
    // Upload each in parallel ; the onInsert callbacks fire in
    // whatever order the PUTs finish. The caller's expected to
    // be idempotent w.r.t. insertion order.
    for (const file of images) {
      uploadImageFile(project, file)
        .then((result) => onInsert(result, e))
        .catch((err) => {
          // Surface the failure via console — the caller can
          // wrap onInsert if they want toast notifications.
          // eslint-disable-next-line no-console
          console.error('uploadImageFile failed', err);
        });
    }
  }

  host.addEventListener('dragover', onDragOver);
  host.addEventListener('drop', onDrop);

  return () => {
    host.removeEventListener('dragover', onDragOver);
    host.removeEventListener('drop', onDrop);
  };
}
