import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_CSV_LIMITS, parseCsv } from '../csv';
import { parseSheetDocument } from '../document';

import { SheetEditor } from './sheet-editor';

describe('sheet-editor cell clipboard and clear commands', () => {
  afterEach(() => document.body.replaceChildren());

  it('copies a reverse-direction rectangular CSV selection as literal TSV', () => {
    const source = '"line\none",<b>text</b>,=SUM(A1)\nragged';
    const element = createCsv(source);
    const changed = vi.fn();
    element.addEventListener('content-change', changed);
    pointerDown(dataCell(element, 1, 2));
    activeCell(element).dispatchEvent(key('ArrowLeft', { shiftKey: true }));
    activeCell(element).dispatchEvent(key('ArrowLeft', { shiftKey: true }));
    activeCell(element).dispatchEvent(key('ArrowUp', { shiftKey: true }));

    const transfer = new ClipboardTransfer();
    const event = clipboardEvent('copy', transfer);
    activeCell(element).dispatchEvent(event);

    const expected = '"line\none"\t<b>text</b>\t=SUM(A1)\nragged\t\t';
    expect(event.defaultPrevented).toBe(true);
    expect(transfer.getData('text/plain')).toBe(expected);
    expect(transfer.getData('text/tab-separated-values')).toBe(expected);
    expect(element.getContent()).toBe(source);
    expect(changed).not.toHaveBeenCalled();
  });

  it('copies a complete merged selection in read-only mode with covered coordinates blank', () => {
    const source = sheet([
      'presentation:',
      '  merges:',
      '    - range: A1:B2',
      '---',
      'Anchor,',
      ',',
    ]);
    const element = createDocument(source);
    element.setAttribute('readonly', 'true');
    const transfer = new ClipboardTransfer();
    const event = clipboardEvent('copy', transfer);

    activeCell(element).dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(transfer.getData('text/plain')).toBe('Anchor\t\n\t');
    expect(element.getContent()).toBe(source);
  });

  it('prefers TSV, anchors at the selection top-left, and preserves selection, focus, and scroll', () => {
    const source = 'a,b,c\nd,e,f\ng,h,i';
    const element = createCsv(source);
    const changed = vi.fn();
    element.addEventListener('content-change', changed);
    pointerDown(dataCell(element, 2, 2));
    activeCell(element).dispatchEvent(key('ArrowUp', { shiftKey: true }));
    activeCell(element).dispatchEvent(key('ArrowLeft', { shiftKey: true }));
    const scroll = scrollSurface(element);
    scroll.scrollLeft = 31;
    scroll.scrollTop = 17;
    activeCell(element).focus();
    const transfer = new ClipboardTransfer([
      ['text/plain', 'ignored'],
      ['text/tab-separated-values', 'X\tY\nZ'],
    ]);
    const event = clipboardEvent('paste', transfer);

    activeCell(element).dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(element.getContent()).toBe('a,b,c\nd,X,Y\ng,Z,');
    expect(changed).toHaveBeenCalledTimes(1);
    expect(changed).toHaveBeenLastCalledWith(
      expect.objectContaining({ detail: { content: element.getContent() } })
    );
    expect(activeCell(element).dataset).toMatchObject({ row: '1', column: '1' });
    expect(selectedCells(element)).toHaveLength(4);
    expect(element.shadowRoot?.activeElement).toBe(activeCell(element));
    expect(scrollSurface(element).scrollLeft).toBe(31);
    expect(scrollSurface(element).scrollTop).toBe(17);

    activeCell(element).dispatchEvent(key('z', { ctrlKey: true }));
    expect(element.getContent()).toBe(source);
    activeCell(element).dispatchEvent(key('y', { ctrlKey: true }));
    expect(element.getContent()).toBe('a,b,c\nd,X,Y\ng,Z,');
  });

  it('materializes only non-empty missing destinations and treats an empty flavor as one cell', () => {
    const element = createCsv('a');
    const changed = vi.fn();
    element.addEventListener('content-change', changed);
    activeCell(element).dispatchEvent(key('ArrowRight'));
    const event = paste(element, '\tX\n\tY');

    expect(event.defaultPrevented).toBe(true);
    expect(element.getContent()).toBe('a,,X\r\n,,Y');
    expect(changed).toHaveBeenCalledTimes(1);

    const blank = createCsv('');
    const blankChanged = vi.fn();
    blank.addEventListener('content-change', blankChanged);
    paste(blank, '\t\n\t');
    expect(blank.getContent()).toBe('');
    expect(blankChanged).not.toHaveBeenCalled();

    const clearing = createCsv('value');
    const emptyEvent = paste(clearing, '');
    expect(emptyEvent.defaultPrevented).toBe(true);
    expect(clearing.getContent()).toBe('""');
  });

  it('does not tile a scalar across a larger selection', () => {
    const element = createCsv('a,b\nc,d');
    activeCell(element).dispatchEvent(key('ArrowRight', { shiftKey: true }));
    activeCell(element).dispatchEvent(key('ArrowDown', { shiftKey: true }));

    paste(element, 'only');

    expect(element.getContent()).toBe('only,b\nc,d');
    expect(selectedCells(element)).toHaveLength(4);
  });

  it('clears rectangular and ragged values without trimming shape and supports both keys', () => {
    const source = '\uFEFFa,b,\nc,d';
    const element = createCsv(source);
    const changed = vi.fn();
    element.addEventListener('content-change', changed);
    pointerDown(dataCell(element, 0, 1));
    activeCell(element).dispatchEvent(key('ArrowRight', { shiftKey: true }));
    activeCell(element).dispatchEvent(key('ArrowDown', { shiftKey: true }));

    const deletion = key('Delete');
    activeCell(element).dispatchEvent(deletion);

    expect(deletion.defaultPrevented).toBe(true);
    expect(element.getContent()).toBe('\uFEFFa,,\nc,');
    expect(changed).toHaveBeenCalledTimes(1);
    expect(selectedCells(element)).toHaveLength(4);

    const noOp = key('Backspace');
    activeCell(element).dispatchEvent(noOp);
    expect(noOp.defaultPrevented).toBe(true);
    expect(changed).toHaveBeenCalledTimes(1);

    activeCell(element).dispatchEvent(key('z', { ctrlKey: true }));
    expect(element.getContent()).toBe(source);
    const backspace = key('Backspace');
    activeCell(element).dispatchEvent(backspace);
    expect(backspace.defaultPrevented).toBe(true);
    expect(element.getContent()).toBe('\uFEFFa,,\nc,');
  });

  it('leaves modified clear keys unassigned', () => {
    const element = createCsv('value');
    for (const event of [
      key('Delete', { shiftKey: true }),
      key('Delete', { altKey: true }),
      key('Backspace', { ctrlKey: true }),
      key('Backspace', { metaKey: true }),
    ]) {
      activeCell(element).dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    }
    expect(element.getContent()).toBe('value');
  });

  it('retains document presentation, accepts a merged anchor, and rejects covered values atomically', () => {
    const source = sheet([
      'presentation:',
      '  merges:',
      '    - range: A1:B1',
      '  formats:',
      '    - range: A1:B1',
      '      bold: true',
      '  alignments:',
      '    - range: A1:B1',
      '      horizontal: center',
      '---',
      'Anchor,',
      'Left,Right',
    ]);
    const element = createDocument(source);
    const changed = vi.fn();
    element.addEventListener('content-change', changed);

    paste(element, 'New\t');

    let parsed = documentValue(element);
    expect(parsed.data.rows).toEqual([
      ['New', ''],
      ['Left', 'Right'],
    ]);
    expect(parsed.presentation).toEqual({
      merges: [{ startRow: 0, endRow: 1, startColumn: 0, endColumn: 2 }],
      formats: [
        {
          range: { startRow: 0, endRow: 1, startColumn: 0, endColumn: 2 },
          bold: true,
        },
      ],
      alignments: [
        {
          range: { startRow: 0, endRow: 1, startColumn: 0, endColumn: 2 },
          horizontal: 'center',
        },
      ],
    });
    expect(changed).toHaveBeenCalledTimes(1);
    expect(changed).toHaveBeenLastCalledWith(
      expect.objectContaining({ detail: { content: element.getContent() } })
    );

    activeCell(element).dispatchEvent(key('z', { ctrlKey: true }));
    expect(element.getContent()).toBe(source);
    const rejected = paste(element, 'New\tCovered');
    expect(rejected.defaultPrevented).toBe(true);
    expect(element.getContent()).toBe(source);
    expect(changed).toHaveBeenCalledTimes(2);
    expect(
      element.shadowRoot?.querySelector('#sheet-editor-structure-notice')?.textContent
    ).toContain('presentation invalid');

    activeCell(element).dispatchEvent(key('Delete'));
    parsed = documentValue(element);
    expect(parsed.data.rows[0]).toEqual(['', '']);
    expect(parsed.presentation.merges).toHaveLength(1);
    expect(parsed.presentation.formats).toHaveLength(1);
    expect(parsed.presentation.alignments).toHaveLength(1);
  });

  it('refuses malformed, cell-limit, footprint-limit, and source-limit pastes atomically', () => {
    const malformed = createCsv('safe');
    const malformedChanged = vi.fn();
    malformed.addEventListener('content-change', malformedChanged);
    const malformedEvent = paste(malformed, '"open');
    expect(malformedEvent.defaultPrevented).toBe(true);
    expect(malformed.getContent()).toBe('safe');
    expect(malformedChanged).not.toHaveBeenCalled();

    const cellLimit = createCsv('safe');
    paste(cellLimit, 'x'.repeat(DEFAULT_CSV_LIMITS.maxCellBytes + 1));
    expect(cellLimit.getContent()).toBe('safe');
    expect(commandNotice(cellLimit)).toContain('65,536-byte limit');

    const columnLimit = createCsv(
      Array.from({ length: DEFAULT_CSV_LIMITS.maxColumns }, (_, index) => String(index)).join(',')
    );
    pointerDown(dataCell(columnLimit, 0, DEFAULT_CSV_LIMITS.maxColumns - 1));
    paste(columnLimit, 'x\ty');
    expect(parseCsv(columnLimit.getContent())).toMatchObject({ ok: true, maxColumns: 256 });
    expect(commandNotice(columnLimit)).toContain('256-column limit');

    const rowLimitSource = Array.from(
      { length: DEFAULT_CSV_LIMITS.maxMaterializedRows },
      (_, index) => String(index)
    ).join('\n');
    const rowLimit = createCsv(rowLimitSource);
    pointerDown(dataCell(rowLimit, DEFAULT_CSV_LIMITS.maxMaterializedRows - 1, 0));
    paste(rowLimit, 'x\ny');
    expect(rowLimit.getContent()).toBe(rowLimitSource);
    expect(commandNotice(rowLimit)).toContain('1,000-row limit');

    const largeCell = 'x'.repeat(DEFAULT_CSV_LIMITS.maxCellBytes - 1);
    const sourceLimitSource = [largeCell, largeCell, largeCell, largeCell].join('\n');
    const sourceLimit = createCsv(sourceLimitSource);
    paste(sourceLimit, `,${'x'.repeat(DEFAULT_CSV_LIMITS.maxCellBytes - 2)}`);
    expect(sourceLimit.getContent()).toBe(sourceLimitSource);
    expect(commandNotice(sourceLimit)).toContain('262,144-byte limit');
  });

  it('requires an advertised text flavor but accepts an intentionally empty one', () => {
    const unavailable = createCsv('value');
    const unavailableEvent = clipboardEvent('paste', new ClipboardTransfer());
    activeCell(unavailable).dispatchEvent(unavailableEvent);
    expect(unavailableEvent.defaultPrevented).toBe(false);
    expect(unavailable.getContent()).toBe('value');

    const empty = createCsv('value');
    const emptyEvent = clipboardEvent('paste', new ClipboardTransfer([['text/plain', '']]));
    activeCell(empty).dispatchEvent(emptyEvent);
    expect(emptyEvent.defaultPrevented).toBe(true);
    expect(empty.getContent()).toBe('""');
  });

  it('allows read-only copy while leaving paste and clear unavailable', () => {
    const element = createCsv('a,b');
    element.setAttribute('readonly', 'true');
    const copyTransfer = new ClipboardTransfer();
    const copyEvent = clipboardEvent('copy', copyTransfer);
    activeCell(element).dispatchEvent(copyEvent);
    expect(copyEvent.defaultPrevented).toBe(true);
    expect(copyTransfer.getData('text/plain')).toBe('a');

    const pasteEvent = clipboardEvent('paste', new ClipboardTransfer([['text/plain', 'changed']]));
    activeCell(element).dispatchEvent(pasteEvent);
    const deletion = key('Delete');
    activeCell(element).dispatchEvent(deletion);
    const backspace = key('Backspace');
    activeCell(element).dispatchEvent(backspace);

    expect(pasteEvent.defaultPrevented).toBe(false);
    expect(deletion.defaultPrevented).toBe(false);
    expect(backspace.defaultPrevented).toBe(false);
    expect(element.getContent()).toBe('a,b');
  });

  it('does not claim clipboard or clear commands for failed and truncated loads', () => {
    const sources = [
      '"unclosed',
      Array.from({ length: DEFAULT_CSV_LIMITS.maxMaterializedRows + 1 }, (_, index) =>
        String(index)
      ).join('\n'),
    ];
    for (const source of sources) {
      const element = createCsv(source);
      const target = element.shadowRoot?.querySelector<HTMLElement>(
        '.sheet-surface__message, .sheet-surface__scroll'
      );
      if (!target) throw new Error('expected a non-interactive status surface');
      const copy = clipboardEvent('copy', new ClipboardTransfer());
      const pasteEvent = clipboardEvent(
        'paste',
        new ClipboardTransfer([['text/plain', 'changed']])
      );
      const deletion = key('Delete');

      target.dispatchEvent(copy);
      target.dispatchEvent(pasteEvent);
      target.dispatchEvent(deletion);

      expect(copy.defaultPrevented).toBe(false);
      expect(pasteEvent.defaultPrevented).toBe(false);
      expect(deletion.defaultPrevented).toBe(false);
      expect(element.getContent()).toBe(source);
      element.remove();
    }
  });

  it('does not intercept textarea clipboard or deletion in quick or caret edit', () => {
    for (const editKey of ['Enter', 'F2']) {
      const element = createCsv('text');
      activeCell(element).dispatchEvent(key(editKey));
      const textarea = editControl(element);
      textarea.setSelectionRange(1, 3);
      const copy = clipboardEvent('copy', new ClipboardTransfer());
      const pasteEvent = clipboardEvent('paste', new ClipboardTransfer([['text/plain', 'native']]));
      const deletion = key('Delete');
      const backspace = key('Backspace');

      textarea.dispatchEvent(copy);
      textarea.dispatchEvent(pasteEvent);
      textarea.dispatchEvent(deletion);
      textarea.dispatchEvent(backspace);

      expect(copy.defaultPrevented).toBe(false);
      expect(pasteEvent.defaultPrevented).toBe(false);
      expect(deletion.defaultPrevented).toBe(false);
      expect(backspace.defaultPrevented).toBe(false);
      expect(editControl(element)).toBe(textarea);
      expect(textarea.value).toBe('text');
      element.remove();
    }
  });

  it('does not run paste or clear during IME composition', () => {
    const element = createCsv('value');
    activeCell(element).dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    const pasteEvent = clipboardEvent('paste', new ClipboardTransfer([['text/plain', 'changed']]));
    activeCell(element).dispatchEvent(pasteEvent);
    const deletion = key('Delete', { isComposing: true });
    activeCell(element).dispatchEvent(deletion);

    expect(pasteEvent.defaultPrevented).toBe(false);
    expect(deletion.defaultPrevented).toBe(false);
    expect(element.getContent()).toBe('value');

    activeCell(element).dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    paste(element, 'changed');
    expect(element.getContent()).toBe('changed');
  });

  it('stores paste and clear as one transaction, clears redo, and resets history on source load', () => {
    const source = '\uFEFF"a",b\n';
    const element = createCsv(source);
    paste(element, 'pasted');
    activeCell(element).dispatchEvent(key('z', { ctrlKey: true }));
    expect(element.getContent()).toBe(source);

    activeCell(element).dispatchEvent(key('Delete'));
    expect(element.getContent()).toBe('\uFEFF,b\n');
    activeCell(element).dispatchEvent(key('y', { ctrlKey: true }));
    expect(element.getContent()).toBe('\uFEFF,b\n');

    element.setDocumentSource(sheet(['---', 'new,value']));
    activeCell(element).dispatchEvent(key('z', { ctrlKey: true }));
    expect(element.getContent()).toBe(sheet(['---', 'new,value']));
  });
});

