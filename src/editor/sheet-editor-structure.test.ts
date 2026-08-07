import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_CSV_LIMITS, parseCsv } from '../csv';
import { parseSheetDocument } from '../document';
import { SheetGrid } from '../grid/sheet-grid';
import { SheetPreview } from '../preview/sheet-preview';

import { SheetEditor } from './sheet-editor';

import type { SheetContentOptions } from '../presentation';

const BASE_CSV = 'a,b\nc,d';

const ACTION_CASES = [
  {
    label: 'Insert row above',
    target: [1, 0],
    content: 'a,b\n,\nc,d',
    rows: [
      ['a', 'b'],
      ['', ''],
      ['c', 'd'],
    ],
    active: [1, 0],
  },
  {
    label: 'Insert row below',
    target: [0, 0],
    content: 'a,b\n,\nc,d',
    rows: [
      ['a', 'b'],
      ['', ''],
      ['c', 'd'],
    ],
    active: [1, 0],
  },
  {
    label: 'Insert column before',
    target: [0, 1],
    content: 'a,,b\nc,,d',
    rows: [
      ['a', '', 'b'],
      ['c', '', 'd'],
    ],
    active: [0, 1],
  },
  {
    label: 'Insert column after',
    target: [0, 0],
    content: 'a,,b\nc,,d',
    rows: [
      ['a', '', 'b'],
      ['c', '', 'd'],
    ],
    active: [0, 1],
  },
  {
    label: 'Delete row',
    target: [0, 0],
    content: 'c,d',
    rows: [['c', 'd']],
    active: [0, 0],
  },
  {
    label: 'Delete column',
    target: [0, 0],
    content: 'b\nd',
    rows: [['b'], ['d']],
    active: [0, 0],
  },
] as const;

