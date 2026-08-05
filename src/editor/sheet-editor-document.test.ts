import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_CSV_LIMITS } from '../csv';
import { parseSheetDocument } from '../document';
import { setErrorHandler } from '../log';

import { SheetEditor } from './sheet-editor';

import type { SheetContentOptions } from '../presentation';

const MERGED_SOURCE = [
  '---',
  '# retained until the first value edit',
  'sheet: stillpoint/v1',
  'presentation:',
  '  merges:',
  '    - range: A1:C1',
  '    - range: A2:A3',
  '    - range: B4:C5',
  '---',
  'Heading,,',
  'Vertical,One,Two',
  ',Three,Four',
  'Row 4,Block,',
  'Row 5,,',
].join('\n');

describe('sheet-editor document source adapter', () => {
  afterEach(() => {
    document.body.replaceChildren();
    setErrorHandler(null);
  });

  it.each([
    ['minimal default-format document', '---\nsheet: stillpoint/v1\n---\na,b'],
    ['explicit-format document', '---\nsheet: stillpoint/v1\nformat: csv\n---\na,b'],
    ['empty document body', '---\nsheet: stillpoint/v1\n---\n'],
    ['CRLF document', '---\r\nsheet: stillpoint/v1\r\n---\r\na,b'],
  ])('loads a %s without rewriting it', (_label, source) => {
    const element = createDocument(source);
    const changed = vi.fn();
    element.addEventListener('content-change', changed);

    activeCell(element).dispatchEvent(key('ArrowRight'));

    expect(element.getContent()).toBe(source);
    expect(changed).not.toHaveBeenCalled();
  });

  it('keeps setContent CSV-only even when a record begins with an envelope marker', () => {
    const source = '---\nsheet: stillpoint/v1\n---';
    const element = new SheetEditor();
    element.setContent(source);
    document.body.append(element);

    expect(dataCell(element, 0, 0).textContent).toBe('---');
    expect(dataCell(element, 1, 0).textContent).toBe('sheet: stillpoint/v1');
    expect(element.getContent()).toBe(source);
  });

  it('renders and navigates horizontal, vertical, and rectangular embedded merges as units', () => {
    const element = createDocument(MERGED_SOURCE);

    expect(dataCell(element, 0, 0).colSpan).toBe(3);
    expect(dataCell(element, 1, 0).rowSpan).toBe(2);
    expect(dataCell(element, 3, 1)).toMatchObject({ rowSpan: 2, colSpan: 2 });
    expect(element.shadowRoot?.querySelector('td[data-row="0"][data-column="1"]')).toBeNull();

    pointerDown(dataCell(element, 0, 0));
    activeCell(element).dispatchEvent(key('ArrowRight'));
    expect(activeCell(element).dataset).toMatchObject({ row: '0', column: '3' });

    pointerDown(dataCell(element, 1, 0));
    activeCell(element).dispatchEvent(key('ArrowDown'));
    expect(activeCell(element).dataset).toMatchObject({ row: '3', column: '0' });

    pointerDown(dataCell(element, 3, 1));
    activeCell(element).dispatchEvent(key('ArrowDown'));
    expect(activeCell(element).dataset).toMatchObject({ row: '5', column: '1' });
  });

  it('emits a complete canonical document for an open draft and preserves embedded presentation', () => {
    const element = createDocument(MERGED_SOURCE);
    const changed = vi.fn();
    element.addEventListener('content-change', changed);

    activeCell(element).dispatchEvent(key('Enter'));
    input(editControl(element), 'Updated heading');

    const draftSource = element.getContent();
    expect(draftSource).toContain('sheet: stillpoint/v1\nformat: csv');
    expect(draftSource).not.toContain('# retained until the first value edit');
    expect(changed).toHaveBeenCalledTimes(1);
    expect(changed).toHaveBeenLastCalledWith(
      expect.objectContaining({ detail: { content: draftSource } })
    );

    const parsed = parseSheetDocument(draftSource);
    if (!parsed.ok) throw new Error('expected edited document to parse');
    expect(parsed.document.data.rows[0]).toEqual(['Updated heading', '', '']);
    expect(parsed.document.presentation.merges).toEqual([
      { startRow: 0, endRow: 1, startColumn: 0, endColumn: 3 },
      { startRow: 1, endRow: 3, startColumn: 0, endColumn: 1 },
      { startRow: 3, endRow: 5, startColumn: 1, endColumn: 3 },
    ]);

    editControl(element).dispatchEvent(key('Enter'));
    expect(changed).toHaveBeenCalledTimes(1);
    expect(element.getContent()).toBe(draftSource);
  });

  it('restores exact source after cancel, same-value commit, and undo-to-baseline', () => {
    const source = '---\n# keep me\nsheet: stillpoint/v1\n---\na,b';
    const element = createDocument(source);
    const changed = vi.fn();
    element.addEventListener('content-change', changed);

    activeCell(element).dispatchEvent(key('Enter'));
    input(editControl(element), 'draft');
    editControl(element).dispatchEvent(key('Escape'));
    expect(element.getContent()).toBe(source);
    expect(changed).toHaveBeenCalledTimes(2);

    activeCell(element).dispatchEvent(key('Enter'));
    input(editControl(element), 'a');
    editControl(element).dispatchEvent(key('Enter'));
    expect(element.getContent()).toBe(source);
    expect(changed).toHaveBeenCalledTimes(2);

    pointerDown(dataCell(element, 0, 1));
    activeCell(element).dispatchEvent(key('x'));
    editControl(element).dispatchEvent(key('Enter'));
    expect(element.getContent()).not.toBe(source);
    activeCell(element).dispatchEvent(key('z', { ctrlKey: true }));
    expect(element.getContent()).toBe(source);
  });

  it('uses the document opener line ending when canonicalizing an edit', () => {
    const source = '---\r\n# comment\r\nsheet: stillpoint/v1\r\n---\r\na,b';
    const element = createDocument(source);

    activeCell(element).dispatchEvent(key('Enter'));
    input(editControl(element), 'changed');

    const changed = element.getContent();
    expect(changed).toContain('---\r\nsheet: stillpoint/v1\r\nformat: csv\r\n---\r\nchanged,b');
    expect(changed.replaceAll('\r\n', '')).not.toContain('\n');
  });

  it('implements call-site inherit, suppress, and replacement precedence without persisting overrides', () => {
    const source = [
      '---',
      'sheet: stillpoint/v1',
      'presentation:',
      '  merges:',
      '    - range: A1:B1',
      '---',
      'Embedded,',
      'Replacement,',
    ].join('\n');
    const element = createDocument(source);

    expect(dataCell(element, 0, 0).colSpan).toBe(2);

    element.setDocumentSource(source, { presentation: null });
    expect(dataCell(element, 0, 0).colSpan).toBe(1);
    expect(dataCell(element, 0, 1)).not.toBeNull();

    element.setDocumentSource(source, { presentation: {} });
    expect(dataCell(element, 0, 0).colSpan).toBe(2);

    element.setDocumentSource(source, { presentation: { merges: undefined } });
    expect(dataCell(element, 0, 0).colSpan).toBe(2);

    element.setDocumentSource(source, { presentation: { merges: [] } });
    expect(dataCell(element, 0, 0).colSpan).toBe(1);

    const replacement = { startRow: 1, endRow: 2, startColumn: 0, endColumn: 2 };
    element.setDocumentSource(source, { presentation: { merges: [replacement] } });
    replacement.endColumn = 1;
    expect(dataCell(element, 0, 0).colSpan).toBe(1);
    expect(dataCell(element, 1, 0).colSpan).toBe(2);

    pointerDown(dataCell(element, 1, 0));
    activeCell(element).dispatchEvent(key('Enter'));
    input(editControl(element), 'Changed');
    const parsed = parseSheetDocument(element.getContent());
    expect(parsed).toMatchObject({
      ok: true,
      document: {
        presentation: {
          merges: [{ startRow: 0, endRow: 1, startColumn: 0, endColumn: 2 }],
        },
      },
    });
  });

  it('does not expose an embedded covered coordinate as an edit target when merges are suppressed', () => {
    const source = [
      '---',
      'sheet: stillpoint/v1',
      'presentation:',
      '  merges:',
      '    - range: A1:B1',
      '---',
      'Anchor,',
    ].join('\n');
    const element = createDocument(source, { presentation: null });

    pointerDown(dataCell(element, 0, 1));
    expect(activeCell(element).getAttribute('aria-readonly')).toBe('true');
    activeCell(element).dispatchEvent(key('Enter'));
    activeCell(element).dispatchEvent(key('x'));

    expect(element.shadowRoot?.querySelector('textarea')).toBeNull();
    expect(element.getContent()).toBe(source);
  });

  it('atomically replaces document, CSV, invalid, and document sessions without state leakage', () => {
    const element = createDocument(MERGED_SOURCE);
    const changed = vi.fn();
    element.addEventListener('content-change', changed);
    pointerDown(dataCell(element, 3, 1));
    activeCell(element).dispatchEvent(key('Enter'));
    input(editControl(element), 'discarded draft');
    const eventCount = changed.mock.calls.length;

    element.setContent('plain,again');
    expect(element.getContent()).toBe('plain,again');
    expect(activeCell(element).dataset).toMatchObject({ row: '0', column: '0' });
    expect(dataCell(element, 0, 0).colSpan).toBe(1);
    expect(changed).toHaveBeenCalledTimes(eventCount);

    activeCell(element).dispatchEvent(key('Enter'));
    input(editControl(element), 'committed');
    editControl(element).dispatchEvent(key('Enter'));
    element.setDocumentSource('not a document');
    expect(element.shadowRoot?.querySelector('[role="alert"]')).not.toBeNull();
    expect(element.shadowRoot?.querySelector('tbody td')).toBeNull();
    expect(element.getContent()).toBe('not a document');

    element.setDocumentSource('---\nsheet: stillpoint/v1\n---\nnew,value');
    activeCell(element).dispatchEvent(key('z', { ctrlKey: true }));
    expect(element.getContent()).toBe('---\nsheet: stillpoint/v1\n---\nnew,value');
  });

  it.each([
    ['malformed envelope', 'not a document'],
    ['malformed frontmatter', '---\nsheet: [\n---\na'],
    ['unsupported version', '---\nsheet: stillpoint/v2\n---\na'],
    ['unsupported format', '---\nsheet: stillpoint/v1\nformat: tsv\n---\na'],
    ['malformed body', '---\nsheet: stillpoint/v1\n---\n"unclosed'],
    [
      'oversized body',
      `---\nsheet: stillpoint/v1\n---\n${'x'.repeat(DEFAULT_CSV_LIMITS.maxInputBytes + 1)}`,
    ],
  ])('keeps a %s exact and non-mutating', (_label, source) => {
    const element = createDocument(source);
    const status = element.shadowRoot?.querySelector<HTMLElement>('[role="alert"]');

    expect(status).not.toBeNull();
    status?.dispatchEvent(key('Enter'));
    expect(element.shadowRoot?.querySelector('textarea')).toBeNull();
    expect(element.getContent()).toBe(source);
  });

  it('renders a truncated body safely while retaining the complete source', () => {
    const source = `---\nsheet: stillpoint/v1\n---\n${Array.from(
      { length: DEFAULT_CSV_LIMITS.maxMaterializedRows + 1 },
      (_, index) => index
    ).join('\n')}`;
    const element = createDocument(source);

    expect(element.shadowRoot?.querySelector('[role="grid"]')).toBeNull();
    expect(element.shadowRoot?.querySelector('.sheet-surface__notice')?.textContent).toContain(
      'Showing first 1,000 of 1,001 rows'
    );
    expect(element.getContent()).toBe(source);
  });

  it('shows contextually invalid embedded presentation unmerged and read-only with safe diagnostics', () => {
    const source = [
      '---',
      'sheet: stillpoint/v1',
      'presentation:',
      '  merges:',
      '    - range: A1:B1',
      '---',
      'visible,private value',
    ].join('\n');
    const report = vi.fn();
    setErrorHandler(report);
    const element = createDocument(source, { presentation: null });

    expect(dataCell(element, 0, 0).colSpan).toBe(1);
    expect(dataCell(element, 0, 1).textContent).toBe('private value');
    expect(element.shadowRoot?.querySelector('[role="grid"]')?.getAttribute('aria-readonly')).toBe(
      'true'
    );
    expect(element.shadowRoot?.querySelector('.sheet-surface__notice')?.textContent).toContain(
      'showing unmerged cells'
    );
    activeCell(element).dispatchEvent(key('Enter'));
    expect(element.shadowRoot?.querySelector('textarea')).toBeNull();
    expect(element.getContent()).toBe(source);
    expect(JSON.stringify(report.mock.calls)).not.toContain('private value');
    expect(JSON.stringify(report.mock.calls)).not.toContain('visible');
  });

  it('falls back from an invalid call-site override without making a valid source read-only', () => {
    const source = '---\nsheet: stillpoint/v1\n---\nvisible,occupied';
    setErrorHandler(vi.fn());
    const element = createDocument(source, {
      presentation: {
        merges: [{ startRow: 0, endRow: 1, startColumn: 0, endColumn: 2 }],
      },
    });

    expect(element.shadowRoot?.querySelector('[role="grid"]')?.getAttribute('aria-readonly')).toBe(
      'false'
    );
    expect(dataCell(element, 0, 1).textContent).toBe('occupied');
    activeCell(element).dispatchEvent(key('Enter'));
    input(editControl(element), 'changed');
    expect(element.getContent()).toContain('\nchanged,occupied');
  });

  it('cancels a document draft when readonly changes instead of saving partial state', () => {
    const source = '---\nsheet: stillpoint/v1\n---\na,b';
    const element = createDocument(source);
    const changed = vi.fn();
    element.addEventListener('content-change', changed);

    activeCell(element).dispatchEvent(key('F2'));
    input(editControl(element), 'draft');
    element.setAttribute('readonly', 'true');

    expect(element.getContent()).toBe(source);
    expect(element.shadowRoot?.querySelector('textarea')).toBeNull();
    expect(element.shadowRoot?.querySelector('[role="grid"]')?.getAttribute('aria-readonly')).toBe(
      'true'
    );
    expect(changed).toHaveBeenCalledTimes(2);
  });
});

