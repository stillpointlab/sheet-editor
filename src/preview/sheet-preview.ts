/// <reference lib="dom" />

import { parseCsv, type CsvParseResult } from '../csv';
import { renderTable } from '../shared/render';

export class SheetPreview extends HTMLElement {
  private readonly root: ShadowRoot;
  private model: CsvParseResult = parseCsv('');

  constructor() {
    super();
    this.root = this.attachShadow({ mode: 'open' });
  }

  connectedCallback(): void {
    this.render();
  }

  setContent(content: string): void {
    this.model = parseCsv(content);
    if (this.isConnected) this.render();
  }

  private render(): void {
    renderTable(this.root, this.model, {
      addressed: true,
      headerRow: false,
      label: 'Spreadsheet preview',
      emptyMessage: 'No sheet data.',
    });
  }
}

if (!customElements.get('sheet-preview')) {
  customElements.define('sheet-preview', SheetPreview);
}
