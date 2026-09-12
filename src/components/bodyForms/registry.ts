/**
 * Body-form registry for SwaggerBlock's Try-it-out editor.
 *
 * Each media-type family gets its own editor component, lazy-imported like
 * the SwaggerBlock renderer itself, so the JSON editor (Shiki layer) is not
 * downloaded unless a JSON body is actually being authored — and file-backed
 * types get a dedicated picker instead of a textarea.
 */

export interface BodyFormProps {
  /** Current body text (for file forms: the serialized data URL or text). */
  value: string;
  /** The exact media type string from the spec. */
  mediaType: string;
  /** Shiki grammar appropriate for this media type. */
  lang: string;
  /** Unique test id base, e.g. `body-input-post:/pets`. */
  testId: string;
  onChange: (text: string) => void;
}

export type BodyFormComponent = React.ComponentType<BodyFormProps>;

type Loader = () => Promise<{ default: BodyFormComponent }>;

/**
 * Resolve the lazy-loaded form for a media type. JSON and text get
 * purpose-built editors; everything else (binary, images, unknown) falls
 * back to the file picker form, since those bodies are best supplied from
 * a real file.
 */
export function bodyFormFor(mediaType: string): Loader {
  if (/json/i.test(mediaType)) return () => import('./JsonBodyForm');
  if (/octet-stream|image\/|audio\/|video\/|pdf|zip|gzip|protobuf|msgpack/i.test(mediaType)) {
    return () => import('./FileBodyForm');
  }
  return () => import('./TextBodyForm');
}

/** True when the body is a serialized data URL produced by the file form. */
export function isDataUrlBody(value: string): boolean {
  return /^data:[^;]+;base64,/.test(value);
}

/**
 * Extract the fetch()-ready body from editor content. JSON/text forms hold
 * raw text; the file form holds a data URL that must be decoded before
 * sending so the wire format matches a real binary upload.
 */
export async function toWireBody(value: string, mediaType: string): Promise<string | undefined> {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (isDataUrlBody(trimmed)) {
    const base64 = trimmed.slice(trimmed.indexOf(',') + 1);
    try {
      // atob → binary string; browsers send it as-is for string bodies.
      return atob(base64);
    } catch {
      return undefined;
    }
  }
  return trimmed;
}