import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import MermaidBlock from '../components/MermaidBlock';

// MermaidBlock imports mermaid statically and even calls mermaid.initialize()
// at module scope, so the mock must be in place before the component import.
// vi.mock is hoisted; the factory is fed from vi.hoisted state so each test
// can decide how render() settles.
const mermaidState = vi.hoisted(() => ({
  renderImpl: null as null | ((id: string, code: string) => Promise<{ svg: string }>),
}));
const { initializeMock, renderMock, codeToHtmlMock } = vi.hoisted(() => ({
  initializeMock: vi.fn(),
  renderMock: vi.fn(),
  codeToHtmlMock: vi.fn(),
}));
vi.mock('mermaid', () => ({
  default: { initialize: initializeMock, render: renderMock },
}));
// The component highlights its source through a dynamic import('shiki') —
// stub it the same way codeblock.test.tsx does.
vi.mock('shiki', () => ({ codeToHtml: codeToHtmlMock }));

const SHIKI_HTML = '<pre data-testid="shiki-mermaid">highlighted-diagram</pre>';
const LATE_HTML = '<pre data-testid="shiki-mermaid">late-diagram</pre>';
const NO_FRONTMATTER = 'graph TD\n  A --> B';
const flushAsync = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('MermaidBlock component', () => {
  beforeEach(() => {
    mermaidState.renderImpl = null;
    initializeMock.mockClear();
    renderMock.mockClear();
    renderMock.mockImplementation((id: string, code: string) =>
      mermaidState.renderImpl
        ? mermaidState.renderImpl(id, code)
        : Promise.resolve({ svg: `<svg id="${id}"></svg>` }),
    );
    codeToHtmlMock.mockReset();
    codeToHtmlMock.mockResolvedValue(SHIKI_HTML);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('renders the mermaid svg into the preview pane', async () => {
    const { container } = render(<MermaidBlock code={NO_FRONTMATTER} />);
    await waitFor(() => {
      expect(container.querySelector('svg')).not.toBeNull();
    });
    expect(container.querySelector('.mermaid-diagram')).not.toBeNull();
    expect(renderMock).toHaveBeenCalledTimes(1);
    // The render id is a unique counter-based prefix; the diagram code is
    // passed through untouched when there is no frontmatter.
    const [id, diagram] = renderMock.mock.calls[0];
    expect(id).toMatch(/^mermaid-\d+$/);
    expect(diagram).toBe(NO_FRONTMATTER);
    expect(container.querySelector(`svg[id="${id}"]`)).not.toBeNull();
    // Preview is the default tab: the code view stays hidden.
    expect(container.querySelector('.shiki-wrapper')).toBeNull();
    expect(screen.getByText('Diagram Preview')).toBeInTheDocument();
  });

  it('applies frontmatter config before rendering and resets it afterwards', async () => {
    const code = 'theme: dark\nflowchart:\n  curve: basis\n---\ngraph TD\n  A --> B';
    render(<MermaidBlock code={code} />);
    await waitFor(() => {
      expect(renderMock).toHaveBeenCalled();
    });
    // Only the diagram body after the first --- reaches mermaid.render.
    expect(renderMock).toHaveBeenCalledWith(
      expect.stringMatching(/^mermaid-\d+$/),
      'graph TD\n  A --> B',
    );
    // The parsed frontmatter keys ARE the config and override the defaults…
    expect(initializeMock).toHaveBeenCalledTimes(2);
    expect(initializeMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ theme: 'dark', flowchart: { curve: 'basis' } }),
    );
    // …and the finally block restores the neutral defaults.
    expect(initializeMock).toHaveBeenNthCalledWith(2, {
      startOnLoad: false,
      theme: 'neutral',
      securityLevel: 'loose',
    });
  });

  it('parses scalars, comments, blank/colon-less lines and nested pipe blocks', async () => {
    const code = [
      '# a comment',
      '',
      'htmlLabels: true',
      'dark: false',
      'nothing: null',
      'fontSize: 14',
      'ratio: 1.5',
      'title: "My Diagram"',
      "alt: 'x'",
      'flowchart: |',
      '  curve: basis',
      'rankdir',
      'theme: forest',
      '---',
      'sequenceDiagram',
      '  Alice->>Bob: Hi',
    ].join('\n');
    render(<MermaidBlock code={code} />);
    await waitFor(() => {
      expect(renderMock).toHaveBeenCalled();
    });
    expect(renderMock).toHaveBeenCalledWith(
      expect.stringMatching(/^mermaid-\d+$/),
      'sequenceDiagram\n  Alice->>Bob: Hi',
    );
    expect(initializeMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        htmlLabels: true,
        dark: false,
        nothing: null,
        fontSize: 14,
        ratio: 1.5,
        title: 'My Diagram',
        alt: 'x',
        flowchart: { curve: 'basis' },
        theme: 'forest',
      }),
    );
  });

  it('does not touch the global config when the code has no frontmatter', async () => {
    render(<MermaidBlock code={NO_FRONTMATTER} />);
    await waitFor(() => {
      expect(renderMock).toHaveBeenCalled();
    });
    expect(initializeMock).not.toHaveBeenCalled();
  });

  it('shows the error UI when render rejects and recovers on the next code', async () => {
    mermaidState.renderImpl = () => Promise.reject(new Error('Syntax error in diagram text'));
    const view = render(<MermaidBlock code={NO_FRONTMATTER} />);
    await waitFor(() => {
      expect(screen.getByText(/Mermaid error:/)).toBeInTheDocument();
    });
    expect(screen.getByText(/Syntax error in diagram text/)).toBeInTheDocument();
    // The error UI replaces the whole block, tabs and svg included.
    expect(view.container.querySelector('svg')).toBeNull();
    expect(screen.queryByText('Code')).not.toBeInTheDocument();

    // A subsequent code that renders successfully clears the error again.
    mermaidState.renderImpl = null;
    view.rerender(<MermaidBlock code={'pie\n  "A": 3'} />);
    await waitFor(() => {
      expect(view.container.querySelector('svg')).not.toBeNull();
    });
    expect(screen.queryByText(/Mermaid error:/)).not.toBeInTheDocument();
  });

  it('renders again with a fresh id when the code prop changes', async () => {
    const view = render(<MermaidBlock code={NO_FRONTMATTER} />);
    await waitFor(() => {
      expect(view.container.querySelector('svg')).not.toBeNull();
    });
    const firstId = renderMock.mock.calls[0][0];
    expect(firstId).toMatch(/^mermaid-\d+$/);

    view.rerender(<MermaidBlock code={'sequenceDiagram\n  Alice->>Bob: Hi'} />);
    await waitFor(() => {
      expect(renderMock).toHaveBeenCalledTimes(2);
    });
    const secondId = renderMock.mock.calls[1][0];
    expect(secondId).not.toBe(firstId);
    expect(renderMock).toHaveBeenLastCalledWith(secondId, 'sequenceDiagram\n  Alice->>Bob: Hi');
    await waitFor(() => {
      expect(view.container.querySelector(`svg[id="${secondId}"]`)).not.toBeNull();
    });
  });

  it('toggles tabs, highlights the source, copies it and reverts the label', async () => {
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
    const { container } = render(<MermaidBlock code={NO_FRONTMATTER} />);
    await waitFor(() => {
      expect(codeToHtmlMock).toHaveBeenCalled();
    });
    // Preview tab is active and shows the rendered svg.
    expect(container.querySelector('svg')).not.toBeNull();
    expect(screen.getByText('Diagram Preview')).toHaveClass('bg-white/10');
    expect(screen.getByText('Code')).not.toHaveClass('bg-white/10');
    expect(screen.queryByText('Copy')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('Code'));
    expect(screen.getByText('Code')).toHaveClass('bg-white/10');
    expect(container.querySelector('.shiki-wrapper')?.innerHTML).toBe(SHIKI_HTML);
    expect(codeToHtmlMock).toHaveBeenCalledWith(NO_FRONTMATTER, {
      lang: 'mermaid',
      theme: 'github-dark',
    });

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    fireEvent.click(screen.getByText('Copy'));
    expect(writeText).toHaveBeenCalledWith(NO_FRONTMATTER);
    expect(screen.getByText('Copied')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.getByText('Copy')).toBeInTheDocument();
    expect(screen.queryByText('Copied')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('Diagram Preview'));
    expect(container.querySelector('svg')).not.toBeNull();
    expect(container.querySelector('.shiki-wrapper')).toBeNull();
  });

  it('shows the plain pre fallback while highlighting is pending and ignores late results', async () => {
    let resolveHtml!: (value: string) => void;
    codeToHtmlMock.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          resolveHtml = resolve;
        }),
    );
    const view = render(<MermaidBlock code={NO_FRONTMATTER} />);
    // The svg renders independently of highlighting.
    await waitFor(() => {
      expect(view.container.querySelector('svg')).not.toBeNull();
    });
    fireEvent.click(screen.getByText('Code'));
    // The highlighted state is still '' → plain <pre> with the raw code.
    expect(view.container.querySelector('.shiki-wrapper')).toBeNull();
    expect(screen.getByText(/graph TD/)).toBeInTheDocument();

    view.unmount();
    await act(async () => {
      resolveHtml(LATE_HTML);
      await flushAsync();
    });
    // The cancelled guard drops results that arrive after unmount.
    expect(view.container.querySelector('.shiki-wrapper')).toBeNull();
  });

  it('falls back to the text grammar when the mermaid grammar is unavailable', async () => {
    codeToHtmlMock.mockRejectedValueOnce(new Error('No shiki grammar for mermaid'));
    const { container } = render(<MermaidBlock code={NO_FRONTMATTER} />);
    // The highlighted html is only mounted on the code tab.
    fireEvent.click(screen.getByText('Code'));
    // While the first attempt is failing, the plain pre fallback shows.
    expect(container.querySelector('pre')).not.toBeNull();
    await waitFor(() => {
      expect(container.querySelector('.shiki-wrapper')).not.toBeNull();
    });
    expect(container.querySelector('.shiki-wrapper')?.innerHTML).toBe(SHIKI_HTML);
    expect(codeToHtmlMock).toHaveBeenCalledTimes(2);
    expect(codeToHtmlMock).toHaveBeenNthCalledWith(1, NO_FRONTMATTER, {
      lang: 'mermaid',
      theme: 'github-dark',
    });
    expect(codeToHtmlMock).toHaveBeenNthCalledWith(2, NO_FRONTMATTER, {
      lang: 'text',
      theme: 'github-dark',
    });
  });

  it('passes the raw code through when frontmatter parsing throws', async () => {
    // With a string code the YAML loop can never throw, so simulate a hostile
    // runtime value: an object whose match() returns a "frontmatter" that
    // explodes on split(). The catch branch must fall back to the raw code.
    const evil = {
      match: (_regex: RegExp) =>
        [
          'whole',
          {
            split: () => {
              throw new Error('yaml exploded');
            },
          },
          NO_FRONTMATTER,
        ] as unknown as RegExpMatchArray,
    } as unknown as string;

    render(<MermaidBlock code={evil} />);
    await waitFor(() => {
      expect(renderMock).toHaveBeenCalled();
    });
    // The ORIGINAL code value (not the fake match[2]) reaches mermaid.render,
    // no config was parsed, and no error UI is shown.
    expect(renderMock).toHaveBeenCalledWith(expect.stringMatching(/^mermaid-\d+$/), evil);
    expect(initializeMock).not.toHaveBeenCalled();
    expect(screen.queryByText(/Mermaid error:/)).not.toBeInTheDocument();
  });

  it('configures mermaid once at module load with neutral defaults', async () => {
    vi.resetModules();
    await import('../components/MermaidBlock');
    expect(initializeMock).toHaveBeenCalledTimes(1);
    expect(initializeMock).toHaveBeenCalledWith({
      startOnLoad: false,
      theme: 'neutral',
      securityLevel: 'loose',
    });
  });
});