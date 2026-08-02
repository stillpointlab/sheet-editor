/// <reference lib="dom" />

import { DEFAULT_CSV_LIMITS, parseCsv, type CsvParseResult } from '../csv';
import {
  createSheetMergeIndex,
  createSheetSelection,
  moveSheetSelection,
  sheetRangesIntersect,
  type SheetCanvasBounds,
  type SheetCoordinate,
  type SheetMergeIndex,
  type SheetMoveDirection,
  type SheetSelection,
} from '../interaction';
import { reportError } from '../log';
import {
  validateSheetPresentation,
  type SheetContentOptions,
  type SheetPresentation,
  type SheetPresentationIssue,
} from '../presentation';
import { snapshotSheetPresentation } from '../presentation/presentation';
import {
  appendColumnGroups,
  createAddressedHead,
  createCell,
  createInvalidPresentationNotice,
  renderTable,
} from '../shared/render';
import { tableStyles } from '../shared/table.styles';

export class SheetEditor extends HTMLElement {
  private readonly root: ShadowRoot;
  private source = '';
  private model: CsvParseResult = parseCsv('');
  private presentation: SheetPresentation = {};
  private mergeIndex: SheetMergeIndex = createSheetMergeIndex([]);
  private presentationIssues: readonly SheetPresentationIssue[] = [];
  private presentationReported = false;
  private bounds: SheetCanvasBounds = { rowCount: 1, columnCount: 1 };
  private selection: SheetSelection = createSheetSelection(
    { row: 0, column: 0 },
    { row: 0, column: 0 },
    this.mergeIndex
  );
  private dragPointerId: number | null = null;
  private dragAnchor: SheetCoordinate | null = null;

  constructor() {
    super();
    this.root = this.attachShadow({ mode: 'open' });
    this.root.addEventListener('keydown', this.handleKeyDown);
    this.root.addEventListener('pointerdown', this.handlePointerDown);
    this.root.addEventListener('pointermove', this.handlePointerMove);
    this.root.addEventListener('pointerup', this.handlePointerEnd);
    this.root.addEventListener('pointercancel', this.handlePointerEnd);
    this.prepareLoad();
  }

  connectedCallback(): void {
    this.render();
  }

  setContent(content: string, options: SheetContentOptions = {}): void {
    this.source = content;
    this.model = parseCsv(content);
    this.presentation = snapshotSheetPresentation(options.presentation);
    this.prepareLoad();
    if (this.isConnected) this.render();
  }

  getContent(): string {
    return this.source;
  }

  override focus(options?: FocusOptions): void {
    if (this.isInteractive()) {
      this.focusActiveCell(options);
      return;
    }
    const target = this.root.querySelector<HTMLElement>(
      '.sheet-surface__message, .sheet-surface__notice, .sheet-surface__scroll'
    );
    if (target) {
      if (target.tabIndex < 0) target.tabIndex = -1;
      target.focus(options);
    }
  }

  private prepareLoad(): void {
    this.dragPointerId = null;
    this.dragAnchor = null;
    this.presentationIssues = [];
    this.presentationReported = false;
    this.mergeIndex = createSheetMergeIndex([]);
    this.bounds = { rowCount: 1, columnCount: 1 };

    if (this.model.ok && !this.model.truncated) {
      const validation = validateSheetPresentation(this.presentation, {
        rows: this.model.rows,
        totalRows: this.model.totalRows,
        maxColumns: this.model.maxColumns,
        headerRow: false,
      });
      if (validation.ok) {
        this.mergeIndex = createSheetMergeIndex(validation.presentation.merges);
      } else {
        this.presentationIssues = validation.issues;
      }
      this.bounds = canvasBounds(this.model);
    }

    this.selection = createSheetSelection(
      { row: 0, column: 0 },
      { row: 0, column: 0 },
      this.mergeIndex
    );
  }

