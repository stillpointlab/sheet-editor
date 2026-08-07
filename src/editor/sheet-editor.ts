/// <reference lib="dom" />

import { DEFAULT_CSV_LIMITS, utf8ByteLength } from '../csv';
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
import { resolveSheetPresentation, snapshotSheetPresentation } from '../presentation/presentation';
import { columnLabel } from '../shared/column-label';
import {
  appendColumnGroups,
  createAddressedHead,
  createCell,
  createInvalidPresentationNotice,
  renderTable,
} from '../shared/render';
import { tableStyles } from '../shared/table.styles';

import {
  createCsvSourceSession,
  createDocumentSourceSession,
  snapshotPresentationOverride,
  type SheetEditorSourceSession,
  type SheetPresentationOverride,
} from './source-session';
import {
  applySheetStructure,
  transformSheetPresentation,
  type SheetStructureOperation,
} from './structure';

export type SheetEditorMode = 'navigation' | 'quick-edit' | 'caret-edit';

interface CellDraft {
  coordinate: SheetCoordinate;
  value: string;
  selectionStart: number;
  selectionEnd: number;
}

interface EditorSnapshot {
  rows: string[][];
  embeddedPresentation: SheetPresentation;
  presentationOverride: SheetPresentationOverride;
  selection: SheetSelection;
}

interface EditorTransaction {
  before: EditorSnapshot;
  after: EditorSnapshot;
}

type SheetStructureCommand =
  | 'insert-row-above'
  | 'insert-row-below'
  | 'insert-column-before'
  | 'insert-column-after'
  | 'delete-row'
  | 'delete-column';

interface ToolbarCommandDefinition {
  command: SheetStructureCommand;
  label: string;
  icon: string;
  group: 'insert' | 'delete';
}

const HISTORY_LIMIT = 100;
const TOOLBAR_COMMANDS: readonly ToolbarCommandDefinition[] = [
  {
    command: 'insert-row-above',
    label: 'Insert row above',
    icon: 'row-above',
    group: 'insert',
  },
  {
    command: 'insert-row-below',
    label: 'Insert row below',
    icon: 'row-below',
    group: 'insert',
  },
  {
    command: 'insert-column-before',
    label: 'Insert column before',
    icon: 'column-before',
    group: 'insert',
  },
  {
    command: 'insert-column-after',
    label: 'Insert column after',
    icon: 'column-after',
    group: 'insert',
  },
  { command: 'delete-row', label: 'Delete row', icon: 'delete-row', group: 'delete' },
  { command: 'delete-column', label: 'Delete column', icon: 'delete-column', group: 'delete' },
];

export class SheetEditor extends HTMLElement {
  private readonly root: ShadowRoot;
  private sourceSession: SheetEditorSourceSession = createCsvSourceSession('');
  private committedRows: string[][] = [];
  private embeddedPresentation: SheetPresentation = {};
  private presentationOverride: SheetPresentationOverride = undefined;
  private resolvedPresentation: SheetPresentation = {};
  private mergeIndex: SheetMergeIndex = createSheetMergeIndex([]);
  private sourceMergeIndex: SheetMergeIndex = createSheetMergeIndex([]);
  private presentationIssues: readonly SheetPresentationIssue[] = [];
  private presentationReported = false;
  private bounds: SheetCanvasBounds = { rowCount: 1, columnCount: 1 };
  private selection: SheetSelection = createSheetSelection(
    { row: 0, column: 0 },
    { row: 0, column: 0 },
    this.mergeIndex
  );
  private mode: SheetEditorMode = 'navigation';
  private draft: CellDraft | null = null;
  private undoHistory: EditorTransaction[] = [];
  private redoHistory: EditorTransaction[] = [];
  private toolbarTabCommand: SheetStructureCommand = TOOLBAR_COMMANDS[0].command;
  private composing = false;
  private dragPointerId: number | null = null;
  private dragAnchor: SheetCoordinate | null = null;

  static get observedAttributes(): string[] {
    return ['readonly'];
  }

  constructor() {
    super();
    this.root = this.attachShadow({ mode: 'open' });
    this.root.addEventListener('keydown', this.handleKeyDown);
    this.root.addEventListener('beforeinput', this.handleBeforeInput);
    this.root.addEventListener('input', this.handleInput);
    this.root.addEventListener('compositionstart', this.handleCompositionStart);
    this.root.addEventListener('compositionend', this.handleCompositionEnd);
    this.root.addEventListener('focusout', this.handleFocusOut);
    this.root.addEventListener('scroll', this.handleOverlayGeometry, true);
    this.root.addEventListener('dblclick', this.handleDoubleClick);
    this.root.addEventListener('pointerdown', this.handlePointerDown);
    this.root.addEventListener('pointermove', this.handlePointerMove);
    this.root.addEventListener('pointerup', this.handlePointerEnd);
    this.root.addEventListener('pointercancel', this.handlePointerEnd);
    this.root.addEventListener('click', this.handleToolbarClick);
    this.prepareLoad();
  }

  connectedCallback(): void {
    window.addEventListener('resize', this.handleOverlayGeometry);
    this.render();
  }

  disconnectedCallback(): void {
    window.removeEventListener('resize', this.handleOverlayGeometry);
  }

  attributeChangedCallback(name: string, oldValue: string | null, newValue: string | null): void {
    if (name !== 'readonly' || oldValue === newValue) return;
    if (newValue === 'true' && this.draft) {
      this.cancelDraft(true, false);
      return;
    }
    this.root
      .querySelector('[role="grid"]')
      ?.setAttribute('aria-readonly', String(this.isEditingDisabled()));
    this.syncToolbarState();
  }

  setContent(content: string, options: SheetContentOptions = {}): void {
    this.sourceSession = createCsvSourceSession(content, options);
    this.prepareLoad();
    if (this.isConnected) this.render();
  }

