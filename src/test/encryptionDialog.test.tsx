import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import EncryptionDialog from '@/components/EncryptionDialog';
import { useEncryption } from '@/hooks/useEncryption';
import { exportKeyPairAsJwk, type EncryptedPayload, type StoredKeyPair } from '@/lib/crypto';
import { db, getAllKeyPairs, type Note } from '@/lib/db';

// ─── fixtures ───────────────────────────────────────────────────

const PASSWORD_PAYLOAD: EncryptedPayload = {
  method: 'password',
  ciphertext: 'Y2lwaGVy',
  iv: 'aXZfMTIzNDU2Nzg5MDEyMzQ1',
  salt: 'c2FsdA==',
};

const KEYPAIR_PAYLOAD: EncryptedPayload = {
  method: 'keypair',
  ciphertext: 'Y2lwaGVy',
  iv: 'aXZfMTIzNDU2Nzg5MDEyMzQ1',
  wrappedKey: 'd3JhcHBlZEtleQ==',
  keyFingerprint: 'FP-KEYPAIR-99',
};

function makeKeyPair(overrides: Partial<StoredKeyPair> = {}): StoredKeyPair {
  return {
    id: 'kp-1',
    name: 'Laptop key',
    fingerprint: 'FP-LAPTOP-1234',
    publicKeyJwk: { kty: 'RSA', e: 'AQAB', n: 'cHVibGlj' },
    privateKeyJwk: { kty: 'RSA', d: 'cHJpdmF0ZQ' },
    createdAt: new Date('2024-01-01T00:00:00Z'),
    ...overrides,
  };
}

function makeNote(overrides: Partial<Note> = {}): Note {
  return {
    id: 1,
    title: 'Secret plans',
    content: 'hello world',
    tags: [],
    category: 'Inbox',
    attachments: [],
    createdAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2024-01-02T00:00:00Z'),
    editDates: [],
    pinned: false,
    ...overrides,
  };
}

type DialogProps = ComponentProps<typeof EncryptionDialog>;

function makeProps(overrides: Partial<DialogProps> = {}): DialogProps {
  return {
    note: makeNote(),
    keyPairs: [] as StoredKeyPair[],
    onEncrypt: vi.fn().mockResolvedValue(undefined),
    onDecrypt: vi.fn().mockResolvedValue(undefined),
    onGenerateKeyPair: vi.fn().mockResolvedValue(makeKeyPair()),
    onImportKeys: vi.fn().mockResolvedValue(undefined),
    onExportKeys: vi.fn().mockResolvedValue(undefined),
    onDeleteKeyPair: vi.fn().mockResolvedValue(undefined),
    onClose: vi.fn(),
    ...overrides,
  };
}

/** Manually resolved promise to hold an async handler in its loading state. */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Click and flush the spawned async handler (mocks resolve on microtasks). */
async function clickAsync(element: Element): Promise<void> {
  await act(async () => {
    fireEvent.click(element);
  });
}

/** The header's icon-only close button is the only button next to the title. */
function closeButton(): HTMLButtonElement {
  const header = screen.getByText('Note Encryption').closest('div')!
    .parentElement as HTMLElement;
  return within(header).getByRole('button') as HTMLButtonElement;
}

function openKeysTab(): void {
  fireEvent.click(screen.getByText('Key Pairs'));
}

// ─── encrypt tab (unencrypted note) ─────────────────────────────

