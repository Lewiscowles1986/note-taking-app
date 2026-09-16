import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import FileBodyForm from '../components/bodyForms/FileBodyForm';
import RequestBodyEditor from '../components/RequestBodyEditor';
import { bodyFormFor, toWireBody } from '../components/bodyForms/registry';

describe('FileBodyForm', () => {
  const testId = 'body-input-post:/upload';

  it('starts empty with a Choose file button and no-file hint', () => {
    render(<FileBodyForm value="" mediaType="application/octet-stream" lang="txt" testId={testId} onChange={() => {}} />);
    expect(screen.getByText('Choose file…')).toBeInTheDocument();
    expect(screen.getByText(/No file selected/)).toHaveTextContent('application/octet-stream');
  });

  it('reads a selected file into a data URL and reports name + size', async () => {
    const onChange = vi.fn();
    render(<FileBodyForm value="" mediaType="application/octet-stream" lang="txt" testId={testId} onChange={onChange} />);

    const file = new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04])], 'archive.zip', { type: 'application/zip' });
    const input = document.querySelector(`input[type="file"]`) as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith(expect.stringMatching(/^data:application\/zip;base64,/));
    });
    expect(screen.getByText(/archive\.zip/)).toHaveTextContent('0.0 KB');
  });

  it('rejects files over 10 MB with an error message', async () => {
    render(<FileBodyForm value="" mediaType="application/octet-stream" lang="txt" testId={testId} onChange={() => {}} />);
    const bigFile = new File([new ArrayBuffer(10 * 1024 * 1024 + 1)], 'huge.bin');
    const input = document.querySelector(`input[type="file"]`) as HTMLInputElement;
    fireEvent.change(input, { target: { files: [bigFile] } });
    expect(await screen.findByText(/10 MB request-body limit/)).toBeInTheDocument();
  });

  it('clears the file label when value is emptied', async () => {
    const { rerender } = render(
      <FileBodyForm
        value="data:application/octet-stream;base64,UEsDBBQ"
        mediaType="application/octet-stream"
        lang="txt"
        testId={testId}
        onChange={() => {}}
      />
    );
    rerender(
      <FileBodyForm value="" mediaType="application/octet-stream" lang="txt" testId={testId} onChange={() => {}} />
    );
    await waitFor(() => {
      expect(screen.getByText(/No file selected/)).toBeInTheDocument();
    });
  });
});

describe('registry routing and wire-body edge cases', () => {
  it('routes media types to the right lazy form', () => {
    expect(bodyFormFor('application/json').toString()).toContain('JsonBodyForm');
    expect(bodyFormFor('multipart/form-data').toString()).toContain('MultipartBodyForm');
    expect(bodyFormFor('application/octet-stream').toString()).toContain('FileBodyForm');
    expect(bodyFormFor('image/png').toString()).toContain('FileBodyForm');
    expect(bodyFormFor('text/plain').toString()).toContain('TextBodyForm');
    expect(bodyFormFor('application/xml').toString()).toContain('TextBodyForm');
    expect(bodyFormFor('weird/unknown').toString()).toContain('TextBodyForm');
  });

  it('toWireBody returns undefined for undecodable base64', async () => {
    expect(await toWireBody('data:application/octet-stream;base64,!!!not-base64!!!', 'application/octet-stream')).toBeUndefined();
  });

  it('toWireBody passes raw text through unchanged', async () => {
    expect(await toWireBody('hello world', 'text/plain')).toBe('hello world');
    expect(await toWireBody('', 'text/plain')).toBeUndefined();
    expect(await toWireBody('   ', 'text/plain')).toBeUndefined();
  });
});

describe('RequestBodyEditor', () => {
  it('renders a Shiki-highlighted layer under a transparent textarea', async () => {
    const onChange = vi.fn();
    render(<RequestBodyEditor value={'{"a": 1}'} lang="json" testId="body-input-x" onChange={onChange} />);
    const ta = await screen.findByTestId('body-input-x');
    expect(ta).toHaveValue('{"a": 1}');
    // Shiki layer eventually fills with highlight markup
    await waitFor(
      () => {
        const layer = document.querySelector('[data-shiki-layer]');
        expect(layer?.querySelector('pre')).toBeTruthy();
      },
      { timeout: 3000 }
    );
  });

  it('emits onChange on typing and syncs scroll handlers without crashing', async () => {
    const onChange = vi.fn();
    const { container } = render(<RequestBodyEditor value="" lang="txt" testId="body-input-y" onChange={onChange} />);
    const ta = await screen.findByTestId('body-input-y');
    fireEvent.change(ta, { target: { value: 'abc' } });
    expect(onChange).toHaveBeenCalledWith('abc');
    // trigger the scroll sync path
    fireEvent.scroll(ta);
    expect(container.querySelector('[data-shiki-layer]')).toBeTruthy();
  });

  it('recovers with the txt grammar when the requested grammar is unknown', async () => {
    render(<RequestBodyEditor value='weird' lang='definitely-not-a-grammar' testId='body-input-z' onChange={() => {}} />);
    await waitFor(
      () => {
        expect(document.querySelector('[data-shiki-layer]')?.querySelector('pre')).toBeTruthy();
      },
      { timeout: 3000 }
    );
    // No crash = fallback path taken.
    expect(screen.getByTestId('body-input-z')).toBeInTheDocument();
  });
});