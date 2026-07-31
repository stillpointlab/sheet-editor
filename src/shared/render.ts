import { columnLabel } from './column-label';
import { tableStyles } from './table.styles';

import type { CsvParseResult } from '../csv';

export interface TableRenderOptions {
  addressed: boolean;
  headerRow: boolean;
  label: string;
  emptyMessage: string;
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

  if (model.totalRows === 0 || model.maxColumns === 0) {
    surface.append(createMessage(options.emptyMessage, 'empty'));
    root.replaceChildren(style, surface);
    return;
  }

  const scroll = document.createElement('div');
  scroll.className = 'sheet-surface__scroll';
  scroll.tabIndex = 0;
  scroll.setAttribute('aria-label', options.label);

  const table = document.createElement('table');
  table.className = 'sheet-table';
  table.setAttribute('aria-label', options.label);

  const bodyStart = options.addressed || !options.headerRow ? 0 : 1;
  if (options.addressed) {
    table.append(createAddressedHead(model.maxColumns));
  } else if (options.headerRow && model.rows.length > 0) {
    table.append(createGridHead(model.rows[0], model.maxColumns));
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
      row.append(createCell('td', cells[columnIndex] ?? '', rowIndex, columnIndex));
    }
    body.append(row);
  }
  table.append(body);
  scroll.append(table);
  surface.append(scroll);

  if (model.truncated) {
    const notice = document.createElement('p');
    notice.id = 'sheet-truncation-notice';
    notice.className = 'sheet-surface__notice';
    notice.setAttribute('role', 'status');
    notice.setAttribute('aria-live', 'polite');
    notice.textContent = `Showing first ${model.rows.length.toLocaleString('en-US')} of ${model.totalRows.toLocaleString('en-US')} rows.`;
    scroll.setAttribute('aria-describedby', notice.id);
    surface.append(notice);
  }

  root.replaceChildren(style, surface);
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

function createGridHead(cells: readonly string[], columnCount: number): HTMLTableSectionElement {
  const head = document.createElement('thead');
  const row = document.createElement('tr');
  for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
    row.append(createCell('th', cells[columnIndex] ?? '', 0, columnIndex, true));
  }
  head.append(row);
  return head;
}

function createCell(
  tag: 'td' | 'th',
  value: string,
  rowIndex: number,
  columnIndex: number,
  columnHeader = false
): HTMLTableCellElement {
  const cell = document.createElement(tag);
  cell.dataset.row = String(rowIndex);
  cell.dataset.column = String(columnIndex);
  if (columnHeader && cell instanceof HTMLTableCellElement) {
    cell.scope = 'col';
  }
  const content = document.createElement('span');
  content.className = 'sheet-table__cell-content';
  content.textContent = value;
  cell.append(content);
  return cell;
}

function createMessage(message: string, kind: 'empty' | 'error'): HTMLElement {
  const state = document.createElement('div');
  state.className = `sheet-surface__message sheet-surface__message--${kind}`;
  if (kind === 'error') state.setAttribute('role', 'alert');
  state.textContent = message;
  return state;
}
