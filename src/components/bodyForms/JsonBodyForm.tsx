import RequestBodyEditor from '../RequestBodyEditor';

/**
 * JSON body form: the full Shiki-highlighted editor (transparent textarea
 * over a live-highlighted layer).
 */
export default function JsonBodyForm({ value, lang, testId, onChange }: { value: string; lang: string; testId: string; onChange: (t: string) => void }) {
  return <RequestBodyEditor value={value} lang={lang} onChange={onChange} testId={testId} />;
}