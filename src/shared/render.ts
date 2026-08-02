import { reportError } from '../log';
import {
  validateSheetPresentation,
  type SheetCellRange,
  type SheetPresentation,
} from '../presentation/presentation';

import { columnLabel } from './column-label';
import { tableStyles } from './table.styles';

import type { CsvParseResult } from '../csv';

export interface TableRenderOptions {
  addressed: boolean;
  headerRow: boolean;
  label: string;
  emptyMessage: string;
  presentation: SheetPresentation;
}

interface MergeIndex {
  anchors: Map<string, SheetCellRange>;
  covered: Set<string>;
}

export function renderTable(
  root: ShadowRoot,
  model: CsvParseResult,
  options: TableRenderOptions
): void {
  const style = document.createElement('style');
  style.textContent = tableStyles;

  const surface = document.createElement('div');
  surface.className = `sheet-surface${options.addressed ? ' sheet-surface--addressed' : ''}`;

  if (!model.ok) {
    surface.append(createMessage(model.error.message, 'error'));
    root.replaceChildren(style, surface);
    return;
  }

  const validation = validateSheetPresentation(options.presentation, {
    rows: model.rows,
    totalRows: model.totalRows,
    maxColumns: model.maxColumns,
    headerRow: options.headerRow,
  });
  const merges = validation.ok ? validation.presentation.merges : [];
  if (!validation.ok) {
    reportError('Merged-cell presentation is invalid.', validation.issues);
  }

  if (model.totalRows === 0 || model.maxColumns === 0) {
    surface.append(createMessage(options.emptyMessage, 'empty'));
    if (!validation.ok) surface.append(createInvalidPresentationNotice());
    root.replaceChildren(style, surface);
    return;
  }

  const mergeIndex = indexMerges(merges);
  const scroll = document.createElement('div');
  scroll.className = 'sheet-surface__scroll';
  scroll.tabIndex = 0;
  scroll.setAttribute('aria-label', options.label);

  const table = document.createElement('table');
  table.className = 'sheet-table';
  table.setAttribute('aria-label', options.label);
  appendColumnGroups(table, model.maxColumns, options.addressed, options.headerRow, merges);

  const bodyStart = options.addressed || !options.headerRow ? 0 : 1;
  if (options.addressed) {
    table.append(createAddressedHead(model.maxColumns));
  } else if (options.headerRow && model.rows.length > 0) {
    table.append(createGridHead(model.rows[0], model.maxColumns, mergeIndex));
  }

  const body = document.createElement('tbody');
  for (let rowIndex = bodyStart; rowIndex < model.rows.length; rowIndex += 1) {
    const row = document.createElement('tr');
    if (options.addressed) {
      const header = document.createElement('th');
      header.className = 'sheet-table__row-header';
      header.scope = 'row';
      header.textContent = String(rowIndex + 1);
      row.append(header);
    }

    const cells = model.rows[rowIndex];
    for (let columnIndex = 0; columnIndex < model.maxColumns; columnIndex += 1) {
      if (mergeIndex.covered.has(cellKey(rowIndex, columnIndex))) continue;
      const range = mergeIndex.anchors.get(cellKey(rowIndex, columnIndex));
      row.append(createCell('td', cells[columnIndex] ?? '', rowIndex, columnIndex, range));
    }
    body.append(row);
  }
  table.append(body);
  scroll.append(table);
  surface.append(scroll);

  const describedBy: string[] = [];
  if (model.truncated) {
    const notice = createTruncationNotice(model.rows.length, model.totalRows);
    describedBy.push(notice.id);
    surface.append(notice);
  }
  if (!validation.ok) {
    const notice = createInvalidPresentationNotice();
    describedBy.push(notice.id);
    surface.append(notice);
  }
  if (describedBy.length > 0) scroll.setAttribute('aria-describedby', describedBy.join(' '));

  root.replaceChildren(style, surface);
}

function indexMerges(merges: readonly SheetCellRange[]): MergeIndex {
  const anchors = new Map<string, SheetCellRange>();
  const covered = new Set<string>();
  for (const range of merges) {
    anchors.set(cellKey(range.startRow, range.startColumn), range);
    for (let row = range.startRow; row < range.endRow; row += 1) {
      for (let column = range.startColumn; column < range.endColumn; column += 1) {
        if (row !== range.startRow || column !== range.startColumn) {
          covered.add(cellKey(row, column));
        }
      }
    }
  }
  return { anchors, covered };
}

