import { afterEach, describe, expect, it, vi } from 'vitest';

import { parseSheetDocument } from '../document';

import { SheetEditor } from './sheet-editor';

import type { SheetContentOptions } from '../presentation';

const STRUCTURE_LABELS = [
  'Insert row above',
  'Insert row below',
  'Insert column before',
  'Insert column after',
  'Delete row',
  'Delete column',
];

describe('sheet-editor formatting toolbar', () => {
  afterEach(() => document.body.replaceChildren());

  it('adds sixteen ordered grouped tools only for explicit document sessions', () => {
    const documentEditor = createDocument(sheet('a,b'));
    const toolbar = documentEditor.shadowRoot?.querySelector('[role="toolbar"]');
    const buttons = toolbarButtons(documentEditor);

    expect(toolbar?.getAttribute('aria-label')).toBe('Sheet tools');
    expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual([
      'Bold',
      'Italic',
      'Strikethrough',
      'Horizontal alignment: Left',
      'Vertical alignment: Middle',
      'Currency',
      'Percent',
      'Decrease decimal places',
      'Increase decimal places',
      'Value format: Automatic',
      ...STRUCTURE_LABELS,
    ]);
    expect(buttons).toHaveLength(16);
    expect(buttons.filter((button) => button.tabIndex === 0)).toEqual([
      formatButton(documentEditor, 'bold'),
    ]);
    expect(toolbar?.querySelectorAll('[role="group"]')).toHaveLength(5);
    expect(toolbar?.querySelectorAll('.sheet-editor__toolbar-separator')).toHaveLength(4);
    expect(trigger(documentEditor, 'horizontal').getAttribute('aria-haspopup')).toBe('menu');
    expect(trigger(documentEditor, 'horizontal').getAttribute('aria-controls')).toBe(
      menu(documentEditor, 'horizontal').id
    );
    expect(menu(documentEditor, 'horizontal').parentElement?.classList).toContain(
      'sheet-editor__toolbar-shell'
    );
    expect(menu(documentEditor, 'horizontal').parentElement).not.toBe(toolbar);

    const csvEditor = createCsv('a,b');
    expect(toolbarButtons(csvEditor).map((button) => button.getAttribute('aria-label'))).toEqual(
      STRUCTURE_LABELS
    );
    expect(csvEditor.shadowRoot?.querySelector('[data-sheet-format]')).toBeNull();
    expect(csvEditor.shadowRoot?.querySelector('[data-sheet-alignment-trigger]')).toBeNull();
    expect(csvEditor.shadowRoot?.querySelector('[data-sheet-value-format-trigger]')).toBeNull();
    expect(csvEditor.shadowRoot?.querySelector('[role="menu"]')).toBeNull();
    expect(csvEditor.getContent()).toBe('a,b');
  });

  it('renders effective styles and synchronizes homogeneous and mixed toolbar state', () => {
    const source = [
      '---',
      'sheet: stillpoint/v1',
      'presentation:',
      '  formats:',
      '    - range: A1',
      '      bold: true',
      '      italic: true',
      '      strikethrough: true',
      '  alignments:',
      '    - range: A1',
      '      horizontal: center',
      '      vertical: top',
      '---',
      'a,b',
    ].join('\n');
    const element = createDocument(source);
    const first = dataCell(element, 0, 0);

    expect(first.classList.contains('sheet-table__cell--bold')).toBe(true);
    expect(first.classList.contains('sheet-table__cell--italic')).toBe(true);
    expect(first.classList.contains('sheet-table__cell--strikethrough')).toBe(true);
    expect(first.classList.contains('sheet-table__cell--align-center')).toBe(true);
    expect(first.classList.contains('sheet-table__cell--align-top')).toBe(true);
    expect(formatButton(element, 'bold').getAttribute('aria-pressed')).toBe('true');
    expect(trigger(element, 'horizontal').getAttribute('aria-label')).toBe(
      'Horizontal alignment: Center'
    );
    expect(trigger(element, 'vertical').getAttribute('aria-label')).toBe('Vertical alignment: Top');

    activeCell(element).dispatchEvent(key('ArrowRight', { shiftKey: true }));
    expect(formatButton(element, 'bold').getAttribute('aria-pressed')).toBe('mixed');
    expect(formatButton(element, 'italic').getAttribute('aria-pressed')).toBe('mixed');
    expect(trigger(element, 'horizontal').dataset.sheetAlignmentState).toBe('mixed');
    expect(trigger(element, 'horizontal').getAttribute('aria-label')).toBe(
      'Horizontal alignment: Mixed'
    );

    trigger(element, 'horizontal').click();
    const horizontalMenu = menu(element, 'horizontal');
    expect(horizontalMenu.hidden).toBe(false);
    expect(horizontalMenu.getAttribute('aria-label')).toBe('Horizontal alignment, Mixed');
    expect(
      [...horizontalMenu.querySelectorAll('[role="menuitemradio"]')].filter(
        (item) => item.getAttribute('aria-checked') === 'true'
      )
    ).toHaveLength(0);
    expect(element.shadowRoot?.activeElement).toBe(alignmentItem(element, 'horizontal', 'left'));
  });

  it('toggles a complete selection, emits once, retains focus, and undoes to exact bytes', () => {
    const source = '---\n# exact baseline\nsheet: stillpoint/v1\n---\na,b\nc,d';
    const element = createDocument(source);
    const changed = vi.fn();
    element.addEventListener('content-change', changed);
    activeCell(element).dispatchEvent(key('ArrowRight', { shiftKey: true }));
    activeCell(element).dispatchEvent(key('ArrowDown', { shiftKey: true }));
    const scroll = element.shadowRoot?.querySelector<HTMLElement>('.sheet-surface__scroll');
    if (!scroll) throw new Error('expected scroll surface');
    scroll.scrollLeft = 37;
    scroll.scrollTop = 19;

    formatButton(element, 'bold').click();

    expect(changed).toHaveBeenCalledTimes(1);
    expect(changed).toHaveBeenLastCalledWith(
      expect.objectContaining({ detail: { content: element.getContent() } })
    );
    expect(documentRows(element)).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
    expect(documentPresentation(element).formats).toEqual([
      {
        range: { startRow: 0, endRow: 2, startColumn: 0, endColumn: 2 },
        bold: true,
      },
    ]);
    expect(
      dataCells(element)
        .filter((cell) => Number(cell.dataset.row) < 2 && Number(cell.dataset.column) < 2)
        .every((cell) => cell.classList.contains('sheet-table__cell--bold'))
    ).toBe(true);
    expect(element.shadowRoot?.activeElement).toBe(formatButton(element, 'bold'));
    expect(element.shadowRoot?.querySelector<HTMLElement>('.sheet-surface__scroll')).toMatchObject({
      scrollLeft: 37,
      scrollTop: 19,
    });

    formatButton(element, 'bold').click();
    expect(changed).toHaveBeenCalledTimes(2);
    expect(element.getContent()).toBe(source);

    activeCell(element).dispatchEvent(key('z', { ctrlKey: true }));
    expect(documentPresentation(element).formats).toEqual([
      {
        range: { startRow: 0, endRow: 2, startColumn: 0, endColumn: 2 },
        bold: true,
      },
    ]);
    activeCell(element).dispatchEvent(key('z', { ctrlKey: true }));
    expect(element.getContent()).toBe(source);
    activeCell(element).dispatchEvent(key('z', { ctrlKey: true, shiftKey: true }));
    expect(documentPresentation(element).formats).toEqual([
      {
        range: { startRow: 0, endRow: 2, startColumn: 0, endColumn: 2 },
        bold: true,
      },
    ]);
  });

  it('turns a mixed emphasis selection on while preserving unrelated properties', () => {
    const element = createDocument(
      [
        '---',
        'sheet: stillpoint/v1',
        'presentation:',
        '  formats:',
        '    - range: A1',
        '      bold: true',
        '    - range: B1',
        '      italic: true',
        '---',
        'a,b',
      ].join('\n')
    );
    activeCell(element).dispatchEvent(key('ArrowRight', { shiftKey: true }));
    expect(formatButton(element, 'bold').getAttribute('aria-pressed')).toBe('mixed');

    formatButton(element, 'bold').click();

    expect(dataCell(element, 0, 0).classList.contains('sheet-table__cell--bold')).toBe(true);
    expect(dataCell(element, 0, 1).classList.contains('sheet-table__cell--bold')).toBe(true);
    expect(dataCell(element, 0, 1).classList.contains('sheet-table__cell--italic')).toBe(true);
    expect(formatButton(element, 'bold').getAttribute('aria-pressed')).toBe('true');
  });

  it('undoes a hand-authored overlapping presentation to its exact original bytes', () => {
    const source = [
      '---',
      '# preserve overlap ordering',
      'sheet: stillpoint/v1',
      'presentation:',
      '  formats:',
      '    - range: A1:B1',
      '      bold: true',
      '    - range: B1',
      '      bold: false',
      '      italic: true',
      '---',
      'a,b',
    ].join('\n');
    const element = createDocument(source);

    formatButton(element, 'strikethrough').click();
    expect(element.getContent()).not.toBe(source);
    formatButton(element, 'strikethrough').dispatchEvent(key('z', { ctrlKey: true }));

    expect(element.getContent()).toBe(source);
    expect(formatButton(element, 'bold').getAttribute('aria-pressed')).toBe('true');
    expect(formatButton(element, 'strikethrough').getAttribute('aria-pressed')).toBe('false');
  });

  it('sets alignment from flyouts, treats the current value as a no-op, and restores trigger focus', () => {
    const element = createDocument(sheet('a,b\nc,d'));
    const changed = vi.fn();
    element.addEventListener('content-change', changed);
    activeCell(element).dispatchEvent(key('ArrowRight', { shiftKey: true }));

    trigger(element, 'horizontal').click();
    alignmentItem(element, 'horizontal', 'right').click();

    expect(changed).toHaveBeenCalledTimes(1);
    expect(trigger(element, 'horizontal').getAttribute('aria-expanded')).toBe('false');
    expect(element.shadowRoot?.activeElement).toBe(trigger(element, 'horizontal'));
    expect(dataCell(element, 0, 0).classList.contains('sheet-table__cell--align-right')).toBe(true);
    expect(dataCell(element, 0, 1).classList.contains('sheet-table__cell--align-right')).toBe(true);
    expect(documentPresentation(element).alignments).toEqual([
      {
        range: { startRow: 0, endRow: 1, startColumn: 0, endColumn: 2 },
        horizontal: 'right',
      },
    ]);

    trigger(element, 'horizontal').click();
    expect(alignmentItem(element, 'horizontal', 'right').getAttribute('aria-checked')).toBe('true');
    alignmentItem(element, 'horizontal', 'right').click();
    expect(changed).toHaveBeenCalledTimes(1);

    trigger(element, 'vertical').click();
    alignmentItem(element, 'vertical', 'bottom').click();
    expect(changed).toHaveBeenCalledTimes(2);
    expect(dataCell(element, 0, 0).classList.contains('sheet-table__cell--align-bottom')).toBe(
      true
    );
    expect(dataCell(element, 0, 0).classList.contains('sheet-table__cell--align-right')).toBe(true);
  });

  it('supports complete alignment-menu keyboard navigation and single-open/outside ownership', () => {
    const element = createDocument(sheet('a,b'));
    const horizontal = trigger(element, 'horizontal');
    const vertical = trigger(element, 'vertical');

    horizontal.focus();
    horizontal.dispatchEvent(key('ArrowDown'));
    expect(menu(element, 'horizontal').hidden).toBe(false);
    expect(element.shadowRoot?.activeElement).toBe(alignmentItem(element, 'horizontal', 'left'));
    alignmentItem(element, 'horizontal', 'left').dispatchEvent(key('ArrowDown'));
    expect(element.shadowRoot?.activeElement).toBe(alignmentItem(element, 'horizontal', 'center'));
    alignmentItem(element, 'horizontal', 'center').dispatchEvent(key('End'));
    expect(element.shadowRoot?.activeElement).toBe(alignmentItem(element, 'horizontal', 'right'));
    alignmentItem(element, 'horizontal', 'right').dispatchEvent(key('Home'));
    expect(element.shadowRoot?.activeElement).toBe(alignmentItem(element, 'horizontal', 'left'));
    alignmentItem(element, 'horizontal', 'left').dispatchEvent(key('ArrowUp'));
    expect(element.shadowRoot?.activeElement).toBe(alignmentItem(element, 'horizontal', 'right'));
    alignmentItem(element, 'horizontal', 'right').dispatchEvent(key('Escape'));
    expect(menu(element, 'horizontal').hidden).toBe(true);
    expect(element.shadowRoot?.activeElement).toBe(horizontal);

    horizontal.click();
    vertical.click();
    expect(menu(element, 'horizontal').hidden).toBe(true);
    expect(horizontal.getAttribute('aria-expanded')).toBe('false');
    expect(menu(element, 'vertical').hidden).toBe(false);
    document.body.dispatchEvent(
      new MouseEvent('pointerdown', { bubbles: true, cancelable: true, composed: true, button: 0 })
    );
    expect(menu(element, 'vertical').hidden).toBe(true);

    horizontal.click();
    const tabEvent = key('Tab');
    expect(alignmentItem(element, 'horizontal', 'left').dispatchEvent(tabEvent)).toBe(true);
    expect(menu(element, 'horizontal').hidden).toBe(true);
    expect(element.shadowRoot?.activeElement).toBe(horizontal);

    trigger(element, 'horizontal').dispatchEvent(key(' '));
    alignmentItem(element, 'horizontal', 'left').dispatchEvent(key('ArrowDown'));
    alignmentItem(element, 'horizontal', 'center').dispatchEvent(key('Enter'));
    expect(dataCell(element, 0, 0).classList.contains('sheet-table__cell--align-center')).toBe(
      true
    );
    expect(element.shadowRoot?.activeElement).toBe(trigger(element, 'horizontal'));
  });

  it('formats ragged and merged stored rectangles without padding values and refuses virtual edges', () => {
    const ragged = createDocument(sheet('a\nb,c'));
    activeCell(ragged).dispatchEvent(key('ArrowRight', { shiftKey: true }));
    expect(formatButton(ragged, 'bold').disabled).toBe(false);
    formatButton(ragged, 'bold').click();
    expect(documentRows(ragged)).toEqual([['a'], ['b', 'c']]);
    expect(documentPresentation(ragged).formats).toEqual([
      {
        range: { startRow: 0, endRow: 1, startColumn: 0, endColumn: 2 },
        bold: true,
      },
    ]);

    pointerDown(dataCell(ragged, 0, 1));
    activeCell(ragged).dispatchEvent(key('ArrowRight'));
    expect(formatButton(ragged, 'bold').disabled).toBe(true);

    const merged = createDocument(
      '---\nsheet: stillpoint/v1\npresentation:\n  merges:\n    - range: A1:B1\n---\nAnchor,'
    );
    formatButton(merged, 'italic').click();
    expect(documentPresentation(merged).formats).toEqual([
      {
        range: { startRow: 0, endRow: 1, startColumn: 0, endColumn: 2 },
        italic: true,
      },
    ]);
    expect(dataCell(merged, 0, 0).classList.contains('sheet-table__cell--italic')).toBe(true);
  });

  it('disables only masked authoring sections and keeps valid read-only document controls visible', () => {
    const range = { startRow: 0, endRow: 1, startColumn: 0, endColumn: 1 };
    const formatsMasked = createDocument(sheet('a'), { presentation: { formats: [] } });
    expect(formatButton(formatsMasked, 'bold').disabled).toBe(true);
    expect(trigger(formatsMasked, 'horizontal').disabled).toBe(false);

    const alignmentsMasked = createDocument(sheet('a'), {
      presentation: { alignments: [{ range, horizontal: 'center' }] },
    });
    expect(formatButton(alignmentsMasked, 'bold').disabled).toBe(false);
    expect(trigger(alignmentsMasked, 'horizontal').disabled).toBe(true);

    const suppressed = createDocument(sheet('a'), { presentation: null });
    expect(formatButton(suppressed, 'bold').disabled).toBe(true);
    expect(trigger(suppressed, 'horizontal').disabled).toBe(true);

    const readonly = createDocument(sheet('a'));
    readonly.setAttribute('readonly', 'true');
    expect(toolbarButtons(readonly)).toHaveLength(16);
    expect(toolbarButtons(readonly).every((button) => button.disabled)).toBe(true);

    const empty = createDocument(sheet(''));
    expect(formatButton(empty, 'bold').disabled).toBe(true);
    expect(structureButton(empty, 'Insert row above').disabled).toBe(false);
  });

  it('commits an open draft before formatting, blocks IME, and keeps two undo entries', () => {
    const element = createDocument(sheet('a,b'));
    const changed = vi.fn();
    element.addEventListener('content-change', changed);
    activeCell(element).dispatchEvent(key('Enter'));
    const textarea = editControl(element);
    input(textarea, 'A');
    textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    expect(formatButton(element, 'bold').disabled).toBe(true);
    formatButton(element, 'bold').click();
    expect(documentPresentation(element).formats).toBeUndefined();

    textarea.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    const scroll = element.shadowRoot?.querySelector<HTMLElement>('.sheet-surface__scroll');
    if (!scroll) throw new Error('expected scroll surface');
    scroll.scrollLeft = 29;
    scroll.scrollTop = 17;
    formatButton(element, 'bold').click();
    expect(changed).toHaveBeenCalledTimes(2);
    expect(documentRows(element)[0]?.[0]).toBe('A');
    expect(documentPresentation(element).formats).toHaveLength(1);
    expect(element.shadowRoot?.querySelector<HTMLElement>('.sheet-surface__scroll')).toMatchObject({
      scrollLeft: 29,
      scrollTop: 17,
    });

    activeCell(element).dispatchEvent(key('z', { ctrlKey: true }));
    expect(documentRows(element)[0]?.[0]).toBe('A');
    expect(documentPresentation(element).formats).toBeUndefined();
    activeCell(element).dispatchEvent(key('z', { ctrlKey: true }));
    expect(documentRows(element)[0]?.[0]).toBe('a');
  });

  it('clears formatting state and history across document/CSV/document replacement', () => {
    const element = createDocument(sheet('a'));
    formatButton(element, 'bold').click();
    expect(formatButton(element, 'bold').getAttribute('aria-pressed')).toBe('true');

    element.setContent('plain');
    expect(element.shadowRoot?.querySelector('[data-sheet-format]')).toBeNull();
    activeCell(element).dispatchEvent(key('z', { ctrlKey: true }));
    expect(element.getContent()).toBe('plain');

    element.setDocumentSource(sheet('new'));
    expect(formatButton(element, 'bold').getAttribute('aria-pressed')).toBe('false');
    expect(dataCell(element, 0, 0).classList.contains('sheet-table__cell--bold')).toBe(false);
  });
});

