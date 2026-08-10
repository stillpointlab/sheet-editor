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
  type SheetAlignmentRule,
  type SheetCellRange,
  type SheetContentOptions,
  type SheetFormatRule,
  type SheetHorizontalAlignment,
  type SheetPresentation,
  type SheetPresentationIssue,
  type SheetValueFormatKind,
  type SheetValueFormatRule,
  type SheetVerticalAlignment,
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
import { createSheetStyleIndex, type SheetStyleIndex } from '../shared/style-index';
import { tableStyles } from '../shared/table.styles';
import {
  createSheetValueFormatIndex,
  formatSheetCellValue,
  inferAutomaticDecimalPlaces,
  type EffectiveSheetValueFormat,
  type SheetValueFormatIndex,
} from '../shared/value-format';

import {
  applyTabularPaste,
  clearTabularRange,
  extractTabularSelection,
  parseTabularClipboard,
  serializeTabularClipboard,
} from './clipboard';
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

type SheetEmphasisProperty = 'bold' | 'italic' | 'strikethrough';
type SheetAlignmentAxis = 'horizontal' | 'vertical';
type SheetAlignmentValue = SheetHorizontalAlignment | SheetVerticalAlignment;
type SheetFormattingCommand = `format-${SheetEmphasisProperty}`;
type SheetAlignmentCommand = `align-${SheetAlignmentAxis}`;
type SheetValueFormatCommand =
  'value-currency' | 'value-percent' | 'decimal-decrease' | 'decimal-increase' | 'value-format';
type SheetToolbarCommand =
  SheetStructureCommand | SheetFormattingCommand | SheetAlignmentCommand | SheetValueFormatCommand;
type SheetToolbarMenu = SheetAlignmentAxis | 'value-format';
type SelectionState<T> = T | 'mixed';

interface ValueFormatSelectionState {
  kind: SelectionState<SheetValueFormatKind>;
  decimalPlaces?: SelectionState<number>;
  currency?: SelectionState<string>;
}

interface ToolbarCommandDefinition {
  command: SheetStructureCommand;
  label: string;
  icon: string;
  group: 'insert' | 'delete';
}

