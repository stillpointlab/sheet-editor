import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { setErrorHandler } from '../log';

import { SheetEditor } from './sheet-editor';

describe('sheet-editor interaction foundation', () => {
  beforeAll(() => {
    expect(customElements.get('sheet-editor')).toBe(SheetEditor);
  });

  afterEach(() => {
    document.body.replaceChildren();
    setErrorHandler(null);
  });

  const create = (): SheetEditor => document.createElement('sheet-editor') as SheetEditor;

  it('preserves exact CSV and emits no content event during selection', () => {
    const source = '\uFEFF"a",b\n1,2\n';
    const element = create();
    const changed = vi.fn();
    element.addEventListener('content-change', changed);
    element.setContent(source);
    document.body.append(element);

    activeCell(element).dispatchEvent(key('ArrowRight'));
    activeCell(element).dispatchEvent(key('ArrowDown', { shiftKey: true }));

    expect(element.getContent()).toBe(source);
    expect(changed).not.toHaveBeenCalled();
  });

  it('renders empty CSV as one selectable virtual A1 cell', () => {
    const element = create();
    document.body.append(element);

    expect(dataCells(element)).toHaveLength(1);
    expect(activeCell(element).dataset).toMatchObject({ row: '0', column: '0' });
    expect(activeCell(element).classList.contains('sheet-table__cell--virtual')).toBe(true);
    expect(element.shadowRoot?.querySelector('[role="grid"]')).not.toBeNull();
  });

  it('adds one virtual row and column without rectangularizing source', () => {
    const element = create();
    element.setContent('a,b\nc');
    document.body.append(element);

    expect(element.shadowRoot?.querySelectorAll('.sheet-table__column-header')).toHaveLength(3);
    expect(element.shadowRoot?.querySelectorAll('.sheet-table__row-header')).toHaveLength(3);
    expect(dataCells(element)).toHaveLength(9);
    pointerDown(dataCell(element, 2, 2));
    expect(element.getContent()).toBe('a,b\nc');
  });

  it('does not add a trailing column once the column cap is reached', () => {
    const element = create();
    element.setContent(Array.from({ length: 256 }, () => '').join(','));
    document.body.append(element);

    expect(element.shadowRoot?.querySelectorAll('.sheet-table__column-header')).toHaveLength(256);
  });

  it('does not add a trailing row once the materialized-row cap is reached', () => {
    const element = create();
    element.setContent(Array.from({ length: 1000 }, () => 'value').join('\n'));
    document.body.append(element);

    expect(element.shadowRoot?.querySelectorAll('.sheet-table__row-header')).toHaveLength(1000);
    expect(element.shadowRoot?.querySelector('[role="grid"]')).not.toBeNull();
  });

  it('moves across the full edge of a merged rectangle and into destination merges', () => {
    const element = create();
    element.setContent('a,b,c,d,e\nf,anchor,,,j\nk,,,,o\np,q,target,,t\nu,v,,,z', {
      presentation: {
        merges: [
          { startRow: 1, endRow: 3, startColumn: 1, endColumn: 4 },
          { startRow: 3, endRow: 4, startColumn: 2, endColumn: 4 },
        ],
      },
    });
    document.body.append(element);

    pointerDown(dataCell(element, 1, 1));
    activeCell(element).dispatchEvent(key('ArrowRight'));
    expect(activeCell(element).dataset).toMatchObject({ row: '1', column: '4' });

    pointerDown(dataCell(element, 3, 1));
    activeCell(element).dispatchEvent(key('ArrowRight'));
    expect(activeCell(element).dataset).toMatchObject({ row: '3', column: '2' });
  });

  it('extends and shrinks one range with Shift+Arrow', () => {
    const element = create();
    element.setContent('a,b,c\nd,e,f');
    document.body.append(element);

    activeCell(element).dispatchEvent(key('ArrowRight', { shiftKey: true }));
    activeCell(element).dispatchEvent(key('ArrowRight', { shiftKey: true }));
    expect(selectedCells(element)).toHaveLength(3);
    activeCell(element).dispatchEvent(key('ArrowLeft', { shiftKey: true }));
    expect(selectedCells(element)).toHaveLength(2);
  });

  it('uses the same fixed-point merge expansion for pointer drag', () => {
    const element = create();
    element.setContent('a,b,,d\ne,f,,h\ni,j,,l', {
      presentation: {
        merges: [
          { startRow: 0, endRow: 1, startColumn: 1, endColumn: 3 },
          { startRow: 1, endRow: 3, startColumn: 2, endColumn: 3 },
        ],
      },
    });
    document.body.append(element);

    dataCell(element, 0, 0).dispatchEvent(pointer('pointerdown', 7));
    dataCell(element, 1, 1).dispatchEvent(pointer('pointermove', 7));
    dataCell(element, 1, 1).dispatchEvent(pointer('pointerup', 7));

    expect(selectedCells(element).map((cell) => [cell.dataset.row, cell.dataset.column])).toEqual([
      ['0', '0'],
      ['0', '1'],
      ['1', '0'],
      ['1', '1'],
      ['1', '2'],
      ['2', '0'],
      ['2', '1'],
    ]);
  });

  it('uses one roving tab stop and exposes native grid selection semantics', () => {
    const element = create();
    element.setContent('a,b');
    document.body.append(element);

    const grid = element.shadowRoot?.querySelector('table');
    expect(grid?.getAttribute('role')).toBe('grid');
    expect(grid?.getAttribute('aria-multiselectable')).toBe('true');
    expect(grid?.getAttribute('aria-readonly')).toBe('true');
    expect(dataCells(element).filter((cell) => cell.tabIndex === 0)).toHaveLength(1);
    expect(element.shadowRoot?.querySelectorAll('th[tabindex]')).toHaveLength(0);

    element.focus();
    expect(element.shadowRoot?.activeElement).toBe(activeCell(element));
  });

  it('falls back to selectable unmerged cells and reports invalid presentation once', () => {
    const report = vi.fn();
    setErrorHandler(report);
    const element = create();
    element.setContent('visible,hidden', {
      presentation: {
        merges: [{ startRow: 0, endRow: 1, startColumn: 0, endColumn: 2 }],
      },
    });
    document.body.append(element);

    expect(dataCells(element)).toHaveLength(6);
    expect(element.shadowRoot?.querySelector('.sheet-surface__notice')?.textContent).toContain(
      'showing unmerged cells'
    );
    activeCell(element).dispatchEvent(key('ArrowRight'));
    expect(report).toHaveBeenCalledTimes(1);
  });

  it('atomically replaces presentation and resets selection on load', () => {
    const element = create();
    const range = { startRow: 0, endRow: 2, startColumn: 0, endColumn: 2 };
    element.setContent('anchor,\n,', {
      presentation: {
        merges: [range],
      },
    });
    range.endColumn = 1;
    document.body.append(element);
    expect(activeCell(element).colSpan).toBe(2);

    element.setContent('plain,again');
    expect(dataCells(element)).toHaveLength(6);
    expect(activeCell(element).dataset).toMatchObject({ row: '0', column: '0' });
  });

  it('renders truncated input without an active grid and retains the omitted source', () => {
    const source = Array.from({ length: 1001 }, (_, index) => String(index)).join('\n');
    const element = create();
    element.setContent(source);
    document.body.append(element);

    expect(element.shadowRoot?.querySelector('[role="grid"]')).toBeNull();
    expect(element.shadowRoot?.querySelector('.sheet-surface__notice')?.textContent).toContain(
      'Showing first 1,000 of 1,001 rows'
    );
    expect(element.getContent()).toBe(source);
  });

  it('keeps malformed input exact and focuses its accessible status', () => {
    const element = create();
    element.setContent('"unclosed');
    document.body.append(element);
    element.focus();

    expect(element.shadowRoot?.querySelector('[role="alert"]')).toBe(
      element.shadowRoot?.activeElement
    );
    expect(element.getContent()).toBe('"unclosed');
  });
});

