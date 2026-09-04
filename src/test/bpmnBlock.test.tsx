import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import BpmnBlock from '../components/BpmnBlock';

// BpmnBlock imports the bpmn-js Viewer statically at module scope and calls
// layoutProcess from bpmn-auto-layout inside its viewer effect, so both mocks
// must be in place before the component import. vi.mock is hoisted; the
// factories are fed from vi.hoisted state so each test can decide how
// importXML settles.
const viewerState = vi.hoisted(() => ({
  created: [] as Array<{
    options: { container: HTMLElement };
    importXML: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
  }>,
  importXMLImpl: null as null | ((xml: string) => Promise<void>),
}));
const { layoutProcessMock, codeToHtmlMock } = vi.hoisted(() => ({
  layoutProcessMock: vi.fn(),
  codeToHtmlMock: vi.fn(),
}));

vi.mock('bpmn-js/lib/Viewer', () => {
  class FakeBpmnViewer {
    options: { container: HTMLElement };
    importXML: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
    constructor(options: { container: HTMLElement }) {
      this.options = options;
      this.importXML = vi.fn((xml: string) =>
        viewerState.importXMLImpl ? viewerState.importXMLImpl(xml) : Promise.resolve(),
      );
      this.destroy = vi.fn();
      viewerState.created.push(this);
    }
  }
  return { default: FakeBpmnViewer };
});
vi.mock('bpmn-auto-layout', () => ({ layoutProcess: layoutProcessMock }));
// The component highlights its source through a dynamic import('shiki') —
// stub it the same way codeblock.test.tsx does.
vi.mock('shiki', () => ({ codeToHtml: codeToHtmlMock }));

const SHIKI_HTML = '<pre data-testid="shiki-bpmn">highlighted-diagram</pre>';
const LAID_OUT_XML =
  '<bpmn:definitions><bpmn:process id="P1"/><bpmndi:BPMNDiagram id="Layout_1"/></bpmn:definitions>';
const DIAGRAM_XML =
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" targetNamespace="http://bpmn.io/schema/bpmn">' +
  '<bpmn:process id="Process_1"><bpmn:startEvent id="Start_1"/></bpmn:process>' +
  '<bpmndi:BPMNDiagram id="Diagram_1">' +
  '<bpmndi:BPMNPlane id="Plane_1" bpmnElement="Process_1"/>' +
  '</bpmndi:BPMNDiagram>' +
  '</bpmn:definitions>';
// Pretty-printed by formatXml(): what the code view, the clipboard and
// codeToHtml all receive instead of the one-line prop.
const FORMATTED_DIAGRAM_XML = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" targetNamespace="http://bpmn.io/schema/bpmn">',
  '  <bpmn:process id="Process_1">',
  '    <bpmn:startEvent id="Start_1"/>',
  '  </bpmn:process>',
  '  <bpmndi:BPMNDiagram id="Diagram_1">',
  '    <bpmndi:BPMNPlane id="Plane_1" bpmnElement="Process_1"/>',
  '  </bpmndi:BPMNDiagram>',
  '</bpmn:definitions>',
].join('\n');
const SECOND_XML =
  '<bpmn:definitions><bpmn:process id="P2"/><bpmndi:BPMNDiagram id="D2"/></bpmn:definitions>';
const FORMATTED_SECOND_XML = [
  '<bpmn:definitions>',
  '  <bpmn:process id="P2"/>',
  '  <bpmndi:BPMNDiagram id="D2"/>',
  '</bpmn:definitions>',
].join('\n');
// The leading newline exercises the blank-line filter in formatXml(), and the
// missing <bpmndi: section forces the layoutProcess path in the viewer effect.
const PLAIN_XML =
  '\n<bpmn:definitions><bpmn:process id="P1"><bpmn:task id="T1"/></bpmn:process></bpmn:definitions>';
const flushAsync = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Make the next importXML return a promise this test settles manually. */
function deferImportXML(): { resolve: () => void; reject: (err: unknown) => void } {
  let resolve!: () => void;
  let reject!: (err: unknown) => void;
  viewerState.importXMLImpl = () =>
    new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
  return {
    resolve: () => resolve(),
    reject: (err: unknown) => reject(err),
  };
}

