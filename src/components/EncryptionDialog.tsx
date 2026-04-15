import { useState } from 'react';
import type { Note } from '@/lib/db';
import type { StoredKeyPair, EncryptedPayload } from '@/lib/crypto';
import {
  Lock,
  Unlock,
  Key,
  KeyRound,
  Shield,
  Download,
  Upload,
  Trash2,
  Plus,
  X,
  Eye,
  EyeOff,
} from 'lucide-react';

interface EncryptionDialogProps {
  note: Note;
  keyPairs: StoredKeyPair[];
  onEncrypt: (method: 'password' | 'keypair', credential: string | StoredKeyPair) => Promise<void>;
  onDecrypt: (credential: string) => Promise<void>;
  onGenerateKeyPair: (name: string) => Promise<StoredKeyPair>;
  onImportKeys: (name: string, data: string) => Promise<void>;
  onExportKeys: (kp: StoredKeyPair, format: 'jwk' | 'pem') => Promise<void>;
  onDeleteKeyPair: (id: string) => Promise<void>;
  onClose: () => void;
}

export default function EncryptionDialog({
  note,
  keyPairs,
  onEncrypt,
  onDecrypt,
  onGenerateKeyPair,
  onImportKeys,
  onExportKeys,
  onDeleteKeyPair,
  onClose,
}: EncryptionDialogProps) {
  const isEncrypted = !!note.encrypted;
  const [tab, setTab] = useState<'encrypt' | 'keys'>(isEncrypted ? 'encrypt' : 'encrypt');
  const [method, setMethod] = useState<'password' | 'keypair'>('password');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [selectedKeyId, setSelectedKeyId] = useState(keyPairs[0]?.id || '');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  // Key management
  const [newKeyName, setNewKeyName] = useState('');
  const [generatingKey, setGeneratingKey] = useState(false);
  const [importMode, setImportMode] = useState(false);
  const [importName, setImportName] = useState('');
  const [importData, setImportData] = useState('');

  const handleEncrypt = async () => {
    setError('');
    if (method === 'password') {
      if (!password) { setError('Password is required'); return; }
      if (password !== confirmPassword) { setError('Passwords do not match'); return; }
      if (password.length < 8) { setError('Password must be at least 8 characters'); return; }
    } else {
      if (!selectedKeyId) { setError('Select a key pair'); return; }
    }

    setLoading(true);
    try {
      if (method === 'password') {
        await onEncrypt('password', password);
      } else {
        const kp = keyPairs.find((k) => k.id === selectedKeyId)!;
        await onEncrypt('keypair', kp);
      }
      onClose();
    } catch (e: any) {
      setError(e.message || 'Encryption failed');
    } finally {
      setLoading(false);
    }
  };

  const handleDecrypt = async () => {
    setError('');
    if (!password && note.encrypted?.method === 'password') {
      setError('Password is required');
      return;
    }
    setLoading(true);
    try {
      await onDecrypt(password);
      onClose();
    } catch (e: any) {
      setError(e.message || 'Decryption failed — wrong password or key?');
    } finally {
      setLoading(false);
    }
  };

  const handleGenerate = async () => {
    if (!newKeyName.trim()) return;
    setGeneratingKey(true);
    try {
      await onGenerateKeyPair(newKeyName.trim());
      setNewKeyName('');
    } finally {
      setGeneratingKey(false);
    }
  };

  const handleImport = async () => {
    if (!importName.trim() || !importData.trim()) return;
    setLoading(true);
    try {
      await onImportKeys(importName.trim(), importData.trim());
      setImportMode(false);
      setImportName('');
      setImportData('');
    } catch (e: any) {
      setError(e.message || 'Import failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/20 backdrop-blur-sm">
      <div className="bg-card border border-border rounded-lg shadow-xl w-full max-w-md mx-4">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <div className="flex items-center gap-2">
            <Shield size={16} className="text-primary" />
            <h3 className="font-semibold text-sm text-foreground">Note Encryption</h3>
          </div>
          <button onClick={onClose} className="p-1 hover:bg-accent rounded transition-colors">
            <X size={16} className="text-muted-foreground" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-border">
          <button
            onClick={() => setTab('encrypt')}
            className={`flex-1 px-4 py-2 text-xs font-medium transition-colors ${
              tab === 'encrypt'
                ? 'text-primary border-b-2 border-primary'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {isEncrypted ? 'Decrypt' : 'Encrypt'}
          </button>
          <button
            onClick={() => setTab('keys')}
            className={`flex-1 px-4 py-2 text-xs font-medium transition-colors ${
              tab === 'keys'
                ? 'text-primary border-b-2 border-primary'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            Key Pairs
          </button>
        </div>

        <div className="p-4 space-y-4 max-h-[60vh] overflow-y-auto">
          {error && (
            <div className="text-xs text-destructive bg-destructive/10 px-3 py-2 rounded">
              {error}
            </div>
          )}

          {tab === 'encrypt' && (
            <>
              {isEncrypted ? (
                /* ─── Decrypt UI ─── */
                <div className="space-y-3">
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Lock size={12} />
                    Encrypted with{' '}
                    <span className="font-medium text-foreground">
                      {note.encrypted?.method === 'password' ? 'password' : 'key pair'}
                    </span>
                    {note.encrypted?.keyFingerprint && (
                      <span className="font-mono text-[10px] text-muted-foreground">
                        ({note.encrypted.keyFingerprint})
                      </span>
                    )}
                  </div>
                  {note.encrypted?.method === 'password' ? (
                    <div className="space-y-2">
                      <label className="text-xs text-muted-foreground">Password</label>
                      <div className="relative">
                        <input
                          type={showPassword ? 'text' : 'password'}
                          value={password}
                          onChange={(e) => setPassword(e.target.value)}
                          onKeyDown={(e) => e.key === 'Enter' && handleDecrypt()}
                          className="w-full px-3 py-2 pr-8 bg-muted rounded text-sm outline-none focus:ring-1 focus:ring-ring"
                          placeholder="Enter password"
                          autoFocus
                        />
                        <button
                          onClick={() => setShowPassword(!showPassword)}
                          className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground"
                        >
                          {showPassword ? <EyeOff size={14} /> : <Eye size={14} />}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      This will decrypt using the matching private key stored in your browser.
                    </p>
                  )}
                  <button
                    onClick={handleDecrypt}
                    disabled={loading}
                    className="w-full py-2 bg-primary text-primary-foreground rounded text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
                  >
                    {loading ? 'Decrypting…' : 'Decrypt Note'}
                  </button>
                </div>
              ) : (
                /* ─── Encrypt UI ─── */
                <div className="space-y-3">
                  {/* Method selector */}
                  <div className="flex gap-2">
                    <button
                      onClick={() => setMethod('password')}
                      className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded text-xs font-medium transition-colors ${
                        method === 'password'
                          ? 'bg-primary text-primary-foreground'
                          : 'bg-muted text-muted-foreground hover:text-foreground'
                      }`}
                    >
                      <KeyRound size={12} />
                      Password
                    </button>
                    <button
                      onClick={() => setMethod('keypair')}
                      className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded text-xs font-medium transition-colors ${
                        method === 'keypair'
                          ? 'bg-primary text-primary-foreground'
                          : 'bg-muted text-muted-foreground hover:text-foreground'
                      }`}
                    >
                      <Key size={12} />
                      Key Pair
                    </button>
                  </div>

                  {method === 'password' ? (
                    <div className="space-y-2">
                      <div>
                        <label className="text-xs text-muted-foreground">Password</label>
                        <div className="relative">
                          <input
                            type={showPassword ? 'text' : 'password'}
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            className="w-full px-3 py-2 pr-8 bg-muted rounded text-sm outline-none focus:ring-1 focus:ring-ring"
                            placeholder="Min 8 characters"
                          />
                          <button
                            onClick={() => setShowPassword(!showPassword)}
                            className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground"
                          >
                            {showPassword ? <EyeOff size={14} /> : <Eye size={14} />}
                          </button>
                        </div>
                      </div>
                      <div>
                        <label className="text-xs text-muted-foreground">Confirm password</label>
                        <input
                          type={showPassword ? 'text' : 'password'}
                          value={confirmPassword}
                          onChange={(e) => setConfirmPassword(e.target.value)}
                          className="w-full px-3 py-2 bg-muted rounded text-sm outline-none focus:ring-1 focus:ring-ring"
                          placeholder="Confirm password"
                        />
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <label className="text-xs text-muted-foreground">Select key pair</label>
                      {keyPairs.length === 0 ? (
                        <p className="text-xs text-muted-foreground italic">
                          No key pairs yet. Go to the Key Pairs tab to generate one.
                        </p>
                      ) : (
                        <select
                          value={selectedKeyId}
                          onChange={(e) => setSelectedKeyId(e.target.value)}
                          className="w-full px-3 py-2 bg-muted rounded text-sm outline-none focus:ring-1 focus:ring-ring"
                        >
                          {keyPairs.map((kp) => (
                            <option key={kp.id} value={kp.id}>
                              {kp.name} ({kp.fingerprint})
                            </option>
                          ))}
                        </select>
                      )}
                    </div>
                  )}

                  <button
                    onClick={handleEncrypt}
                    disabled={loading}
                    className="w-full py-2 bg-primary text-primary-foreground rounded text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
                  >
                    {loading ? 'Encrypting…' : 'Encrypt Note'}
                  </button>
                </div>
              )}
            </>
          )}

          {tab === 'keys' && (
            <div className="space-y-3">
              {/* Generate new key */}
              <div className="flex gap-2">
                <input
                  value={newKeyName}
                  onChange={(e) => setNewKeyName(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleGenerate()}
                  placeholder="Key pair name"
                  className="flex-1 px-3 py-2 bg-muted rounded text-sm outline-none focus:ring-1 focus:ring-ring"
                />
                <button
                  onClick={handleGenerate}
                  disabled={generatingKey || !newKeyName.trim()}
                  className="px-3 py-2 bg-primary text-primary-foreground rounded text-xs font-medium hover:opacity-90 disabled:opacity-50 flex items-center gap-1"
                >
                  <Plus size={12} />
                  {generatingKey ? 'Generating…' : 'Generate'}
                </button>
              </div>

              {/* Import */}
              {importMode ? (
                <div className="space-y-2 p-3 border border-border rounded">
                  <input
                    value={importName}
                    onChange={(e) => setImportName(e.target.value)}
                    placeholder="Name for imported key"
                    className="w-full px-3 py-2 bg-muted rounded text-sm outline-none"
                  />
                  <textarea
                    value={importData}
                    onChange={(e) => setImportData(e.target.value)}
                    placeholder='Paste JWK JSON ({"publicKey": ..., "privateKey": ...})'
                    className="w-full px-3 py-2 bg-muted rounded text-xs font-mono outline-none resize-none h-24"
                  />
                  <div className="flex gap-2">
                    <button
                      onClick={handleImport}
                      disabled={loading}
                      className="px-3 py-1.5 bg-primary text-primary-foreground rounded text-xs font-medium"
                    >
                      Import
                    </button>
                    <button
                      onClick={() => setImportMode(false)}
                      className="px-3 py-1.5 bg-muted text-muted-foreground rounded text-xs"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  onClick={() => setImportMode(true)}
                  className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  <Upload size={12} /> Import key pair
                </button>
              )}

              {/* Key list */}
              {keyPairs.length === 0 ? (
                <p className="text-xs text-muted-foreground italic text-center py-4">
                  No key pairs stored yet
                </p>
              ) : (
                <div className="space-y-2">
                  {keyPairs.map((kp) => (
                    <div
                      key={kp.id}
                      className="flex items-center justify-between p-2 bg-muted/50 rounded"
                    >
                      <div>
                        <div className="text-xs font-medium text-foreground">{kp.name}</div>
                        <div className="text-[10px] font-mono text-muted-foreground">
                          {kp.fingerprint}
                        </div>
                      </div>
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => onExportKeys(kp, 'jwk')}
                          className="p-1 hover:bg-accent rounded text-muted-foreground"
                          title="Export as JWK"
                        >
                          <Download size={12} />
                        </button>
                        <button
                          onClick={() => onExportKeys(kp, 'pem')}
                          className="p-1 hover:bg-accent rounded text-muted-foreground"
                          title="Export as PEM"
                        >
                          <Key size={12} />
                        </button>
                        <button
                          onClick={() => onDeleteKeyPair(kp.id)}
                          className="p-1 hover:bg-destructive/10 rounded text-destructive"
                          title="Delete"
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