const HISTORY_LIMIT = 100;
const EMPHASIS_PROPERTIES: readonly SheetEmphasisProperty[] = ['bold', 'italic', 'strikethrough'];
const ALIGNMENT_VALUES = {
  horizontal: ['left', 'center', 'right'],
  vertical: ['top', 'middle', 'bottom'],
} as const;
const VALUE_FORMAT_KINDS: readonly SheetValueFormatKind[] = [
  'automatic',
  'number',
  'currency',
  'percent',
  'date',
  'time',
  'datetime',
];
const VALUE_FORMAT_COMMANDS: readonly SheetValueFormatCommand[] = [
  'value-currency',
  'value-percent',
  'decimal-decrease',
  'decimal-increase',
  'value-format',
];
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
  private styleIndex: SheetStyleIndex = createSheetStyleIndex({});
  private valueFormatIndex: SheetValueFormatIndex = createSheetValueFormatIndex({});
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
  private toolbarTabCommand: SheetToolbarCommand = TOOLBAR_COMMANDS[0].command;
  private openToolbarMenu: SheetToolbarMenu | null = null;
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
    this.root.addEventListener('copy', this.handleCopy);
    this.root.addEventListener('paste', this.handlePaste);
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
    document.addEventListener('pointerdown', this.handleDocumentPointerDown, true);
    this.render();
  }

  disconnectedCallback(): void {
    window.removeEventListener('resize', this.handleOverlayGeometry);
    document.removeEventListener('pointerdown', this.handleDocumentPointerDown, true);
  }

  attributeChangedCallback(name: string, oldValue: string | null, newValue: string | null): void {
    if (name !== 'readonly' || oldValue === newValue) return;
    if (newValue === 'true' && this.draft) {
      this.cancelDraft(true, false);
      return;
    }
    if (newValue === 'true') this.closeToolbarFlyout(false);
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
    this.openToolbarMenu = null;
    this.toolbarTabCommand =
      this.sourceSession.kind === 'document' ? 'format-bold' : TOOLBAR_COMMANDS[0].command;
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
    this.styleIndex = createSheetStyleIndex({});
    this.valueFormatIndex = createSheetValueFormatIndex({});
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
    this.styleIndex = createSheetStyleIndex({});
    this.valueFormatIndex = createSheetValueFormatIndex({});
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
    this.styleIndex = createSheetStyleIndex(validation.presentation);
    this.valueFormatIndex = createSheetValueFormatIndex(validation.presentation);
    return true;
  }

  private render(): void {
    this.openToolbarMenu = null;
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
          formatSheetCellValue(
            this.committedRows[rowIndex]?.[columnIndex] ?? '',
            this.valueFormatIndex.formatAt(rowIndex, columnIndex)
          ),
          rowIndex,
          columnIndex,
          range,
          false,
          this.styleIndex.styleAt(rowIndex, columnIndex)
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
    surface.append(this.createToolbarShell(), scroll);

    if (this.presentationIssues.length > 0) {
      const notice = createInvalidPresentationNotice();
      table.setAttribute('aria-describedby', notice.id);
      surface.append(notice);
    }

    this.root.replaceChildren(style, surface);
    this.applySelection(false);
    if (this.draft) this.mountDraftControl();
  }

  private createToolbarShell(): HTMLElement {
    const shell = document.createElement('div');
    shell.className = 'sheet-editor__toolbar-shell';
    shell.append(this.createToolbar());
    if (this.sourceSession.kind === 'document') {
      shell.append(
        this.createAlignmentFlyout('horizontal'),
        this.createAlignmentFlyout('vertical'),
        this.createValueFormatFlyout()
      );
    }
    return shell;
  }

  private createToolbar(): HTMLElement {
    const toolbar = document.createElement('div');
    toolbar.className = 'sheet-editor__toolbar';
    toolbar.setAttribute('role', 'toolbar');
    toolbar.setAttribute('aria-label', 'Sheet tools');

    const visibleCommands = this.visibleToolbarCommands();
    const enabledCommands = visibleCommands.filter((command) =>
      this.isToolbarCommandEnabled(command)
    );
    if (!enabledCommands.includes(this.toolbarTabCommand)) {
      this.toolbarTabCommand =
        enabledCommands[0] ?? visibleCommands[0] ?? TOOLBAR_COMMANDS[0].command;
    }

    if (this.sourceSession.kind === 'document') {
      const emphasis = document.createElement('div');
      emphasis.className = 'sheet-editor__toolbar-group';
      emphasis.setAttribute('role', 'group');
      emphasis.setAttribute('aria-label', 'Text emphasis');
      for (const property of EMPHASIS_PROPERTIES) {
        const command: SheetFormattingCommand = `format-${property}`;
        const label = emphasisLabel(property);
        const button = this.createToolbarButton(command, label);
        button.dataset.sheetFormat = property;
        button.setAttribute('aria-pressed', 'false');
        button.innerHTML = formattingIcon(property);
        emphasis.append(button);
      }
      toolbar.append(emphasis, createToolbarSeparator());

      const alignment = document.createElement('div');
      alignment.className = 'sheet-editor__toolbar-group';
      alignment.setAttribute('role', 'group');
      alignment.setAttribute('aria-label', 'Cell alignment');
      for (const axis of ['horizontal', 'vertical'] as const) {
        const command: SheetAlignmentCommand = `align-${axis}`;
        const button = this.createToolbarButton(command, `${axisLabel(axis)} alignment`);
        button.classList.add('sheet-editor__toolbar-button--flyout');
        button.dataset.sheetAlignmentTrigger = axis;
        button.setAttribute('aria-haspopup', 'menu');
        button.setAttribute('aria-expanded', 'false');
        button.setAttribute('aria-controls', alignmentMenuId(axis));
        alignment.append(button);
      }
      toolbar.append(alignment, createToolbarSeparator());

      const valueFormat = document.createElement('div');
      valueFormat.className = 'sheet-editor__toolbar-group';
      valueFormat.setAttribute('role', 'group');
      valueFormat.setAttribute('aria-label', 'Value formatting');
      for (const definition of [
        { command: 'value-currency', label: 'Currency', icon: 'currency' },
        { command: 'value-percent', label: 'Percent', icon: 'percent' },
        { command: 'decimal-decrease', label: 'Decrease decimal places', icon: 'decimal-decrease' },
        { command: 'decimal-increase', label: 'Increase decimal places', icon: 'decimal-increase' },
      ] as const) {
        const button = this.createToolbarButton(definition.command, definition.label);
        button.dataset.sheetValueFormatAction = definition.command;
        button.innerHTML = valueFormatIcon(definition.icon);
        valueFormat.append(button);
      }
      const valueFormatTrigger = this.createToolbarButton(
        'value-format',
        'Value format: Automatic'
      );
      valueFormatTrigger.classList.add('sheet-editor__toolbar-button--flyout');
      valueFormatTrigger.dataset.sheetValueFormatTrigger = '';
      valueFormatTrigger.setAttribute('aria-haspopup', 'menu');
      valueFormatTrigger.setAttribute('aria-expanded', 'false');
      valueFormatTrigger.setAttribute('aria-controls', valueFormatMenuId());
      valueFormat.append(valueFormatTrigger);
      toolbar.append(valueFormat, createToolbarSeparator());
    }

    for (const groupName of ['insert', 'delete'] as const) {
      if (groupName === 'delete') {
        toolbar.append(createToolbarSeparator());
      }
      const group = document.createElement('div');
      group.className = 'sheet-editor__toolbar-group';
      group.setAttribute('role', 'group');
      group.setAttribute(
        'aria-label',
        groupName === 'insert' ? 'Insert rows and columns' : 'Delete rows and columns'
      );
      for (const definition of TOOLBAR_COMMANDS.filter(({ group }) => group === groupName)) {
        const button = this.createToolbarButton(definition.command, definition.label);
        button.classList.add(`sheet-editor__toolbar-button--${definition.group}`);
        button.dataset.sheetCommand = definition.command;
        button.innerHTML = structureIcon(definition.icon);
        group.append(button);
      }
      toolbar.append(group);
    }
    return toolbar;
  }

  private createToolbarButton(command: SheetToolbarCommand, label: string): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'sheet-editor__toolbar-button';
    button.dataset.sheetToolbarCommand = command;
    button.setAttribute('aria-label', label);
    button.title = label;
    button.disabled = !this.isToolbarCommandEnabled(command);
    button.tabIndex = !button.disabled && command === this.toolbarTabCommand ? 0 : -1;
    return button;
  }

  private createAlignmentFlyout(axis: SheetAlignmentAxis): HTMLElement {
    const menu = document.createElement('div');
    menu.id = alignmentMenuId(axis);
    menu.className = 'sheet-editor__alignment-menu';
    menu.dataset.sheetAlignmentMenu = axis;
    menu.setAttribute('role', 'menu');
    menu.hidden = true;
    for (const value of ALIGNMENT_VALUES[axis]) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'sheet-editor__alignment-item';
      item.dataset.sheetAlignmentAxis = axis;
      item.dataset.sheetAlignmentValue = value;
      item.setAttribute('role', 'menuitemradio');
      item.setAttribute('aria-checked', 'false');
      item.tabIndex = -1;
      item.innerHTML = `${alignmentIcon(axis, value)}<span>${titleCase(value)}</span>`;
      menu.append(item);
    }
    return menu;
  }

  private createValueFormatFlyout(): HTMLElement {
    const menu = document.createElement('div');
    menu.id = valueFormatMenuId();
    menu.className = 'sheet-editor__alignment-menu sheet-editor__value-format-menu';
    menu.dataset.sheetValueFormatMenu = '';
    menu.setAttribute('role', 'menu');
    menu.hidden = true;
    for (const kind of VALUE_FORMAT_KINDS) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'sheet-editor__alignment-item sheet-editor__value-format-item';
      item.dataset.sheetValueFormatKind = kind;
      item.setAttribute('role', 'menuitemradio');
      item.setAttribute('aria-checked', 'false');
      item.tabIndex = -1;
      item.innerHTML = `${valueFormatKindIcon(kind)}<span>${valueFormatKindLabel(kind)}</span>`;
      menu.append(item);
    }
    return menu;
  }

  private syncToolbarState(): void {
    const buttons = [
      ...this.root.querySelectorAll<HTMLButtonElement>('[data-sheet-toolbar-command]'),
    ];
    if (buttons.length === 0) return;
    const enabledButtons = buttons.filter((button) => {
      const command = toolbarCommandFromButton(button);
      const enabled = command !== null && this.isToolbarCommandEnabled(command);
      button.disabled = !enabled;
      const property = emphasisPropertyFromButton(button);
      if (property) {
        button.setAttribute('aria-pressed', String(this.emphasisSelectionState(property)));
      }
      const axis = alignmentAxisFromTrigger(button);
      if (axis) this.syncAlignmentTrigger(button, axis);
      if (isValueFormatTrigger(button)) this.syncValueFormatTrigger(button);
      return enabled;
    });
    if (
      !enabledButtons.some(
        (button) => button.dataset.sheetToolbarCommand === this.toolbarTabCommand
      )
    ) {
      const command = enabledButtons[0] ? toolbarCommandFromButton(enabledButtons[0]) : null;
      if (command) this.toolbarTabCommand = command;
    }
    for (const button of buttons) {
      button.tabIndex =
        !button.disabled && button.dataset.sheetToolbarCommand === this.toolbarTabCommand ? 0 : -1;
    }
    for (const axis of ['horizontal', 'vertical'] as const) this.syncAlignmentMenuState(axis);
    this.syncValueFormatMenuState();
    const openCommand =
      this.openToolbarMenu === 'value-format'
        ? 'value-format'
        : this.openToolbarMenu
          ? (`align-${this.openToolbarMenu}` as SheetAlignmentCommand)
          : null;
    if (openCommand && !this.isToolbarCommandEnabled(openCommand)) {
      this.closeToolbarFlyout(false);
    }
  }

  private readonly handleToolbarClick = (event: Event): void => {
    const target = event.target;
    const alignmentMenuItem =
      target instanceof Element
        ? target.closest<HTMLButtonElement>('button[data-sheet-alignment-axis]')
        : null;
    if (alignmentMenuItem) {
      const choice = alignmentChoiceFromButton(alignmentMenuItem);
      if (!choice || alignmentMenuItem.disabled) return;
      event.preventDefault();
      this.runAlignmentCommand(choice.axis, choice.value);
      return;
    }
    const valueFormatMenuItem =
      target instanceof Element
        ? target.closest<HTMLButtonElement>('button[data-sheet-value-format-kind]')
        : null;
    if (valueFormatMenuItem) {
      const kind = valueFormatKindFromButton(valueFormatMenuItem);
      if (!kind || valueFormatMenuItem.disabled) return;
      event.preventDefault();
      this.runValueFormatChoice(kind);
      return;
    }
    const button =
      target instanceof Element
        ? target.closest<HTMLButtonElement>('button[data-sheet-toolbar-command]')
        : null;
    const command = button ? toolbarCommandFromButton(button) : null;
    if (!button || !command || button.disabled) return;
    event.preventDefault();
    if (this.composing) {
      this.editControl()?.focus({ preventScroll: true });
      return;
    }
    this.toolbarTabCommand = command;
    if (isStructureCommand(command)) this.runStructureCommand(command);
    else if (command.startsWith('format-')) {
      this.runEmphasisCommand(command.slice('format-'.length) as SheetEmphasisProperty);
    } else if (command.startsWith('align-')) {
      const axis = command.slice('align-'.length) as SheetAlignmentAxis;
      if (this.openToolbarMenu === axis) this.closeToolbarFlyout(true);
      else this.openAlignmentFlyout(axis);
    } else if (command === 'value-format') {
      if (this.openToolbarMenu === 'value-format') this.closeToolbarFlyout(true);
      else this.openValueFormatFlyout();
    } else if (command === 'value-currency') {
      this.runValueFormatChoice('currency', command);
    } else if (command === 'value-percent') {
      this.runValueFormatChoice('percent', command);
    } else if (command === 'decimal-decrease') {
      this.runDecimalCommand(-1);
    } else if (command === 'decimal-increase') {
      this.runDecimalCommand(1);
    }
  };

  private handleToolbarKeyDown(event: KeyboardEvent, button: HTMLButtonElement): void {
    const axis = alignmentAxisFromTrigger(button);
    if (axis && ['Enter', ' ', 'ArrowDown'].includes(event.key)) {
      event.preventDefault();
      this.toolbarTabCommand = `align-${axis}`;
      this.openAlignmentFlyout(axis);
      return;
    }
    if (isValueFormatTrigger(button) && ['Enter', ' ', 'ArrowDown'].includes(event.key)) {
      event.preventDefault();
      this.toolbarTabCommand = 'value-format';
      this.openValueFormatFlyout();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      this.closeToolbarFlyout(false);
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
    const command = toolbarCommandFromButton(next);
    if (!command) return;
    this.toolbarTabCommand = command;
    this.syncToolbarState();
    next.focus();
  }

  private handleToolbarMenuKeyDown(event: KeyboardEvent, item: HTMLButtonElement): void {
    const choice = alignmentChoiceFromButton(item);
    const valueFormatKind = valueFormatKindFromButton(item);
    if (!choice && !valueFormatKind) return;
    const menu = item.closest<HTMLElement>('[role="menu"]');
    const items = menu
      ? [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')]
      : [];
    if (event.key === 'Escape') {
      event.preventDefault();
      this.closeToolbarFlyout(true);
      return;
    }
    if (event.key === 'Tab') {
      this.closeToolbarFlyout(true);
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (choice) this.runAlignmentCommand(choice.axis, choice.value);
      else if (valueFormatKind) this.runValueFormatChoice(valueFormatKind);
      return;
    }
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key) || items.length === 0) return;
    event.preventDefault();
    const currentIndex = Math.max(0, items.indexOf(item));
    const nextIndex =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? items.length - 1
          : event.key === 'ArrowUp'
            ? (currentIndex - 1 + items.length) % items.length
            : (currentIndex + 1) % items.length;
    items[nextIndex]?.focus();
  }

  private runEmphasisCommand(property: SheetEmphasisProperty): void {
    const command: SheetFormattingCommand = `format-${property}`;
    if (this.draft) {
      const scrollPosition = this.captureScrollPosition();
      this.commitDraft(null, false);
      this.restoreScrollPosition(scrollPosition);
    }
    if (!this.isToolbarCommandEnabled(command)) {
      this.focusToolbarCommand(command);
      return;
    }
    const rule: SheetFormatRule = {
      range: { ...this.selection.range },
      [property]: this.emphasisSelectionState(property) !== true,
    };
    const candidate: SheetPresentation = {
      ...snapshotSheetPresentation(this.embeddedPresentation),
      formats: [...(this.embeddedPresentation.formats ?? []), rule],
    };
    this.installPresentationCandidate(candidate, command);
  }

  private runAlignmentCommand(axis: SheetAlignmentAxis, value: SheetAlignmentValue): void {
    const command: SheetAlignmentCommand = `align-${axis}`;
    if (this.draft) {
      const scrollPosition = this.captureScrollPosition();
      this.commitDraft(null, false);
      this.restoreScrollPosition(scrollPosition);
    }
    if (!this.isToolbarCommandEnabled(command)) {
      this.closeToolbarFlyout(false);
      this.focusToolbarCommand(command);
      return;
    }
    if (this.alignmentSelectionState(axis) === value) {
      this.closeToolbarFlyout(false);
      this.focusToolbarCommand(command);
      return;
    }
    const rule: SheetAlignmentRule =
      axis === 'horizontal'
        ? { range: { ...this.selection.range }, horizontal: value as SheetHorizontalAlignment }
        : { range: { ...this.selection.range }, vertical: value as SheetVerticalAlignment };
    const candidate: SheetPresentation = {
      ...snapshotSheetPresentation(this.embeddedPresentation),
      alignments: [...(this.embeddedPresentation.alignments ?? []), rule],
    };
    this.installPresentationCandidate(candidate, command);
  }

  private runValueFormatChoice(
    kind: SheetValueFormatKind,
    focusCommand: SheetValueFormatCommand = 'value-format'
  ): void {
    if (this.draft) {
      const scrollPosition = this.captureScrollPosition();
      this.commitDraft(null, false);
      this.restoreScrollPosition(scrollPosition);
    }
    if (!this.isToolbarCommandEnabled(focusCommand)) {
      this.closeToolbarFlyout(false);
      this.focusToolbarCommand(focusCommand);
      return;
    }
    const descriptor = defaultValueFormat(kind);
    if (this.selectionHasValueFormat(descriptor)) {
      this.closeToolbarFlyout(false);
      this.focusToolbarCommand(focusCommand);
      return;
    }
    const rule = valueFormatRule({ ...this.selection.range }, descriptor);
    const candidate: SheetPresentation = {
      ...snapshotSheetPresentation(this.embeddedPresentation),
      valueFormats: [...(this.embeddedPresentation.valueFormats ?? []), rule],
    };
    this.installPresentationCandidate(candidate, focusCommand);
  }

  private runDecimalCommand(direction: -1 | 1): void {
    const command: SheetValueFormatCommand =
      direction < 0 ? 'decimal-decrease' : 'decimal-increase';
    if (this.draft) {
      const scrollPosition = this.captureScrollPosition();
      this.commitDraft(null, false);
      this.restoreScrollPosition(scrollPosition);
    }
    if (!this.isToolbarCommandEnabled(command)) {
      this.closeToolbarFlyout(false);
      this.focusToolbarCommand(command);
      return;
    }
    const rules = this.decimalRulesForSelection(direction);
    if (rules.length === 0) {
      this.closeToolbarFlyout(false);
      this.focusToolbarCommand(command);
      return;
    }
    const candidate: SheetPresentation = {
      ...snapshotSheetPresentation(this.embeddedPresentation),
      valueFormats: [...(this.embeddedPresentation.valueFormats ?? []), ...rules],
    };
    this.installPresentationCandidate(candidate, command);
  }

  private installPresentationCandidate(
    candidate: SheetPresentation,
    focusCommand: SheetFormattingCommand | SheetAlignmentCommand | SheetValueFormatCommand
  ): void {
    const validation = validateSheetPresentation(
      candidate,
      presentationContext(this.committedRows)
    );
    if (!validation.ok) {
      this.closeToolbarFlyout(false);
      this.showStructureError(
        validation.issues[0]?.message ?? 'The presentation change is invalid.'
      );
      this.focusToolbarCommand(focusCommand);
      return;
    }
    if (!this.sourceSession.validateCandidate(this.committedRows, validation.presentation)) {
      this.closeToolbarFlyout(false);
      this.showStructureError('The presentation change exceeds a document serialization limit.');
      this.focusToolbarCommand(focusCommand);
      return;
    }

    const previousSource = this.getContent();
    const before = this.createSnapshot();
    const scrollPosition = this.captureScrollPosition();
    this.embeddedPresentation = validation.presentation;
    this.rebuildPresentationState();
    const after = this.createSnapshot();
    this.pushHistory({ before, after });
    if (this.isConnected) this.render();
    this.restoreScrollPosition(scrollPosition);
    this.focusToolbarCommand(focusCommand);
    this.emitIfChanged(previousSource);
  }

  private selectionHasValueFormat(descriptor: EffectiveSheetValueFormat): boolean {
    let matches = true;
    forEachCell(this.selection.range, (row, column) => {
      if (!valueFormatsEqual(this.valueFormatIndex.formatAt(row, column), descriptor)) {
        matches = false;
      }
    });
    return matches;
  }

  private decimalRulesForSelection(direction: -1 | 1): SheetValueFormatRule[] {
    const rules: SheetValueFormatRule[] = [];
    for (let row = this.selection.range.startRow; row < this.selection.range.endRow; row += 1) {
      let runStart: number | null = null;
      let runDescriptor: EffectiveSheetValueFormat | null = null;
      const flush = (endColumn: number): void => {
        if (runStart === null || runDescriptor === null) return;
        rules.push(
          valueFormatRule(
            { startRow: row, endRow: row + 1, startColumn: runStart, endColumn },
            runDescriptor
          )
        );
        runStart = null;
        runDescriptor = null;
      };

      for (
        let column = this.selection.range.startColumn;
        column < this.selection.range.endColumn;
        column += 1
      ) {
        const current = this.valueFormatIndex.formatAt(row, column);
        const next = this.adjustedDecimalFormat(current, row, column, direction);
        if (next === null || valueFormatsEqual(current, next)) {
          flush(column);
          continue;
        }
        if (runDescriptor && valueFormatsEqual(runDescriptor, next)) continue;
        flush(column);
        runStart = column;
        runDescriptor = next;
      }
      flush(this.selection.range.endColumn);
    }
    return rules;
  }

  private adjustedDecimalFormat(
    current: EffectiveSheetValueFormat,
    row: number,
    column: number,
    direction: -1 | 1
  ): EffectiveSheetValueFormat | null {
    if (isTemporalValueFormat(current)) return null;
    const baseline =
      current.kind === 'automatic'
        ? inferAutomaticDecimalPlaces(this.rawValueAt(row, column))
        : current.decimalPlaces;
    const decimalPlaces = Math.min(10, Math.max(0, baseline + direction));
    if (current.kind === 'automatic') {
      return decimalPlaces === baseline ? current : { kind: 'number', decimalPlaces };
    }
    if (current.kind === 'currency') {
      return { kind: current.kind, currency: current.currency, decimalPlaces };
    }
    return { kind: current.kind, decimalPlaces };
  }

  private decimalCommandCanChange(direction: -1 | 1): boolean {
    if (this.draft) {
      const { row, column } = this.draft.coordinate;
      const current = this.valueFormatIndex.formatAt(row, column);
      if (isTemporalValueFormat(current)) return false;
      const next = this.adjustedDecimalFormat(current, row, column, direction);
      return next !== null && !valueFormatsEqual(current, next);
    }
    let canChange = false;
    let hasTemporal = false;
    forEachCell(this.selection.range, (row, column) => {
      const current = this.valueFormatIndex.formatAt(row, column);
      if (isTemporalValueFormat(current)) {
        hasTemporal = true;
        return;
      }
      const next = this.adjustedDecimalFormat(current, row, column, direction);
      if (next && !valueFormatsEqual(current, next)) canChange = true;
    });
    return !hasTemporal && canChange;
  }

  private rawValueAt(row: number, column: number): string {
    if (
      this.draft &&
      this.draft.coordinate.row === row &&
      this.draft.coordinate.column === column
    ) {
      return this.draft.value;
    }
    return this.committedRows[row]?.[column] ?? '';
  }

  private emphasisSelectionState(property: SheetEmphasisProperty): SelectionState<boolean> {
    let state: boolean | undefined;
    let mixed = false;
    forEachCell(this.selection.range, (row, column) => {
      const value = this.styleIndex.styleAt(row, column)[property];
      if (state === undefined) state = value;
      else if (state !== value) mixed = true;
    });
    return mixed ? 'mixed' : (state ?? false);
  }

  private alignmentSelectionState<T extends SheetAlignmentAxis>(
    axis: T
  ): SelectionState<T extends 'horizontal' ? SheetHorizontalAlignment : SheetVerticalAlignment> {
    let state: SheetAlignmentValue | 'mixed' | undefined;
    forEachCell(this.selection.range, (row, column) => {
      const value = this.styleIndex.styleAt(row, column)[axis];
      if (state === undefined) state = value;
      else if (state !== value) state = 'mixed';
    });
    return (state ?? (axis === 'horizontal' ? 'left' : 'middle')) as SelectionState<
      T extends 'horizontal' ? SheetHorizontalAlignment : SheetVerticalAlignment
    >;
  }

  private activeAlignment(axis: SheetAlignmentAxis): SheetAlignmentValue {
    return this.styleIndex.styleAt(this.selection.active.row, this.selection.active.column)[axis];
  }

  private valueFormatSelectionState(): ValueFormatSelectionState {
    let kind: SheetValueFormatKind | 'mixed' | undefined;
    let decimalPlaces: number | 'mixed' | undefined;
    let currency: string | 'mixed' | undefined;
    forEachCell(this.selection.range, (row, column) => {
      const format = this.valueFormatIndex.formatAt(row, column);
      if (kind === undefined) kind = format.kind;
      else if (kind !== format.kind) kind = 'mixed';
      if (format.kind === 'number' || format.kind === 'currency' || format.kind === 'percent') {
        if (decimalPlaces === undefined) decimalPlaces = format.decimalPlaces;
        else if (decimalPlaces !== format.decimalPlaces) decimalPlaces = 'mixed';
      }
      if (format.kind === 'currency') {
        if (currency === undefined) currency = format.currency;
        else if (currency !== format.currency) currency = 'mixed';
      }
    });
    return {
      kind: kind ?? 'automatic',
      ...(decimalPlaces === undefined ? {} : { decimalPlaces }),
      ...(currency === undefined ? {} : { currency }),
    };
  }

  private activeValueFormatKind(): SheetValueFormatKind {
    return this.valueFormatIndex.formatAt(this.selection.active.row, this.selection.active.column)
      .kind;
  }

  private syncAlignmentTrigger(button: HTMLButtonElement, axis: SheetAlignmentAxis): void {
    const state = this.alignmentSelectionState(axis);
    const label = `${axisLabel(axis)} alignment: ${titleCase(state)}`;
    button.setAttribute('aria-label', label);
    button.title = label;
    button.dataset.sheetAlignmentState = state;
    button.setAttribute('aria-expanded', String(this.openToolbarMenu === axis));
    button.innerHTML = `${alignmentIcon(axis, state)}${chevronIcon()}`;
  }

  private syncAlignmentMenuState(axis: SheetAlignmentAxis): void {
    const menu = this.root.querySelector<HTMLElement>(`[data-sheet-alignment-menu="${axis}"]`);
    if (!menu) return;
    const state = this.alignmentSelectionState(axis);
    menu.setAttribute('aria-label', `${axisLabel(axis)} alignment, ${titleCase(state)}`);
    for (const item of menu.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')) {
      item.setAttribute(
        'aria-checked',
        String(state !== 'mixed' && item.dataset.sheetAlignmentValue === state)
      );
      item.disabled = !this.isToolbarCommandEnabled(`align-${axis}`);
    }
  }

  private syncValueFormatTrigger(button: HTMLButtonElement): void {
    const state = this.valueFormatSelectionState();
    const label = valueFormatAccessibleLabel(state);
    button.setAttribute('aria-label', label);
    button.title = label;
    button.dataset.sheetValueFormatState = state.kind;
    button.setAttribute('aria-expanded', String(this.openToolbarMenu === 'value-format'));
    button.innerHTML = `${valueFormatTriggerIcon(state.kind)}${chevronIcon()}`;
  }

  private syncValueFormatMenuState(): void {
    const menu = this.valueFormatMenu();
    if (!menu) return;
    const state = this.valueFormatSelectionState();
    menu.setAttribute('aria-label', valueFormatAccessibleLabel(state));
    for (const item of menu.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')) {
      item.setAttribute(
        'aria-checked',
        String(state.kind !== 'mixed' && item.dataset.sheetValueFormatKind === state.kind)
      );
      item.disabled = !this.isToolbarCommandEnabled('value-format');
    }
  }

  private openAlignmentFlyout(axis: SheetAlignmentAxis): void {
    const command: SheetAlignmentCommand = `align-${axis}`;
    if (!this.isToolbarCommandEnabled(command)) return;
    if (this.openToolbarMenu && this.openToolbarMenu !== axis) {
      this.closeToolbarFlyout(false);
    }
    this.openToolbarMenu = axis;
    const menu = this.root.querySelector<HTMLElement>(`[data-sheet-alignment-menu="${axis}"]`);
    const trigger = this.alignmentTrigger(axis);
    if (!menu || !trigger) {
      this.openToolbarMenu = null;
      return;
    }
    menu.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    this.syncAlignmentMenuState(axis);
    this.positionAlignmentFlyout(axis);
    const value = this.activeAlignment(axis);
    menu
      .querySelector<HTMLButtonElement>(`[data-sheet-alignment-value="${value}"]`)
      ?.focus({ preventScroll: true });
  }

  private openValueFormatFlyout(): void {
    if (!this.isToolbarCommandEnabled('value-format')) return;
    if (this.openToolbarMenu && this.openToolbarMenu !== 'value-format') {
      this.closeToolbarFlyout(false);
    }
    this.openToolbarMenu = 'value-format';
    const menu = this.valueFormatMenu();
    const trigger = this.valueFormatTrigger();
    if (!menu || !trigger) {
      this.openToolbarMenu = null;
      return;
    }
    menu.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    this.syncValueFormatMenuState();
    this.positionValueFormatFlyout();
    const kind = this.activeValueFormatKind();
    menu
      .querySelector<HTMLButtonElement>(`[data-sheet-value-format-kind="${kind}"]`)
      ?.focus({ preventScroll: true });
  }

  private closeToolbarFlyout(focusTrigger: boolean): void {
    const open = this.openToolbarMenu;
    if (!open) return;
    const menu =
      open === 'value-format'
        ? this.valueFormatMenu()
        : this.root.querySelector<HTMLElement>(`[data-sheet-alignment-menu="${open}"]`);
    const trigger =
      open === 'value-format' ? this.valueFormatTrigger() : this.alignmentTrigger(open);
    if (menu) menu.hidden = true;
    trigger?.setAttribute('aria-expanded', 'false');
    this.openToolbarMenu = null;
    if (focusTrigger) trigger?.focus({ preventScroll: true });
  }

  private positionAlignmentFlyout(axis: SheetAlignmentAxis): void {
    const shell = this.root.querySelector<HTMLElement>('.sheet-editor__toolbar-shell');
    const menu = this.root.querySelector<HTMLElement>(`[data-sheet-alignment-menu="${axis}"]`);
    const trigger = this.alignmentTrigger(axis);
    if (!shell || !menu || !trigger || menu.hidden) return;
    const shellRect = shell.getBoundingClientRect();
    const triggerRect = trigger.getBoundingClientRect();
    const menuWidth = menu.getBoundingClientRect().width || 152;
    const maximum = Math.max(0, shellRect.width - menuWidth);
    menu.style.left = `${Math.min(maximum, Math.max(0, triggerRect.left - shellRect.left))}px`;
  }

  private positionValueFormatFlyout(): void {
    const shell = this.root.querySelector<HTMLElement>('.sheet-editor__toolbar-shell');
    const menu = this.valueFormatMenu();
    const trigger = this.valueFormatTrigger();
    if (!shell || !menu || !trigger || menu.hidden) return;
    const shellRect = shell.getBoundingClientRect();
    const triggerRect = trigger.getBoundingClientRect();
    const menuWidth = menu.getBoundingClientRect().width || 176;
    const maximum = Math.max(0, shellRect.width - menuWidth);
    menu.style.left = `${Math.min(maximum, Math.max(0, triggerRect.left - shellRect.left))}px`;
  }

  private readonly handleDocumentPointerDown = (event: PointerEvent): void => {
    const open = this.openToolbarMenu;
    if (!open) return;
    const menu =
      open === 'value-format'
        ? this.valueFormatMenu()
        : this.root.querySelector<HTMLElement>(`[data-sheet-alignment-menu="${open}"]`);
    const trigger =
      open === 'value-format' ? this.valueFormatTrigger() : this.alignmentTrigger(open);
    const path = event.composedPath();
    if ((menu && path.includes(menu)) || (trigger && path.includes(trigger))) return;
    this.closeToolbarFlyout(false);
  };

  private alignmentTrigger(axis: SheetAlignmentAxis): HTMLButtonElement | null {
    return this.root.querySelector<HTMLButtonElement>(`[data-sheet-alignment-trigger="${axis}"]`);
  }

  private valueFormatMenu(): HTMLElement | null {
    return this.root.querySelector<HTMLElement>('[data-sheet-value-format-menu]');
  }

  private valueFormatTrigger(): HTMLButtonElement | null {
    return this.root.querySelector<HTMLButtonElement>('[data-sheet-value-format-trigger]');
  }

  private focusToolbarCommand(command: SheetToolbarCommand): void {
    this.root
      .querySelector<HTMLButtonElement>(`[data-sheet-toolbar-command="${command}"]`)
      ?.focus({ preventScroll: true });
  }

  private captureScrollPosition(): { left: number; top: number } {
    const scroll = this.root.querySelector<HTMLElement>('.sheet-surface__scroll');
    return { left: scroll?.scrollLeft ?? 0, top: scroll?.scrollTop ?? 0 };
  }

  private restoreScrollPosition(position: { left: number; top: number }): void {
    const scroll = this.root.querySelector<HTMLElement>('.sheet-surface__scroll');
    if (!scroll) return;
    scroll.scrollLeft = position.left;
    scroll.scrollTop = position.top;
  }

  private visibleToolbarCommands(): SheetToolbarCommand[] {
    const structure = TOOLBAR_COMMANDS.map(({ command }) => command);
    if (this.sourceSession.kind !== 'document') return structure;
    return [
      ...EMPHASIS_PROPERTIES.map((property): SheetFormattingCommand => `format-${property}`),
      'align-horizontal',
      'align-vertical',
      ...VALUE_FORMAT_COMMANDS,
      ...structure,
    ];
  }

  private isToolbarCommandEnabled(command: SheetToolbarCommand): boolean {
    if (isStructureCommand(command)) return this.isStructureCommandEnabled(command);
    const section = command.startsWith('format-')
      ? 'formats'
      : command.startsWith('align-')
        ? 'alignments'
        : 'valueFormats';
    const enabled =
      this.canMutate() &&
      !this.composing &&
      this.sourceSession.kind === 'document' &&
      this.presentationIssues.length === 0 &&
      this.selectionIsMaterialized() &&
      this.embeddedOwnsSection(section);
    if (!enabled) return false;
    if (command === 'decimal-decrease') return this.decimalCommandCanChange(-1);
    if (command === 'decimal-increase') return this.decimalCommandCanChange(1);
    return true;
  }

  private selectionIsMaterialized(): boolean {
    return (
      this.committedRows.length > 0 &&
      widestRow(this.committedRows) > 0 &&
      this.selection.range.endRow <= this.committedRows.length &&
      this.selection.range.endColumn <= widestRow(this.committedRows)
    );
  }

  private embeddedOwnsSection(section: 'formats' | 'alignments' | 'valueFormats'): boolean {
    const override = this.presentationOverride;
    return (
      override === undefined ||
      (override !== null && (!Object.hasOwn(override, section) || override[section] === undefined))
    );
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
    const transformedEmbedded = transformSheetPresentation(this.embeddedPresentation, operation);
    const transformedValidation = validateSheetPresentation(
      transformedEmbedded,
      presentationContext(rows)
    );
    const embeddedPresentation = transformedValidation.ok
      ? transformedValidation.presentation
      : transformedEmbedded;
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
    return this.validateRowsCandidate(
      rows,
      embeddedPresentation,
      presentationOverride,
      requireValidView,
      'The structural change would make sheet presentation invalid.',
      'The structural change could not be serialized safely.'
    );
  }

  private validateValueCandidate(
    rows: readonly (readonly string[])[],
    action: 'paste' | 'clear'
  ): string | null {
    const currentContext = presentationContext(this.committedRows);
    const currentViewValid = validateSheetPresentation(
      resolveSheetPresentation(this.embeddedPresentation, this.presentationOverride),
      currentContext
    ).ok;
    const description = action === 'paste' ? 'The pasted values' : 'The selected values';
    return this.validateRowsCandidate(
      rows,
      this.embeddedPresentation,
      this.presentationOverride,
      currentViewValid,
      `${description} would make sheet presentation invalid.`,
      `${description} could not be serialized safely.`
    );
  }

  private validateRowsCandidate(
    rows: readonly (readonly string[])[],
    embeddedPresentation: SheetPresentation,
    presentationOverride: SheetPresentationOverride,
    requireValidView: boolean,
    presentationFailure: string,
    serializationFailure: string
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
      return presentationFailure;
    }
    if (
      requireValidView &&
      !validateSheetPresentation(
        resolveSheetPresentation(embeddedPresentation, presentationOverride),
        context
      ).ok
    ) {
      return presentationFailure;
    }
    if (!this.sourceSession.validateCandidate(rows, embeddedPresentation)) {
      return serializationFailure;
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

  private readonly handleCopy = (event: Event): void => {
    if (this.mode !== 'navigation' || !this.isInteractive() || !this.gridOwnsEvent(event)) {
      return;
    }
    const clipboardEvent = event as ClipboardEvent;
    const clipboardData = clipboardEvent.clipboardData;
    if (!clipboardData || typeof clipboardData.setData !== 'function') return;
    const matrix = extractTabularSelection(
      this.committedRows,
      this.selection.range,
      (row, column) => this.mergeIndex.isCovered(row, column)
    );
    const text = serializeTabularClipboard(matrix);
    try {
      clipboardData.setData('text/plain', text);
    } catch {
      return;
    }
    try {
      clipboardData.setData('text/tab-separated-values', text);
    } catch {
      // text/plain is the required interoperable flavor.
    }
    clipboardEvent.preventDefault();
  };

  private readonly handlePaste = (event: Event): void => {
    if (
      this.mode !== 'navigation' ||
      this.composing ||
      !this.canMutate() ||
      !this.gridOwnsEvent(event)
    ) {
      return;
    }
    const clipboardEvent = event as ClipboardEvent;
    const payload = readClipboardText(clipboardEvent.clipboardData);
    if (payload === null) return;
    clipboardEvent.preventDefault();

    const parsed = parseTabularClipboard(payload);
    if (!parsed.ok) {
      this.showStructureError(parsed.error.message);
      return;
    }
    const start = {
      row: this.selection.range.startRow,
      column: this.selection.range.startColumn,
    };
    if (start.row + parsed.rowCount > DEFAULT_CSV_LIMITS.maxMaterializedRows) {
      this.showStructureError(
        `Pasted values would exceed the ${DEFAULT_CSV_LIMITS.maxMaterializedRows.toLocaleString('en-US')}-row limit.`
      );
      return;
    }
    if (start.column + parsed.columnCount > DEFAULT_CSV_LIMITS.maxColumns) {
      this.showStructureError(
        `Pasted values would exceed the ${DEFAULT_CSV_LIMITS.maxColumns.toLocaleString('en-US')}-column limit.`
      );
      return;
    }

    const rows = applyTabularPaste(this.committedRows, start, parsed.rows);
    const failure = this.validateValueCandidate(rows, 'paste');
    if (failure) {
      this.showStructureError(failure);
      return;
    }
    this.commitRowsTransaction(rows);
  };

  private clearSelectedValues(): void {
    const rows = clearTabularRange(this.committedRows, this.selection.range);
    const failure = this.validateValueCandidate(rows, 'clear');
    if (failure) {
      this.showStructureError(failure);
      return;
    }
    this.commitRowsTransaction(rows);
  }

  private commitRowsTransaction(rows: readonly (readonly string[])[]): void {
    if (rowsEqual(rows, this.committedRows)) return;
    const previousSource = this.getContent();
    const before = this.createSnapshot();
    const scrollPosition = this.captureScrollPosition();
    const restoreGridFocus = this.gridHasFocus();
    this.committedRows = cloneRows(rows);
    this.rebuildPresentationState();
    this.bounds = canvasBounds(this.committedRows);
    this.selection = createSheetSelection(
      before.selection.anchor,
      before.selection.active,
      this.mergeIndex
    );
    this.pushHistory({ before, after: this.createSnapshot() });
    if (this.isConnected) this.render();
    this.restoreScrollPosition(scrollPosition);
    if (restoreGridFocus) {
      this.focusActiveCell({ preventScroll: true });
      this.restoreScrollPosition(scrollPosition);
    }
    this.emitIfChanged(previousSource);
  }

  private gridOwnsEvent(event: Event): boolean {
    const target = event.target;
    return target instanceof Element && target.closest('[role="grid"]') !== null;
  }

  private gridHasFocus(): boolean {
    const active = this.root.activeElement;
    return active instanceof Element && active.closest('[role="grid"]') !== null;
  }

  private readonly handleKeyDown = (event: Event): void => {
    if (!this.isInteractive()) return;
    const keyboardEvent = event as KeyboardEvent;
    const target = keyboardEvent.target;
    const toolbarButton =
      target instanceof Element
        ? target.closest<HTMLButtonElement>('button[data-sheet-toolbar-command]')
        : null;
    const menuItem =
      target instanceof Element
        ? target.closest<HTMLButtonElement>(
            'button[data-sheet-alignment-axis], button[data-sheet-value-format-kind]'
          )
        : null;
    if ((toolbarButton || menuItem) && isUndoShortcut(keyboardEvent)) {
      if (!this.canMutate()) return;
      keyboardEvent.preventDefault();
      if (keyboardEvent.key.toLowerCase() === 'y' || keyboardEvent.shiftKey) this.redo();
      else this.undo();
      return;
    }
    if (menuItem) {
      this.handleToolbarMenuKeyDown(keyboardEvent, menuItem);
      return;
    }
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

    if (keyboardEvent.key === 'Delete' || keyboardEvent.key === 'Backspace') {
      if (
        !this.canMutate() ||
        this.isComposingEvent(keyboardEvent) ||
        keyboardEvent.shiftKey ||
        hasCommandModifier(keyboardEvent) ||
        !this.gridOwnsEvent(keyboardEvent)
      ) {
        return;
      }
      keyboardEvent.preventDefault();
      this.clearSelectedValues();
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
    this.syncToolbarState();
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
    this.syncToolbarState();
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
    this.syncToolbarState();
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
    if (this.openToolbarMenu === 'value-format') this.positionValueFormatFlyout();
    else if (this.openToolbarMenu) this.positionAlignmentFlyout(this.openToolbarMenu);
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
    reportError('Sheet presentation is invalid.', this.presentationIssues);
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
  return transformSheetPresentation(snapshot, operation);
}

function isStructureCommand(command: string): command is SheetStructureCommand {
  return TOOLBAR_COMMANDS.some((definition) => definition.command === command);
}

function toolbarCommandFromButton(button: HTMLButtonElement): SheetToolbarCommand | null {
  const command = button.dataset.sheetToolbarCommand;
  if (!command) return null;
  if (isStructureCommand(command)) return command;
  if (
    EMPHASIS_PROPERTIES.some((property) => command === `format-${property}`) ||
    command === 'align-horizontal' ||
    command === 'align-vertical' ||
    VALUE_FORMAT_COMMANDS.includes(command as SheetValueFormatCommand)
  ) {
    return command as SheetToolbarCommand;
  }
  return null;
}

function emphasisPropertyFromButton(button: HTMLButtonElement): SheetEmphasisProperty | null {
  const property = button.dataset.sheetFormat;
  return EMPHASIS_PROPERTIES.includes(property as SheetEmphasisProperty)
    ? (property as SheetEmphasisProperty)
    : null;
}

function alignmentAxisFromTrigger(button: HTMLButtonElement): SheetAlignmentAxis | null {
  const axis = button.dataset.sheetAlignmentTrigger;
  return axis === 'horizontal' || axis === 'vertical' ? axis : null;
}

function alignmentChoiceFromButton(
  button: HTMLButtonElement
): { axis: SheetAlignmentAxis; value: SheetAlignmentValue } | null {
  const axis = button.dataset.sheetAlignmentAxis;
  const value = button.dataset.sheetAlignmentValue;
  if (axis === 'horizontal' && ALIGNMENT_VALUES.horizontal.includes(value as never)) {
    return { axis, value: value as SheetHorizontalAlignment };
  }
  if (axis === 'vertical' && ALIGNMENT_VALUES.vertical.includes(value as never)) {
    return { axis, value: value as SheetVerticalAlignment };
  }
  return null;
}

function isValueFormatTrigger(button: HTMLButtonElement): boolean {
  return Object.hasOwn(button.dataset, 'sheetValueFormatTrigger');
}

function valueFormatKindFromButton(button: HTMLButtonElement): SheetValueFormatKind | null {
  const kind = button.dataset.sheetValueFormatKind;
  return VALUE_FORMAT_KINDS.includes(kind as SheetValueFormatKind)
    ? (kind as SheetValueFormatKind)
    : null;
}

function createToolbarSeparator(): HTMLElement {
  const separator = document.createElement('span');
  separator.className = 'sheet-editor__toolbar-separator';
  separator.setAttribute('aria-hidden', 'true');
  return separator;
}

function emphasisLabel(property: SheetEmphasisProperty): string {
  return property === 'strikethrough' ? 'Strikethrough' : titleCase(property);
}

function axisLabel(axis: SheetAlignmentAxis): string {
  return axis === 'horizontal' ? 'Horizontal' : 'Vertical';
}

function titleCase(value: string): string {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

function alignmentMenuId(axis: SheetAlignmentAxis): string {
  return `sheet-editor-${axis}-alignment-menu`;
}

function valueFormatMenuId(): string {
  return 'sheet-editor-value-format-menu';
}

function valueFormatKindLabel(kind: SheetValueFormatKind): string {
  return kind === 'datetime' ? 'Date time' : titleCase(kind);
}

function defaultValueFormat(kind: SheetValueFormatKind): EffectiveSheetValueFormat {
  if (kind === 'currency') return { kind, currency: 'USD', decimalPlaces: 2 };
  if (kind === 'number' || kind === 'percent') return { kind, decimalPlaces: 2 };
  return { kind };
}

function valueFormatRule(
  range: SheetCellRange,
  descriptor: EffectiveSheetValueFormat
): SheetValueFormatRule {
  if (descriptor.kind === 'currency') {
    return {
      range,
      kind: descriptor.kind,
      currency: descriptor.currency,
      decimalPlaces: descriptor.decimalPlaces,
    };
  }
  if (descriptor.kind === 'number' || descriptor.kind === 'percent') {
    return { range, kind: descriptor.kind, decimalPlaces: descriptor.decimalPlaces };
  }
  return { range, kind: descriptor.kind };
}

function valueFormatsEqual(
  left: EffectiveSheetValueFormat,
  right: EffectiveSheetValueFormat
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'currency' && right.kind === 'currency') {
    return left.currency === right.currency && left.decimalPlaces === right.decimalPlaces;
  }
  if (
    (left.kind === 'number' || left.kind === 'percent') &&
    (right.kind === 'number' || right.kind === 'percent')
  ) {
    return left.decimalPlaces === right.decimalPlaces;
  }
  return true;
}

function isTemporalValueFormat(
  format: EffectiveSheetValueFormat
): format is { kind: 'date' | 'time' | 'datetime' } {
  return format.kind === 'date' || format.kind === 'time' || format.kind === 'datetime';
}

function valueFormatAccessibleLabel(state: ValueFormatSelectionState): string {
  if (state.kind === 'mixed') return 'Value format: Mixed';
  const kind = valueFormatKindLabel(state.kind);
  if (!['number', 'currency', 'percent'].includes(state.kind)) {
    return `Value format: ${kind}`;
  }
  const decimal =
    state.decimalPlaces === 'mixed'
      ? 'mixed decimal places'
      : `${state.decimalPlaces ?? 0} decimal ${state.decimalPlaces === 1 ? 'place' : 'places'}`;
  if (state.kind !== 'currency') return `Value format: ${kind}, ${decimal}`;
  const currency = state.currency === 'mixed' ? 'mixed currencies' : (state.currency ?? 'USD');
  return `Value format: Currency ${currency}, ${decimal}`;
}

function forEachCell(range: SheetCellRange, visit: (row: number, column: number) => void): void {
  for (let row = range.startRow; row < range.endRow; row += 1) {
    for (let column = range.startColumn; column < range.endColumn; column += 1) {
      visit(row, column);
    }
  }
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
  return iconSvg(STRUCTURE_ICONS[name] ?? '');
}

function formattingIcon(property: SheetEmphasisProperty): string {
  const content =
    property === 'bold'
      ? '<path d="M7 4h6.2a4 4 0 0 1 2.5 7.1A4.5 4.5 0 0 1 13 20H7zm3 3v3h3a1.5 1.5 0 0 0 0-3zm0 6v4h3.3a2 2 0 0 0 0-4z" fill="currentColor"/>'
      : property === 'italic'
        ? '<path d="M9 4v3h2.2l-2.4 10H6v3h8v-3h-2.2l2.4-10H17V4z" fill="currentColor"/>'
        : '<path d="M7.2 5.3A7.8 7.8 0 0 1 12 4c2.2 0 4 .7 5.4 1.8l-1.8 2A5.7 5.7 0 0 0 12 6.7c-1.6 0-2.6.6-2.6 1.5 0 .8.7 1.2 3.5 1.8H19v2H5v-2h3c-1-.5-1.6-1.3-1.6-2.4 0-.9.3-1.7.8-2.3M5 14h3c.4 1.8 1.8 2.8 4.2 2.8 1.8 0 2.8-.6 2.8-1.6 0-.5-.2-.9-.7-1.2h3.5c.2.5.2.9.2 1.4 0 2.6-2.2 4.3-5.9 4.3-4 0-6.5-2-7.1-5.7" fill="currentColor"/>';
  return iconSvg(content);
}

function valueFormatIcon(
  name: 'currency' | 'percent' | 'decimal-decrease' | 'decimal-increase'
): string {
  const content =
    name === 'currency'
      ? '<path d="M13 3v2.1c2.5.3 4 1.8 4.2 4h-2.8c-.2-1.1-1-1.7-2.4-1.7-1.3 0-2.1.5-2.1 1.3 0 .7.6 1.1 2.8 1.6 3.4.8 4.8 2 4.8 4.5 0 2.4-1.7 4-4.5 4.3V21h-2v-1.9c-2.9-.3-4.6-1.9-4.8-4.4H9c.2 1.4 1.2 2.1 3 2.1 1.5 0 2.5-.6 2.5-1.5 0-.8-.6-1.2-2.9-1.8-3.2-.7-4.6-2-4.6-4.4 0-2.2 1.5-3.6 4-4V3z" fill="currentColor"/>'
      : name === 'percent'
        ? '<path d="M7.5 4A3.5 3.5 0 1 1 4 7.5 3.5 3.5 0 0 1 7.5 4m9 9a3.5 3.5 0 1 1-3.5 3.5 3.5 3.5 0 0 1 3.5-3.5M17.8 4 6.2 20 4 18.4 15.6 2.5zM7.5 6.4a1.1 1.1 0 1 0 0 2.2 1.1 1.1 0 0 0 0-2.2m9 9a1.1 1.1 0 1 0 0 2.2 1.1 1.1 0 0 0 0-2.2" fill="currentColor"/>'
        : name === 'decimal-decrease'
          ? '<path d="M3 7h2v2H3zm4 0h2v2H7zm4 0h2v2h-2zm5-3 5 4-5 4V9h-2V7h2zM4 15h2v5H4zm5 0h2v5H9zm5 0h2v5h-2z" fill="currentColor"/>'
          : '<path d="M3 7h2v2H3zm4 0h2v2H7zm4 0h2v2h-2zM8 4 3 8l5 4V9h2V7H8zM4 15h2v5H4zm5 0h2v5H9zm5 0h2v5h-2z" fill="currentColor"/>';
  return iconSvg(content);
}

function valueFormatKindIcon(kind: SheetValueFormatKind): string {
  if (kind === 'currency') return valueFormatIcon('currency');
  if (kind === 'percent') return valueFormatIcon('percent');
  const content =
    kind === 'automatic'
      ? '<path d="m12 3 8 18h-3.3l-1.8-4.3H9.1L7.3 21H4L12 3m0 6-1.8 5h3.6z" fill="currentColor"/>'
      : kind === 'number'
        ? '<path d="M4 6h3V4h2v2h4V4h2v2h3v2h-3v5h3v2h-3v3h-2v-3H9v3H7v-3H4v-2h3V8H4zm5 2v5h4V8z" fill="currentColor"/>'
        : kind === 'date'
          ? '<path d="M5 3h2v2h10V3h2v2h2v16H3V5h2zm14 7H5v9h14zM7 12h3v2H7zm5 0h3v2h-3z" fill="currentColor"/>'
          : kind === 'time'
            ? '<path d="M12 3a9 9 0 1 1-9 9 9 9 0 0 1 9-9m0 2.5A6.5 6.5 0 1 0 18.5 12 6.5 6.5 0 0 0 12 5.5m-1 2h2v4l3 2-1.2 1.7L11 12.7z" fill="currentColor"/>'
            : '<path d="M4 4h2v2h8V4h2v2h2v7h-2V9H6v9h6v2H4zm11 9h2v3h3v2h-5z" fill="currentColor"/>';
  return iconSvg(content);
}

function valueFormatTriggerIcon(kind: SelectionState<SheetValueFormatKind>): string {
  if (kind === 'mixed') {
    return iconSvg('<path d="M4 5h16v3H4zm0 6h10v3H4zm0 6h16v3H4z" fill="currentColor"/>');
  }
  return valueFormatKindIcon(kind);
}

function alignmentIcon(axis: SheetAlignmentAxis, value: SheetAlignmentValue | 'mixed'): string {
  if (value === 'mixed') {
    return iconSvg(
      axis === 'horizontal'
        ? '<path d="M4 5h10v2H4zm6 5h10v2H10zm-6 5h13v2H4z" fill="currentColor"/>'
        : '<path d="M5 4h2v10H5zm5 6h2v10h-2zm5-4h2v11h-2z" fill="currentColor"/>'
    );
  }
  if (axis === 'horizontal') {
    const starts = value === 'left' ? [4, 4, 4] : value === 'right' ? [8, 4, 8] : [6, 4, 6];
    return iconSvg(
      `<path d="M${starts[0]} 5h12v2H${starts[0]}zM${starts[1]} 10h16v2H${starts[1]}zM${starts[2]} 15h12v2H${starts[2]}z" fill="currentColor"/>`
    );
  }
  const rows = value === 'top' ? [4, 8, 12] : value === 'bottom' ? [12, 16, 20] : [8, 12, 16];
  return iconSvg(
    `<path d="M4 ${rows[0]}h16v2H4zM6 ${rows[1]}h12v2H6zM4 ${rows[2]}h16v2H4z" fill="currentColor"/>`
  );
}

function chevronIcon(): string {
  return '<svg class="sheet-editor__toolbar-chevron" viewBox="0 0 8 8" width="8" height="8" aria-hidden="true" focusable="false"><path d="m1 2 3 3 3-3z" fill="currentColor"/></svg>';
}

function iconSvg(content: string): string {
  return `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">${content}</svg>`;
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

function readClipboardText(clipboardData: DataTransfer | null): string | null {
  if (!clipboardData || typeof clipboardData.getData !== 'function') return null;
  const types = Array.from(clipboardData.types ?? []);
  const preferredTypes = ['text/tab-separated-values', 'text/plain'];
  const type = preferredTypes
    .map((preferred) => types.find((candidate) => candidate.toLowerCase() === preferred))
    .find((candidate): candidate is string => candidate !== undefined);
  if (!type) return null;
  try {
    return clipboardData.getData(type);
  } catch {
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