  setDocumentSource(source: string, options: SheetContentOptions = {}): void {
    this.sourceSession = createDocumentSourceSession(source, options);
    this.prepareLoad();
    if (this.isConnected) this.render();
  }

  getContent(): string {
    if (!this.isInteractive()) return this.sourceSession.originalSource;
    return this.serializeRows(this.rowsWithDraft());
  }

  override focus(options?: FocusOptions): void {
    const textarea = this.editControl();
    if (textarea) {
      textarea.focus(options);
      return;
    }
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
    this.mode = 'navigation';
    this.draft = null;
    this.composing = false;
    this.dragPointerId = null;
    this.dragAnchor = null;
    this.undoHistory = [];
    this.redoHistory = [];
    this.presentationIssues = [...this.sourceSession.presentationIssues];
    this.presentationReported = false;
    this.mergeIndex = createSheetMergeIndex([]);
    this.sourceMergeIndex = createSheetMergeIndex([]);
    this.embeddedPresentation = snapshotSheetPresentation(this.sourceSession.embeddedPresentation);
    this.presentationOverride = snapshotPresentationOverride(
      this.sourceSession.presentationOverride
    );
    this.resolvedPresentation = resolveSheetPresentation(
      this.embeddedPresentation,
      this.presentationOverride
    );
    this.bounds = { rowCount: 1, columnCount: 1 };
    this.committedRows = [];

    const model = this.sourceSession.model;
    if (model.ok) {
      this.committedRows = cloneRows(model.rows);
    }

    if (model.ok && !model.truncated) {
      this.rebuildPresentationState();
      this.bounds = canvasBounds(this.committedRows);
    }

    this.selection = createSheetSelection(
      { row: 0, column: 0 },
      { row: 0, column: 0 },
      this.mergeIndex
    );
  }

  private rebuildPresentationState(): boolean {
    this.presentationIssues = [];
    this.mergeIndex = createSheetMergeIndex([]);
    this.sourceMergeIndex = createSheetMergeIndex([]);
    const context = presentationContext(this.committedRows);
    const sourceValidation = validateSheetPresentation(this.embeddedPresentation, context);
    if (!sourceValidation.ok) {
      this.presentationIssues = [...sourceValidation.issues];
      this.resolvedPresentation = {};
      return false;
    }
    this.embeddedPresentation = sourceValidation.presentation;
    this.sourceMergeIndex = createSheetMergeIndex(sourceValidation.presentation.merges);

    this.resolvedPresentation = resolveSheetPresentation(
      this.embeddedPresentation,
      this.presentationOverride
    );
    const validation = validateSheetPresentation(this.resolvedPresentation, context);
    if (!validation.ok) {
      this.presentationIssues = [...validation.issues];
      this.resolvedPresentation = {};
      return true;
    }
    this.resolvedPresentation = validation.presentation;
    this.mergeIndex = createSheetMergeIndex(validation.presentation.merges);
    return true;
  }