class ClipboardTransfer {
  private readonly values = new Map<string, string>();

  constructor(entries: readonly (readonly [string, string])[] = []) {
    for (const [type, value] of entries) this.values.set(type, value);
  }

  get types(): string[] {
    return [...this.values.keys()];
  }

  getData(type: string): string {
    return this.values.get(type) ?? '';
  }

  setData(type: string, value: string): void {
    this.values.set(type, value);
  }
}

function createCsv(source: string): SheetEditor {
  const element = new SheetEditor();
  element.setContent(source);
  document.body.append(element);
  return element;
}

function createDocument(source: string): SheetEditor {
  const element = new SheetEditor();
  element.setDocumentSource(source);
  document.body.append(element);
  return element;
}

function sheet(lines: readonly string[]): string {
  return ['---', 'sheet: stillpoint/v1', ...lines].join('\n');
}

function documentValue(element: SheetEditor) {
  const parsed = parseSheetDocument(element.getContent());
  if (!parsed.ok) throw new Error(`expected document: ${parsed.error.message}`);
  return parsed.document;
}

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

function selectedCells(element: SheetEditor): HTMLTableCellElement[] {
  return [
    ...(element.shadowRoot?.querySelectorAll<HTMLTableCellElement>('td[aria-selected="true"]') ??
      []),
  ];
}

