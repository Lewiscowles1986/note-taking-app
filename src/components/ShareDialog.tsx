import { useState } from 'react';
import type { Note } from '@/lib/db';
import { buildShareUrl, encodeSharedNote, SHARE_URL_SOFT_LIMIT } from '@/lib/share';
import { Copy, Share2, TriangleAlert, X } from 'lucide-react';

interface ShareDialogProps {
  note: Note;
  onClose: () => void;
}

/**
 * Generates and presents a share link for a note.
 *
 * Encrypted notes: the link carries only the EncryptedPayload (ciphertext) —
 * safe to hand out; the recipient still needs the password / private key.
 * Unencrypted notes: the markdown itself is embedded in the URL, so the dialog
 * states that plainly before the user copies the link.
 */
export default function ShareDialog({ note, onClose }: ShareDialogProps) {
  const isEncrypted = !!note.encrypted;
  // For encrypted notes we can build the link immediately (ciphertext only).
  // Unencrypted notes wait for an explicit "create link" click so users see
  // the privacy warning first.
  const [url, setUrl] = useState<string | null>(isEncrypted ? buildUrl(note) : null);
  const [copied, setCopied] = useState(false);

  const tooLong = url !== null && url.length > SHARE_URL_SOFT_LIMIT;

  const createLink = () => setUrl(buildUrl(note));

  const copy = async () => {
    if (!url) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
      } else {
        // Fallback for non-secure contexts (e.g. http LAN testing).
        const ta = document.createElement('textarea');
        ta.value = url;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Copy failed — the URL stays visible so the user can select it manually.
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/20 backdrop-blur-sm">
      <div className="bg-card border border-border rounded-lg shadow-xl w-full max-w-md mx-4">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <div className="flex items-center gap-2">
            <Share2 size={16} className="text-primary" />
            <h3 className="font-semibold text-sm text-foreground">Share note</h3>
          </div>
          <button onClick={onClose} className="p-1 hover:bg-accent rounded transition-colors">
            <X size={16} className="text-muted-foreground" />
          </button>
        </div>

        <div className="p-4 space-y-4">
          {isEncrypted ? (
            <div className="text-xs bg-primary/10 text-primary rounded px-3 py-2">
              This note is <strong>encrypted</strong> — the link carries only the ciphertext.
              Anyone with the link can store it, but only holders of the password or key pair
              can read it. Share the credential through a different channel.
            </div>
          ) : (
            <div className="text-xs bg-amber-500/10 text-amber-700 dark:text-amber-400 rounded px-3 py-2 flex gap-2">
              <TriangleAlert size={14} className="shrink-0 mt-0.5" />
              <span>
                The note content will be embedded <strong>unencrypted</strong> in the link.
                Anyone who obtains the link can read it — treat the URL as the message itself.
              </span>
            </div>
          )}

          {url === null ? (
            <button
              onClick={createLink}
              className="w-full py-2 bg-primary text-primary-foreground rounded text-sm font-medium hover:opacity-90 transition-opacity"
            >
              Create share link
            </button>
          ) : (
            <>
              <div className="space-y-1.5">
                <label className="text-xs text-muted-foreground">Share link</label>
                <textarea
                  readOnly
                  value={url}
                  rows={3}
                  onFocus={(e) => e.currentTarget.select()}
                  className="w-full px-3 py-2 bg-muted rounded text-xs font-mono break-all outline-none resize-none focus:ring-1 focus:ring-ring"
                />
                {tooLong && (
                  <div className="text-[10px] text-muted-foreground">
                    {url.length} characters — some messengers or QR codes may truncate long URLs.
                    Consider exporting the note as a file instead.
                  </div>
                )}
              </div>
              <button
                onClick={copy}
                className="w-full flex items-center justify-center gap-1.5 py-2 bg-primary text-primary-foreground rounded text-sm font-medium hover:opacity-90 transition-opacity"
              >
                <Copy size={14} />
                {copied ? 'Copied!' : 'Copy link'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function buildUrl(note: Note): string {
  return buildShareUrl(encodeSharedNote(note));
}