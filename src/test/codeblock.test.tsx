import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import CodeBlock from '../components/CodeBlock';
import { listRunners, registerRunner, unregisterRunner } from '@/lib/codeRunners';
import { registerJSRunner } from '@/lib/jsRunner';

// CodeBlock pulls shiki in with a dynamic import(); replace it with a
// deterministic stub so highlight output resolves instantly and can be
// inspected. vi.mock is hoisted above the component import, so the factory
// must be fed from vi.hoisted.
const { codeToHtmlMock } = vi.hoisted(() => ({ codeToHtmlMock: vi.fn() }));
vi.mock('shiki', () => ({ codeToHtml: codeToHtmlMock }));

const HIGHLIGHTED = '<span data-testid="shiki-output">highlighted</span>';
const REHIGHLIGHTED = '<span data-testid="shiki-output">rehighlighted</span>';

const GITHUB_DARK = { theme: 'github-dark' };
const flushAsync = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('CodeBlock component', () => {
  beforeEach(() => {
    codeToHtmlMock.mockReset();
    codeToHtmlMock.mockResolvedValue(HIGHLIGHTED);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    for (const lang of listRunners()) {
      unregisterRunner(lang);
    }
  });

  it('renders a loading placeholder and then the shiki-highlighted html', async () => {
    const { container } = render(<CodeBlock code="const x = 1" language="ts" />);

    // While the shiki promise is pending, the raw code shows in a plain <pre>.
    expect(container.querySelector('pre')).not.toBeNull();
    expect(screen.getByText('const x = 1')).toBeInTheDocument();
    expect(screen.getByText('ts')).toBeInTheDocument();
    expect(screen.queryByTestId('shiki-output')).not.toBeInTheDocument();

    await waitFor(() => {
      expect(container.querySelector('.shiki-wrapper')).not.toBeNull();
    });
    expect(container.querySelector('.shiki-wrapper')?.innerHTML).toBe(HIGHLIGHTED);
    expect(codeToHtmlMock).toHaveBeenCalledWith('const x = 1', {
      lang: 'ts',
      ...GITHUB_DARK,
    });
    // The loading placeholder is replaced once highlighting resolves.
    expect(screen.queryByText('const x = 1')).not.toBeInTheDocument();
  });

  it('re-runs highlighting when the code prop changes', async () => {
    const view = render(<CodeBlock code="first" language="ts" />);
    await waitFor(() => {
      expect(view.container.querySelector('.shiki-wrapper')).not.toBeNull();
    });

    codeToHtmlMock.mockResolvedValueOnce(REHIGHLIGHTED);
    view.rerender(<CodeBlock code="second" language="ts" />);

    await waitFor(() => {
      expect(view.container.querySelector('.shiki-wrapper')?.innerHTML).toBe(REHIGHLIGHTED);
    });
    expect(codeToHtmlMock).toHaveBeenCalledTimes(2);
    expect(codeToHtmlMock).toHaveBeenLastCalledWith('second', {
      lang: 'ts',
      ...GITHUB_DARK,
    });
  });

  it('falls back to a plain-text grammar when highlighting throws', async () => {
    codeToHtmlMock.mockRejectedValueOnce(new Error('unknown grammar: ts'));
    const { container } = render(<CodeBlock code="const x = 1" language="ts" />);

    await waitFor(() => {
      expect(container.querySelector('.shiki-wrapper')).not.toBeNull();
    });
    // The catch branch retries with lang: 'text' and renders that result.
    expect(container.querySelector('.shiki-wrapper')?.innerHTML).toBe(HIGHLIGHTED);
    expect(codeToHtmlMock).toHaveBeenCalledTimes(2);
    expect(codeToHtmlMock).toHaveBeenNthCalledWith(1, 'const x = 1', {
      lang: 'ts',
      ...GITHUB_DARK,
    });
    expect(codeToHtmlMock).toHaveBeenNthCalledWith(2, 'const x = 1', {
      lang: 'text',
      ...GITHUB_DARK,
    });
  });

  it('ignores the highlight result when the block unmounts before it resolves', async () => {
    let resolveHtml!: (value: string) => void;
    codeToHtmlMock.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          resolveHtml = resolve;
        }),
    );

    const view = render(<CodeBlock code="late" language="ts" />);
    // The highlight promise is now pending but unresolved (still loading).
    await waitFor(() => {
      expect(codeToHtmlMock).toHaveBeenCalled();
    });
    view.unmount();

    // Resolving after unmount must not touch state (cancelled guard).
    await act(async () => {
      resolveHtml(HIGHLIGHTED);
      await flushAsync();
    });

    expect(view.container.querySelector('.shiki-wrapper')).toBeNull();
    expect(codeToHtmlMock).toHaveBeenCalledTimes(1);
  });

  it('copies the parsed code, shows Copied feedback, then reverts', async () => {
    // Frontmatter header = every line before the first '---'.
    const rawCode = 'notes: remember me\n---\nconst greeting = "hi";';
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);

    render(<CodeBlock code={rawCode} language="js" />);
    // Let highlighting settle before switching to fake timers.
    await waitFor(() => {
      expect(screen.queryByText('const greeting = "hi";')).not.toBeInTheDocument();
    });

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    fireEvent.click(screen.getByText('Copy'));

    // The clipboard receives the frontmatter-stripped code, not the raw block.
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith('const greeting = "hi";');
    expect(screen.getByText('Copied')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(2000);
    });

    expect(screen.getByText('Copy')).toBeInTheDocument();
    expect(screen.queryByText('Copied')).not.toBeInTheDocument();
    writeText.mockRestore();
  });

  it('runs the sandboxed JS runner and renders captured output', async () => {
    registerJSRunner();
    const { container } = render(
      <CodeBlock code={'console.log("hello from CodeBlock")'} language="javascript" />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    expect(screen.getByRole('button', { name: /Running/ })).toBeDisabled();
    expect(screen.queryByText('▸')).not.toBeInTheDocument();

    expect(await screen.findByText('[log]: hello from CodeBlock')).toBeInTheDocument();
    expect(screen.getByText('▸')).toBeInTheDocument();
    expect(container.querySelector('.text-green-300')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Run' })).toBeEnabled();
  });

  it('keeps the Run button pending until a slow runner settles', async () => {
    let resolveRun!: (value: string) => void;
    registerRunner(
      'python',
      () =>
        new Promise<string>((resolve) => {
          resolveRun = resolve;
        }),
    );
    render(<CodeBlock code="print('hi')" language="python" />);

    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    expect(screen.getByRole('button', { name: /Running/ })).toBeDisabled();

    await act(async () => {
      resolveRun('computed 42');
      await flushAsync();
    });

    expect(await screen.findByText('computed 42')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Run' })).toBeEnabled();
    expect(screen.queryByText(/Running/)).not.toBeInTheDocument();
  });

  it('renders runner failures as an error output', async () => {
    registerJSRunner();
    const { container } = render(<CodeBlock code={'throw new Error("boom")'} language="js" />);

    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    expect(await screen.findByText('boom')).toBeInTheDocument();
    expect(screen.getByText('✗')).toBeInTheDocument();
    expect(container.querySelector('.text-red-300')).not.toBeNull();
    expect(screen.queryByText('▸')).not.toBeInTheDocument();
  });

  it('stringifies non-Error rejections from the runner', async () => {
    registerRunner('python', () => Promise.reject('plain failure'));
    render(<CodeBlock code="print('hi')" language="python" />);

    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    expect(await screen.findByText('plain failure')).toBeInTheDocument();
    expect(screen.getByText('✗')).toBeInTheDocument();
  });

  it('shows (no output) when the runner resolves an empty string', async () => {
    registerRunner('python', () => Promise.resolve(''));
    render(<CodeBlock code="print('hi')" language="python" />);

    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    expect(await screen.findByText('(no output)')).toBeInTheDocument();
    expect(screen.getByText('▸')).toBeInTheDocument();
  });

  it('does nothing when the runner disappears between render and click', async () => {
    // Keep highlighting pending so no re-render can recompute canRun and
    // remove the Run button after the runner is unregistered.
    let resolveHtml!: (value: string) => void;
    codeToHtmlMock.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          resolveHtml = resolve;
        }),
    );

    registerRunner('python', () => Promise.resolve('unused'));
    render(<CodeBlock code="print('hi')" language="python" />);
    await waitFor(() => {
      expect(codeToHtmlMock).toHaveBeenCalled();
    });
    unregisterRunner('python');

    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    await act(async () => {
      await flushAsync();
    });

    expect(screen.queryByText('▸')).not.toBeInTheDocument();
    expect(screen.queryByText('✗')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Run' })).toBeEnabled();

    // Settle the deferred highlight so nothing is left pending.
    await act(async () => {
      resolveHtml(HIGHLIGHTED);
      await flushAsync();
    });
  });

  it('toggles the frontmatter notes panel', () => {
    const rawCode = 'notes: first line\n  second line\n---\nconst x = 1;';
    render(<CodeBlock code={rawCode} language="ts" />);

    expect(screen.queryByText(/first line/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Notes'));
    expect(screen.getByText(/first line/)).toBeInTheDocument();

    fireEvent.click(screen.getByText('Notes'));
    expect(screen.queryByText(/first line/)).not.toBeInTheDocument();
  });

  it('shows version chips and no Run button for languages without a runner', async () => {
    const { container, unmount } = render(
      <CodeBlock code={'compatible: 2.7, 3.6\nincompatible: 1.0\n---\nprint("hi")'} language="python" />,
    );

    expect(screen.getByText('✓ 2.7')).toBeInTheDocument();
    expect(screen.getByText('✓ 3.6')).toBeInTheDocument();
    expect(screen.getByText('✗ 1.0')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Run' })).not.toBeInTheDocument();
    expect(screen.queryByText('Notes')).not.toBeInTheDocument();
    unmount();

    // incompatible-only frontmatter: compatible is absent, so the hasMeta
    // fallback chain reaches the incompatible branch.
    const second = render(
      <CodeBlock code={'incompatible: 2.0\n---\nprint("hi")'} language="python" />,
    );
    expect(screen.getByText('✗ 2.0')).toBeInTheDocument();

    await waitFor(() => {
      expect(second.container.querySelector('.shiki-wrapper')).not.toBeNull();
    });
  });

  it('highlights empty code without crashing', async () => {
    const { container } = render(<CodeBlock code="" language="ts" />);
    expect(container.querySelector('pre')).not.toBeNull();

    await waitFor(() => {
      expect(container.querySelector('.shiki-wrapper')).not.toBeNull();
    });
    expect(codeToHtmlMock).toHaveBeenCalledWith('', { lang: 'ts', ...GITHUB_DARK });
  });
});