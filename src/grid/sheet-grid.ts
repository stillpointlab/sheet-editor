/// <reference lib="dom" />

import { parseCsv, type CsvParseResult } from '../csv';
import {
  resolveSheetPresentation,
  snapshotSheetPresentation,
  type SheetContentOptions,
  type SheetPresentation,
} from '../presentation/presentation';
import { modelFromRows, snapshotSuccessfulModel } from '../shared/model';
import { renderTable } from '../shared/render';

import type { ParsedSheetDocument } from '../document';

export interface SheetGridDataOptions extends SheetContentOptions {
  headerRow?: boolean;
}

export class SheetGrid extends HTMLElement {
  private readonly root: ShadowRoot;
  private model: CsvParseResult = parseCsv('');
  private headerRowOverride: boolean | undefined;
  private presentation: SheetPresentation = {};

  static get observedAttributes(): string[] {
    return ['header-row'];
  }

  constructor() {
    super();
    this.root = this.attachShadow({ mode: 'open' });
  }

  connectedCallback(): void {
    this.render();
  }

  attributeChangedCallback(_name: string, oldValue: string | null, newValue: string | null): void {
    if (oldValue === newValue || !this.isConnected) return;
    this.render();
  }

  setContent(content: string, options: SheetContentOptions = {}): void {
    this.headerRowOverride = undefined;
    this.model = parseCsv(content);
    this.presentation = snapshotSheetPresentation(options.presentation);
    if (this.isConnected) this.render();
  }

  setData(rows: readonly (readonly string[])[], options: SheetGridDataOptions = {}): void {
    this.headerRowOverride =
      options.headerRow === undefined ? undefined : Boolean(options.headerRow);
    this.model = modelFromRows(rows);
    this.presentation = snapshotSheetPresentation(options.presentation);
    if (this.isConnected) this.render();
  }

  setDocument(document: ParsedSheetDocument, options: SheetGridDataOptions = {}): void {
    this.headerRowOverride =
      options.headerRow === undefined ? undefined : Boolean(options.headerRow);
    this.model = snapshotSuccessfulModel(document.data);
    this.presentation = resolveSheetPresentation(document.presentation, options.presentation);
    if (this.isConnected) this.render();
  }

  private render(): void {
    renderTable(this.root, this.model, {
      addressed: false,
      headerRow: this.headerRowOverride ?? this.hasAttribute('header-row'),
      label: 'Data grid',
      emptyMessage: 'No grid data.',
      presentation: this.presentation,
    });
  }
}

if (!customElements.get('sheet-grid')) {
  customElements.define('sheet-grid', SheetGrid);
}
