import { lazy, Suspense, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { sharedNoteFromSearchParams, type SharedNote } from '@/lib/share';
import { createNote, detectContentFeatures } from '@/lib/db';
import { decryptWithPassword } from '@/lib/crypto';
import { Shield, Download, Eye, ArrowLeft, Lock, AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';

// The full markdown pipeline (~300 KB minified) is only needed when the
// recipient previews the note, so keep it out of the share route's initial cost.
const NoteViewer = lazy(() => import('@/components/NoteViewer'));

/**
 * Receiver for `/?note=<base64url>` share links.
 *
 * Shows what the link contains before anything is stored, and only writes to
 * the local database after an explicit "Save to my notes" action. Encrypted
 * notes stay locked — the recipient can optionally decrypt to preview with a
 * password (in memory only), but the note is saved in its encrypted form
 * regardless.
 */
export default function ShareView() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [importing, setImporting] = useState(false);
  const [previewPlaintext, setPreviewPlaintext] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [decrypting, setDecrypting] = useState(false);
  const [decryptError, setDecryptError] = useState<string | null>(null);

  // Parse the share payload during render (URL params are immutable for a
  // given navigation, so this is stable). Errors surface synchronously.
  const { shared, error } = useMemo(() => {
    try {
      return { shared: sharedNoteFromSearchParams(searchParams), error: null };
    } catch (e) {
      return { shared: null, error: e instanceof Error ? e.message : 'Invalid share link' };
    }
  }, [searchParams]);

  const isEncrypted = shared?.encrypted ?? false;
  const canPreview = !isEncrypted;

  // Plaintext preview for unencrypted notes comes straight from the envelope.
  const previewContent = useMemo(() => {
    if (isEncrypted) return previewPlaintext;
    return shared?.content ?? '';
  }, [shared, isEncrypted, previewPlaintext]);

  const previewNote = useMemo(
    () =>
      shared && previewContent !== null
        ? {
            id: 0,
            title: shared.title,
            content: previewContent,
            tags: shared.tags,
            category: shared.category,
            attachments: [],
            createdAt: new Date(),
            updatedAt: new Date(),
            editDates: [],
            pinned: false,
            encrypted: null,
          }
        : null,
    [shared, previewContent],
  );

  const handleDecryptPreview = async () => {
    if (!shared?.payload || !password) return;
    setDecrypting(true);
    setDecryptError(null);
    try {
      const plaintext = await decryptWithPassword(shared.payload, password);
      setPreviewPlaintext(plaintext);
    } catch {
      setDecryptError('Decryption failed — wrong password or corrupted link?');
    } finally {
      setDecrypting(false);
    }
  };

  const handleImport = async () => {
    if (!shared) return;
    setImporting(true);
    try {
      if (isEncrypted && shared.payload) {
        // Store exactly like a locally-encrypted note: ciphertext only.
        const features = { hasCodeBlocks: false, hasMermaid: false, hasGeoJson: false, hasModel3D: false };
        const id = await createNote({
          title: shared.title,
          content: '[encrypted]',
          tags: shared.tags,
          category: shared.category,
          encrypted: shared.payload,
          ...features,
        });
        toast.success('Encrypted note saved — locked until you unlock it');
        navigate(`/?open=${id}`);
      } else if (!isEncrypted && shared.content !== null) {
        const features = detectContentFeatures(shared.content);
        const id = await createNote({
          title: shared.title,
          content: shared.content,
          tags: shared.tags,
          category: shared.category,
          ...features,
        });
        toast.success('Note saved to your device');
        navigate(`/?open=${id}`);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to save shared note');
    } finally {
      setImporting(false);
    }
  };

  if (error) {
    return (
      <div className="min-h-dvh flex items-center justify-center bg-background p-6">
        <div className="text-center max-w-md">
          <AlertTriangle size={40} className="mx-auto mb-4 text-destructive" />
          <h1 className="text-lg font-semibold text-foreground mb-2">Invalid share link</h1>
          <p className="text-sm text-muted-foreground mb-6">{error}</p>
          <button
            onClick={() => navigate('/')}
            className="px-4 py-2.5 min-h-11 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:opacity-90 sm:py-2 sm:min-h-0"
          >
            Go to my notes
          </button>
        </div>
      </div>
    );
  }

  if (!shared) {
    return (
      <div className="min-h-dvh flex items-center justify-center bg-background">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="min-h-dvh bg-background flex flex-col">
      <div className="px-4 py-3 pt-[calc(env(safe-area-inset-top,0px)_+_0.75rem)] border-b border-border bg-card flex items-center gap-2">
        <button
          onClick={() => navigate('/')}
          className="p-2.5 min-w-11 min-h-11 flex items-center justify-center rounded-md hover:bg-accent text-muted-foreground transition-colors sm:min-w-min sm:min-h-min sm:p-1.5"
          title="Back to notes"
        >
          <ArrowLeft size={18} />
        </button>
        <Shield size={16} className="text-primary" />
        <span className="text-sm font-medium text-foreground">Shared note</span>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-2xl mx-auto p-4 space-y-4">
          {/* What is in this link */}
          <div className="rounded-lg border border-border bg-card p-4 space-y-2">
            <div className="flex items-center gap-2">
              {isEncrypted ? <Lock size={14} className="text-primary" /> : <Eye size={14} className="text-muted-foreground" />}
              <h2 className="text-sm font-semibold text-foreground truncate">{shared.title}</h2>
            </div>
            <div className="text-xs text-muted-foreground">
              Category: {shared.category}
              {shared.tags.length > 0 && ` · Tags: ${shared.tags.join(', ')}`}
            </div>
            {isEncrypted ? (
              <div className="text-xs bg-primary/10 text-primary rounded px-3 py-2">
                This note is <strong>encrypted</strong> — the link carries only ciphertext.
                Save it, then unlock it with the password or key pair the sender used.
                {shared.payload?.method === 'password' && ' (Password-encrypted)'}
                {shared.payload?.method === 'keypair' && shared.payload.keyFingerprint && (
                  <> Key fingerprint: <span className="font-mono">{shared.payload.keyFingerprint}</span>.</>
                )}
              </div>
            ) : (
              <div className="text-xs bg-amber-500/10 text-amber-700 dark:text-amber-400 rounded px-3 py-2">
                This link contains the note content in <strong>plain text</strong>. Only open
                links from people you trust.
              </div>
            )}
          </div>

          {/* Preview (plaintext only; never auto-renders unknown link content before consent) */}
          {previewNote && (
            <div className="rounded-lg border border-border bg-card overflow-hidden">
              <div className="px-4 py-2 border-b border-border text-xs font-medium text-muted-foreground">
                Preview
              </div>
              <div className="max-h-72 overflow-y-auto">
                <Suspense
                  fallback={
                    <div className="flex items-center justify-center p-6">
                      <div className="h-6 w-6 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
                    </div>
                  }
                >
                  <NoteViewer note={previewNote} onSave={() => {}} />
                </Suspense>
              </div>
            </div>
          )}

          {/* Optional decrypt-to-preview for encrypted links */}
          {isEncrypted && !previewPlaintext && shared.payload?.method === 'password' && (
            <div className="rounded-lg border border-border bg-card p-4 space-y-2">
              <div className="text-xs font-medium text-muted-foreground">Optional: preview before saving</div>
              <div className="flex gap-2">
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleDecryptPreview()}
                  placeholder="Password (kept in memory only)"
                  className="flex-1 px-3 py-2 bg-muted rounded text-sm outline-none focus:ring-1 focus:ring-ring"
                />
                <button
                  onClick={handleDecryptPreview}
                  disabled={decrypting || !password}
                  className="px-3 py-2 min-h-11 rounded text-xs font-medium bg-muted text-foreground hover:bg-accent disabled:opacity-50 sm:min-h-0"
                >
                  {decrypting ? 'Decrypting…' : 'Preview'}
                </button>
              </div>
              {decryptError && <div className="text-xs text-destructive">{decryptError}</div>}
            </div>
          )}
        </div>
      </div>

      {/* Action bar */}
      <div className="border-t border-border bg-card px-4 py-3 pb-[calc(env(safe-area-inset-bottom,0px)_+_0.75rem)] flex gap-2">
        <button
          onClick={() => navigate('/')}
          className="px-3 py-2.5 min-h-11 rounded text-xs font-medium text-muted-foreground hover:text-foreground sm:py-1.5 sm:min-h-0"
        >
          Discard
        </button>
        <button
          onClick={handleImport}
          disabled={importing}
          className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2.5 min-h-11 bg-primary text-primary-foreground rounded text-sm font-medium hover:opacity-90 disabled:opacity-50 sm:py-2 sm:min-h-0"
        >
          <Download size={14} />
          {importing ? 'Saving…' : isEncrypted ? 'Save encrypted note' : 'Save to my notes'}
        </button>
      </div>
    </div>
  );
}