import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import SlashCommandMenu from '../components/SlashCommandMenu';

// The command registry merges 14 hard-coded base commands with the 5 callout
// types auto-generated from src/lib/callouts.ts — 19 entries in total.
const TOTAL_COMMANDS = 19;

/**
 * Render the menu with controlled props. The menu is driven entirely through
 * props (visible / position / filter) and window-level key events, so no
 * parent editor scaffolding is needed.
 */
function renderMenu({ visible = true, filter = '' }: { visible?: boolean; filter?: string } = {}) {
  const onSelect = vi.fn();
  const onClose = vi.fn();
  const view = render(
    <SlashCommandMenu
      visible={visible}
      position={{ top: 120, left: 40 }}
      filter={filter}
      onSelect={onSelect}
      onClose={onClose}
    />,
  );
  return { onSelect, onClose, ...view };
}

describe('SlashCommandMenu component', () => {
  it('renders nothing and attaches no keydown listener while hidden', () => {
    const addSpy = vi.spyOn(document, 'addEventListener');
    const { onSelect, onClose, container } = renderMenu({ visible: false });

    expect(container.querySelector('.slash-menu')).toBeNull();
    // The keyboard effect early-returns before subscribing to the document.
    expect(addSpy).not.toHaveBeenCalledWith('keydown', expect.any(Function));
    // With no handler attached the events are left unprevented and ignored.
    expect(fireEvent.keyDown(document, { key: 'ArrowDown' })).toBe(true);
    expect(fireEvent.keyDown(document, { key: 'Enter' })).toBe(true);
    expect(onSelect).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('renders nothing for a filter with no matches while keys stay live', () => {
    const { onSelect, onClose, container } = renderMenu({ filter: 'zzz-no-match' });

    expect(container.querySelector('.slash-menu')).toBeNull();
    // The keydown handler is still attached with an empty list: Enter finds
    // no command at the active index and must not select anything…
    expect(fireEvent.keyDown(document, { key: 'Enter' })).toBe(false);
    expect(onSelect).not.toHaveBeenCalled();
    // …while Escape still closes the (invisible) menu.
    expect(fireEvent.keyDown(document, { key: 'Escape' })).toBe(false);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('renders every command at the given position with the first one active', () => {
    const { container } = renderMenu();

    const menu = container.querySelector<HTMLElement>('.slash-menu');
    expect(menu).not.toBeNull();
    expect(menu?.style.top).toBe('120px');
    expect(menu?.style.left).toBe('40px');

    const items = container.querySelectorAll('.slash-menu-item');
    expect(items).toHaveLength(TOTAL_COMMANDS);
    items.forEach((item, i) => {
      if (i === 0) expect(item).toHaveClass('active');
      else expect(item).not.toHaveClass('active');
    });
    // Base commands…
    expect(screen.getByText('Heading 1')).toBeInTheDocument();
    expect(screen.getByText('Code Block')).toBeInTheDocument();
    expect(screen.getByText('Table')).toBeInTheDocument();
    expect(screen.getByText('Mermaid Diagram')).toBeInTheDocument();
    expect(screen.getByText('GeoJSON Map')).toBeInTheDocument();
    expect(screen.getByText('3D Model')).toBeInTheDocument();
    // …and the callout commands generated from the registry.
    expect(screen.getByText('Note Callout')).toBeInTheDocument();
    expect(screen.getByText('Tip Callout')).toBeInTheDocument();
    expect(screen.getByText('Important Callout')).toBeInTheDocument();
    expect(screen.getByText('Warning Callout')).toBeInTheDocument();
    expect(screen.getByText('Caution Callout')).toBeInTheDocument();
  });

  it('filters by label substring case-insensitively', () => {
    const { container } = renderMenu({ filter: 'HEADING' });

    const labels = [...container.querySelectorAll('.slash-menu-item')].map(
      (item) => item.querySelector('.font-medium')?.textContent,
    );
    expect(labels).toEqual(['Heading 1', 'Heading 2', 'Heading 3']);
  });

  it('falls back to matching the description when the label does not match', () => {
    // 'fenced' only appears in the Code Block description, never in a label.
    const { container } = renderMenu({ filter: 'fenced' });

    const items = container.querySelectorAll('.slash-menu-item');
    expect(items).toHaveLength(1);
    expect(items[0]).toHaveTextContent('Code Block');
  });

  it('resets the active item to the first match whenever the filter changes', () => {
    const view = renderMenu();
    let items = view.container.querySelectorAll('.slash-menu-item');
    fireEvent.mouseOver(items[2]); // 'Heading 3' under the empty filter
    expect(items[2]).toHaveClass('active');

    view.rerender(
      <SlashCommandMenu
        visible
        position={{ top: 120, left: 40 }}
        filter="head"
        onSelect={view.onSelect}
        onClose={view.onClose}
      />,
    );
    // The filter-change effect snaps the highlight back to index 0.
    items = view.container.querySelectorAll('.slash-menu-item');
    expect(items[0]).toHaveClass('active');
    expect(items[0]).toHaveTextContent('Heading 1');
    expect(items[2]).not.toHaveClass('active');
  });

  it('moves the active item down with ArrowDown and clamps at the last match', () => {
    const { container, onSelect } = renderMenu({ filter: 'head' });
    const items = () => container.querySelectorAll('.slash-menu-item');

    // preventDefault() marks the key as consumed for the host editor.
    expect(fireEvent.keyDown(document, { key: 'ArrowDown' })).toBe(false);
    expect(items()[1]).toHaveClass('active');
    expect(items()[0]).not.toHaveClass('active');

    expect(fireEvent.keyDown(document, { key: 'ArrowDown' })).toBe(false);
    expect(items()[2]).toHaveClass('active');

    // Pressing past the end clamps at the last item instead of wrapping.
    fireEvent.keyDown(document, { key: 'ArrowDown' });
    fireEvent.keyDown(document, { key: 'ArrowDown' });
    expect(items()[2]).toHaveClass('active');
    expect(items()[1]).not.toHaveClass('active');
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('moves the active item up with ArrowUp and clamps at the first item', () => {
    const { container } = renderMenu();
    const items = container.querySelectorAll('.slash-menu-item');

    fireEvent.keyDown(document, { key: 'ArrowDown' });
    fireEvent.keyDown(document, { key: 'ArrowDown' });
    expect(items[2]).toHaveClass('active');

    fireEvent.keyDown(document, { key: 'ArrowUp' });
    expect(items[1]).toHaveClass('active');
    expect(items[2]).not.toHaveClass('active');

    // Pressing past the top clamps at index 0 instead of going negative.
    fireEvent.keyDown(document, { key: 'ArrowUp' });
    fireEvent.keyDown(document, { key: 'ArrowUp' });
    fireEvent.keyDown(document, { key: 'ArrowUp' });
    expect(items[0]).toHaveClass('active');
    expect(items[1]).not.toHaveClass('active');
  });

  it('scrolls each newly active item into view while arrowing through the overflowed list', () => {
    const scrolled: HTMLElement[] = [];
    const original = HTMLElement.prototype.scrollIntoView;
    // jsdom does not implement scrollIntoView; stub it so we can observe calls.
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      writable: true,
      value: function (this: HTMLElement) {
        scrolled.push(this);
      },
    });
    try {
      const { container } = renderMenu();
      const items = container.querySelectorAll<HTMLElement>('.slash-menu-item');

      // Drive the highlight deep into a list that overflows max-h-64.
      for (let i = 0; i < 6; i++) {
        fireEvent.keyDown(document, { key: 'ArrowDown' });
      }
      // The last scroll request must target the newly focused, off-screen item.
      expect(scrolled[scrolled.length - 1]).toBe(items[6]);
      expect(items[6]).toHaveClass('active');

      // Arrowing back up keeps the focus item scrolled into view too.
      fireEvent.keyDown(document, { key: 'ArrowUp' });
      expect(scrolled[scrolled.length - 1]).toBe(items[5]);
    } finally {
      Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
        configurable: true,
        writable: true,
        value: original,
      });
    }
  });

  it('selects the active command on Enter', () => {
    const { onSelect } = renderMenu({ filter: 'head' });

    fireEvent.keyDown(document, { key: 'ArrowDown' }); // 'Heading 2' becomes active
    expect(fireEvent.keyDown(document, { key: 'Enter' })).toBe(false);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        label: 'Heading 2',
        description: 'Medium heading',
        insert: '## ',
      }),
    );
  });

  it('closes on Escape without selecting anything', () => {
    const { onSelect, onClose } = renderMenu({ filter: 'head' });

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('selects a command on click with its exact insert payload', () => {
    const { onSelect } = renderMenu();

    fireEvent.click(screen.getByText('Table').closest('.slash-menu-item') as HTMLElement);
    expect(onSelect).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        label: 'Table',
        description: 'Markdown table',
        insert: '| Column 1 | Column 2 |\n| --- | --- |\n| Cell | Cell |',
      }),
    );

    // Callout commands are generated from the registry with block syntax.
    fireEvent.click(screen.getByText('Note Callout').closest('.slash-menu-item') as HTMLElement);
    expect(onSelect).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        label: 'Note Callout',
        description: 'Note callout block',
        insert: '> [!NOTE]\n> Your note here',
      }),
    );
  });

  it('activates an item on hover so Enter selects it', () => {
    const { onSelect, container } = renderMenu();

    const quoteItem = screen.getByText('Quote').closest('.slash-menu-item');
    expect(quoteItem).not.toBeNull();
    fireEvent.mouseOver(quoteItem as HTMLElement);
    expect(quoteItem).toHaveClass('active');

    fireEvent.keyDown(document, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        label: 'Quote',
        description: 'Block quote',
        insert: '> ',
      }),
    );
    expect(container.querySelectorAll('.slash-menu-item')).toHaveLength(TOTAL_COMMANDS);
  });

  it('stops handling keys after unmount by removing the document listener', () => {
    const removeSpy = vi.spyOn(document, 'removeEventListener');
    const view = renderMenu();

    view.unmount();
    expect(removeSpy).toHaveBeenCalledWith('keydown', expect.any(Function));
    expect(fireEvent.keyDown(document, { key: 'Enter' })).toBe(true);
    expect(view.onSelect).not.toHaveBeenCalled();
    expect(view.onClose).not.toHaveBeenCalled();
  });
});