describe('BpmnBlock component', () => {
  beforeEach(() => {
    viewerState.created.length = 0;
    viewerState.importXMLImpl = null;
    layoutProcessMock.mockReset();
    layoutProcessMock.mockResolvedValue(LAID_OUT_XML);
    codeToHtmlMock.mockReset();
    codeToHtmlMock.mockResolvedValue(SHIKI_HTML);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('mounts the viewer, imports the xml and hides the loading overlay', async () => {
    const view = render(<BpmnBlock code={DIAGRAM_XML} />);
    // The overlay shows while the first importXML is still pending.
    expect(screen.getByText('Loading diagram…')).toBeInTheDocument();
    expect(screen.getByText('bpmn')).toBeInTheDocument();
    expect(screen.getByText('Diagram Preview')).toHaveClass('bg-white/10');
    expect(screen.getByText('Code')).not.toHaveClass('bg-white/10');

    await waitFor(() => {
      expect(viewerState.created).toHaveLength(1);
    });
    const viewer = viewerState.created[0];
    // The viewer is attached to the preview container div.
    expect(viewer.options.container).toBe(view.container.querySelector('.relative > .w-full'));
    expect(viewer.options.container.className).toBe('h-[420px] w-full');
    // The code already contains a DI section, so auto-layout must not run and
    // the raw code reaches importXML untouched.
    expect(layoutProcessMock).not.toHaveBeenCalled();
    expect(viewer.importXML).toHaveBeenCalledTimes(1);
    expect(viewer.importXML).toHaveBeenCalledWith(DIAGRAM_XML);

    await waitFor(() => {
      expect(screen.queryByText('Loading diagram…')).not.toBeInTheDocument();
    });
    expect(screen.queryByText(/BPMN error:/)).not.toBeInTheDocument();
    // Preview tab is active: the highlighted source stays hidden.
    expect(view.container.querySelector('.shiki-wrapper')).toBeNull();
    expect(codeToHtmlMock).toHaveBeenCalledWith(FORMATTED_DIAGRAM_XML, {
      lang: 'xml',
      theme: 'github-dark',
    });
  });

  it('auto-layouts xml that has no Diagram Interchange section', async () => {
    render(<BpmnBlock code={PLAIN_XML} />);
    await waitFor(() => {
      expect(viewerState.created).toHaveLength(1);
    });
    expect(layoutProcessMock).toHaveBeenCalledTimes(1);
    expect(layoutProcessMock).toHaveBeenCalledWith(PLAIN_XML);
    expect(viewerState.created[0].importXML).toHaveBeenCalledWith(LAID_OUT_XML);
    await waitFor(() => {
      expect(screen.queryByText('Loading diagram…')).not.toBeInTheDocument();
    });
    expect(screen.queryByText(/BPMN error:/)).not.toBeInTheDocument();
  });

  it('shows the error UI when importXML rejects and cannot recover from a new code', async () => {
    viewerState.importXMLImpl = () => Promise.reject(new Error('unexpected element <boom>'));
    const view = render(<BpmnBlock code={DIAGRAM_XML} />);
    await waitFor(() => {
      expect(screen.getByText(/BPMN error:/)).toBeInTheDocument();
    });
    expect(screen.getByText('BPMN error: unexpected element <boom>')).toBeInTheDocument();
    // The error banner replaces the whole preview pane.
    expect(view.container.querySelector('.relative')).toBeNull();
    expect(view.container.querySelector('pre')).toBeNull();

    // Rerendering with a different code cannot recover: the error banner has
    // removed the container div, so the viewer effect early-returns and no
    // second viewer or importXML is ever created. Only unmounting helps.
    view.rerender(<BpmnBlock code={SECOND_XML} />);
    expect(viewerState.created).toHaveLength(1);
    expect(viewerState.created[0].importXML).toHaveBeenCalledTimes(1);
    expect(viewerState.created[0].importXML).toHaveBeenLastCalledWith(DIAGRAM_XML);
    expect(viewerState.created[0].destroy).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/BPMN error:/)).toBeInTheDocument();
  });

  it('stringifies non-Error rejections from auto-layout', async () => {
    layoutProcessMock.mockRejectedValue('auto-layout exploded');
    render(<BpmnBlock code={PLAIN_XML} />);
    await waitFor(() => {
      expect(screen.getByText('BPMN error: auto-layout exploded')).toBeInTheDocument();
    });
  });

  it('destroys the viewer on unmount', async () => {
    const view = render(<BpmnBlock code={DIAGRAM_XML} />);
    await waitFor(() => {
      expect(viewerState.created).toHaveLength(1);
    });
    view.unmount();
    expect(viewerState.created[0].destroy).toHaveBeenCalledTimes(1);
  });

  it('destroys the old viewer and imports again when the code prop changes', async () => {
    const view = render(<BpmnBlock code={DIAGRAM_XML} />);
    await waitFor(() => {
      expect(viewerState.created).toHaveLength(1);
    });
    view.rerender(<BpmnBlock code={SECOND_XML} />);
    await waitFor(() => {
      expect(viewerState.created).toHaveLength(2);
    });
    expect(viewerState.created[0].destroy).toHaveBeenCalledTimes(1);
    expect(viewerState.created[1].destroy).not.toHaveBeenCalled();
    expect(viewerState.created[1].importXML).toHaveBeenCalledTimes(1);
    expect(viewerState.created[1].importXML).toHaveBeenCalledWith(SECOND_XML);
    // Highlighting also re-runs for the new formatted source.
    await waitFor(() => {
      expect(codeToHtmlMock).toHaveBeenCalledTimes(2);
    });
    expect(codeToHtmlMock).toHaveBeenLastCalledWith(FORMATTED_SECOND_XML, {
      lang: 'xml',
      theme: 'github-dark',
    });
  });

  it('early-returns on the code tab and recreates the viewer on the preview tab', async () => {
    const view = render(<BpmnBlock code={DIAGRAM_XML} />);
    await waitFor(() => {
      expect(viewerState.created).toHaveLength(1);
    });
    await waitFor(() => {
      expect(codeToHtmlMock).toHaveBeenCalled();
    });

    // Switch to the code tab: the preview container is unmounted, so the
    // viewer effect destroys the old viewer and early-returns.
    fireEvent.click(screen.getByText('Code'));
    expect(viewerState.created).toHaveLength(1);
    expect(viewerState.created[0].destroy).toHaveBeenCalledTimes(1);
    expect(view.container.querySelector('.shiki-wrapper')?.innerHTML).toBe(SHIKI_HTML);
    expect(view.container.querySelector('.relative')).toBeNull();

    // Switch back: the container div remounts and a fresh viewer imports.
    fireEvent.click(screen.getByText('Diagram Preview'));
    await waitFor(() => {
      expect(viewerState.created).toHaveLength(2);
    });
    expect(viewerState.created[1].importXML).toHaveBeenCalledWith(DIAGRAM_XML);
    expect(viewerState.created[1].destroy).not.toHaveBeenCalled();
    expect(view.container.querySelector('.relative')).not.toBeNull();
    expect(view.container.querySelector('.shiki-wrapper')).toBeNull();
  });

  it('copies the formatted xml on the code tab and reverts the label after two seconds', async () => {
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
    render(<BpmnBlock code={DIAGRAM_XML} />);
    await waitFor(() => {
      expect(codeToHtmlMock).toHaveBeenCalled();
    });
    // The copy button only exists on the code tab.
    expect(screen.queryByText('Copy')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Code'));

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    fireEvent.click(screen.getByText('Copy'));
    // The clipboard receives the pretty-printed xml, not the one-line prop.
    expect(writeText).toHaveBeenCalledWith(FORMATTED_DIAGRAM_XML);
    expect(screen.getByText('Copied')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.getByText('Copy')).toBeInTheDocument();
    expect(screen.queryByText('Copied')).not.toBeInTheDocument();
  });

  it('shows the plain pre fallback while highlighting is pending and drops late results', async () => {
    let resolveHtml!: (value: string) => void;
    codeToHtmlMock.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          resolveHtml = resolve;
        }),
    );
    const view = render(<BpmnBlock code={DIAGRAM_XML} />);
    // The diagram renders independently of highlighting.
    await waitFor(() => {
      expect(viewerState.created).toHaveLength(1);
    });
    fireEvent.click(screen.getByText('Code'));
    // The highlighted state is still '' → plain <pre> with the formatted xml.
    expect(view.container.querySelector('.shiki-wrapper')).toBeNull();
    expect(screen.getByText(/bpmn:process id="Process_1"/)).toBeInTheDocument();

    view.unmount();
    await act(async () => {
      resolveHtml(SHIKI_HTML);
      await flushAsync();
    });
    // The cancelled guard drops results that arrive after unmount.
    expect(view.container.querySelector('.shiki-wrapper')).toBeNull();
  });

  it('falls back to the text grammar when the xml grammar is unavailable', async () => {
    codeToHtmlMock.mockRejectedValueOnce(new Error('No shiki grammar for xml'));
    const view = render(<BpmnBlock code={DIAGRAM_XML} />);
    // The highlighted html is only mounted on the code tab.
    fireEvent.click(screen.getByText('Code'));
    // While the first attempt is failing, the plain pre fallback shows.
    expect(view.container.querySelector('pre')).not.toBeNull();
    await waitFor(() => {
      expect(view.container.querySelector('.shiki-wrapper')).not.toBeNull();
    });
    expect(view.container.querySelector('.shiki-wrapper')?.innerHTML).toBe(SHIKI_HTML);
    expect(codeToHtmlMock).toHaveBeenCalledTimes(2);
    expect(codeToHtmlMock).toHaveBeenNthCalledWith(1, FORMATTED_DIAGRAM_XML, {
      lang: 'xml',
      theme: 'github-dark',
    });
    expect(codeToHtmlMock).toHaveBeenNthCalledWith(2, FORMATTED_DIAGRAM_XML, {
      lang: 'text',
      theme: 'github-dark',
    });
  });

  it('ignores importXML settling after unmount', async () => {
    // Late resolution after unmount: the success path must not touch state.
    const settledResolve = deferImportXML();
    const first = render(<BpmnBlock code={DIAGRAM_XML} />);
    await waitFor(() => {
      expect(viewerState.created).toHaveLength(1);
    });
    first.unmount();
    await act(async () => {
      settledResolve.resolve();
      await flushAsync();
    });
    expect(viewerState.created[0].destroy).toHaveBeenCalledTimes(1);

    // Late rejection after unmount: the catch path must not touch state either.
    const settledReject = deferImportXML();
    const second = render(<BpmnBlock code={SECOND_XML} />);
    await waitFor(() => {
      expect(viewerState.created).toHaveLength(2);
    });
    second.unmount();
    await act(async () => {
      settledReject.reject(new Error('late failure'));
      await flushAsync();
    });
    expect(viewerState.created[1].destroy).toHaveBeenCalledTimes(1);
  });
});