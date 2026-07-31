/// <reference lib="dom" />

import { parseCsv, type CsvParseResult } from '../csv';
import { modelFromRows } from '../shared/model';
import { renderTable } from '../shared/render';

export interface SheetGridDataOptions {
  headerRow?: boolean;
}

export class SheetGrid extends HTMLElement {
  private readonly root: ShadowRoot;
  private model: CsvParseResult = parseCsv('');
  private headerRowOverride: boolean | undefined;

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

  setContent(content: string): void {
    this.headerRowOverride = undefined;
    this.model = parseCsv(content);
    if (this.isConnected) this.render();
  }

  setData(rows: readonly (readonly string[])[], options: SheetGridDataOptions = {}): void {
    this.headerRowOverride =
      options.headerRow === undefined ? undefined : Boolean(options.headerRow);
    this.model = modelFromRows(rows);
    if (this.isConnected) this.render();
  }

  private render(): void {
    renderTable(this.root, this.model, {
      addressed: false,
      headerRow: this.headerRowOverride ?? this.hasAttribute('header-row'),
      label: 'Data grid',
      emptyMessage: 'No grid data.',
    });
  }
}

if (!customElements.get('sheet-grid')) {
  customElements.define('sheet-grid', SheetGrid);
}
