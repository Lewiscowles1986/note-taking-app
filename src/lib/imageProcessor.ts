/**
 * Image processing utilities — lazily imported to avoid loading canvas logic
 * until an image is actually pasted/attached.
 */

/** Max thumbnail dimension for inline markdown preview */
const THUMB_MAX_DIM = 600;
/** JPEG quality for thumbnails */
const THUMB_QUALITY = 0.6;

export interface ProcessedImage {
  /** Small thumbnail data URL for inline markdown preview */
  thumbnailDataUrl: string;
  /** Original file as data URL (stored in attachment) */
  originalDataUrl: string;
  originalSize: number;
  thumbnailSize: number;
  width: number;
  height: number;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/**
 * Create a small JPEG thumbnail from an image element.
 */
function createThumbnail(img: HTMLImageElement, maxDim: number, quality: number): string {
  let { naturalWidth: w, naturalHeight: h } = img;

  // Always downscale to thumbnail size
  if (w > maxDim || h > maxDim) {
    const ratio = Math.min(maxDim / w, maxDim / h);
    w = Math.round(w * ratio);
    h = Math.round(h * ratio);
  }

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(img, 0, 0, w, h);

  return canvas.toDataURL('image/jpeg', quality);
}

/**
 * Process an image file:
 * - Creates a small thumbnail for the attachment record (used in viewer)
 * - Keeps the original data URL in the attachment
 * - Markdown only stores `attachment:<id>` — no data URL in content
 */
export async function processImage(file: File): Promise<ProcessedImage> {
  const originalDataUrl = await fileToDataUrl(file);
  const img = await loadImage(originalDataUrl);

  const thumbnailDataUrl = createThumbnail(img, THUMB_MAX_DIM, THUMB_QUALITY);

  return {
    thumbnailDataUrl,
    originalDataUrl,
    originalSize: file.size,
    thumbnailSize: thumbnailDataUrl.length,
    width: img.naturalWidth,
    height: img.naturalHeight,
  };
}