describe('sheet-editor structure toolbar', () => {
  afterEach(() => document.body.replaceChildren());

  it('renders six ordered, grouped, labelled icon buttons with one toolbar tab stop', () => {
    const element = createCsv('a,b');
    const toolbar = element.shadowRoot?.querySelector('[role="toolbar"]');
    const buttons = toolbarButtons(element);

    expect(toolbar?.getAttribute('aria-label')).toBe('Sheet structure');
    expect(buttons.map((item) => item.getAttribute('aria-label'))).toEqual(
      ACTION_CASES.map(({ label }) => label)
    );
    expect(buttons.every((item) => item.type === 'button' && item.title === item.ariaLabel)).toBe(
      true
    );
    expect(buttons.filter((item) => item.tabIndex === 0)).toHaveLength(1);
    expect(buttons[0]?.tabIndex).toBe(0);
    expect(toolbar?.querySelectorAll('[role="group"]')).toHaveLength(2);
    expect(toolbar?.querySelectorAll('.sheet-editor__toolbar-separator')).toHaveLength(1);
    expect(toolbar?.querySelectorAll('svg[aria-hidden="true"]')).toHaveLength(6);
    expect(button(element, 'Delete row').classList).toContain(
      'sheet-editor__toolbar-button--delete'
    );
  });

  it('does not add mutation controls to preview or grid elements', () => {
    const preview = new SheetPreview();
    preview.setContent('a,b');
    const grid = new SheetGrid();
    grid.setContent('a,b');
    document.body.append(preview, grid);

    expect(preview.shadowRoot?.querySelector('[role="toolbar"]')).toBeNull();
    expect(grid.shadowRoot?.querySelector('[role="toolbar"]')).toBeNull();
  });

  it('uses roving arrow/Home/End focus and Escape without changing the logical selection', () => {
    const element = createCsv('a,b');
    activeCell(element).dispatchEvent(key('ArrowRight', { shiftKey: true }));
    const buttons = toolbarButtons(element);

    buttons[0]?.focus();
    expect(selectedCells(element)).toHaveLength(2);
    buttons[0]?.dispatchEvent(key('ArrowRight'));
    expect(element.shadowRoot?.activeElement).toBe(buttons[1]);
    expect(buttons[1]?.tabIndex).toBe(0);

    buttons[1]?.dispatchEvent(key('End'));
    expect(element.shadowRoot?.activeElement).toBe(buttons[5]);
    buttons[5]?.dispatchEvent(key('Home'));
    expect(element.shadowRoot?.activeElement).toBe(buttons[0]);
    buttons[0]?.dispatchEvent(key('ArrowLeft'));
    expect(element.shadowRoot?.activeElement).toBe(buttons[5]);

    buttons[5]?.dispatchEvent(key('Escape'));
    expect(element.shadowRoot?.activeElement).toBe(activeCell(element));
    expect(selectedCells(element)).toHaveLength(2);
  });

  it('skips disabled controls and synchronizes editable, readonly, and failure states', () => {
    const element = createCsv('');
    const first = button(element, 'Insert row above');
    const deleteRow = button(element, 'Delete row');
    const deleteColumn = button(element, 'Delete column');

    expect(first.disabled).toBe(false);
    expect(deleteRow.disabled).toBe(true);
    expect(deleteColumn.disabled).toBe(true);
    first.focus();
    first.dispatchEvent(key('End'));
    expect((element.shadowRoot?.activeElement as HTMLElement | null)?.ariaLabel).toBe(
      'Insert column after'
    );

    element.setAttribute('readonly', 'true');
    expect(toolbarButtons(element).every((item) => item.disabled && item.tabIndex === -1)).toBe(
      true
    );
    expect(element.shadowRoot?.querySelector('[role="toolbar"]')).not.toBeNull();

    element.setAttribute('readonly', 'false');
    expect(button(element, 'Insert row above').disabled).toBe(false);
    element.setContent('"unclosed');
    expect(element.shadowRoot?.querySelector('[role="toolbar"]')).toBeNull();

    element.setContent(Array.from({ length: 1001 }, (_, index) => String(index)).join('\n'));
    expect(element.shadowRoot?.querySelector('[role="toolbar"]')).toBeNull();
  });

  it('keeps invalid embedded presentation non-editable but permits an invalid view override', () => {
    const invalidEmbedded = createDocument(
      [
        '---',
        'sheet: stillpoint/v1',
        'presentation:',
        '  merges:',
        '    - range: A1:B1',
        '---',
        'visible,occupied',
      ].join('\n')
    );
    expect(toolbarButtons(invalidEmbedded).every((item) => item.disabled)).toBe(true);

    const invalidOverride = createDocument('---\nsheet: stillpoint/v1\n---\nvisible,occupied', {
      presentation: {
        merges: [{ startRow: 0, endRow: 1, startColumn: 0, endColumn: 2 }],
      },
    });
    const changed = vi.fn();
    invalidOverride.addEventListener('content-change', changed);
    expect(button(invalidOverride, 'Insert row below').disabled).toBe(false);

    button(invalidOverride, 'Insert row below').click();
    expect(documentRows(invalidOverride)).toEqual([
      ['visible', 'occupied'],
      ['', ''],
    ]);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(dataCell(invalidOverride, 0, 1).textContent).toBe('occupied');
  });

  it.each(ACTION_CASES)(
    '$label changes plain CSV once and focuses the resulting active cell',
    (testCase) => {
      const element = createCsv(BASE_CSV);
      const changed = vi.fn();
      element.addEventListener('content-change', changed);
      pointerDown(dataCell(element, testCase.target[0], testCase.target[1]));

      button(element, testCase.label).click();

      expect(element.getContent()).toBe(testCase.content);
      expect(parseCsv(element.getContent())).toMatchObject({ ok: true, rows: testCase.rows });
      expect(activeCell(element).dataset).toMatchObject({
        row: String(testCase.active[0]),
        column: String(testCase.active[1]),
      });
      expect(element.shadowRoot?.activeElement).toBe(activeCell(element));
      expect(changed).toHaveBeenCalledTimes(1);
      expect(changed).toHaveBeenLastCalledWith(
        expect.objectContaining({ detail: { content: element.getContent() } })
      );
    }
  );

  it.each(ACTION_CASES)(
    '$label changes a complete .sheet document through the same toolbar',
    (testCase) => {
      const source = `---\n# canonicalized by a real change\nsheet: stillpoint/v1\n---\n${BASE_CSV}`;
      const element = createDocument(source);
      const changed = vi.fn();
      element.addEventListener('content-change', changed);
      pointerDown(dataCell(element, testCase.target[0], testCase.target[1]));

      button(element, testCase.label).click();

      expect(documentRows(element)).toEqual(testCase.rows);
      expect(element.getContent()).toContain('sheet: stillpoint/v1\nformat: csv');
      expect(element.getContent()).not.toContain('# canonicalized by a real change');
      expect(changed).toHaveBeenCalledTimes(1);
      expect(changed).toHaveBeenLastCalledWith(
        expect.objectContaining({ detail: { content: element.getContent() } })
      );
    }
  );

  it('uses outer selection edges for insertion and the active endpoint for deletion', () => {
    const below = createCsv('r0\nr1\nr2');
    activeCell(below).dispatchEvent(key('ArrowDown', { shiftKey: true }));
    button(below, 'Insert row below').click();
    expect(below.getContent()).toBe('r0\nr1\n\nr2');
    expect(activeCell(below).dataset.row).toBe('2');

    const before = createCsv('a,b,c');
    activeCell(before).dispatchEvent(key('ArrowRight', { shiftKey: true }));
    button(before, 'Insert column before').click();
    expect(before.getContent()).toBe(',a,b,c');
    expect(activeCell(before).dataset.column).toBe('0');

    const deleteActive = createCsv('r0\nr1\nr2');
    activeCell(deleteActive).dispatchEvent(key('ArrowDown', { shiftKey: true }));
    button(deleteActive, 'Delete row').click();
    expect(deleteActive.getContent()).toBe('r0\nr2');
    expect(activeCell(deleteActive).dataset.row).toBe('1');
  });

  it('places relative insertions outside a selected merged unit', () => {
    const source = [
      '---',
      'sheet: stillpoint/v1',
      'presentation:',
      '  merges:',
      '    - range: A1:B1',
      '---',
      'Anchor,,tail',
    ].join('\n');
    const after = createDocument(source);

    button(after, 'Insert column after').click();

    expect(documentRows(after)).toEqual([['Anchor', '', '', 'tail']]);
    expect(documentPresentation(after).merges).toEqual([
      { startRow: 0, endRow: 1, startColumn: 0, endColumn: 2 },
    ]);
    expect(activeCell(after).dataset.column).toBe('2');

    const before = createDocument(source);
    button(before, 'Insert column before').click();
    expect(documentPresentation(before).merges).toEqual([
      { startRow: 0, endRow: 1, startColumn: 1, endColumn: 3 },
    ]);
    expect(activeCell(before).dataset.column).toBe('0');
  });

  it.each([
    ['Insert row above', 'a\r\n""', 1, 0],
    ['Insert row below', 'a\r\n""', 1, 0],
    ['Insert column before', 'a,', 0, 1],
    ['Insert column after', 'a,', 0, 1],
  ] as const)(
    '%s clamps a virtual-edge selection to materialized append',
    (label, content, row, column) => {
      const element = createCsv('a');
      activeCell(element).dispatchEvent(key('ArrowDown'));
      activeCell(element).dispatchEvent(key('ArrowRight'));
      expect(button(element, 'Delete row').disabled).toBe(true);
      expect(button(element, 'Delete column').disabled).toBe(true);

      button(element, label).click();

      expect(element.getContent()).toBe(content);
      expect(activeCell(element).dataset).toMatchObject({
        row: String(row),
        column: String(column),
      });
    }
  );

  it('rectangularizes only column commands and normalizes final row/column deletion to empty', () => {
    const empty = createCsv('');
    button(empty, 'Insert row above').click();
    expect(empty.getContent()).toBe('""');
    activeCell(empty).dispatchEvent(key('z', { ctrlKey: true }));
    expect(empty.getContent()).toBe('');

    const ragged = createCsv('a\nb,c');
    pointerDown(dataCell(ragged, 0, 1));
    button(ragged, 'Insert column before').click();
    expect(ragged.getContent()).toBe('a,,\nb,,c');

    const finalColumn = createCsv('only');
    button(finalColumn, 'Delete column').click();
    expect(finalColumn.getContent()).toBe('');
    expect(activeCell(finalColumn).dataset).toMatchObject({ row: '0', column: '0' });
    expect(button(finalColumn, 'Delete column').disabled).toBe(true);
    activeCell(finalColumn).dispatchEvent(key('z', { ctrlKey: true }));
    expect(finalColumn.getContent()).toBe('only');
    expect(button(finalColumn, 'Delete column').disabled).toBe(false);

    const finalRow = createCsv('only');
    button(finalRow, 'Delete row').click();
    expect(finalRow.getContent()).toBe('');
  });

  it('preserves BOM, LF termination, and literal formula-looking values', () => {
    const source = '\uFEFF=SUM(A1),value\n';
    const element = createCsv(source);

    button(element, 'Insert row below').click();
    expect(element.getContent()).toBe('\uFEFF=SUM(A1),value\n,\n');
    expect(element.getContent()).not.toContain("'=SUM");

    activeCell(element).dispatchEvent(key('z', { ctrlKey: true }));
    expect(element.getContent()).toBe(source);
  });

  it('transforms a CSV view override for rendering without persisting it', () => {
    const range = { startRow: 0, endRow: 1, startColumn: 0, endColumn: 2 };
    const element = createCsv('Anchor,\nnext,value', {
      presentation: { merges: [range] },
    });

    button(element, 'Insert row above').click();

    expect(element.getContent()).toBe(',\nAnchor,\nnext,value');
    expect(dataCell(element, 1, 0).colSpan).toBe(2);
    expect(element.getContent()).not.toContain('presentation');
    expect(range).toEqual({ startRow: 0, endRow: 1, startColumn: 0, endColumn: 2 });

    activeCell(element).dispatchEvent(key('z', { ctrlKey: true }));
    expect(element.getContent()).toBe('Anchor,\nnext,value');
    expect(dataCell(element, 0, 0).colSpan).toBe(2);
  });

  it('commits an open draft before restructuring and keeps the two changes as two undo steps', () => {
    const element = createCsv('a,b');
    const changed = vi.fn();
    element.addEventListener('content-change', changed);
    activeCell(element).dispatchEvent(key('Enter'));
    input(editControl(element), 'A');
    expect(changed).toHaveBeenCalledTimes(1);

    button(element, 'Insert row below').click();
    expect(element.getContent()).toBe('A,b\r\n,');
    expect(changed).toHaveBeenCalledTimes(2);

    activeCell(element).dispatchEvent(key('z', { ctrlKey: true }));
    expect(element.getContent()).toBe('A,b');
    activeCell(element).dispatchEvent(key('z', { ctrlKey: true }));
    expect(element.getContent()).toBe('a,b');
  });

  it('disables restructuring during IME composition and resumes after composition ends', () => {
    const element = createCsv('a');
    activeCell(element).dispatchEvent(key('Enter'));
    const textarea = editControl(element);
    textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));

    expect(toolbarButtons(element).every((item) => item.disabled)).toBe(true);
    button(element, 'Insert row below').click();
    expect(element.getContent()).toBe('a');

    textarea.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    expect(button(element, 'Insert row below').disabled).toBe(false);
    button(element, 'Insert row below').click();
    expect(element.getContent()).toBe('a\r\n""');
  });

  it('atomically transforms embedded merges and restores exact source, presentation, and selection', () => {
    const source = [
      '---',
      '# preserve on undo',
      'sheet: stillpoint/v1',
      'presentation:',
      '  merges:',
      '    - range: A1:B3',
      '---',
      'Anchor,,c0',
      ',,c1',
      ',,c2',
    ].join('\n');
    const element = createDocument(source);
    const changed = vi.fn();
    element.addEventListener('content-change', changed);
    pointerDown(dataCell(element, 1, 2));

    button(element, 'Insert row above').click();
    expect(documentPresentation(element).merges).toEqual([
      { startRow: 0, endRow: 4, startColumn: 0, endColumn: 2 },
    ]);
    expect(documentRows(element)[1]).toEqual(['', '', '']);
    expect(activeCell(element).dataset).toMatchObject({ row: '1', column: '2' });

    activeCell(element).dispatchEvent(key('z', { ctrlKey: true }));
    expect(element.getContent()).toBe(source);
    expect(activeCell(element).dataset).toMatchObject({ row: '1', column: '2' });

    activeCell(element).dispatchEvent(key('z', { ctrlKey: true, shiftKey: true }));
    expect(documentPresentation(element).merges).toEqual([
      { startRow: 0, endRow: 4, startColumn: 0, endColumn: 2 },
    ]);
    expect(changed).toHaveBeenCalledTimes(3);
  });

  it('contracts a merge when its anchor row is deleted', () => {
    const source = [
      '---',
      'sheet: stillpoint/v1',
      'presentation:',
      '  merges:',
      '    - range: A1:B3',
      '---',
      'Anchor,',
      ',',
      ',',
    ].join('\n');
    const element = createDocument(source);

    button(element, 'Delete row').click();

    expect(documentRows(element)).toEqual([
      ['', ''],
      ['', ''],
    ]);
    expect(documentPresentation(element).merges).toEqual([
      { startRow: 0, endRow: 2, startColumn: 0, endColumn: 2 },
    ]);
    expect(dataCell(element, 0, 0).colSpan).toBe(2);
  });

  it('accepts canonical serialization that reorders equivalent embedded merges', () => {
    const source = [
      '---',
      'sheet: stillpoint/v1',
      'presentation:',
      '  merges:',
      '    - range: B2:C2',
      '    - range: A1:B1',
      '---',
      'First,,x',
      'x,Second,',
    ].join('\n');
    const element = createDocument(source);

    button(element, 'Insert row below').click();

    expect(documentPresentation(element).merges).toEqual([
      { startRow: 0, endRow: 1, startColumn: 0, endColumn: 2 },
      { startRow: 2, endRow: 3, startColumn: 1, endColumn: 3 },
    ]);
    expect(documentRows(element)).toHaveLength(3);
  });

  it('tracks a valid view override without mutating or persisting it', () => {
    const source = [
      '---',
      '# exact baseline',
      'sheet: stillpoint/v1',
      'presentation:',
      '  merges:',
      '    - range: A1:B1',
      '---',
      'Embedded,',
      'Override,',
    ].join('\n');
    const replacement = { startRow: 1, endRow: 2, startColumn: 0, endColumn: 2 };
    const options = { presentation: { merges: [replacement] } };
    const element = createDocument(source, options);

    button(element, 'Insert row above').click();

    expect(documentPresentation(element).merges).toEqual([
      { startRow: 1, endRow: 2, startColumn: 0, endColumn: 2 },
    ]);
    expect(dataCell(element, 1, 0).colSpan).toBe(1);
    expect(dataCell(element, 2, 0).colSpan).toBe(2);
    expect(replacement).toEqual({ startRow: 1, endRow: 2, startColumn: 0, endColumn: 2 });

    activeCell(element).dispatchEvent(key('z', { ctrlKey: true }));
    expect(element.getContent()).toBe(source);
    expect(dataCell(element, 1, 0).colSpan).toBe(2);
  });

  it.each([
    ['inherit when omitted', {}, 2],
    ['inherit when merges are undefined', { presentation: { merges: undefined } }, 2],
    ['suppress with null', { presentation: null }, 1],
    ['suppress with an empty replacement', { presentation: { merges: [] } }, 1],
  ] as const)('%s while embedded coordinates still move in source', (_label, options, colSpan) => {
    const source = [
      '---',
      'sheet: stillpoint/v1',
      'presentation:',
      '  merges:',
      '    - range: A1:B1',
      '---',
      'Anchor,',
    ].join('\n');
    const element = createDocument(source, options);

    button(element, 'Insert row above').click();

    expect(documentPresentation(element).merges).toEqual([
      { startRow: 1, endRow: 2, startColumn: 0, endColumn: 2 },
    ]);
    expect(dataCell(element, 1, 0).colSpan).toBe(colSpan);
  });

  it('disables cap-bound actions and rejects a serialized-byte overflow without partial state', () => {
    const rowCap = createCsv(
      Array.from({ length: DEFAULT_CSV_LIMITS.maxMaterializedRows }, () => 'x').join('\n')
    );
    expect(button(rowCap, 'Insert row above').disabled).toBe(true);
    expect(button(rowCap, 'Insert row below').disabled).toBe(true);

    const columnCap = createCsv(
      Array.from({ length: DEFAULT_CSV_LIMITS.maxColumns }, () => 'x').join(',')
    );
    expect(button(columnCap, 'Insert column before').disabled).toBe(true);
    expect(button(columnCap, 'Insert column after').disabled).toBe(true);

    const largeCell = 'x'.repeat(DEFAULT_CSV_LIMITS.maxCellBytes - 1);
    const source = [largeCell, largeCell, largeCell, largeCell].join('\n');
    const byteCap = createCsv(source);
    const changed = vi.fn();
    byteCap.addEventListener('content-change', changed);
    button(byteCap, 'Insert column after').click();

    expect(byteCap.getContent()).toBe(source);
    expect(changed).not.toHaveBeenCalled();
    expect(
      byteCap.shadowRoot?.querySelector('#sheet-editor-structure-notice')?.textContent
    ).toContain('262,144-byte limit');
    expect(byteCap.shadowRoot?.activeElement).toBe(activeCell(byteCap));
  });

  it('clears structural history when the source adapter is replaced', () => {
    const element = createDocument('---\nsheet: stillpoint/v1\n---\na,b');
    button(element, 'Insert row below').click();
    expect(documentRows(element)).toHaveLength(2);

    element.setContent('plain');
    activeCell(element).dispatchEvent(key('z', { ctrlKey: true }));
    expect(element.getContent()).toBe('plain');

    element.setDocumentSource('---\nsheet: stillpoint/v1\n---\nnew,value');
    activeCell(element).dispatchEvent(key('z', { ctrlKey: true }));
    expect(element.getContent()).toBe('---\nsheet: stillpoint/v1\n---\nnew,value');
  });
});