describe('EncryptionDialog — encrypt tab (unencrypted note)', () => {
  it('renders the encrypt tab for a plain note and closes via the header button', () => {
    const props = makeProps();
    render(<EncryptionDialog {...props} />);

    expect(screen.getByText('Note Encryption')).toBeTruthy();
    // Unencrypted notes start on the encrypt tab with both password fields.
    expect(screen.getByText('Encrypt')).toBeTruthy();
    expect(screen.getByPlaceholderText('Min 8 characters')).toBeTruthy();
    expect(screen.getByPlaceholderText('Confirm password')).toBeTruthy();

    fireEvent.click(closeButton());
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('blocks an empty password with a validation error', () => {
    const props = makeProps();
    render(<EncryptionDialog {...props} />);

    fireEvent.click(screen.getByText('Encrypt Note'));
    expect(screen.getByText('Password is required')).toBeTruthy();
    expect(props.onEncrypt).not.toHaveBeenCalled();
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it('rejects a mismatched confirmation', () => {
    const props = makeProps();
    render(<EncryptionDialog {...props} />);

    fireEvent.change(screen.getByPlaceholderText('Min 8 characters'), {
      target: { value: 'long enough 1' },
    });
    fireEvent.change(screen.getByPlaceholderText('Confirm password'), {
      target: { value: 'long enough 2' },
    });
    fireEvent.click(screen.getByText('Encrypt Note'));

    expect(screen.getByText('Passwords do not match')).toBeTruthy();
    expect(props.onEncrypt).not.toHaveBeenCalled();
  });

  it('rejects passwords shorter than 8 characters', () => {
    const props = makeProps();
    render(<EncryptionDialog {...props} />);

    fireEvent.change(screen.getByPlaceholderText('Min 8 characters'), {
      target: { value: 'short12' },
    });
    fireEvent.change(screen.getByPlaceholderText('Confirm password'), {
      target: { value: 'short12' },
    });
    fireEvent.click(screen.getByText('Encrypt Note'));

    expect(screen.getByText('Password must be at least 8 characters')).toBeTruthy();
    expect(props.onEncrypt).not.toHaveBeenCalled();
  });

  it('encrypts with a valid password and closes the dialog', async () => {
    const props = makeProps();
    render(<EncryptionDialog {...props} />);

    fireEvent.change(screen.getByPlaceholderText('Min 8 characters'), {
      target: { value: 'correct horse 1' },
    });
    fireEvent.change(screen.getByPlaceholderText('Confirm password'), {
      target: { value: 'correct horse 1' },
    });
    await clickAsync(screen.getByText('Encrypt Note'));

    expect(props.onEncrypt).toHaveBeenCalledTimes(1);
    expect(props.onEncrypt).toHaveBeenCalledWith('password', 'correct horse 1');
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('encrypts with the selected key pair and honours the dropdown choice', async () => {
    const kp1 = makeKeyPair();
    const kp2 = makeKeyPair({ id: 'kp-2', name: 'Backup key', fingerprint: 'FP-BACKUP-5678' });
    const props = makeProps({ keyPairs: [kp1, kp2] });
    render(<EncryptionDialog {...props} />);

    fireEvent.click(screen.getByText('Key Pair'));
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('kp-1');
    expect(screen.getByRole('option', { name: 'Laptop key (FP-LAPTOP-1234)' })).toBeTruthy();

    // Toggling back to the password method restores the password fields.
    fireEvent.click(screen.getByText('Password'));
    expect(screen.getByPlaceholderText('Confirm password')).toBeTruthy();
    expect(screen.queryByRole('combobox')).toBeNull();

    fireEvent.click(screen.getByText('Key Pair'));
    // The combobox is re-created on the re-selected method — re-query it.
    const select = screen.getByRole('combobox') as HTMLSelectElement;
    await clickAsync(screen.getByText('Encrypt Note'));
    expect(props.onEncrypt).toHaveBeenCalledWith('keypair', kp1);

    fireEvent.change(select, { target: { value: 'kp-2' } });
    await clickAsync(screen.getByText('Encrypt Note'));
    expect(props.onEncrypt).toHaveBeenLastCalledWith('keypair', kp2);
    expect(props.onClose).toHaveBeenCalledTimes(2);
  });

  it('blocks key-pair encryption when no key pairs exist yet', () => {
    const props = makeProps({ keyPairs: [] });
    render(<EncryptionDialog {...props} />);

    fireEvent.click(screen.getByText('Key Pair'));
    expect(
      screen.getByText('No key pairs yet. Go to the Key Pairs tab to generate one.')
    ).toBeTruthy();

    fireEvent.click(screen.getByText('Encrypt Note'));
    expect(screen.getByText('Select a key pair')).toBeTruthy();
    expect(props.onEncrypt).not.toHaveBeenCalled();
  });

  it('shows the caught error message when encryption fails', async () => {
    const props = makeProps({ onEncrypt: vi.fn().mockRejectedValue(new Error('AES failure')) });
    render(<EncryptionDialog {...props} />);

    fireEvent.change(screen.getByPlaceholderText('Min 8 characters'), {
      target: { value: 'correct horse 1' },
    });
    fireEvent.change(screen.getByPlaceholderText('Confirm password'), {
      target: { value: 'correct horse 1' },
    });
    await clickAsync(screen.getByText('Encrypt Note'));

    expect(screen.getByText('AES failure')).toBeTruthy();
    expect(props.onClose).not.toHaveBeenCalled();
    // Loading cleared: the button is back to its resting label and enabled.
    const button = screen.getByText('Encrypt Note') as HTMLButtonElement;
    expect(button.disabled).toBe(false);
  });

  it('falls back to a generic message when encryption fails with a non-Error', async () => {
    const props = makeProps({ onEncrypt: vi.fn().mockRejectedValue('boom') });
    render(<EncryptionDialog {...props} />);

    fireEvent.change(screen.getByPlaceholderText('Min 8 characters'), {
      target: { value: 'correct horse 1' },
    });
    fireEvent.change(screen.getByPlaceholderText('Confirm password'), {
      target: { value: 'correct horse 1' },
    });
    await clickAsync(screen.getByText('Encrypt Note'));

    expect(screen.getByText('Encryption failed')).toBeTruthy();
  });

  it('disables the button and shows Encrypting… while encryption is in flight', async () => {
    const def = deferred();
    const props = makeProps({ onEncrypt: vi.fn().mockReturnValue(def.promise) });
    render(<EncryptionDialog {...props} />);

    fireEvent.change(screen.getByPlaceholderText('Min 8 characters'), {
      target: { value: 'correct horse 1' },
    });
    fireEvent.change(screen.getByPlaceholderText('Confirm password'), {
      target: { value: 'correct horse 1' },
    });
    fireEvent.click(screen.getByText('Encrypt Note'));

    const busy = screen.getByText('Encrypting…') as HTMLButtonElement;
    expect(busy.disabled).toBe(true);
    expect(props.onClose).not.toHaveBeenCalled();

    await act(async () => {
      def.resolve();
    });
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('toggles password visibility in the encrypt form', () => {
    const props = makeProps();
    render(<EncryptionDialog {...props} />);

    const input = screen.getByPlaceholderText('Min 8 characters') as HTMLInputElement;
    const toggle = input.parentElement!.querySelector('button') as HTMLButtonElement;
    expect(input.type).toBe('password');

    fireEvent.click(toggle);
    expect(input.type).toBe('text');
    fireEvent.click(toggle);
    expect(input.type).toBe('password');
  });
});

// ─── key pairs tab ──────────────────────────────────────────────

/** The key-list row: name div → inner wrapper → row div holding the action buttons. */
function keyRowFor(name: string): HTMLElement {
  return screen.getByText(name).closest('div')!.parentElement!.parentElement as HTMLElement;
}

describe('EncryptionDialog — key pairs tab', () => {
  it('shows an empty key list, the import trigger, and switches tabs back', () => {
    const props = makeProps();
    render(<EncryptionDialog {...props} />);

    openKeysTab();
    expect(screen.getByText('No key pairs stored yet')).toBeTruthy();
    expect(screen.getByText('Import key pair')).toBeTruthy();

    fireEvent.click(screen.getByText('Encrypt'));
    expect(screen.getByText('Encrypt Note')).toBeTruthy();
  });

  it('generates a key pair via the button using the trimmed name', async () => {
    const props = makeProps();
    render(<EncryptionDialog {...props} />);

    openKeysTab();
    const nameInput = screen.getByPlaceholderText('Key pair name');
    fireEvent.change(nameInput, { target: { value: '  Travel key  ' } });
    await clickAsync(screen.getByText('Generate'));

    expect(props.onGenerateKeyPair).toHaveBeenCalledTimes(1);
    expect(props.onGenerateKeyPair).toHaveBeenCalledWith('Travel key');
    expect((nameInput as HTMLInputElement).value).toBe('');
  });

  it('generates on Enter but ignores whitespace-only names', async () => {
    const props = makeProps();
    render(<EncryptionDialog {...props} />);

    openKeysTab();
    const nameInput = screen.getByPlaceholderText('Key pair name');
    fireEvent.change(nameInput, { target: { value: '   ' } });
    fireEvent.keyDown(nameInput, { key: 'Enter' });
    expect(props.onGenerateKeyPair).not.toHaveBeenCalled();

    // A non-Enter key never triggers generation either.
    fireEvent.keyDown(nameInput, { key: 'a' });
    expect(props.onGenerateKeyPair).not.toHaveBeenCalled();

    fireEvent.change(nameInput, { target: { value: 'Laptop' } });
    await act(async () => {
      fireEvent.keyDown(nameInput, { key: 'Enter' });
    });
    expect(props.onGenerateKeyPair).toHaveBeenCalledWith('Laptop');
  });

  it('shows Generating… while the key pair is being created', async () => {
    const def = deferred<StoredKeyPair>();
    const props = makeProps({ onGenerateKeyPair: vi.fn().mockReturnValue(def.promise) });
    render(<EncryptionDialog {...props} />);

    openKeysTab();
    const nameInput = screen.getByPlaceholderText('Key pair name');
    fireEvent.change(nameInput, { target: { value: 'Slow key' } });
    fireEvent.click(screen.getByText('Generate'));

    const busy = screen.getByText('Generating…') as HTMLButtonElement;
    expect(busy.disabled).toBe(true);
    expect(props.onGenerateKeyPair).toHaveBeenCalledWith('Slow key');

    await act(async () => {
      def.resolve(makeKeyPair());
    });
    expect((nameInput as HTMLInputElement).value).toBe('');
  });

  it('imports a pasted JWK payload and resets the form', async () => {
    const props = makeProps();
    render(<EncryptionDialog {...props} />);

    openKeysTab();
    fireEvent.click(screen.getByText('Import key pair'));
    const nameInput = screen.getByPlaceholderText('Name for imported key');
    const dataInput = screen.getByPlaceholderText(
      'Paste JWK JSON ({"publicKey": ..., "privateKey": ...})'
    );
    fireEvent.change(nameInput, { target: { value: '  Imported pair  ' } });
    fireEvent.change(dataInput, {
      target: { value: '  {"publicKey":{},"privateKey":{}}  ' },
    });
    await clickAsync(screen.getByText('Import'));

    expect(props.onImportKeys).toHaveBeenCalledTimes(1);
    expect(props.onImportKeys).toHaveBeenCalledWith(
      'Imported pair',
      '{"publicKey":{},"privateKey":{}}'
    );
    // The form collapsed back to the trigger…
    expect(screen.getByText('Import key pair')).toBeTruthy();
    // …and reopening it shows cleared fields.
    fireEvent.click(screen.getByText('Import key pair'));
    expect((screen.getByPlaceholderText('Name for imported key') as HTMLInputElement).value).toBe(
      ''
    );
    expect(
      (
        screen.getByPlaceholderText(
          'Paste JWK JSON ({"publicKey": ..., "privateKey": ...})'
        ) as HTMLTextAreaElement
      ).value
    ).toBe('');
  });

  it('shows import errors (Error and non-Error) and keeps the form open', async () => {
    const props = makeProps({
      onImportKeys: vi
        .fn()
        .mockRejectedValueOnce(new Error('Invalid JWK'))
        .mockRejectedValueOnce('nope'),
    });
    render(<EncryptionDialog {...props} />);

    openKeysTab();
    fireEvent.click(screen.getByText('Import key pair'));
    fireEvent.change(screen.getByPlaceholderText('Name for imported key'), {
      target: { value: 'Bad key' },
    });
    fireEvent.change(
      screen.getByPlaceholderText('Paste JWK JSON ({"publicKey": ..., "privateKey": ...})'),
      { target: { value: '{"broken"' } }
    );

    await clickAsync(screen.getByText('Import'));
    expect(screen.getByText('Invalid JWK')).toBeTruthy();
    expect(screen.getByText('Import')).toBeTruthy();

    await clickAsync(screen.getByText('Import'));
    expect(screen.getByText('Import failed')).toBeTruthy();
  });

  it('ignores an import click with empty fields', () => {
    const props = makeProps();
    render(<EncryptionDialog {...props} />);

    openKeysTab();
    fireEvent.click(screen.getByText('Import key pair'));
    fireEvent.click(screen.getByText('Import'));

    expect(props.onImportKeys).not.toHaveBeenCalled();
    expect(screen.getByPlaceholderText('Name for imported key')).toBeTruthy();
  });

  it('closes the import form on Cancel', () => {
    const props = makeProps();
    render(<EncryptionDialog {...props} />);

    openKeysTab();
    fireEvent.click(screen.getByText('Import key pair'));
    expect(screen.getByText('Import')).toBeTruthy();

    fireEvent.click(screen.getByText('Cancel'));
    expect(screen.getByText('Import key pair')).toBeTruthy();
    expect(screen.queryByPlaceholderText('Name for imported key')).toBeNull();
  });

  it('lists key pairs and wires export and delete actions per row', () => {
    const kp1 = makeKeyPair();
    const kp2 = makeKeyPair({ id: 'kp-2', name: 'Backup key', fingerprint: 'FP-BACKUP-5678' });
    const props = makeProps({ keyPairs: [kp1, kp2] });
    render(<EncryptionDialog {...props} />);

    openKeysTab();
    expect(screen.getByText('Backup key')).toBeTruthy();
    expect(screen.getByText('FP-BACKUP-5678')).toBeTruthy();

    const row = keyRowFor('Laptop key');
    expect(within(row).getByText('FP-LAPTOP-1234')).toBeTruthy();

    fireEvent.click(within(row).getByTitle('Export as JWK'));
    expect(props.onExportKeys).toHaveBeenCalledWith(kp1, 'jwk');
    fireEvent.click(within(row).getByTitle('Export as PEM'));
    expect(props.onExportKeys).toHaveBeenLastCalledWith(kp1, 'pem');
    fireEvent.click(within(row).getByTitle('Delete'));
    expect(props.onDeleteKeyPair).toHaveBeenCalledWith('kp-1');
  });
});

// ─── decrypt tab (encrypted note) ───────────────────────────────

describe('EncryptionDialog — decrypt tab (encrypted note)', () => {
  it('shows the decrypt UI for a password-encrypted note and requires a password', () => {
    const props = makeProps({ note: makeNote({ encrypted: PASSWORD_PAYLOAD }) });
    render(<EncryptionDialog {...props} />);

    expect(screen.getByText('Decrypt')).toBeTruthy();
    expect(screen.getByText('password')).toBeTruthy();
    expect(screen.getByPlaceholderText('Enter password')).toBeTruthy();
    expect(screen.queryByText('Encrypt Note')).toBeNull();

    fireEvent.click(screen.getByText('Decrypt Note'));
    expect(screen.getByText('Password is required')).toBeTruthy();
    expect(props.onDecrypt).not.toHaveBeenCalled();
  });

  it('decrypts with a password via Enter and via the button', async () => {
    const props = makeProps({ note: makeNote({ encrypted: PASSWORD_PAYLOAD }) });
    render(<EncryptionDialog {...props} />);

    const input = screen.getByPlaceholderText('Enter password');
    fireEvent.change(input, { target: { value: 'secret 1' } });

    // Only Enter triggers decryption from the input.
    fireEvent.keyDown(input, { key: 'a' });
    await act(async () => {});
    expect(props.onDecrypt).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: 'Enter' });
    await act(async () => {});
    expect(props.onDecrypt).toHaveBeenCalledTimes(1);
    expect(props.onDecrypt).toHaveBeenCalledWith('secret 1');
    expect(props.onClose).toHaveBeenCalledTimes(1);

    await clickAsync(screen.getByText('Decrypt Note'));
    expect(props.onDecrypt).toHaveBeenCalledTimes(2);
    expect(props.onClose).toHaveBeenCalledTimes(2);
  });

  it('disables the button and shows Decrypting… while decryption is in flight', async () => {
    const def = deferred();
    const props = makeProps({
      note: makeNote({ encrypted: PASSWORD_PAYLOAD }),
      onDecrypt: vi.fn().mockReturnValue(def.promise),
    });
    render(<EncryptionDialog {...props} />);

    fireEvent.change(screen.getByPlaceholderText('Enter password'), {
      target: { value: 'secret 1' },
    });
    fireEvent.click(screen.getByText('Decrypt Note'));

    const busy = screen.getByText('Decrypting…') as HTMLButtonElement;
    expect(busy.disabled).toBe(true);
    expect(props.onClose).not.toHaveBeenCalled();

    await act(async () => {
      def.resolve();
    });
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('shows the error message when decryption fails with an Error', async () => {
    const props = makeProps({
      note: makeNote({ encrypted: PASSWORD_PAYLOAD }),
      onDecrypt: vi.fn().mockRejectedValue(new Error('bad padding')),
    });
    render(<EncryptionDialog {...props} />);

    fireEvent.change(screen.getByPlaceholderText('Enter password'), {
      target: { value: 'wrong' },
    });
    await clickAsync(screen.getByText('Decrypt Note'));

    expect(screen.getByText('bad padding')).toBeTruthy();
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it('falls back to the generic message when decryption fails with a non-Error', async () => {
    const props = makeProps({
      note: makeNote({ encrypted: PASSWORD_PAYLOAD }),
      onDecrypt: vi.fn().mockRejectedValue('nope'),
    });
    render(<EncryptionDialog {...props} />);

    fireEvent.change(screen.getByPlaceholderText('Enter password'), {
      target: { value: 'wrong' },
    });
    await clickAsync(screen.getByText('Decrypt Note'));

    expect(screen.getByText('Decryption failed — wrong password or key?')).toBeTruthy();
  });

  it('toggles password visibility in the decrypt form', () => {
    const props = makeProps({ note: makeNote({ encrypted: PASSWORD_PAYLOAD }) });
    render(<EncryptionDialog {...props} />);

    const input = screen.getByPlaceholderText('Enter password') as HTMLInputElement;
    const toggle = input.parentElement!.querySelector('button') as HTMLButtonElement;
    expect(input.type).toBe('password');

    fireEvent.click(toggle);
    expect(input.type).toBe('text');
    fireEvent.click(toggle);
    expect(input.type).toBe('password');
  });

  it('shows key-pair metadata with fingerprint and decrypts without a password', async () => {
    const props = makeProps({ note: makeNote({ encrypted: KEYPAIR_PAYLOAD }) });
    render(<EncryptionDialog {...props} />);

    expect(screen.getByText('key pair')).toBeTruthy();
    expect(screen.getByText('(FP-KEYPAIR-99)')).toBeTruthy();
    expect(
      screen.getByText(
        'This will decrypt using the matching private key stored in your browser.'
      )
    ).toBeTruthy();
    expect(screen.queryByPlaceholderText('Enter password')).toBeNull();

    await clickAsync(screen.getByText('Decrypt Note'));
    expect(props.onDecrypt).toHaveBeenCalledWith('');
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('omits the fingerprint span when the payload carries none', () => {
    const props = makeProps({
      note: makeNote({ encrypted: { ...KEYPAIR_PAYLOAD, keyFingerprint: undefined } }),
    });
    render(<EncryptionDialog {...props} />);

    expect(screen.getByText('key pair')).toBeTruthy();
    expect(screen.queryByText(/FP-KEYPAIR/)).toBeNull();
  });
});

// ─── real-flow round trip (real hook, real db, real webcrypto) ──

// RSA-4096 keygen is CPU-bound; give it room like use-encryption.test.tsx.
const CRYPTO_TIMEOUT = 30_000;

/** Clear every table (schema stays open at v4). Unlike delete/reopen this
 * cannot raise DatabaseClosedError from a previous test's in-flight read
 * landing after the wipe — pending reads resolve against empty tables. */
async function resetDb(): Promise<void> {
  await Promise.all(db.tables.map((table) => table.clear()));
}

/**
 * Mirrors Index.tsx wiring: the REAL useEncryption hook drives the dialog's
 * callback props (minus toasts and db note-saving).
 */
function RealHarness({ note, onClose }: { note: Note; onClose: () => void }) {
  const encryption = useEncryption();
  return (
    <EncryptionDialog
      note={note}
      keyPairs={encryption.keyPairs}
      onEncrypt={async (method, credential) => {
        const payload = await encryption.encryptContent(note.content, method, credential);
        note.content = '[encrypted]';
        note.encrypted = payload;
      }}
      onDecrypt={async (credential) => {
        if (!note.encrypted) return;
        note.content = await encryption.decryptContent(note.encrypted, credential);
        note.encrypted = null;
      }}
      onGenerateKeyPair={encryption.generateNewKeyPair}
      onImportKeys={async (name, data) => {
        try {
          const parsed = JSON.parse(data) as { publicKey?: JsonWebKey; privateKey?: JsonWebKey };
          if (parsed.publicKey && parsed.privateKey) {
            await encryption.importJwk(name, parsed.publicKey, parsed.privateKey);
            return;
          }
        } catch {
          // Not JWK JSON — fall through to the error below.
        }
        throw new Error('Invalid format. Paste JWK JSON: {"publicKey": {...}, "privateKey": {...}}');
      }}
      onExportKeys={async (kp, format) => {
        if (format === 'jwk') await encryption.exportAsJwk(kp);
        else await encryption.exportAsPem(kp);
      }}
      onDeleteKeyPair={encryption.removeKeyPair}
      onClose={onClose}
    />
  );
}

describe('EncryptionDialog — real-flow round trip (real hook, db, webcrypto)', () => {
  beforeEach(resetDb);

  it('generates, imports, deletes a key pair, then encrypts and decrypts the note', async () => {
    const note = makeNote({ content: 'round trip secret' });
    let closeCount = 0;
    const { rerender } = render(<RealHarness note={note} onClose={() => { closeCount += 1; }} />);
    await act(async () => {}); // flush the mount-time keyPairs load

    // Generate a real RSA key pair through the dialog.
    openKeysTab();
    fireEvent.change(screen.getByPlaceholderText('Key pair name'), {
      target: { value: 'Round trip key' },
    });
    fireEvent.click(screen.getByText('Generate'));
    await waitFor(() => expect(screen.getByText('Round trip key')).toBeTruthy(), {
      timeout: CRYPTO_TIMEOUT,
    });

    // Import the same pair as JWK JSON through the dialog.
    const [stored] = await getAllKeyPairs();
    expect(stored?.name).toBe('Round trip key');
    const jwks = await exportKeyPairAsJwk(stored!);
    fireEvent.click(screen.getByText('Import key pair'));
    fireEvent.change(screen.getByPlaceholderText('Name for imported key'), {
      target: { value: 'Imported pair' },
    });
    fireEvent.change(
      screen.getByPlaceholderText('Paste JWK JSON ({"publicKey": ..., "privateKey": ...})'),
      { target: { value: JSON.stringify(jwks) } }
    );
    await clickAsync(screen.getByText('Import'));
    await waitFor(() => expect(screen.getByText('Imported pair')).toBeTruthy());

    // Delete the imported duplicate through the dialog.
    const dupRow = keyRowFor('Imported pair');
    fireEvent.click(within(dupRow).getByTitle('Delete'));
    await waitFor(() => expect(screen.queryByText('Imported pair')).toBeNull());

    // Encrypt the note with the generated key pair.
    fireEvent.click(screen.getByText('Encrypt'));
    fireEvent.click(screen.getByText('Key Pair'));
    // selectedKeyId was captured on first mount (empty list), so pick the key explicitly.
    const select = screen.getByRole('combobox') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: stored!.id } });
    await clickAsync(screen.getByText('Encrypt Note'));
    await waitFor(() => expect(closeCount).toBeGreaterThan(0));

    expect(note.encrypted?.method).toBe('keypair');
    expect(note.encrypted?.keyFingerprint).toBe(stored!.fingerprint);
    expect(note.encrypted?.wrappedKey).toBeDefined();
    expect(note.content).toBe('[encrypted]');

    // Decrypt again through the dialog.
    rerender(<RealHarness note={note} onClose={() => { closeCount += 1; }} />);
    await waitFor(() => expect(screen.getByText('Decrypt Note')).toBeTruthy());
    expect(screen.getByText('key pair')).toBeTruthy();
    expect(screen.getByText(`(${stored!.fingerprint})`)).toBeTruthy();
    fireEvent.click(screen.getByText('Decrypt Note'));
    await waitFor(() => expect(note.content).toBe('round trip secret'));
    expect(note.encrypted).toBeNull();

    rerender(<RealHarness note={note} onClose={() => { closeCount += 1; }} />);
    expect(screen.getByText('Encrypt Note')).toBeTruthy();
  }, CRYPTO_TIMEOUT);
});