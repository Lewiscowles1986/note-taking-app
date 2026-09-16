import { useEffect, useRef, useState } from 'react';

/**
 * File-backed body form for binary media types (octet-stream, images, pdf,
 * archives…). A file picker reads the chosen file as a data URL; the wire
 * body is decoded from it at send time by the registry's toWireBody().
 * Also shows the file's name and size after selection.
 */
export default function FileBodyForm({
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
  const inputRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState('');
  const [fileSize, setFileSize] = useState(0);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!value) {
      setFileName('');
      setFileSize(0);
    }
  }, [value]);

  const pick = async (file: File) => {
    setError('');
    if (file.size > 10 * 1024 * 1024) {
      setError('File exceeds the 10 MB request-body limit');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setFileName(file.name);
      setFileSize(file.size);
      onChange(reader.result as string);
    };
    reader.onerror = () => setError('Could not read the file');
    reader.readAsDataURL(file);
  };

  return (
    <div
      className="p-3 rounded bg-[#24292e] min-h-[76px] flex flex-col items-start gap-2"
      data-testid={`body-editor-${testId.replace('body-input-', '')}`}
    >
      <input
        ref={inputRef}
        type="file"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) pick(f);
        }}
        data-testid={`body-file-${testId.replace('body-input-', '')}`}
      />
      <button
        onClick={() => inputRef.current?.click()}
        className="flex items-center gap-1.5 px-2.5 py-1 text-xs rounded bg-white/10 text-white hover:bg-white/20 transition-colors"
        data-testid={`${testId.replace('body-input-', 'body-choose-')}`}
      >
        Choose file…
      </button>
      <div className="text-[11px] font-mono">
        {fileName ? (
          <span className="text-emerald-300" data-testid={`body-file-info-${testId.replace('body-input-', '')}`}>
            {fileName} ({(fileSize / 1024).toFixed(1)} KB) → sent as {mediaType}
          </span>
        ) : (
          <span className="text-white/30">
            No file selected — body will be sent as {mediaType}
          </span>
        )}
      </div>
      {error && <div className="text-[11px] font-mono text-red-300">{error}</div>}
    </div>
  );
}