function appendColumnGroups(
  table: HTMLTableElement,
  columnCount: number,
  addressed: boolean,
  headerRow: boolean,
  merges: readonly SheetCellRange[]
): void {
  if (addressed) {
    const group = document.createElement('colgroup');
    const gutter = document.createElement('col');
    gutter.className = 'sheet-table__gutter-column';
    group.append(gutter);
    appendDataColumns(group, columnCount);
    table.append(group);
    return;
  }

  const boundaries = new Set([0, columnCount]);
  if (headerRow) {
    for (const range of merges) {
      if (range.startRow === 0 && range.endRow === 1) {
        boundaries.add(range.startColumn);
        boundaries.add(range.endColumn);
      }
    }
  }
  const sorted = [...boundaries].sort((left, right) => left - right);
  for (let index = 0; index < sorted.length - 1; index += 1) {
    const group = document.createElement('colgroup');
    appendDataColumns(group, sorted[index + 1] - sorted[index]);
    table.append(group);
  }
}

function appendDataColumns(group: HTMLTableColElement, count: number): void {
  for (let index = 0; index < count; index += 1) {
    const column = document.createElement('col');
    column.className = 'sheet-table__data-column';
    group.append(column);
  }
}

function createAddressedHead(columnCount: number): HTMLTableSectionElement {
  const head = document.createElement('thead');
  const row = document.createElement('tr');
  const corner = document.createElement('th');
  corner.className = 'sheet-table__corner';
  corner.setAttribute('aria-label', 'Row and column headers');
  row.append(corner);

  for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
    const header = document.createElement('th');
    header.className = 'sheet-table__column-header';
    header.scope = 'col';
    header.textContent = columnLabel(columnIndex);
    row.append(header);
  }
  head.append(row);
  return head;
}

function createGridHead(
  cells: readonly string[],
  columnCount: number,
  mergeIndex: MergeIndex
): HTMLTableSectionElement {
  const head = document.createElement('thead');
  const row = document.createElement('tr');
  for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
    if (mergeIndex.covered.has(cellKey(0, columnIndex))) continue;
    const range = mergeIndex.anchors.get(cellKey(0, columnIndex));
    row.append(createCell('th', cells[columnIndex] ?? '', 0, columnIndex, range, true));
  }
  head.append(row);
  return head;
}

function createCell(
  tag: 'td' | 'th',
  value: string,
  rowIndex: number,
  columnIndex: number,
  range?: SheetCellRange,
  columnHeader = false
): HTMLTableCellElement {
  const cell = document.createElement(tag);
  cell.dataset.row = String(rowIndex);
  cell.dataset.column = String(columnIndex);
  if (range) {
    const rowSpan = range.endRow - range.startRow;
    const columnSpan = range.endColumn - range.startColumn;
    if (rowSpan > 1) cell.rowSpan = rowSpan;
    if (columnSpan > 1) cell.colSpan = columnSpan;
  }
  if (columnHeader) {
    cell.scope = range && range.endColumn - range.startColumn > 1 ? 'colgroup' : 'col';
  }
  const content = document.createElement('span');
  content.className = 'sheet-table__cell-content';
  content.textContent = value;
  cell.append(content);
  return cell;
}

function createTruncationNotice(materializedRows: number, totalRows: number): HTMLParagraphElement {
  const notice = createStatusNotice('sheet-truncation-notice');
  notice.textContent = `Showing first ${materializedRows.toLocaleString('en-US')} of ${totalRows.toLocaleString('en-US')} rows.`;
  return notice;
}

function createInvalidPresentationNotice(): HTMLParagraphElement {
  const notice = createStatusNotice('sheet-presentation-notice');
  notice.textContent = 'Merged-cell presentation is invalid; showing unmerged cells.';
  return notice;
}

function createStatusNotice(id: string): HTMLParagraphElement {
  const notice = document.createElement('p');
  notice.id = id;
  notice.className = 'sheet-surface__notice';
  notice.setAttribute('role', 'status');
  notice.setAttribute('aria-live', 'polite');
  return notice;
}

function createMessage(message: string, kind: 'empty' | 'error'): HTMLElement {
  const state = document.createElement('div');
  state.className = `sheet-surface__message sheet-surface__message--${kind}`;
  if (kind === 'error') state.setAttribute('role', 'alert');
  state.textContent = message;
  return state;
}

function cellKey(row: number, column: number): string {
  return `${row}:${column}`;
}
