import { afterEach, describe, expect, it, vi } from 'vitest';
import { processImage } from '@/lib/imageProcessor';

/**
 * jsdom has no image decoder and no canvas 2D context, so processImage is
 * driven through test-local stand-ins:
 *  - FakeImage replaces the global `Image` and "decodes" asynchronously from
 *    a per-test spec (natural dimensions, or a failure).
 *  - document.createElement('canvas') returns a fake canvas whose 2D context
 *    and toDataURL are vi.fn()s; every other tag passes through to jsdom.
 *  - The real jsdom FileReader reads a genuine File, so fileToDataUrl runs
 *    its actual implementation.
 */

/** Real PNG magic bytes — readAsDataURL yields data:image/png;base64,iVBORw==. */
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const PNG_DATA_URL = 'data:image/png;base64,iVBORw==';
const THUMB_DATA_URL = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';

type DecodeSpec = { decode: 'ok' | 'fail'; width: number; height: number };

let decodeSpec: DecodeSpec = { decode: 'ok', width: 0, height: 0 };
const createdImages: FakeImage[] = [];
/** Most recently constructed FakeImage (the one loadImage decoded last). */
const lastImage = (): FakeImage | undefined => createdImages[createdImages.length - 1];

class FakeImage {
  onload: (() => void) | null = null;
  onerror: ((err: unknown) => void) | null = null;
  naturalWidth = 0;
  naturalHeight = 0;
  private srcValue = '';

  constructor() {
    createdImages.push(this);
  }

  get src(): string {
    return this.srcValue;
  }

  set src(value: string) {
    this.srcValue = value;
    // Real browsers decode asynchronously; loadImage assigns onload/onerror
    // before setting src, so a microtask is enough to observe load/error.
    queueMicrotask(() => {
      if (decodeSpec.decode === 'fail') {
        this.onerror?.(new Error('mock image decode failure'));
        return;
      }
      this.naturalWidth = decodeSpec.width;
      this.naturalHeight = decodeSpec.height;
      this.onload?.();
    });
  }
}

/** Replaces jsdom's FileReader for the read-failure test. */
class FailingFileReader {
  onload: (() => void) | null = null;
  onerror: ((err: unknown) => void) | null = null;
  readAsDataURL(): void {
    queueMicrotask(() => this.onerror?.(new Error('mock FileReader failure')));
  }
}

function pasteFile(): File {
  return new File([PNG_BYTES], 'paste.png', { type: 'image/png' });
}

/** Stub Image + canvas for one test; returns the fake canvas/context handles. */
function stubImagePipeline(spec: DecodeSpec) {
  decodeSpec = spec;
  vi.stubGlobal('Image', FakeImage);

  const ctx = { drawImage: vi.fn() };
  const canvas = {
    width: 0,
    height: 0,
    getContext: vi.fn(() => ctx),
    toDataURL: vi.fn(() => THUMB_DATA_URL),
  };

  const originalCreateElement = document.createElement.bind(document);
  const spy = vi.spyOn(document, 'createElement');
  spy.mockImplementation(((tagName: string, options?: ElementCreationOptions) => {
    if (tagName === 'canvas') return canvas as unknown as HTMLCanvasElement;
    return originalCreateElement(tagName, options);
  }) as typeof document.createElement);

  return { canvas, ctx };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  createdImages.length = 0;
});

describe('processImage', () => {
  it('passes a small image through without downscaling', async () => {
    const { canvas, ctx } = stubImagePipeline({ decode: 'ok', width: 320, height: 200 });
    const file = pasteFile();

    const result = await processImage(file);

    expect(result.originalDataUrl).toBe(PNG_DATA_URL);
    expect(result.originalSize).toBe(PNG_BYTES.length);
    expect(result.width).toBe(320);
    expect(result.height).toBe(200);
    expect(result.thumbnailDataUrl).toBe(THUMB_DATA_URL);
    expect(result.thumbnailSize).toBe(THUMB_DATA_URL.length);
    // The decoded image element received the FileReader data URL.
    expect(lastImage()?.src).toBe(PNG_DATA_URL);
    expect(canvas.width).toBe(320);
    expect(canvas.height).toBe(200);
    expect(canvas.getContext).toHaveBeenCalledWith('2d');
    expect(ctx.drawImage).toHaveBeenCalledWith(lastImage(), 0, 0, 320, 200);
    expect(canvas.toDataURL).toHaveBeenCalledWith('image/jpeg', 0.6);
  });

  it('downscales a wide image to the 600px thumbnail limit', async () => {
    const { canvas, ctx } = stubImagePipeline({ decode: 'ok', width: 1200, height: 300 });

    const result = await processImage(pasteFile());

    // ratio = min(600/1200, 600/300) = 0.5 → 600×150
    expect(canvas.width).toBe(600);
    expect(canvas.height).toBe(150);
    expect(ctx.drawImage).toHaveBeenCalledWith(lastImage(), 0, 0, 600, 150);
    // The reported dimensions stay natural, not thumbnail-sized.
    expect(result.width).toBe(1200);
    expect(result.height).toBe(300);
  });

  it('downscales a tall image via the height side of the size check', async () => {
    const { canvas, ctx } = stubImagePipeline({ decode: 'ok', width: 300, height: 1200 });

    await processImage(pasteFile());

    // ratio = min(600/300, 600/1200) = 0.5 → 150×600
    expect(canvas.width).toBe(150);
    expect(canvas.height).toBe(600);
    expect(ctx.drawImage).toHaveBeenCalledWith(lastImage(), 0, 0, 150, 600);
  });

  it('keeps an image at exactly the thumbnail limit unscaled', async () => {
    const { canvas, ctx } = stubImagePipeline({ decode: 'ok', width: 600, height: 600 });

    await processImage(pasteFile());

    // Strict `>` comparison: 600 is not downscaled.
    expect(canvas.width).toBe(600);
    expect(canvas.height).toBe(600);
    expect(ctx.drawImage).toHaveBeenCalledWith(lastImage(), 0, 0, 600, 600);
  });

  it('rounds downscaled dimensions', async () => {
    const { canvas, ctx } = stubImagePipeline({ decode: 'ok', width: 1000, height: 999 });

    await processImage(pasteFile());

    // ratio = min(600/1000, 600/999) = 0.6 → 600×round(599.4)=599
    expect(canvas.width).toBe(600);
    expect(canvas.height).toBe(599);
    expect(ctx.drawImage).toHaveBeenCalledWith(lastImage(), 0, 0, 600, 599);
  });

  it('rejects when the image fails to decode', async () => {
    const { canvas, ctx } = stubImagePipeline({ decode: 'fail', width: 0, height: 0 });

    await expect(processImage(pasteFile())).rejects.toThrow('mock image decode failure');
    expect(ctx.drawImage).not.toHaveBeenCalled();
    expect(canvas.toDataURL).not.toHaveBeenCalled();
  });

  it('rejects when reading the file fails', async () => {
    stubImagePipeline({ decode: 'ok', width: 10, height: 10 });
    vi.stubGlobal('FileReader', FailingFileReader);

    await expect(processImage(pasteFile())).rejects.toThrow('mock FileReader failure');
  });
});