function editControl(element: SheetEditor): HTMLTextAreaElement {
  const textarea = element.shadowRoot?.querySelector<HTMLTextAreaElement>('textarea');
  if (!textarea) throw new Error('expected a textarea');
  return textarea;
}

function scrollSurface(element: SheetEditor): HTMLElement {
  const scroll = element.shadowRoot?.querySelector<HTMLElement>('.sheet-surface__scroll');
  if (!scroll) throw new Error('expected a scroll surface');
  return scroll;
}

function commandNotice(element: SheetEditor): string {
  return element.shadowRoot?.querySelector('#sheet-editor-structure-notice')?.textContent ?? '';
}

function key(keyValue: string, init: KeyboardEventInit = {}): KeyboardEvent {
  return new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: keyValue, ...init });
}

function pointerDown(cell: HTMLTableCellElement): void {
  const event = new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 });
  Object.defineProperty(event, 'pointerId', { value: 1 });
  cell.dispatchEvent(event);
}

function clipboardEvent(type: 'copy' | 'paste', transfer: ClipboardTransfer): ClipboardEvent {
  const event = new Event(type, { bubbles: true, cancelable: true }) as ClipboardEvent;
  Object.defineProperty(event, 'clipboardData', { value: transfer });
  return event;
}

function paste(element: SheetEditor, value: string): ClipboardEvent {
  const event = clipboardEvent('paste', new ClipboardTransfer([['text/plain', value]]));
  activeCell(element).dispatchEvent(event);
  return event;
}
