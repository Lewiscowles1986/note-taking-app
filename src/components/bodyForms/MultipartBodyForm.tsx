import { useRef, useState } from 'react';
import { parseMultipartFields, serializeMultipartFields, type MultipartField } from './registry';

/**
 * Multipart/form-data body form: named fields, each either a text input or a
 * file picker — mirroring how real clients author multipart uploads. The
 * stored value is serialized field state; toWireBody() converts it to a real
 * FormData at send time so the browser generates the boundary.
 */
export default function MultipartBodyForm({
  value,
  mediaType,
  testId,
  onChange,
}: {
  value: string;
  mediaType: string;
  testId: string;
  onChange: (t: string) => void;
}) {
  const initial = parseMultipartFields(value) || [{ id: 0, name: '', kind: 'text' as const, text: '' }];
  const [fields, setFields] = useState<MultipartField[]>(initial);
  const nextId = useRef(initial.length);
  const fileInputs = useRef<Record<number, HTMLInputElement | null>>({});
  const shortId = testId.replace('body-input-', '');

  const update = (next: MultipartField[]) => {
    setFields(next);
    // Strip the ephemeral row ids from the serialized draft — parse
    // regenerates them from array order anyway.
    onChange(serializeMultipartFields(next.map(({ id: _id, ...rest }) => rest)));
  };

  const setField = (id: number, patch: Partial<MultipartField>) =>
    update(fields.map((f) => (f.id === id ? { ...f, ...patch } : f)));

  const addField = () =>
    update([...fields, { id: nextId.current++, name: '', kind: 'text' as const, text: '' }]);

  const removeField = (id: number) => update(fields.filter((f) => f.id !== id));

  return (
    <div
      className="p-3 rounded bg-[#24292e] min-h-[76px] flex flex-col gap-2"
      data-testid={`body-editor-${shortId}`}
    >
      {fields.map((field) => (
        <div key={field.id} className="flex items-center gap-2">
          <input
            value={field.name}
            onChange={(e) => setField(field.id, { name: e.target.value })}
            placeholder="field name"
            spellCheck={false}
            data-testid={`multipart-name-${shortId}-${field.id}`}
            className="w-36 bg-transparent border border-white/15 rounded px-1.5 py-1 text-[11px] font-mono text-white/90 focus:outline-none focus:border-emerald-500/60"
          />
          <span className="text-white/30 text-xs">=</span>
          {field.kind === 'text' ? (
            <input
              value={field.text}
              onChange={(e) => setField(field.id, { text: e.target.value })}
              placeholder="value"
              spellCheck={false}
              data-testid={`multipart-value-${shortId}-${field.id}`}
              className="flex-1 bg-transparent border border-white/15 rounded px-1.5 py-1 text-[11px] font-mono text-white/90 focus:outline-none focus:border-emerald-500/60"
            />
          ) : (
            <span className="flex-1 text-[11px] font-mono text-emerald-300" data-testid={`multipart-file-${shortId}-${field.id}`}>
              {field.fileName || 'no file chosen'}
            </span>
          )}
          <select
            value={field.kind}
            onChange={(e) => setField(field.id, { kind: e.target.value as 'text' | 'file', text: '', fileName: undefined })}
            className="bg-[#24292e] border border-white/15 rounded px-1 py-0.5 text-[10px] font-mono text-white/70"
            data-testid={`multipart-kind-${shortId}-${field.id}`}
          >
            <option value="text">text</option>
            <option value="file">file</option>
          </select>
          {field.kind === 'file' && (
            <>
              <input
                ref={(el) => {
                  if (el) fileInputs.current[field.id] = el;
                }}
                type="file"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  const reader = new FileReader();
                  reader.onload = () =>
                    setField(field.id, { text: reader.result as string, fileName: file.name });
                  reader.readAsDataURL(file);
                }}
              />
              <button
                onClick={() => fileInputs.current[field.id]?.click()}
                className="px-1.5 py-0.5 text-[10px] font-mono rounded bg-white/10 text-white hover:bg-white/20 transition-colors"
                data-testid={`multipart-choose-${shortId}-${field.id}`}
              >
                Choose
              </button>
            </>
          )}
          <button
            onClick={() => removeField(field.id)}
            className="px-1.5 py-0.5 text-[10px] font-mono rounded text-red-300/70 hover:text-red-300 transition-colors"
            title="Remove field"
          >
            ✕
          </button>
        </div>
      ))}
      <button
        onClick={addField}
        className="self-start px-2 py-0.5 text-[10px] font-mono rounded bg-white/10 text-white hover:bg-white/20 transition-colors"
        data-testid={`multipart-add-${shortId}`}
      >
        + Add field
      </button>
    </div>
  );
}