  private render(): void {
    const model = this.model;
    if (!model.ok || model.truncated) {
      renderTable(this.root, model, {
        addressed: true,
        headerRow: false,
        label: 'Spreadsheet editor',
        emptyMessage: 'No sheet data.',
        presentation: this.presentation,
      });
      const status = this.root.querySelector<HTMLElement>(
        '.sheet-surface__message, .sheet-surface__notice'
      );
      if (status) status.tabIndex = -1;
      return;
    }

    this.reportPresentationIssues();
    const style = document.createElement('style');
    style.textContent = tableStyles;

    const surface = document.createElement('div');
    surface.className = 'sheet-surface sheet-surface--addressed sheet-surface--interactive';
    const scroll = document.createElement('div');
    scroll.className = 'sheet-surface__scroll';

    const table = document.createElement('table');
    table.className = 'sheet-table';
    table.setAttribute('role', 'grid');
    table.setAttribute('aria-label', 'Spreadsheet editor');
    table.setAttribute('aria-multiselectable', 'true');
    table.setAttribute('aria-readonly', 'true');
    appendColumnGroups(table, this.bounds.columnCount, true, false, this.mergeIndex.ranges);
    table.append(createAddressedHead(this.bounds.columnCount));

    const body = document.createElement('tbody');
    for (let rowIndex = 0; rowIndex < this.bounds.rowCount; rowIndex += 1) {
      const row = document.createElement('tr');
      const header = document.createElement('th');
      header.className = 'sheet-table__row-header';
      header.scope = 'row';
      header.textContent = String(rowIndex + 1);
      row.append(header);

      for (let columnIndex = 0; columnIndex < this.bounds.columnCount; columnIndex += 1) {
        if (this.mergeIndex.isCovered(rowIndex, columnIndex)) continue;
        const range = this.mergeIndex.anchorAt(rowIndex, columnIndex);
        const cell = createCell(
          'td',
          model.rows[rowIndex]?.[columnIndex] ?? '',
          rowIndex,
          columnIndex,
          range
        );
        cell.setAttribute('role', 'gridcell');
        if (rowIndex >= model.rows.length || columnIndex >= (model.rows[rowIndex]?.length ?? 0)) {
          cell.classList.add('sheet-table__cell--virtual');
        }
        row.append(cell);
      }
      body.append(row);
    }
    table.append(body);
    scroll.append(table);
    surface.append(scroll);

    if (this.presentationIssues.length > 0) {
      const notice = createInvalidPresentationNotice();
      table.setAttribute('aria-describedby', notice.id);
      surface.append(notice);
    }

    this.root.replaceChildren(style, surface);
    this.applySelection(false);
  }

  private readonly handleKeyDown = (event: Event): void => {
    if (!this.isInteractive()) return;
    const keyboardEvent = event as KeyboardEvent;
    if (keyboardEvent.altKey || keyboardEvent.ctrlKey || keyboardEvent.metaKey) return;
    const direction = directionForKey(keyboardEvent.key);
    if (!direction) return;
    keyboardEvent.preventDefault();
    this.selection = moveSheetSelection(
      this.selection,
      direction,
      this.bounds,
      this.mergeIndex,
      keyboardEvent.shiftKey
    );
    this.applySelection(true);
  };

  private readonly handlePointerDown = (event: Event): void => {
    if (!this.isInteractive()) return;
    const pointerEvent = event as PointerEvent;
    if (pointerEvent.button !== 0) return;
    const cell = this.cellFromEvent(pointerEvent);
    if (!cell) return;
    const coordinate = coordinateFromCell(cell);
    if (!coordinate) return;
    pointerEvent.preventDefault();
    const pointerId = pointerEvent.pointerId ?? 0;
    this.dragPointerId = pointerId;
    this.dragAnchor = coordinate;
    this.selection = createSheetSelection(coordinate, coordinate, this.mergeIndex);
    cell.setPointerCapture?.(pointerId);
    this.applySelection(true);
  };

  private readonly handlePointerMove = (event: Event): void => {
    if (!this.isInteractive() || this.dragPointerId === null || !this.dragAnchor) return;
    const pointerEvent = event as PointerEvent;
    if ((pointerEvent.pointerId ?? 0) !== this.dragPointerId) return;
    const cell = this.cellFromEvent(pointerEvent, true);
    if (!cell) return;
    const coordinate = coordinateFromCell(cell);
    if (!coordinate) return;
    this.selection = createSheetSelection(this.dragAnchor, coordinate, this.mergeIndex);
    this.applySelection(true);
  };

