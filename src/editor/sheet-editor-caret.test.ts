import { afterEach, describe, expect, it, vi } from 'vitest';

import { parseCsv } from '../csv';

import { SheetEditor } from './sheet-editor';

describe('sheet-editor caret editing', () => {
  afterEach(() => document.body.replaceChildren());

  const create = (source = ''): SheetEditor => {
    const element = new SheetEditor();
    element.setContent(source);
    document.body.append(element);
    return element;
  };

  it('enters at the value end with F2 and keeps repeated F2 idempotent', () => {
    const element = create('value');
    activeCell(element).dispatchEvent(key('F2'));
    const textarea = editControl(element);

    expect(textarea.dataset.mode).toBe('caret-edit');
    expect(textarea.selectionStart).toBe(5);
    textarea.setSelectionRange(2, 2);
    textarea.dispatchEvent(key('F2'));
    expect(editControl(element)).toBe(textarea);
    expect(textarea.selectionStart).toBe(2);
    expect(element.getContent()).toBe('value');
  });

  it('switches a quick draft to caret mode without committing or losing selection', () => {
    const element = create('old');
    const listener = vi.fn();
    element.addEventListener('content-change', listener);
    activeCell(element).dispatchEvent(key('Enter'));
    const textarea = editControl(element);
    input(textarea, 'draft');
    textarea.setSelectionRange(1, 4);
    textarea.dispatchEvent(key('F2'));

    expect(editControl(element)).toBe(textarea);
    expect(textarea.dataset.mode).toBe('caret-edit');
    expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([1, 4]);
    expect(element.getContent()).toBe('draft');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('selects and opens a pointer-targeted cell on primary double-click', () => {
    const element = create('a,b');
    dataCell(element, 0, 1).dispatchEvent(
      new MouseEvent('dblclick', { bubbles: true, cancelable: true, button: 0 })
    );

    expect(activeCell(element).dataset.column).toBe('1');
    expect(editControl(element).value).toBe('b');
    expect(editControl(element).dataset.mode).toBe('caret-edit');
  });

  it('leaves arrows, Home/End, selection modifiers, clipboard, and native undo to the textarea', () => {
    const element = create('text');
    activeCell(element).dispatchEvent(key('F2'));
    const textarea = editControl(element);

    for (const event of [
      key('ArrowLeft'),
      key('ArrowRight', { shiftKey: true }),
      key('Home'),
      key('End', { ctrlKey: true }),
      key('a', { ctrlKey: true }),
      key('z', { ctrlKey: true }),
    ]) {
      textarea.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
      expect(editControl(element)).toBe(textarea);
    }
    expect(activeCell(element).dataset).toMatchObject({ row: '0', column: '0' });
  });

  it('commits down/up with Enter/Shift+Enter and cancels the full draft with Escape', () => {
    const element = create('a\nb');
    activeCell(element).dispatchEvent(key('F2'));
    input(editControl(element), 'A');
    editControl(element).dispatchEvent(key('Enter'));
    expect(activeCell(element).dataset.row).toBe('1');

    activeCell(element).dispatchEvent(key('F2'));
    input(editControl(element), 'B');
    editControl(element).dispatchEvent(key('Enter', { shiftKey: true }));
    expect(activeCell(element).dataset.row).toBe('0');
    expect(element.getContent()).toBe('A\nB');

    activeCell(element).dispatchEvent(key('F2'));
    input(editControl(element), 'cancelled');
    editControl(element).dispatchEvent(key('Escape'));
    expect(element.getContent()).toBe('A\nB');
  });

  it.each([
    [0, 0, '\nabcd', 1],
    [2, 2, 'ab\ncd', 3],
    [1, 3, 'a\nd', 2],
    [4, 4, 'abcd\n', 5],
  ])(
    'inserts one LF for Alt+Enter at selection %i:%i',
    (selectionStart, selectionEnd, expected, expectedCaret) => {
      const element = create('abcd');
      const listener = vi.fn();
      element.addEventListener('content-change', listener);
      activeCell(element).dispatchEvent(key('F2'));
      const textarea = editControl(element);
      textarea.setSelectionRange(selectionStart, selectionEnd);
      textarea.dispatchEvent(key('Enter', { altKey: true }));

      expect(textarea.value).toBe(expected);
      expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([
        expectedCaret,
        expectedCaret,
      ]);
      expect(editControl(element)).toBe(textarea);
      expect(listener).toHaveBeenCalledTimes(1);
      const parsed = parseCsv(element.getContent());
      expect(parsed.ok && parsed.rows[0]?.[0]).toBe(expected);
    }
  );

  it('keeps LF cell content distinct from CRLF record endings and supports repeated insertion', () => {
    const element = create('first,second\r\nnext,row');
    activeCell(element).dispatchEvent(key('F2'));
    const textarea = editControl(element);
    textarea.setSelectionRange(5, 5);
    textarea.dispatchEvent(key('Enter', { altKey: true }));
    textarea.dispatchEvent(key('Enter', { altKey: true }));
    textarea.dispatchEvent(key('Enter'));

    expect(element.getContent()).toContain('"first\n\n",second\r\nnext,row');
    const parsed = parseCsv(element.getContent());
    expect(parsed.ok && parsed.rows[0]?.[0]).toBe('first\n\n');
  });

  it('commits multiline input as one transaction and undoes it back to exact source', () => {
    const source = '"value"';
    const element = create(source);
    const listener = vi.fn();
    element.addEventListener('content-change', listener);
    activeCell(element).dispatchEvent(key('F2'));
    editControl(element).dispatchEvent(key('Enter', { altKey: true }));
    editControl(element).dispatchEvent(key('Enter'));
    expect(element.getContent()).toBe('"value\n"');
    expect(listener).toHaveBeenCalledTimes(1);

    activeCell(element).dispatchEvent(key('z', { ctrlKey: true }));
    expect(element.getContent()).toBe(source);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('leaves Ctrl/Command+Enter unassigned without inserting or committing', () => {
    const element = create('value');
    activeCell(element).dispatchEvent(key('F2'));
    const textarea = editControl(element);
    for (const event of [key('Enter', { ctrlKey: true }), key('Enter', { metaKey: true })]) {
      textarea.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
      expect(textarea.value).toBe('value');
      expect(editControl(element)).toBe(textarea);
    }
  });

  it('does not commit, cancel, switch, or insert a newline during IME composition', () => {
    const element = create('value');
    activeCell(element).dispatchEvent(key('F2'));
    const textarea = editControl(element);
    textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    for (const event of [
      key('Enter', { altKey: true, isComposing: true }),
      key('Enter', { isComposing: true }),
      key('Escape', { isComposing: true }),
      key('F2', { isComposing: true }),
    ]) {
      textarea.dispatchEvent(event);
    }
    expect(textarea.value).toBe('value');
    expect(editControl(element)).toBe(textarea);
    textarea.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
  });

  it('rejects an Alt+Enter that exceeds limits without changing value, selection, or events', () => {
    const value = 'x'.repeat(64 * 1024);
    const element = create(value);
    const listener = vi.fn();
    element.addEventListener('content-change', listener);
    activeCell(element).dispatchEvent(key('F2'));
    const textarea = editControl(element);
    textarea.setSelectionRange(value.length, value.length);
    textarea.dispatchEvent(key('Enter', { altKey: true }));

    expect(textarea.value).toBe(value);
    expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([value.length, value.length]);
    expect(listener).not.toHaveBeenCalled();
    expect(element.shadowRoot?.querySelector('#sheet-editor-limit-notice')?.textContent).toContain(
      '65,536-byte limit'
    );
  });

  it('uses the merged anchor bounds and moves beyond the merged unit after commit', () => {
    const element = create();
    element.setContent('a,b,c,d,e\nf,anchor,,,j\nk,,,,o\np,q,r,s,t', {
      presentation: {
        merges: [{ startRow: 1, endRow: 3, startColumn: 1, endColumn: 4 }],
      },
    });
    dataCell(element, 1, 1).dispatchEvent(
      new MouseEvent('dblclick', { bubbles: true, cancelable: true, button: 0 })
    );
    const textarea = editControl(element);
    const cell = textarea.closest<HTMLTableCellElement>('td');
    expect(cell?.rowSpan).toBe(2);
    expect(cell?.colSpan).toBe(3);
    textarea.dispatchEvent(key('Enter', { altKey: true }));
    textarea.dispatchEvent(key('Enter'));
    expect(activeCell(element).dataset).toMatchObject({ row: '3', column: '1' });
  });

  it('recomputes overlay growth in place without losing selection', () => {
    const element = create('line');
    activeCell(element).dispatchEvent(key('F2'));
    const textarea = editControl(element);
    input(textarea, 'line one\nline two\nline three');
    textarea.setSelectionRange(4, 8);
    const height = textarea.style.height;
    window.dispatchEvent(new Event('resize'));
    element.shadowRoot?.querySelector('.sheet-surface__scroll')?.dispatchEvent(new Event('scroll'));

    expect(editControl(element)).toBe(textarea);
    expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([4, 8]);
    expect(textarea.style.height).toBe(height);
    expect(textarea.classList.contains('sheet-editor__input--caret')).toBe(true);
  });

  it('does not enter caret mode for readonly, malformed, or truncated input', () => {
    const readonly = create('value');
    readonly.setAttribute('readonly', 'true');
    activeCell(readonly).dispatchEvent(key('F2'));
    expect(readonly.shadowRoot?.querySelector('textarea')).toBeNull();

    const malformed = create('"unclosed');
    malformed.shadowRoot?.querySelector('[role="alert"]')?.dispatchEvent(key('F2'));
    expect(malformed.shadowRoot?.querySelector('textarea')).toBeNull();

    const source = Array.from({ length: 1001 }, (_, index) => String(index)).join('\n');
    const truncated = create(source);
    truncated.shadowRoot?.querySelector('.sheet-surface__scroll')?.dispatchEvent(key('F2'));
    expect(truncated.shadowRoot?.querySelector('textarea')).toBeNull();
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
