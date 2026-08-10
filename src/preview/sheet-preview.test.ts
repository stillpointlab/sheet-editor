import { beforeAll, describe, expect, it } from 'vitest';

import { parseSheetDocument } from '../document';

import { SheetPreview } from './sheet-preview';

describe('sheet-preview', () => {
  beforeAll(() => {
    expect(customElements.get('sheet-preview')).toBe(SheetPreview);
  });

  const create = (): SheetPreview => document.createElement('sheet-preview') as SheetPreview;

  it('renders A1 column letters through AA and row-number headers', () => {
    const source = Array.from({ length: 27 }, (_, index) => `value-${index}`).join(',');
    const element = create();
    element.setContent(source);
    document.body.append(element);

    const columnHeaders = [
      ...(element.shadowRoot?.querySelectorAll('.sheet-table__column-header') ?? []),
    ];
    expect(columnHeaders[0]?.textContent).toBe('A');
    expect(columnHeaders[25]?.textContent).toBe('Z');
    expect(columnHeaders[26]?.textContent).toBe('AA');

    const columns = element.shadowRoot?.querySelectorAll('colgroup col');
    expect(columns).toHaveLength(28);
    expect(columns?.[0]?.classList.contains('sheet-table__gutter-column')).toBe(true);
    expect(columns?.[1]?.classList.contains('sheet-table__data-column')).toBe(true);

    const rowHeader = element.shadowRoot?.querySelector('.sheet-table__row-header');
    expect(rowHeader?.textContent).toBe('1');
    expect(rowHeader?.getAttribute('scope')).toBe('row');
  });

  it('keeps CSV row 1 as data rather than inferring a header', () => {
    const element = create();
    element.setContent('Name,Value\nCoffee,12');
    document.body.append(element);

    expect(element.shadowRoot?.querySelectorAll('thead tr')).toHaveLength(1);
    expect(element.shadowRoot?.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(element.shadowRoot?.querySelector('tbody td')?.textContent).toBe('Name');
  });

  it('keeps YAML-looking leading CSV records as ordinary cells', () => {
    const element = create();
    element.setContent('---\nsheet: stillpoint/v1\n---');
    document.body.append(element);

    expect(element.shadowRoot?.querySelectorAll('tbody tr')).toHaveLength(3);
    expect(
      [...(element.shadowRoot?.querySelectorAll('tbody td') ?? [])].map((cell) => cell.textContent)
    ).toEqual(['---', 'sheet: stillpoint/v1', '---']);
  });

  it('shows a compact user-content error for malformed CSV', () => {
    const element = create();
    element.setContent('"unclosed');
    document.body.append(element);

    expect(element.shadowRoot?.querySelector('[role="alert"]')?.textContent).toContain(
      'Unclosed quoted field'
    );
    expect(element.shadowRoot?.querySelector('table')).toBeNull();
  });

  it('renders source values as text rather than HTML', () => {
    const element = create();
    element.setContent('<script>alert(1)</script>');
    document.body.append(element);

    expect(element.shadowRoot?.querySelector('script')).toBeNull();
    expect(element.shadowRoot?.querySelector('td')?.textContent).toBe('<script>alert(1)</script>');
  });

  it('renders an accessible empty state', () => {
    const element = create();
    element.setContent('');
    document.body.append(element);

    expect(element.shadowRoot?.textContent).toContain('No sheet data.');
    expect(element.shadowRoot?.querySelector('table')).toBeNull();
  });

  it('truncates long input by complete rows', () => {
    const source = Array.from({ length: 1001 }, (_, index) => String(index)).join('\n');
    const element = create();
    element.setContent(source);
    document.body.append(element);

    expect(element.shadowRoot?.querySelectorAll('tbody tr')).toHaveLength(1000);
    expect(element.shadowRoot?.querySelector('[role="status"]')?.textContent).toBe(
      'Showing first 1,000 of 1,001 rows.'
    );
  });

  it('renders vertical merges without removing addressed gutters', () => {
    const element = create();
    element.setContent('anchor,\n,', {
      presentation: {
        merges: [{ startRow: 0, endRow: 2, startColumn: 0, endColumn: 1 }],
      },
    });
    document.body.append(element);

    const anchor = element.shadowRoot?.querySelector<HTMLTableCellElement>('tbody td');
    expect(anchor?.rowSpan).toBe(2);
    expect(element.shadowRoot?.querySelectorAll('.sheet-table__row-header')).toHaveLength(2);
    expect(element.shadowRoot?.querySelectorAll('.sheet-table__column-header')).toHaveLength(2);
    expect(element.shadowRoot?.querySelectorAll('tbody td')).toHaveLength(3);
  });

  it('inherits, suppresses, and replaces document presentation', () => {
    const parsed = parseSheetDocument(
      '---\nsheet: stillpoint/v1\npresentation:\n  merges:\n    - range: A1:B1\n---\nanchor,\n,'
    );
    if (!parsed.ok) throw new Error('expected document parse to succeed');
    const element = create();
    document.body.append(element);

    element.setDocument(parsed.document);
    expect(element.shadowRoot?.querySelector<HTMLTableCellElement>('tbody td')?.colSpan).toBe(2);

    element.setDocument(parsed.document, { presentation: null });
    expect(element.shadowRoot?.querySelectorAll('tbody td')).toHaveLength(4);

    element.setDocument(parsed.document, {
      presentation: {
        merges: [{ startRow: 0, endRow: 2, startColumn: 0, endColumn: 1 }],
      },
    });
    expect(element.shadowRoot?.querySelector<HTMLTableCellElement>('tbody td')?.rowSpan).toBe(2);
  });

  it('uses embedded and call-site value formats without changing document values', () => {
    const parsed = parseSheetDocument(
      [
        '---',
        'sheet: stillpoint/v1',
        'presentation:',
        '  valueFormats:',
        '    - range: A1',
        '      kind: datetime',
        '---',
        '2026-08-10T14:05:06',
      ].join('\n')
    );
    if (!parsed.ok) throw new Error('expected document parse to succeed');
    const element = create();
    document.body.append(element);

    element.setDocument(parsed.document);
    expect(element.shadowRoot?.querySelector('tbody td')?.textContent).toBe('8/10/2026 2:05:06 PM');

    element.setDocument(parsed.document, { presentation: { valueFormats: [] } });
    expect(element.shadowRoot?.querySelector('tbody td')?.textContent).toBe('2026-08-10T14:05:06');
    expect(parsed.document.data.rows).toEqual([['2026-08-10T14:05:06']]);
  });
});