  private render(): void {
    const model = this.sourceSession.model;
    if (!model.ok || model.truncated) {
      renderTable(this.root, model, {
        addressed: true,
        headerRow: false,
        label: 'Spreadsheet editor',
        emptyMessage: 'No sheet data.',
        presentation: this.resolvedPresentation,
      });
      const status = this.root.querySelector<HTMLElement>(
        '.sheet-surface__message, .sheet-surface__notice'
      );
      if (status) status.tabIndex = -1;
      if (model.ok && model.truncated) {
        const notice = this.root.querySelector('.sheet-surface__notice');
        if (notice) {
          notice.textContent = `${notice.textContent ?? ''} Editing is unavailable because not all rows were loaded.`;
        }
      }
      return;
    }

    this.reportPresentationIssues();
    const style = document.createElement('style');
    style.textContent = tableStyles;

    const surface = document.createElement('div');
    surface.className =
      'sheet-surface sheet-surface--addressed sheet-surface--interactive sheet-surface--editor';
    const scroll = document.createElement('div');
    scroll.className = 'sheet-surface__scroll';

    const table = document.createElement('table');
    table.className = 'sheet-table';
    table.setAttribute('role', 'grid');
    table.setAttribute('aria-label', 'Spreadsheet editor');
    table.setAttribute('aria-multiselectable', 'true');
    table.setAttribute('aria-readonly', String(this.isEditingDisabled()));
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
          this.committedRows[rowIndex]?.[columnIndex] ?? '',
          rowIndex,
          columnIndex,
          range
        );
        cell.setAttribute('role', 'gridcell');
        if (this.sourceMergeIndex.isCovered(rowIndex, columnIndex)) {
          cell.setAttribute('aria-readonly', 'true');
        }
        if (
          rowIndex >= this.committedRows.length ||
          columnIndex >= (this.committedRows[rowIndex]?.length ?? 0)
        ) {
          cell.classList.add('sheet-table__cell--virtual');
        }
        row.append(cell);
      }
      body.append(row);
    }
    table.append(body);
    scroll.append(table);
    surface.append(this.createToolbar(), scroll);

    if (this.presentationIssues.length > 0) {
      const notice = createInvalidPresentationNotice();
      table.setAttribute('aria-describedby', notice.id);
      surface.append(notice);
    }

    this.root.replaceChildren(style, surface);
    this.applySelection(false);
    if (this.draft) this.mountDraftControl();
  }

  private createToolbar(): HTMLElement {
    const toolbar = document.createElement('div');
    toolbar.className = 'sheet-editor__toolbar';
    toolbar.setAttribute('role', 'toolbar');
    toolbar.setAttribute('aria-label', 'Sheet structure');

    const enabledCommands = TOOLBAR_COMMANDS.filter(({ command }) =>
      this.isStructureCommandEnabled(command)
    );
    if (!enabledCommands.some(({ command }) => command === this.toolbarTabCommand)) {
      this.toolbarTabCommand = enabledCommands[0]?.command ?? TOOLBAR_COMMANDS[0].command;
    }

    for (const groupName of ['insert', 'delete'] as const) {
      if (groupName === 'delete') {
        const separator = document.createElement('span');
        separator.className = 'sheet-editor__toolbar-separator';
        separator.setAttribute('aria-hidden', 'true');
        toolbar.append(separator);
      }
      const group = document.createElement('div');
      group.className = 'sheet-editor__toolbar-group';
      group.setAttribute('role', 'group');
      group.setAttribute(
        'aria-label',
        groupName === 'insert' ? 'Insert rows and columns' : 'Delete rows and columns'
      );
      for (const definition of TOOLBAR_COMMANDS.filter(({ group }) => group === groupName)) {
        const button = document.createElement('button');
        const enabled = this.isStructureCommandEnabled(definition.command);
        button.type = 'button';
        button.className = `sheet-editor__toolbar-button sheet-editor__toolbar-button--${definition.group}`;
        button.dataset.sheetCommand = definition.command;
        button.setAttribute('aria-label', definition.label);
        button.title = definition.label;
        button.disabled = !enabled;
        button.tabIndex = enabled && definition.command === this.toolbarTabCommand ? 0 : -1;
        button.innerHTML = structureIcon(definition.icon);
        group.append(button);
      }
      toolbar.append(group);
    }
    return toolbar;
  }

  private syncToolbarState(): void {
    const buttons = [...this.root.querySelectorAll<HTMLButtonElement>('[data-sheet-command]')];
    if (buttons.length === 0) return;
    const enabledButtons = buttons.filter((button) => {
      const command = structureCommandFromButton(button);
      const enabled = command !== null && this.isStructureCommandEnabled(command);
      button.disabled = !enabled;
      return enabled;
    });
    if (!enabledButtons.some((button) => button.dataset.sheetCommand === this.toolbarTabCommand)) {
      const command = enabledButtons[0] ? structureCommandFromButton(enabledButtons[0]) : null;
      if (command) this.toolbarTabCommand = command;
    }
    for (const button of buttons) {
      button.tabIndex =
        !button.disabled && button.dataset.sheetCommand === this.toolbarTabCommand ? 0 : -1;
    }
  }

  private readonly handleToolbarClick = (event: Event): void => {
    const target = event.target;
    const button =
      target instanceof Element
        ? target.closest<HTMLButtonElement>('button[data-sheet-command]')
        : null;
    const command = button ? structureCommandFromButton(button) : null;
    if (!button || !command || button.disabled) return;
    event.preventDefault();
    if (this.composing) {
      this.editControl()?.focus({ preventScroll: true });
      return;
    }
    this.toolbarTabCommand = command;
    this.runStructureCommand(command);
  };

  private handleToolbarKeyDown(event: KeyboardEvent, button: HTMLButtonElement): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      this.focusActiveCell({ preventScroll: true });
      return;
    }
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;

    const buttons = [
      ...this.root.querySelectorAll<HTMLButtonElement>(
        '.sheet-editor__toolbar-button:not(:disabled)'
      ),
    ];
    if (buttons.length === 0) return;
    event.preventDefault();
    const currentIndex = Math.max(0, buttons.indexOf(button));
    let nextIndex: number;
    if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = buttons.length - 1;
    else if (event.key === 'ArrowLeft') {
      nextIndex = (currentIndex - 1 + buttons.length) % buttons.length;
    } else {
      nextIndex = (currentIndex + 1) % buttons.length;
    }
    const next = buttons[nextIndex];
    if (!next) return;
    const command = structureCommandFromButton(next);
    if (!command) return;
    this.toolbarTabCommand = command;
    this.syncToolbarState();
    next.focus();
  }

  private runStructureCommand(command: SheetStructureCommand): void {
    if (!this.isStructureCommandEnabled(command)) {
      this.focusActiveCell({ preventScroll: true });
      return;
    }
    if (this.draft) this.commitDraft(null, false);
    if (!this.isStructureCommandEnabled(command)) {
      this.focusActiveCell({ preventScroll: true });
      return;
    }

    const previousSource = this.getContent();
    const before = this.createSnapshot();
    const operation = this.structureOperation(command);
    const currentResolved = resolveSheetPresentation(
      this.embeddedPresentation,
      this.presentationOverride
    );
    const currentViewValid = validateSheetPresentation(
      currentResolved,
      presentationContext(this.committedRows)
    ).ok;
    const rows = applySheetStructure(this.committedRows, operation);
    const embeddedPresentation = transformSheetPresentation(this.embeddedPresentation, operation);
    const presentationOverride = currentViewValid
      ? transformPresentationOverride(this.presentationOverride, operation)
      : snapshotPresentationOverride(this.presentationOverride);
    const failure = this.validateStructureCandidate(
      rows,
      embeddedPresentation,
      presentationOverride,
      currentViewValid
    );
    if (failure) {
      this.showStructureError(failure);
      this.focusActiveCell({ preventScroll: true });
      return;
    }

    this.committedRows = rows;
    this.embeddedPresentation = embeddedPresentation;
    this.presentationOverride = presentationOverride;
    this.rebuildPresentationState();
    this.bounds = canvasBounds(this.committedRows);
    this.selection = this.selectionAfterStructure(operation, before.selection.active);
    const after = this.createSnapshot();
    this.pushHistory({ before, after });
    if (this.isConnected) this.render();
    this.focusActiveCell({ preventScroll: true });
    this.emitIfChanged(previousSource);
  }

  private structureOperation(command: SheetStructureCommand): SheetStructureOperation {
    const materializedRows = this.committedRows.length;
    const materializedColumns = widestRow(this.committedRows);
    switch (command) {
      case 'insert-row-above':
        return {
          axis: 'row',
          kind: 'insert',
          index: Math.min(this.selection.range.startRow, materializedRows),
        };
      case 'insert-row-below':
        return {
          axis: 'row',
          kind: 'insert',
          index: Math.min(this.selection.range.endRow, materializedRows),
        };
      case 'insert-column-before':
        return {
          axis: 'column',
          kind: 'insert',
          index: Math.min(this.selection.range.startColumn, materializedColumns),
        };
      case 'insert-column-after':
        return {
          axis: 'column',
          kind: 'insert',
          index: Math.min(this.selection.range.endColumn, materializedColumns),
        };
      case 'delete-row':
        return { axis: 'row', kind: 'delete', index: this.selection.active.row };
      case 'delete-column':
        return { axis: 'column', kind: 'delete', index: this.selection.active.column };
    }
  }

  private selectionAfterStructure(
    operation: SheetStructureOperation,
    previousActive: SheetCoordinate
  ): SheetSelection {
    const rowMaximum = Math.max(0, this.committedRows.length - 1);
    const columnMaximum = Math.max(0, widestRow(this.committedRows) - 1);
    const coordinate =
      operation.axis === 'row'
        ? {
            row:
              operation.kind === 'insert' ? operation.index : Math.min(operation.index, rowMaximum),
            column: Math.min(previousActive.column, columnMaximum),
          }
        : {
            row: Math.min(previousActive.row, rowMaximum),
            column:
              operation.kind === 'insert'
                ? operation.index
                : Math.min(operation.index, columnMaximum),
          };
    return createSheetSelection(coordinate, coordinate, this.mergeIndex);
  }

  private validateStructureCandidate(
    rows: readonly (readonly string[])[],
    embeddedPresentation: SheetPresentation,
    presentationOverride: SheetPresentationOverride,
    requireValidView: boolean
  ): string | null {
    if (rows.length > DEFAULT_CSV_LIMITS.maxMaterializedRows) {
      return `Sheet content exceeds the ${DEFAULT_CSV_LIMITS.maxMaterializedRows.toLocaleString('en-US')}-row limit.`;
    }
    if (widestRow(rows) > DEFAULT_CSV_LIMITS.maxColumns) {
      return `Sheet content exceeds the ${DEFAULT_CSV_LIMITS.maxColumns.toLocaleString('en-US')}-column limit.`;
    }
    if (
      rows.some((row) =>
        row.some((value) => utf8ByteLength(value) > DEFAULT_CSV_LIMITS.maxCellBytes)
      )
    ) {
      return `Cell content exceeds the ${DEFAULT_CSV_LIMITS.maxCellBytes.toLocaleString('en-US')}-byte limit.`;
    }
    if (
      utf8ByteLength(this.sourceSession.serializeRowsForLimit(rows)) >
      DEFAULT_CSV_LIMITS.maxInputBytes
    ) {
      return `Sheet content exceeds the ${DEFAULT_CSV_LIMITS.maxInputBytes.toLocaleString('en-US')}-byte limit.`;
    }
    const context = presentationContext(rows);
    if (!validateSheetPresentation(embeddedPresentation, context).ok) {
      return 'The structural change would make merged-cell presentation invalid.';
    }
    if (
      requireValidView &&
      !validateSheetPresentation(
        resolveSheetPresentation(embeddedPresentation, presentationOverride),
        context
      ).ok
    ) {
      return 'The structural change would make merged-cell presentation invalid.';
    }
    if (!this.sourceSession.validateCandidate(rows, embeddedPresentation)) {
      return 'The structural change could not be serialized safely.';
    }
    return null;
  }

  private isStructureCommandEnabled(command: SheetStructureCommand): boolean {
    if (!this.canMutate() || this.composing) return false;
    switch (command) {
      case 'insert-row-above':
      case 'insert-row-below':
        return this.committedRows.length < DEFAULT_CSV_LIMITS.maxMaterializedRows;
      case 'insert-column-before':
      case 'insert-column-after':
        return widestRow(this.committedRows) < DEFAULT_CSV_LIMITS.maxColumns;
      case 'delete-row':
        return this.selection.active.row < this.committedRows.length;
      case 'delete-column':
        return this.selection.active.column < widestRow(this.committedRows);
    }
  }

  private showStructureError(message: string): void {
    let notice = this.root.querySelector<HTMLParagraphElement>('#sheet-editor-structure-notice');
    if (!notice) {
      notice = document.createElement('p');
      notice.id = 'sheet-editor-structure-notice';
      notice.className = 'sheet-surface__notice sheet-editor__limit';
      notice.setAttribute('role', 'status');
      notice.setAttribute('aria-live', 'polite');
      this.root.querySelector('.sheet-surface')?.append(notice);
    }
    notice.textContent = message;
  }

  private readonly handleKeyDown = (event: Event): void => {
    if (!this.isInteractive()) return;
    const keyboardEvent = event as KeyboardEvent;
    const target = keyboardEvent.target;
    const toolbarButton =
      target instanceof Element
        ? target.closest<HTMLButtonElement>('button[data-sheet-command]')
        : null;
    if (toolbarButton) {
      this.handleToolbarKeyDown(keyboardEvent, toolbarButton);
      return;
    }
    if (this.mode === 'quick-edit') {
      this.handleQuickEditKey(keyboardEvent);
      return;
    }
    if (this.mode === 'caret-edit') {
      this.handleCaretEditKey(keyboardEvent);
      return;
    }

    if (keyboardEvent.key === 'F2') {
      if (this.canEdit() && !this.isComposingEvent(keyboardEvent)) {
        keyboardEvent.preventDefault();
        this.startCaretEdit();
      }
      return;
    }

    if (isUndoShortcut(keyboardEvent)) {
      if (!this.canMutate()) return;
      keyboardEvent.preventDefault();
      if (keyboardEvent.key.toLowerCase() === 'y' || keyboardEvent.shiftKey) this.redo();
      else this.undo();
      return;
    }

    if (
      keyboardEvent.key === 'Enter' &&
      !hasCommandModifier(keyboardEvent) &&
      !keyboardEvent.shiftKey
    ) {
      if (this.canEdit()) {
        keyboardEvent.preventDefault();
        this.startQuickEdit();
      }
      return;
    }

    if (isPrintableKey(keyboardEvent) && this.canEdit()) {
      keyboardEvent.preventDefault();
      this.startQuickEdit(keyboardEvent.key);
      return;
    }

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

  private handleQuickEditKey(event: KeyboardEvent): void {
    if (this.isComposingEvent(event)) return;
    if (event.key === 'F2') {
      event.preventDefault();
      this.switchToCaretEdit();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      this.cancelDraft(true, true);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      this.commitDraft(event.shiftKey ? 'up' : 'down', true);
      return;
    }
    const direction = directionForKey(event.key);
    if (direction && !event.shiftKey && !hasCommandModifier(event)) {
      event.preventDefault();
      this.commitDraft(direction, true);
    }
  }

  private handleCaretEditKey(event: KeyboardEvent): void {
    if (this.isComposingEvent(event)) return;
    if (event.key === 'F2') {
      event.preventDefault();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      this.cancelDraft(true, true);
      return;
    }
    if (event.key !== 'Enter') return;

    event.preventDefault();
    if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
      this.insertDraftNewline();
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    this.commitDraft(event.shiftKey ? 'up' : 'down', true);
  }

  private readonly handleBeforeInput = (event: Event): void => {
    const textarea = event.target;
    if (!(textarea instanceof HTMLTextAreaElement) || !this.draft) return;
    this.draft.selectionStart = textarea.selectionStart;
    this.draft.selectionEnd = textarea.selectionEnd;
  };

  private readonly handleInput = (event: Event): void => {
    const textarea = event.target;
    if (!(textarea instanceof HTMLTextAreaElement) || !this.draft) return;
    const previousSource = this.getContent();
    const candidate = textarea.value;
    const failure = this.validateDraftCandidate(candidate);
    if (failure) {
      textarea.value = this.draft.value;
      textarea.setSelectionRange(this.draft.selectionStart, this.draft.selectionEnd);
      this.showLimit(failure, textarea);
      return;
    }

    this.clearLimit(textarea);
    this.draft.value = candidate;
    this.draft.selectionStart = textarea.selectionStart;
    this.draft.selectionEnd = textarea.selectionEnd;
    this.resizeDraftControl(textarea);
    this.emitIfChanged(previousSource);
  };

  private readonly handleCompositionStart = (): void => {
    this.composing = true;
    this.syncToolbarState();
  };

  private readonly handleCompositionEnd = (): void => {
    this.composing = false;
    this.syncToolbarState();
  };

  private readonly handleFocusOut = (event: Event): void => {
    if (this.mode === 'navigation' || !this.draft) return;
    const focusEvent = event as FocusEvent;
    const next = focusEvent.relatedTarget;
    if (next instanceof Node && this.root.contains(next)) return;
    this.commitDraft(null, false);
  };

  private readonly handleDoubleClick = (event: Event): void => {
    if (!this.canEdit()) return;
    const mouseEvent = event as MouseEvent;
    if (mouseEvent.button !== 0 || mouseEvent.target instanceof HTMLTextAreaElement) return;
    const target = mouseEvent.target;
    const cell =
      target instanceof Element ? target.closest<HTMLElement>('td[data-row][data-column]') : null;
    if (!cell) return;
    const coordinate = coordinateFromCell(cell);
    if (!coordinate) return;
    mouseEvent.preventDefault();
    if (this.mode !== 'navigation') this.commitDraft(null, false);
    this.selection = createSheetSelection(coordinate, coordinate, this.mergeIndex);
    this.applySelection(false);
    this.startCaretEdit();
  };

  private readonly handlePointerDown = (event: Event): void => {
    if (!this.isInteractive()) return;
    const pointerEvent = event as PointerEvent;
    if (pointerEvent.button !== 0) return;
    if (pointerEvent.target instanceof HTMLTextAreaElement) return;
    const cell = this.cellFromEvent(pointerEvent);
    if (!cell) return;
    const coordinate = coordinateFromCell(cell);
    if (!coordinate) return;
    pointerEvent.preventDefault();

    if (this.mode !== 'navigation') this.commitDraft(null, false);

    const liveCell = this.cellAt(coordinate);
    if (!liveCell) return;
    const pointerId = pointerEvent.pointerId ?? 0;
    this.dragPointerId = pointerId;
    this.dragAnchor = coordinate;
    this.selection = createSheetSelection(coordinate, coordinate, this.mergeIndex);
    liveCell.setPointerCapture?.(pointerId);
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

  private startQuickEdit(replacement?: string): void {
    this.startDraft('quick-edit', replacement);
  }

  private startCaretEdit(): void {
    this.startDraft('caret-edit');
  }

  private startDraft(mode: Exclude<SheetEditorMode, 'navigation'>, replacement?: string): void {
    if (!this.canEdit()) return;
    const previousSource = this.getContent();
    const coordinate = { ...this.selection.active };
    const value = this.committedRows[coordinate.row]?.[coordinate.column] ?? '';
    this.mode = mode;
    this.draft = {
      coordinate,
      value,
      selectionStart: value.length,
      selectionEnd: value.length,
    };

    let failure: string | null = null;
    if (replacement !== undefined) {
      failure = this.validateDraftCandidate(replacement);
      if (!failure) {
        this.draft.value = replacement;
        this.draft.selectionStart = replacement.length;
        this.draft.selectionEnd = replacement.length;
      }
    }
    const textarea = this.mountDraftControl();
    if (failure && textarea) this.showLimit(failure, textarea);
    this.emitIfChanged(previousSource);
  }

  private switchToCaretEdit(): void {
    if (!this.draft || this.mode !== 'quick-edit') return;
    const textarea = this.editControl();
    if (textarea) {
      this.draft.selectionStart = textarea.selectionStart;
      this.draft.selectionEnd = textarea.selectionEnd;
      textarea.classList.add('sheet-editor__input--caret');
      textarea.dataset.mode = 'caret-edit';
    }
    this.mode = 'caret-edit';
    if (textarea) this.resizeDraftControl(textarea);
  }

  private mountDraftControl(): HTMLTextAreaElement | null {
    if (!this.draft) return null;
    const cell = this.cellAt(this.draft.coordinate);
    if (!cell) return null;
    cell.classList.add('sheet-table__cell--editing');
    cell.querySelector('.sheet-editor__input')?.remove();

    const textarea = document.createElement('textarea');
    textarea.className = 'sheet-editor__input';
    if (this.mode === 'caret-edit') textarea.classList.add('sheet-editor__input--caret');
    textarea.dataset.mode = this.mode;
    textarea.rows = 1;
    textarea.spellcheck = true;
    textarea.value = this.draft.value;
    textarea.setAttribute(
      'aria-label',
      `Edit ${columnLabel(this.draft.coordinate.column)}${this.draft.coordinate.row + 1}`
    );
    cell.append(textarea);
    textarea.focus({ preventScroll: true });
    textarea.setSelectionRange(this.draft.selectionStart, this.draft.selectionEnd);
    this.resizeDraftControl(textarea);
    return textarea;
  }

  private insertDraftNewline(): void {
    const draft = this.draft;
    const textarea = this.editControl();
    if (!draft || !textarea || this.mode !== 'caret-edit') return;
    const previousSource = this.getContent();
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const candidate = `${textarea.value.slice(0, start)}\n${textarea.value.slice(end)}`;
    const failure = this.validateDraftCandidate(candidate);
    if (failure) {
      this.showLimit(failure, textarea);
      return;
    }

    this.clearLimit(textarea);
    draft.value = candidate;
    draft.selectionStart = start + 1;
    draft.selectionEnd = start + 1;
    textarea.value = candidate;
    textarea.setSelectionRange(start + 1, start + 1);
    this.resizeDraftControl(textarea);
    this.emitIfChanged(previousSource);
  }

  private commitDraft(direction: SheetMoveDirection | null, focus: boolean): void {
    const draft = this.draft;
    if (!draft) return;
    const before = this.createSnapshot();
    const beforeRows = cloneRows(this.committedRows);
    const afterRows = applyCellValue(beforeRows, draft.coordinate, draft.value);
    const changed = !rowsEqual(beforeRows, afterRows);
    if (changed) {
      this.committedRows = afterRows;
    }

    this.mode = 'navigation';
    this.draft = null;
    this.composing = false;
    this.bounds = canvasBounds(this.committedRows);
    this.selection = createSheetSelection(draft.coordinate, draft.coordinate, this.mergeIndex);
    if (direction) {
      this.selection = moveSheetSelection(this.selection, direction, this.bounds, this.mergeIndex);
    }
    if (changed) this.pushHistory({ before, after: this.createSnapshot() });
    if (this.isConnected) this.render();
    if (focus) this.focusActiveCell({ preventScroll: true });
  }

  private cancelDraft(emit: boolean, focus: boolean): void {
    if (!this.draft) return;
    const previousSource = this.getContent();
    const coordinate = { ...this.draft.coordinate };
    this.mode = 'navigation';
    this.draft = null;
    this.composing = false;
    this.selection = createSheetSelection(coordinate, coordinate, this.mergeIndex);
    if (this.isConnected) this.render();
    if (focus) this.focusActiveCell({ preventScroll: true });
    if (emit) this.emitIfChanged(previousSource);
  }

  private undo(): void {
    const transaction = this.undoHistory.pop();
    if (!transaction) return;
    const previousSource = this.getContent();
    this.redoHistory.push(transaction);
    this.finishHistoryChange(transaction.before, previousSource);
  }

  private redo(): void {
    const transaction = this.redoHistory.pop();
    if (!transaction) return;
    const previousSource = this.getContent();
    this.undoHistory.push(transaction);
    this.finishHistoryChange(transaction.after, previousSource);
  }

  private finishHistoryChange(snapshot: EditorSnapshot, previousSource: string): void {
    this.applySnapshot(snapshot);
    if (this.isConnected) this.render();
    this.focusActiveCell({ preventScroll: true });
    this.emitIfChanged(previousSource);
  }

  private createSnapshot(): EditorSnapshot {
    return {
      rows: cloneRows(this.committedRows),
      embeddedPresentation: snapshotSheetPresentation(this.embeddedPresentation),
      presentationOverride: snapshotPresentationOverride(this.presentationOverride),
      selection: snapshotSelection(this.selection),
    };
  }

  private applySnapshot(snapshot: EditorSnapshot): void {
    this.committedRows = cloneRows(snapshot.rows);
    this.embeddedPresentation = snapshotSheetPresentation(snapshot.embeddedPresentation);
    this.presentationOverride = snapshotPresentationOverride(snapshot.presentationOverride);
    this.rebuildPresentationState();
    this.bounds = canvasBounds(this.committedRows);
    this.selection = createSheetSelection(
      snapshot.selection.anchor,
      snapshot.selection.active,
      this.mergeIndex
    );
  }

  private pushHistory(transaction: EditorTransaction): void {
    this.undoHistory.push(transaction);
    if (this.undoHistory.length > HISTORY_LIMIT) this.undoHistory.shift();
    this.redoHistory = [];
  }

  private validateDraftCandidate(value: string): string | null {
    if (!this.draft) return null;
    if (utf8ByteLength(value) > DEFAULT_CSV_LIMITS.maxCellBytes) {
      return `Cell content exceeds the ${DEFAULT_CSV_LIMITS.maxCellBytes.toLocaleString('en-US')}-byte limit.`;
    }
    const rows = applyCellValue(this.committedRows, this.draft.coordinate, value);
    if (rows.length > DEFAULT_CSV_LIMITS.maxMaterializedRows) {
      return `Sheet content exceeds the ${DEFAULT_CSV_LIMITS.maxMaterializedRows.toLocaleString('en-US')}-row limit.`;
    }
    if (widestRow(rows) > DEFAULT_CSV_LIMITS.maxColumns) {
      return `Sheet content exceeds the ${DEFAULT_CSV_LIMITS.maxColumns.toLocaleString('en-US')}-column limit.`;
    }
    if (
      utf8ByteLength(this.sourceSession.serializeRowsForLimit(rows)) >
      DEFAULT_CSV_LIMITS.maxInputBytes
    ) {
      return `Sheet content exceeds the ${DEFAULT_CSV_LIMITS.maxInputBytes.toLocaleString('en-US')}-byte limit.`;
    }
    return null;
  }

  private rowsWithDraft(): string[][] {
    if (!this.draft) return this.committedRows;
    return applyCellValue(this.committedRows, this.draft.coordinate, this.draft.value);
  }

  private serializeRows(rows: readonly (readonly string[])[]): string {
    return this.sourceSession.serialize(rows, this.embeddedPresentation);
  }

  private emitIfChanged(previousSource: string): void {
    const content = this.getContent();
    if (content === previousSource) return;
    this.dispatchEvent(new CustomEvent('content-change', { detail: { content } }));
  }

  private showLimit(message: string, textarea: HTMLTextAreaElement): void {
    let notice = this.root.querySelector<HTMLParagraphElement>('#sheet-editor-limit-notice');
    if (!notice) {
      notice = document.createElement('p');
      notice.id = 'sheet-editor-limit-notice';
      notice.className = 'sheet-surface__notice sheet-editor__limit';
      notice.setAttribute('role', 'status');
      notice.setAttribute('aria-live', 'polite');
      this.root.querySelector('.sheet-surface')?.append(notice);
    }
    notice.textContent = message;
    textarea.setAttribute('aria-describedby', notice.id);
  }

  private clearLimit(textarea: HTMLTextAreaElement): void {
    this.root.querySelector('#sheet-editor-limit-notice')?.remove();
    textarea.removeAttribute('aria-describedby');
  }

  private resizeDraftControl(textarea: HTMLTextAreaElement): void {
    if (this.mode !== 'caret-edit') {
      textarea.style.removeProperty('height');
      textarea.style.removeProperty('overflow-y');
      return;
    }
    const cell = textarea.closest<HTMLTableCellElement>('td[data-row][data-column]');
    const surface = this.root.querySelector<HTMLElement>('.sheet-surface');
    const baseHeight = Math.max(cell?.getBoundingClientRect().height ?? 0, 20) + 2;
    const surfaceHeight = surface?.getBoundingClientRect().height ?? 0;
    const maxHeight = Math.max(baseHeight, Math.min(surfaceHeight || 160, 160));
    textarea.style.height = 'auto';
    const desired = Math.max(baseHeight, Math.min(textarea.scrollHeight + 4, maxHeight));
    textarea.style.height = `${desired}px`;
    textarea.style.overflowY = textarea.scrollHeight + 4 > desired ? 'auto' : 'hidden';
  }

  private readonly handleOverlayGeometry = (): void => {
    const textarea = this.editControl();
    if (textarea) this.resizeDraftControl(textarea);
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
    this.syncToolbarState();
    if (focus) this.focusActiveCell({ preventScroll: true });
  }

  private focusActiveCell(options?: FocusOptions): void {
    const active = this.cellAt(this.selection.active);
    if (!active) return;
    active.focus({ ...options, preventScroll: true });
    this.scrollCellIntoView(active);
  }

  private scrollCellIntoView(cell: HTMLTableCellElement): void {
    const scroll = cell.closest<HTMLElement>('.sheet-surface__scroll');
    if (!scroll) return;

    const viewport = scroll.getBoundingClientRect();
    const cellRect = cell.getBoundingClientRect();
    const rowHeader = this.root.querySelector<HTMLElement>('.sheet-table__row-header');
    const columnHeader = this.root.querySelector<HTMLElement>('.sheet-table__column-header');
    const rowHeaderRect = rowHeader?.getBoundingClientRect();
    const columnHeaderRect = columnHeader?.getBoundingClientRect();
    const visibleLeft =
      viewport.left + Math.max(0, (rowHeaderRect?.right ?? viewport.left) - viewport.left);
    const visibleTop =
      viewport.top + Math.max(0, (columnHeaderRect?.bottom ?? viewport.top) - viewport.top);

    let horizontalDelta = 0;
    if (cellRect.left < visibleLeft) horizontalDelta = cellRect.left - visibleLeft;
    else if (cellRect.right > viewport.right) horizontalDelta = cellRect.right - viewport.right;

    let verticalDelta = 0;
    if (cellRect.top < visibleTop) verticalDelta = cellRect.top - visibleTop;
    else if (cellRect.bottom > viewport.bottom) verticalDelta = cellRect.bottom - viewport.bottom;

    if (horizontalDelta !== 0) {
      scroll.scrollLeft = Math.max(0, scroll.scrollLeft + horizontalDelta);
    }
    if (verticalDelta !== 0) {
      scroll.scrollTop = Math.max(0, scroll.scrollTop + verticalDelta);
    }
  }

  private cellAt(coordinate: SheetCoordinate): HTMLTableCellElement | null {
    return this.root.querySelector<HTMLTableCellElement>(
      `td[data-row="${coordinate.row}"][data-column="${coordinate.column}"]`
    );
  }

  private editControl(): HTMLTextAreaElement | null {
    return this.root.querySelector<HTMLTextAreaElement>('.sheet-editor__input');
  }

  private isInteractive(): boolean {
    return this.sourceSession.model.ok && !this.sourceSession.model.truncated;
  }

  private isReadOnly(): boolean {
    return this.getAttribute('readonly') === 'true';
  }

  private canEdit(): boolean {
    return (
      this.canMutate() &&
      !this.sourceMergeIndex.isCovered(this.selection.active.row, this.selection.active.column)
    );
  }

  private canMutate(): boolean {
    return this.isInteractive() && !this.isEditingDisabled();
  }

  private isEditingDisabled(): boolean {
    return !this.sourceSession.editable || this.isReadOnly();
  }

  private isComposingEvent(event: KeyboardEvent): boolean {
    return this.composing || event.isComposing || event.keyCode === 229;
  }

  private reportPresentationIssues(): void {
    if (this.presentationReported || this.presentationIssues.length === 0) return;
    this.presentationReported = true;
    reportError('Merged-cell presentation is invalid.', this.presentationIssues);
  }
}

function canvasBounds(rows: readonly (readonly string[])[]): SheetCanvasBounds {
  const rowCount =
    rows.length < DEFAULT_CSV_LIMITS.maxMaterializedRows ? rows.length + 1 : rows.length;
  const maxColumns = widestRow(rows);
  const columnCount = maxColumns < DEFAULT_CSV_LIMITS.maxColumns ? maxColumns + 1 : maxColumns;
  return {
    rowCount: Math.max(1, rowCount),
    columnCount: Math.max(1, columnCount),
  };
}

function widestRow(rows: readonly (readonly string[])[]): number {
  return rows.reduce((widest, row) => Math.max(widest, row.length), 0);
}

function applyCellValue(
  sourceRows: readonly (readonly string[])[],
  coordinate: SheetCoordinate,
  value: string
): string[][] {
  const rows = cloneRows(sourceRows);
  const existingRow = rows[coordinate.row];
  if (existingRow && coordinate.column < existingRow.length) {
    existingRow[coordinate.column] = value;
    return rows;
  }
  if (value === '') return rows;

  while (rows.length <= coordinate.row) rows.push([]);
  const row = rows[coordinate.row];
  while (row.length < coordinate.column) row.push('');
  row.push(value);
  return rows;
}

function cloneRows(rows: readonly (readonly string[])[]): string[][] {
  return rows.map((row) => [...row]);
}

function rowsEqual(
  left: readonly (readonly string[])[],
  right: readonly (readonly string[])[]
): boolean {
  if (left.length !== right.length) return false;
  return left.every(
    (row, rowIndex) =>
      row.length === right[rowIndex]?.length &&
      row.every((value, columnIndex) => value === right[rowIndex]?.[columnIndex])
  );
}

function presentationContext(rows: readonly (readonly string[])[]) {
  return {
    rows,
    totalRows: rows.length,
    maxColumns: widestRow(rows),
    headerRow: false,
  };
}

function snapshotSelection(selection: SheetSelection): SheetSelection {
  return {
    anchor: { ...selection.anchor },
    active: { ...selection.active },
    range: { ...selection.range },
  };
}

function transformPresentationOverride(
  override: SheetPresentationOverride,
  operation: SheetStructureOperation
): SheetPresentationOverride {
  const snapshot = snapshotPresentationOverride(override);
  if (snapshot === null || snapshot === undefined) return snapshot;
  if (!Object.hasOwn(snapshot, 'merges') || snapshot.merges === undefined) return snapshot;
  return transformSheetPresentation(snapshot, operation);
}

function structureCommandFromButton(button: HTMLButtonElement): SheetStructureCommand | null {
  const command = button.dataset.sheetCommand;
  return TOOLBAR_COMMANDS.some((definition) => definition.command === command)
    ? (command as SheetStructureCommand)
    : null;
}

const STRUCTURE_ICONS: Readonly<Record<string, string>> = {
  'row-above': '<path d="M4 13h16v7H4zM11 3h2v3h3v2h-3v3h-2V8H8V6h3z" fill="currentColor"/>',
  'row-below': '<path d="M4 4h16v7H4zM11 13h2v3h3v2h-3v3h-2v-3H8v-2h3z" fill="currentColor"/>',
  'column-before': '<path d="M13 4h7v16h-7zM3 11h3V8h2v3h3v2H8v3H6v-3H3z" fill="currentColor"/>',
  'column-after': '<path d="M4 4h7v16H4zM13 11h3V8h2v3h3v2h-3v3h-2v-3h-3z" fill="currentColor"/>',
  'delete-row':
    '<path d="M3 8h18v8H3zM8.7 10.3 12 13.6l3.3-3.3 1.4 1.4-3.3 3.3 3.3 3.3-1.4 1.4-3.3-3.3-3.3 3.3-1.4-1.4 3.3-3.3-3.3-3.3z" fill="currentColor"/>',
  'delete-column':
    '<path d="M8 3h8v18H8zM10.3 8.7l3.3 3.3-3.3 3.3 1.4 1.4 3.3-3.3 3.3 3.3 1.4-1.4-3.3-3.3 3.3-3.3-1.4-1.4-3.3 3.3-3.3-3.3z" fill="currentColor"/>',
};

function structureIcon(name: string): string {
  return `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">${STRUCTURE_ICONS[name] ?? ''}</svg>`;
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

function hasCommandModifier(event: KeyboardEvent): boolean {
  return event.altKey || event.ctrlKey || event.metaKey;
}

function isPrintableKey(event: KeyboardEvent): boolean {
  return event.key.length === 1 && !hasCommandModifier(event) && !event.isComposing;
}

function isUndoShortcut(event: KeyboardEvent): boolean {
  if (event.altKey || (!event.ctrlKey && !event.metaKey)) return false;
  const key = event.key.toLowerCase();
  return key === 'z' || key === 'y';
}

if (!customElements.get('sheet-editor')) {
  customElements.define('sheet-editor', SheetEditor);
}