function sheet(body: string): string {
  return `---\nsheet: stillpoint/v1\n---\n${body}`;
}

function createDocument(source: string, options: SheetContentOptions = {}): SheetEditor {
  const element = new SheetEditor();
  element.setDocumentSource(source, options);
  document.body.append(element);
  return element;
}

function createCsv(source: string): SheetEditor {
  const element = new SheetEditor();
  element.setContent(source);
  document.body.append(element);
  return element;
}

function toolbarButtons(element: SheetEditor): HTMLButtonElement[] {
  return [
    ...(element.shadowRoot?.querySelectorAll<HTMLButtonElement>('[data-sheet-toolbar-command]') ??
      []),
  ];
}

function formatButton(element: SheetEditor, property: string): HTMLButtonElement {
  const button = element.shadowRoot?.querySelector<HTMLButtonElement>(
    `[data-sheet-format="${property}"]`
  );
  if (!button) throw new Error(`expected ${property} button`);
  return button;
}

function trigger(element: SheetEditor, axis: string): HTMLButtonElement {
  const button = element.shadowRoot?.querySelector<HTMLButtonElement>(
    `[data-sheet-alignment-trigger="${axis}"]`
  );
  if (!button) throw new Error(`expected ${axis} trigger`);
  return button;
}

function menu(element: SheetEditor, axis: string): HTMLElement {
  const result = element.shadowRoot?.querySelector<HTMLElement>(
    `[data-sheet-alignment-menu="${axis}"]`
  );
  if (!result) throw new Error(`expected ${axis} menu`);
  return result;
}