  private readonly handlePointerEnd = (event: Event): void => {
    if (this.dragPointerId === null) return;
    const pointerEvent = event as PointerEvent;
    if ((pointerEvent.pointerId ?? 0) !== this.dragPointerId) return;
    const target = pointerEvent.target;
    if (target instanceof Element) {
      const cell = target.closest<HTMLElement>('td[data-row][data-column]');
      if (cell?.hasPointerCapture?.(this.dragPointerId)) {
        cell.releasePointerCapture(this.dragPointerId);
      }
    }
    this.dragPointerId = null;
    this.dragAnchor = null;
  };

  private cellFromEvent(event: PointerEvent, usePoint = false): HTMLElement | null {
    const target = event.target;
    const direct =
      target instanceof Element ? target.closest<HTMLElement>('td[data-row][data-column]') : null;
    if (!usePoint || typeof this.root.elementFromPoint !== 'function') return direct;
    const pointed = this.root.elementFromPoint(event.clientX, event.clientY);
    return pointed?.closest<HTMLElement>('td[data-row][data-column]') ?? direct;
  }

  private applySelection(focus: boolean): void {
    for (const cell of this.root.querySelectorAll<HTMLTableCellElement>(
      'td[data-row][data-column]'
    )) {
      const coordinate = coordinateFromCell(cell);
      if (!coordinate) continue;
      const unit = this.mergeIndex.unitAt(coordinate.row, coordinate.column);
      const selected = sheetRangesIntersect(unit, this.selection.range);
      const active =
        coordinate.row === this.selection.active.row &&
        coordinate.column === this.selection.active.column;
      cell.setAttribute('aria-selected', String(selected));
      cell.tabIndex = active ? 0 : -1;
      cell.classList.toggle('sheet-table__cell--active', active);
    }
    if (focus) this.focusActiveCell({ preventScroll: true });
  }

  private focusActiveCell(options?: FocusOptions): void {
    const active = this.root.querySelector<HTMLTableCellElement>(
      `td[data-row="${this.selection.active.row}"][data-column="${this.selection.active.column}"]`
    );
    if (!active) return;
    active.focus(options);
    active.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }

  private isInteractive(): boolean {
    return this.model.ok && !this.model.truncated;
  }

  private reportPresentationIssues(): void {
    if (this.presentationReported || this.presentationIssues.length === 0) return;
    this.presentationReported = true;
    reportError('Merged-cell presentation is invalid.', this.presentationIssues);
  }
}

function canvasBounds(model: Extract<CsvParseResult, { ok: true }>): SheetCanvasBounds {
  const rowCount =
    model.totalRows < DEFAULT_CSV_LIMITS.maxMaterializedRows
      ? model.totalRows + 1
      : model.totalRows;
  const columnCount =
    model.maxColumns < DEFAULT_CSV_LIMITS.maxColumns ? model.maxColumns + 1 : model.maxColumns;
  return {
    rowCount: Math.max(1, rowCount),
    columnCount: Math.max(1, columnCount),
  };
}

function coordinateFromCell(cell: HTMLElement): SheetCoordinate | null {
  const row = Number(cell.dataset.row);
  const column = Number(cell.dataset.column);
  if (!Number.isSafeInteger(row) || row < 0 || !Number.isSafeInteger(column) || column < 0) {
    return null;
  }
  return { row, column };
}

function directionForKey(key: string): SheetMoveDirection | null {
  switch (key) {
    case 'ArrowUp':
      return 'up';
    case 'ArrowDown':
      return 'down';
    case 'ArrowLeft':
      return 'left';
    case 'ArrowRight':
      return 'right';
    default:
      return null;
  }
}

if (!customElements.get('sheet-editor')) {
  customElements.define('sheet-editor', SheetEditor);
}
