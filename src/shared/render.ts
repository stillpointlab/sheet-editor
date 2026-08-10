import { reportError } from '../log';
import {
  validateSheetPresentation,
  type SheetCellRange,
  type SheetPresentation,
} from '../presentation/presentation';

import { columnLabel } from './column-label';
import { createSheetMergeIndex, type SheetMergeIndex } from './merge-index';
import {
  createSheetStyleIndex,
  type EffectiveSheetCellStyle,
  type SheetStyleIndex,
} from './style-index';
import { tableStyles } from './table.styles';
import {
  createSheetValueFormatIndex,
  formatSheetCellValue,
  type SheetValueFormatIndex,
} from './value-format';

import type { CsvParseResult } from '../csv';

export interface TableRenderOptions {
  addressed: boolean;
  headerRow: boolean;
  label: string;
  emptyMessage: string;
  presentation: SheetPresentation;
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
  const presentation = validation.ok ? validation.presentation : { merges: [] };
  const merges = presentation.merges;
  if (!validation.ok) {
    reportError('Sheet presentation is invalid.', validation.issues);
  }

  if (model.totalRows === 0 || model.maxColumns === 0) {
    surface.append(createMessage(options.emptyMessage, 'empty'));
    if (!validation.ok) surface.append(createInvalidPresentationNotice());
    root.replaceChildren(style, surface);
    return;
  }

  const mergeIndex = createSheetMergeIndex(merges);
  const styleIndex = createSheetStyleIndex(presentation);
  const valueFormatIndex = createSheetValueFormatIndex(presentation);
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
    table.append(
      createGridHead(model.rows[0], model.maxColumns, mergeIndex, styleIndex, valueFormatIndex)
    );
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
      if (mergeIndex.isCovered(rowIndex, columnIndex)) continue;
      const range = mergeIndex.anchorAt(rowIndex, columnIndex);
      row.append(
        createCell(
          'td',
          formatSheetCellValue(
            cells[columnIndex] ?? '',
            valueFormatIndex.formatAt(rowIndex, columnIndex)
          ),
          rowIndex,
          columnIndex,
          range,
          false,
          styleIndex.styleAt(rowIndex, columnIndex)
        )
      );
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

export function appendColumnGroups(
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

export function createAddressedHead(columnCount: number): HTMLTableSectionElement {
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
  mergeIndex: SheetMergeIndex,
  styleIndex: SheetStyleIndex,
  valueFormatIndex: SheetValueFormatIndex
): HTMLTableSectionElement {
  const head = document.createElement('thead');
  const row = document.createElement('tr');
  for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
    if (mergeIndex.isCovered(0, columnIndex)) continue;
    const range = mergeIndex.anchorAt(0, columnIndex);
    row.append(
      createCell(
        'th',
        formatSheetCellValue(cells[columnIndex] ?? '', valueFormatIndex.formatAt(0, columnIndex)),
        0,
        columnIndex,
        range,
        true,
        styleIndex.styleAt(0, columnIndex)
      )
    );
  }
  head.append(row);
  return head;
}

export function createCell(
  tag: 'td' | 'th',
  value: string,
  rowIndex: number,
  columnIndex: number,
  range?: SheetCellRange,
  columnHeader = false,
  cellStyle?: EffectiveSheetCellStyle
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
  if (cellStyle) applyCellStyle(cell, cellStyle);
  const content = document.createElement('span');
  content.className = 'sheet-table__cell-content';
  content.textContent = value;
  cell.append(content);
  return cell;
}

export function createTruncationNotice(
  materializedRows: number,
  totalRows: number
): HTMLParagraphElement {
  const notice = createStatusNotice('sheet-truncation-notice');
  notice.textContent = `Showing first ${materializedRows.toLocaleString('en-US')} of ${totalRows.toLocaleString('en-US')} rows.`;
  return notice;
}

export function createInvalidPresentationNotice(): HTMLParagraphElement {
  const notice = createStatusNotice('sheet-presentation-notice');
  notice.textContent = 'Sheet presentation is invalid; showing default presentation.';
  return notice;
}

function applyCellStyle(cell: HTMLTableCellElement, style: EffectiveSheetCellStyle): void {
  cell.classList.toggle('sheet-table__cell--bold', style.bold);
  cell.classList.toggle('sheet-table__cell--italic', style.italic);
  cell.classList.toggle('sheet-table__cell--strikethrough', style.strikethrough);
  cell.classList.add(`sheet-table__cell--align-${style.horizontal}`);
  cell.classList.add(`sheet-table__cell--align-${style.vertical}`);
}

function createStatusNotice(id: string): HTMLParagraphElement {
  const notice = document.createElement('p');
  notice.id = id;
  notice.className = 'sheet-surface__notice';
  notice.setAttribute('role', 'status');
  notice.setAttribute('aria-live', 'polite');
  return notice;
}

export function createMessage(message: string, kind: 'empty' | 'error'): HTMLElement {
  const state = document.createElement('div');
  state.className = `sheet-surface__message sheet-surface__message--${kind}`;
  if (kind === 'error') state.setAttribute('role', 'alert');
  state.textContent = message;
  return state;
}
