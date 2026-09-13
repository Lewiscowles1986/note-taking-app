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
  if (/multipart\//i.test(mediaType)) return () => import('./MultipartBodyForm');
  if (/octet-stream|image\/|audio\/|video\/|pdf|zip|gzip|protobuf|msgpack/i.test(mediaType)) {
    return () => import('./FileBodyForm');
  }
  return () => import('./TextBodyForm');
}

/** True when the body is a serialized data URL produced by the file form. */
export function isDataUrlBody(value: string): boolean {
  return /^data:[^;]+;base64,/.test(value);
}

export interface MultipartField {
  id: number;
  name: string;
  kind: 'text' | 'file';
  /** Text value, or a data URL for file fields. */
  text: string;
  /** Original file name for file fields (display only). */
  fileName?: string;
}

/**
 * Serialize multipart fields into the string stored in the body draft.
 * Opaque to the editor; decoded by parseMultipartFields() at render and
 * toWireBody() at send time.
 */
export function serializeMultipartFields(fields: Omit<MultipartField, 'id'>[]): string {
  return JSON.stringify({ __multipart__: fields });
}

/** Parse editor content back into fields; null when it isn't multipart state. */
export function parseMultipartFields(value: string): MultipartField[] | null {
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.__multipart__)) {
      return (parsed.__multipart__ as Omit<MultipartField, 'id'>[]).map((f, i) => ({
        ...f,
        id: i,
      }));
    }
  } catch {
    /* not multipart state */
  }
  return null;
}

/**
 * Extract the fetch()-ready body from editor content. JSON/text forms hold
 * raw text; the file form holds a data URL that must be decoded before
 * sending so the wire format matches a real binary upload; the multipart
 * form holds serialized field state that becomes a real FormData (so the
 * browser generates the boundary and encodes files natively).
 */
export async function toWireBody(
  value: string,
  mediaType: string
): Promise<string | FormData | undefined> {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (/multipart\//i.test(mediaType)) {
    const fields = parseMultipartFields(trimmed);
    if (!fields) return undefined;
    const form = new FormData();
    for (const field of fields) {
      if (!field.name) continue;
      if (field.kind === 'file' && isDataUrlBody(field.text)) {
        const base64 = field.text.slice(field.text.indexOf(',') + 1);
        const bytes = atob(base64);
        const bytesArr = Uint8Array.from(bytes, (c) => c.charCodeAt(0));
        form.append(field.name, new Blob([bytesArr]), field.fileName || 'file');
      } else if (field.kind === 'text') {
        form.append(field.name, field.text);
      }
    }
    return form;
  }
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