function alignmentItem(element: SheetEditor, axis: string, value: string): HTMLButtonElement {
  const item = menu(element, axis).querySelector<HTMLButtonElement>(
    `[data-sheet-alignment-value="${value}"]`
  );
  if (!item) throw new Error(`expected ${axis} ${value}`);
  return item;
}

function structureButton(element: SheetEditor, label: string): HTMLButtonElement {
  const result = [
    ...(element.shadowRoot?.querySelectorAll<HTMLButtonElement>('[data-sheet-command]') ?? []),
  ].find((button) => button.getAttribute('aria-label') === label);
  if (!result) throw new Error(`expected ${label}`);
  return result;
}

function dataCell(element: SheetEditor, row: number, column: number): HTMLTableCellElement {
  const cell = element.shadowRoot?.querySelector<HTMLTableCellElement>(
    `td[data-row="${row}"][data-column="${column}"]`
  );
  if (!cell) throw new Error(`expected cell ${row}:${column}`);
  return cell;
}

function dataCells(element: SheetEditor): HTMLTableCellElement[] {
  return [...(element.shadowRoot?.querySelectorAll<HTMLTableCellElement>('tbody td') ?? [])];
}

function activeCell(element: SheetEditor): HTMLTableCellElement {
  const cell = element.shadowRoot?.querySelector<HTMLTableCellElement>('td[tabindex="0"]');
  if (!cell) throw new Error('expected active cell');
  return cell;
}

function editControl(element: SheetEditor): HTMLTextAreaElement {
  const textarea = element.shadowRoot?.querySelector<HTMLTextAreaElement>('textarea');
  if (!textarea) throw new Error('expected textarea');
  return textarea;
}

function input(textarea: HTMLTextAreaElement, value: string): void {
  textarea.value = value;
  textarea.setSelectionRange(value.length, value.length);
  textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
}

function key(keyValue: string, init: KeyboardEventInit = {}): KeyboardEvent {
  return new KeyboardEvent('keydown', {
    bubbles: true,
    cancelable: true,
    key: keyValue,
    ...init,
  });
}

function pointerDown(cell: HTMLTableCellElement): void {
  const event = new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 });
  Object.defineProperty(event, 'pointerId', { value: 1 });
  cell.dispatchEvent(event);
}

function documentRows(element: SheetEditor): string[][] {
  const parsed = parseSheetDocument(element.getContent());
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.document.data.rows;
}

function documentPresentation(element: SheetEditor) {
  const parsed = parseSheetDocument(element.getContent());
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.document.presentation;
}
