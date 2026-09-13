import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import MultipartBodyForm from '../components/bodyForms/MultipartBodyForm';
import { serializeMultipartFields } from '../components/bodyForms/registry';

const shortId = 'post:/upload';
const testId = `body-input-${shortId}`;

describe('MultipartBodyForm interactions', () => {
  it('adds and removes field rows', async () => {
    render(<MultipartBodyForm value="" mediaType="multipart/form-data" lang="txt" testId={testId} onChange={() => {}} />);
    // starts with one row
    expect(screen.getByTestId(`multipart-name-${shortId}-0`)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId(`multipart-add-${shortId}`));
    expect(screen.getByTestId(`multipart-name-${shortId}-1`)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId(`multipart-add-${shortId}`));
    expect(screen.getByTestId(`multipart-name-${shortId}-2`)).toBeInTheDocument();
    // remove the middle row — ids are stable, so id 1 disappears and 0/2 remain
    const removeButtons = screen.getAllByTitle('Remove field');
    fireEvent.click(removeButtons[1]);
    expect(screen.queryByTestId(`multipart-name-${shortId}-1`)).toBeNull();
    expect(screen.getByTestId(`multipart-name-${shortId}-0`)).toBeInTheDocument();
    expect(screen.getByTestId(`multipart-name-${shortId}-2`)).toBeInTheDocument();
  });

  it('switches a field to file kind and picks a file', async () => {
    const onChange = vi.fn();
    render(<MultipartBodyForm value="" mediaType="multipart/form-data" lang="txt" testId={testId} onChange={onChange} />);
    fireEvent.change(screen.getByTestId(`multipart-name-${shortId}-0`), { target: { value: 'upload' } });
    // toggle kind → file: value input is replaced by a 'no file chosen' hint + Choose button
    fireEvent.change(screen.getByTestId(`multipart-kind-${shortId}-0`), { target: { value: 'file' } });
    expect(screen.getByTestId(`multipart-file-${shortId}-0`)).toHaveTextContent('no file chosen');
    // choose a file
    const file = new File([new Uint8Array([1, 2, 3])], 'pic.png', { type: 'image/png' });
    const input = containerFileInput();
    fireEvent.change(input, { target: { files: [file] } });
    await vi.waitFor(() => {
      expect(screen.getByTestId(`multipart-file-${shortId}-0`)).toHaveTextContent('pic.png');
    });
    // onChange emits serialized multipart state containing the data URL
    const serialized = onChange.mock.calls.at(-1)[0];
    expect(serialized).toContain('"name":"upload"');
    expect(serialized).toContain('data:image/png;base64,');
  });

  it('clears kind-switched field state and emits serialized output on every edit', async () => {
    const onChange = vi.fn();
    render(<MultipartBodyForm value="" mediaType="multipart/form-data" lang="txt" testId={testId} onChange={onChange} />);
    fireEvent.change(screen.getByTestId(`multipart-name-${shortId}-0`), { target: { value: 'field' } });
    fireEvent.change(screen.getByTestId(`multipart-value-${shortId}-0`), { target: { value: 'val' } });
    // parsed round-trip of emitted state (registry serializer strips ids)
    const last = onChange.mock.calls.at(-1)[0];
    expect(last).toBe(JSON.stringify({ __multipart__: [{ name: 'field', kind: 'text', text: 'val' }] }));
    // switching kind resets text
    fireEvent.change(screen.getByTestId(`multipart-kind-${shortId}-0`), { target: { value: 'file' } });
    expect(onChange.mock.calls.at(-1)[0]).toContain('"text":""');
  });

  it('seeds rows from pre-existing multipart state', () => {
    const seeded = serializeMultipartFields([
      { name: 'a', kind: 'text', text: '1' },
      { name: 'b', kind: 'text', text: '2' },
    ]);
    render(<MultipartBodyForm value={seeded} mediaType="multipart/form-data" lang="txt" testId={testId} onChange={() => {}} />);
    expect(screen.getByTestId(`multipart-name-${shortId}-0`)).toHaveValue('a');
    expect(screen.getByTestId(`multipart-name-${shortId}-1`)).toHaveValue('b');
  });

  function containerFileInput(): HTMLInputElement {
    // The hidden file input lives next to the row; select it directly.
    return document.querySelector(`input[type="file"]`) as HTMLInputElement;
  }
});