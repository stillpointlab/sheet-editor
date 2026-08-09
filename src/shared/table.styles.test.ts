import { afterEach, describe, expect, it } from 'vitest';

import { tableStyles } from './table.styles';

describe('shared table styles', () => {
  afterEach(() => {
    document.head.querySelector('[data-sheet-style-test]')?.remove();
    document.body.replaceChildren();
  });

  it('inherits the host theme tokens with standalone light and dark fallbacks', () => {
    for (const token of [
      '--spl-text-primary',
      '--spl-text-muted',
      '--spl-background-primary',
      '--spl-header-bg',
      '--spl-border-light',
      '--spl-primary-blue',
      '--spl-error-color',
    ]) {
      expect(tableStyles).toContain(token);
    }
    expect(tableStyles).not.toContain('--color-');
  });

  it('reserves the sticky addressed gutters as scroll padding', () => {
    expect(tableStyles).toContain('scroll-padding-block-start');
    expect(tableStyles).toContain('scroll-padding-inline-start');
    expect(tableStyles).toContain('--spl-sheet-row-gutter-width');
  });

  it('keeps the editor toolbar above the independently scrolling grid', () => {
    expect(tableStyles).toContain('.sheet-surface--editor');
    expect(tableStyles).toContain('grid-template-rows:auto minmax(0, 1fr) auto');
    expect(tableStyles).toContain('.sheet-editor__toolbar');
    expect(tableStyles).toContain('overflow-x:auto');
    expect(tableStyles).toContain('.sheet-editor__toolbar-button--delete');
    expect(tableStyles).toContain('--spl-sheet-danger');
    expect(tableStyles).toContain('.sheet-editor__toolbar-shell');
    expect(tableStyles).toContain('.sheet-editor__alignment-menu');
    expect(tableStyles).toContain('position:absolute');
    expect(tableStyles).toContain('[aria-pressed=mixed]');
  });

  it('lets presentation classes override the default table-cell styles', () => {
    const style = document.createElement('style');
    style.dataset.sheetStyleTest = '';
    style.textContent = tableStyles;
    document.head.append(style);

    const table = document.createElement('table');
    table.className = 'sheet-table';
    const row = document.createElement('tr');
    const header = document.createElement('th');
    header.className = [
      'sheet-table__cell--bold',
      'sheet-table__cell--align-center',
      'sheet-table__cell--align-top',
    ].join(' ');
    const data = document.createElement('td');
    data.className = ['sheet-table__cell--align-right', 'sheet-table__cell--align-bottom'].join(
      ' '
    );
    row.append(header, data);
    table.append(row);
    document.body.append(table);

    expect(getComputedStyle(header).fontWeight).toBe('700');
    expect(getComputedStyle(header).textAlign).toBe('center');
    expect(getComputedStyle(header).verticalAlign).toBe('top');
    expect(getComputedStyle(data).textAlign).toBe('right');
    expect(getComputedStyle(data).verticalAlign).toBe('bottom');
  });
});