function createDocument(source: string, options: SheetContentOptions = {}): SheetEditor {
  const element = new SheetEditor();
  element.setDocumentSource(source, options);
  document.body.append(element);
  return element;
}

function dataCell(element: SheetEditor, row: number, column: number): HTMLTableCellElement {
  const cell = element.shadowRoot?.querySelector<HTMLTableCellElement>(
    `td[data-row="${row}"][data-column="${column}"]`
  );
  if (!cell) throw new Error(`expected cell ${row}:${column}`);
  return cell;
}

function activeCell(element: SheetEditor): HTMLTableCellElement {
  const cell = element.shadowRoot?.querySelector<HTMLTableCellElement>('td[tabindex="0"]');
  if (!cell) throw new Error('expected an active sheet cell');
  return cell;
}

function editControl(element: SheetEditor): HTMLTextAreaElement {
  const textarea = element.shadowRoot?.querySelector<HTMLTextAreaElement>('textarea');
  if (!textarea) throw new Error('expected an editor textarea');
  return textarea;
}

function input(textarea: HTMLTextAreaElement, value: string): void {
  textarea.value = value;
  textarea.setSelectionRange(value.length, value.length);
  textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
}

function key(keyValue: string, init: KeyboardEventInit = {}): KeyboardEvent {
  return new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: keyValue, ...init });
}

function pointerDown(cell: HTMLTableCellElement): void {
  const event = new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 });
  Object.defineProperty(event, 'pointerId', { value: 1 });
  cell.dispatchEvent(event);
}
