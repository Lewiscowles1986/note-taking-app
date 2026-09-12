import RequestBodyEditor from '../RequestBodyEditor';

/**
 * Plain-text body form (text/plain, XML, YAML, form-urlencoded…) — same
 * highlighted editor as JSON, with the grammar chosen by media type.
 */
export default function TextBodyForm({ value, lang, testId, onChange }: { value: string; lang: string; testId: string; onChange: (t: string) => void }) {
  return <RequestBodyEditor value={value} lang={lang} onChange={onChange} testId={testId} />;
}