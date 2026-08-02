import { afterEach, describe, expect, it, vi } from 'vitest';

import { SheetEditor } from './sheet-editor';

describe('sheet-editor CSV quick editing', () => {
  afterEach(() => document.body.replaceChildren());

  const create = (source = ''): SheetEditor => {
    const element = new SheetEditor();
    element.setContent(source);
    document.body.append(element);
    return element;
  };

  it('starts with Enter, exposes the live draft, cancels with Escape, and emits exact content', () => {
    const element = create('a,b');
    const listener = vi.fn();
    element.addEventListener('content-change', listener);

    activeCell(element).dispatchEvent(key('Enter'));
    const textarea = editControl(element);
    expect(textarea.value).toBe('a');
    expect(textarea.getAttribute('aria-label')).toBe('Edit A1');
    expect(listener).not.toHaveBeenCalled();

    input(textarea, 'changed');
    expect(element.getContent()).toBe('changed,b');
    expect(listener).toHaveBeenLastCalledWith(
      expect.objectContaining({ detail: { content: 'changed,b' } })
    );

    textarea.dispatchEvent(key('Escape'));
    expect(element.getContent()).toBe('a,b');
    expect(element.shadowRoot?.querySelector('textarea')).toBeNull();
    expect(listener).toHaveBeenLastCalledWith(
      expect.objectContaining({ detail: { content: 'a,b' } })
    );
  });

  it('commits with Enter/Shift+Enter and moves by merged-aware geometry without duplicate events', () => {
    const element = create('a\nb\nc');
    const listener = vi.fn();
    element.addEventListener('content-change', listener);

    activeCell(element).dispatchEvent(key('Enter'));
    input(editControl(element), 'A');
    expect(listener).toHaveBeenCalledTimes(1);
    editControl(element).dispatchEvent(key('Enter'));
    expect(activeCell(element).dataset.row).toBe('1');
    expect(listener).toHaveBeenCalledTimes(1);

    activeCell(element).dispatchEvent(key('Enter'));
    input(editControl(element), 'B');
    editControl(element).dispatchEvent(key('Enter', { shiftKey: true }));
    expect(activeCell(element).dataset.row).toBe('0');
    expect(element.getContent()).toBe('A\nB\nc');
  });

  it.each([
    ['ArrowRight', '0', '1'],
    ['ArrowLeft', '1', '0'],
    ['ArrowDown', '1', '0'],
    ['ArrowUp', '0', '1'],
  ])('commits with %s and moves to %s:%s', (arrow, row, column) => {
    const element = create('a,b\nc,d');
    if (arrow === 'ArrowLeft' || arrow === 'ArrowUp') {
      activeCell(element).dispatchEvent(key('ArrowDown'));
      activeCell(element).dispatchEvent(key('ArrowRight'));
    }
    activeCell(element).dispatchEvent(key('Enter'));
    input(editControl(element), 'value');
    editControl(element).dispatchEvent(key(arrow));

    expect(activeCell(element).dataset).toMatchObject({ row, column });
  });

  it('direct printable input replaces the value while command shortcuts do not enter edit', () => {
    const element = create('old');
    activeCell(element).dispatchEvent(key('x'));
    expect(editControl(element).value).toBe('x');
    expect(element.getContent()).toBe('x');
    editControl(element).dispatchEvent(key('Escape'));

    activeCell(element).dispatchEvent(key('c', { ctrlKey: true }));
    expect(element.shadowRoot?.querySelector('textarea')).toBeNull();
  });

  it('commits before pointer selection or external focus leaves the editor', () => {
    const element = create('a,b');
    activeCell(element).dispatchEvent(key('Enter'));
    input(editControl(element), 'first');
    pointerDown(dataCell(element, 0, 1));
    expect(element.getContent()).toBe('first,b');
    expect(activeCell(element).dataset.column).toBe('1');

    activeCell(element).dispatchEvent(key('Enter'));
    input(editControl(element), 'second');
    const outside = document.createElement('button');
    document.body.append(outside);
    editControl(element).dispatchEvent(
      new FocusEvent('focusout', { bubbles: true, relatedTarget: outside })
    );
    expect(element.getContent()).toBe('first,second');
    expect(element.shadowRoot?.querySelector('textarea')).toBeNull();
  });

  it('cancels an open draft on readonly/load transitions and uses the family attribute convention', () => {
    const element = create('a');
    const listener = vi.fn();
    element.addEventListener('content-change', listener);
    activeCell(element).dispatchEvent(key('Enter'));
    input(editControl(element), 'draft');

    element.setAttribute('readonly', 'true');
    expect(element.getContent()).toBe('a');
    expect(element.shadowRoot?.querySelector('[role="grid"]')?.getAttribute('aria-readonly')).toBe(
      'true'
    );
    expect(listener).toHaveBeenCalledTimes(2);
    activeCell(element).dispatchEvent(key('Enter'));
    expect(element.shadowRoot?.querySelector('textarea')).toBeNull();

    element.setAttribute('readonly', 'false');
    activeCell(element).dispatchEvent(key('Enter'));
    input(editControl(element), 'discarded');
    const eventCount = listener.mock.calls.length;
    element.setContent('replacement');
    expect(element.getContent()).toBe('replacement');
    expect(listener).toHaveBeenCalledTimes(eventCount);
  });

  it('materializes only a changed virtual row/column and preserves explicit cleared shape', () => {
    const element = create('a\nb');
    pointerDown(dataCell(element, 0, 1));
    activeCell(element).dispatchEvent(key('Enter'));
    input(editControl(element), 'x');
    editControl(element).dispatchEvent(key('Enter'));
    expect(element.getContent()).toBe('a,x\nb');

    const empty = create('');
    activeCell(empty).dispatchEvent(key('Enter'));
    editControl(empty).dispatchEvent(key('Enter'));
    expect(empty.getContent()).toBe('');
    expect(activeCell(empty).dataset.row).toBe('0');

    const clearing = create('a,b');
    pointerDown(dataCell(clearing, 0, 1));
    activeCell(clearing).dispatchEvent(key('Enter'));
    input(editControl(clearing), '');
    editControl(clearing).dispatchEvent(key('Enter'));
    expect(clearing.getContent()).toBe('a,');
  });

  it('exposes a new trailing edge after materializing a virtual cell', () => {
    const element = create('a');
    activeCell(element).dispatchEvent(key('ArrowRight'));
    activeCell(element).dispatchEvent(key('x'));
    editControl(element).dispatchEvent(key('ArrowRight'));

    expect(element.getContent()).toBe('a,x');
    expect(activeCell(element).dataset.column).toBe('2');
  });

  it('restores exact original bytes at semantic baseline and preserves source style after edits', () => {
    const source = '\uFEFF"a",b\n';
    const element = create(source);
    activeCell(element).dispatchEvent(key('Enter'));
    input(editControl(element), 'changed');
    expect(element.getContent()).toBe('\uFEFFchanged,b\n');
    input(editControl(element), 'a');
    expect(element.getContent()).toBe(source);

    input(editControl(element), 'final');
    editControl(element).dispatchEvent(key('Enter'));
    expect(element.getContent()).toBe('\uFEFFfinal,b\n');
  });

  it('canonicalizes mixed endings only after a real edit and keeps formula-looking values literal', () => {
    const source = 'a\r\nb\nc';
    const element = create(source);
    expect(element.getContent()).toBe(source);
    activeCell(element).dispatchEvent(key('='));
    input(editControl(element), '=SUM(A1)');
    editControl(element).dispatchEvent(key('Enter'));
    expect(element.getContent()).toBe('=SUM(A1)\r\nb\r\nc');
  });

  it('rejects oversized cell and serialized-source candidates atomically', () => {
    const element = create('a');
    activeCell(element).dispatchEvent(key('Enter'));
    const textarea = editControl(element);
    input(textarea, 'x'.repeat(64 * 1024 + 1));
    expect(textarea.value).toBe('a');
    expect(element.getContent()).toBe('a');
    expect(element.shadowRoot?.querySelector('#sheet-editor-limit-notice')?.textContent).toContain(
      '65,536-byte limit'
    );

    const largeCell = 'x'.repeat(64 * 1024 - 1);
    const nearLimit = create([largeCell, largeCell, largeCell, largeCell].join('\n'));
    activeCell(nearLimit).dispatchEvent(key('Enter'));
    const largeTextarea = editControl(nearLimit);
    input(largeTextarea, `,${'x'.repeat(64 * 1024 - 2)}`);
    expect(largeTextarea.value).toBe(largeCell);
    expect(
      nearLimit.shadowRoot?.querySelector('#sheet-editor-limit-notice')?.textContent
    ).toContain('262,144-byte limit');
  });

  it('locks truncated loads against editing while retaining exact source', () => {
    const source = Array.from({ length: 1001 }, (_, index) => String(index)).join('\n');
    const element = create(source);
    const scroll = element.shadowRoot?.querySelector<HTMLElement>('.sheet-surface__scroll');
    scroll?.dispatchEvent(key('Enter'));

    expect(element.shadowRoot?.querySelector('textarea')).toBeNull();
    expect(element.getContent()).toBe(source);
    expect(element.shadowRoot?.querySelector('.sheet-surface__notice')?.textContent).toContain(
      'Editing is unavailable because not all rows were loaded'
    );
  });

  it('keeps native textarea undo and IME keys inside the open draft', () => {
    const element = create('a');
    activeCell(element).dispatchEvent(key('Enter'));
    const textarea = editControl(element);
    const undo = key('z', { ctrlKey: true });
    textarea.dispatchEvent(undo);
    expect(undo.defaultPrevented).toBe(false);

    textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    textarea.dispatchEvent(key('Enter', { isComposing: true }));
    expect(element.shadowRoot?.querySelector('textarea')).toBe(textarea);
    input(textarea, 'composed');
    textarea.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    textarea.dispatchEvent(key('Enter'));
    expect(element.getContent()).toBe('composed');
  });

  it('undoes and redoes committed transactions while restoring baseline source', () => {
    const source = '"a",b';
    const element = create(source);
    const listener = vi.fn();
    element.addEventListener('content-change', listener);
    activeCell(element).dispatchEvent(key('x'));
    editControl(element).dispatchEvent(key('Enter'));
    expect(element.getContent()).toBe('x,b');

    activeCell(element).dispatchEvent(key('z', { ctrlKey: true }));
    expect(element.getContent()).toBe(source);
    expect(activeCell(element).dataset).toMatchObject({ row: '0', column: '0' });

    activeCell(element).dispatchEvent(key('z', { ctrlKey: true, shiftKey: true }));
    expect(element.getContent()).toBe('x,b');
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it('bounds committed transaction history to the latest 100 edits', () => {
    const element = create('0');
    for (let index = 1; index <= 101; index += 1) {
      pointerDown(dataCell(element, 0, 0));
      activeCell(element).dispatchEvent(key('Enter'));
      input(editControl(element), String(index));
      editControl(element).dispatchEvent(key('ArrowRight'));
    }

    for (let index = 0; index < 101; index += 1) {
      activeCell(element).dispatchEvent(key('z', { ctrlKey: true }));
    }
    expect(element.getContent()).toBe('1');
  });

  it('edits only a merged anchor and commits movement beyond its full edge', () => {
    const element = create('a,b,c,d,e\nf,anchor,,,j\nk,,,,o');
    element.setContent('a,b,c,d,e\nf,anchor,,,j\nk,,,,o', {
      presentation: {
        merges: [{ startRow: 1, endRow: 3, startColumn: 1, endColumn: 4 }],
      },
    });
    pointerDown(dataCell(element, 1, 1));
    activeCell(element).dispatchEvent(key('Enter'));
    input(editControl(element), 'merged');
    editControl(element).dispatchEvent(key('ArrowRight'));

    expect(activeCell(element).dataset).toMatchObject({ row: '1', column: '4' });
    expect(element.getContent()).toContain('f,merged,,,j');
  });
});

function activeCell(element: SheetEditor): HTMLTableCellElement {
  const cell = element.shadowRoot?.querySelector<HTMLTableCellElement>('td[tabindex="0"]');
  if (!cell) throw new Error('expected an active cell');
  return cell;
}

function dataCell(element: SheetEditor, row: number, column: number): HTMLTableCellElement {
  const cell = element.shadowRoot?.querySelector<HTMLTableCellElement>(
    `td[data-row="${row}"][data-column="${column}"]`
  );
  if (!cell) throw new Error(`expected cell ${row}:${column}`);
  return cell;
}

function editControl(element: SheetEditor): HTMLTextAreaElement {
  const textarea = element.shadowRoot?.querySelector<HTMLTextAreaElement>('textarea');
  if (!textarea) throw new Error('expected a cell edit control');
  return textarea;
}

function key(keyValue: string, init: KeyboardEventInit = {}): KeyboardEvent {
  return new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: keyValue, ...init });
}

function input(textarea: HTMLTextAreaElement, value: string): void {
  textarea.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true }));
  textarea.value = value;
  textarea.setSelectionRange(value.length, value.length);
  textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
}

function pointerDown(cell: HTMLTableCellElement): void {
  const event = new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 });
  Object.defineProperty(event, 'pointerId', { value: 1 });
  cell.dispatchEvent(event);
}
