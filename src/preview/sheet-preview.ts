/// <reference lib="dom" />

import { parseCsv, type CsvParseResult } from '../csv';
import {
  snapshotSheetPresentation,
  type SheetContentOptions,
  type SheetPresentation,
} from '../presentation/presentation';
import { renderTable } from '../shared/render';

export class SheetPreview extends HTMLElement {
  private readonly root: ShadowRoot;
  private model: CsvParseResult = parseCsv('');
  private presentation: SheetPresentation = {};

  constructor() {
    super();
    this.root = this.attachShadow({ mode: 'open' });
  }

  connectedCallback(): void {
    this.render();
  }

  setContent(content: string, options: SheetContentOptions = {}): void {
    this.model = parseCsv(content);
    this.presentation = snapshotSheetPresentation(options.presentation);
    if (this.isConnected) this.render();
  }

  private render(): void {
    renderTable(this.root, this.model, {
      addressed: true,
      headerRow: false,
      label: 'Spreadsheet preview',
      emptyMessage: 'No sheet data.',
      presentation: this.presentation,
    });
  }
}

if (!customElements.get('sheet-preview')) {
  customElements.define('sheet-preview', SheetPreview);
}