function createCsv(source: string, options: SheetContentOptions = {}): SheetEditor {
  const element = new SheetEditor();
  element.setContent(source, options);
  document.body.append(element);
  return element;
}

function createDocument(source: string, options: SheetContentOptions = {}): SheetEditor {
  const element = new SheetEditor();
  element.setDocumentSource(source, options);
  document.body.append(element);
  return element;
}

function toolbarButtons(element: SheetEditor): HTMLButtonElement[] {
  return [
    ...(element.shadowRoot?.querySelectorAll<HTMLButtonElement>('button[data-sheet-command]') ??
      []),
  ];
}

function button(element: SheetEditor, label: string): HTMLButtonElement {
  const match = toolbarButtons(element).find((item) => item.getAttribute('aria-label') === label);
  if (!match) throw new Error(`expected toolbar button ${label}`);
  return match;
}

function activeCell(element: SheetEditor): HTMLTableCellElement {
  const cell = element.shadowRoot?.querySelector<HTMLTableCellElement>('td[tabindex="0"]');
  if (!cell) throw new Error('expected an active cell');
  return cell;
}

function selectedCells(element: SheetEditor): HTMLTableCellElement[] {
  return [
    ...(element.shadowRoot?.querySelectorAll<HTMLTableCellElement>('td[aria-selected="true"]') ??
      []),
  ];
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
  textarea.value = value;
  textarea.setSelectionRange(value.length, value.length);
  textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
}

function pointerDown(cell: HTMLTableCellElement): void {
  const event = new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 });
  Object.defineProperty(event, 'pointerId', { value: 1 });
  cell.dispatchEvent(event);
}

function documentRows(element: SheetEditor): readonly (readonly string[])[] {
  const parsed = parseSheetDocument(element.getContent());
  if (!parsed.ok) throw new Error(`expected a valid document: ${parsed.error.message}`);
  return parsed.document.data.rows;
}

function documentPresentation(element: SheetEditor) {
  const parsed = parseSheetDocument(element.getContent());
  if (!parsed.ok) throw new Error(`expected a valid document: ${parsed.error.message}`);
  return parsed.document.presentation;
}