function dataCells(element: SheetEditor): HTMLTableCellElement[] {
  return [...(element.shadowRoot?.querySelectorAll<HTMLTableCellElement>('tbody td') ?? [])];
}

function selectedCells(element: SheetEditor): HTMLTableCellElement[] {
  return dataCells(element).filter((cell) => cell.getAttribute('aria-selected') === 'true');
}

function activeCell(element: SheetEditor): HTMLTableCellElement {
  const cell = dataCells(element).find((candidate) => candidate.tabIndex === 0);
  if (!cell) throw new Error('expected an active sheet cell');
  return cell;
}

function dataCell(element: SheetEditor, row: number, column: number): HTMLTableCellElement {
  const cell = element.shadowRoot?.querySelector<HTMLTableCellElement>(
    `td[data-row="${row}"][data-column="${column}"]`
  );
  if (!cell) throw new Error(`expected cell ${row}:${column}`);
  return cell;
}

function key(keyValue: string, init: KeyboardEventInit = {}): KeyboardEvent {
  return new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: keyValue, ...init });
}

function pointer(type: string, pointerId = 1): Event {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 });
  Object.defineProperty(event, 'pointerId', { value: pointerId });
  return event;
}

function pointerDown(cell: HTMLTableCellElement): void {
  cell.dispatchEvent(pointer('pointerdown'));
}
