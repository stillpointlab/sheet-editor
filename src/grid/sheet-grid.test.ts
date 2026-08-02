import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { parseSheetDocument } from '../document';
import { setErrorHandler } from '../log';

import { SheetGrid } from './sheet-grid';

describe('sheet-grid', () => {
  beforeAll(() => {
    expect(customElements.get('sheet-grid')).toBe(SheetGrid);
  });

  const create = (): SheetGrid => document.createElement('sheet-grid') as SheetGrid;

  afterEach(() => setErrorHandler(null));

  it('renders CSV as a semantic gutterless table and pads ragged rows', () => {
    const element = create();
    element.setContent('a,b\nc');
    document.body.append(element);

    expect(element.shadowRoot?.querySelector('table')).not.toBeNull();
    expect(element.shadowRoot?.querySelector('thead')).toBeNull();
    expect(element.shadowRoot?.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(element.shadowRoot?.querySelectorAll('tbody td')).toHaveLength(4);
    expect(element.shadowRoot?.querySelectorAll('tbody tr')[1]?.textContent).toBe('c');
  });

  it('promotes the first row when header-row is present', () => {
    const element = create();
    element.setAttribute('header-row', '');
    element.setContent('Name,Value\nCoffee,12');
    document.body.append(element);

    const headers = [...(element.shadowRoot?.querySelectorAll('thead th') ?? [])];
    expect(headers.map((header) => header.textContent)).toEqual(['Name', 'Value']);
    expect(headers.every((header) => header.getAttribute('scope') === 'col')).toBe(true);
    expect(element.shadowRoot?.querySelectorAll('tbody tr')).toHaveLength(1);
  });

  it('gives an explicit setData option precedence without mutating the attribute', () => {
    const attributeTrue = create();
    attributeTrue.setAttribute('header-row', '');
    attributeTrue.setData([['Header'], ['Value']], { headerRow: false });
    document.body.append(attributeTrue);
    expect(attributeTrue.shadowRoot?.querySelector('thead')).toBeNull();
    expect(attributeTrue.hasAttribute('header-row')).toBe(true);

    const attributeFalse = create();
    attributeFalse.setData([['Header'], ['Value']], { headerRow: true });
    document.body.append(attributeFalse);
    expect(attributeFalse.shadowRoot?.querySelector('thead th')?.textContent).toBe('Header');
    expect(attributeFalse.hasAttribute('header-row')).toBe(false);

    attributeFalse.setContent('Not a header\nValue');
    expect(attributeFalse.shadowRoot?.querySelector('thead')).toBeNull();
  });

  it('accepts structured values without a CSV serialize/reparse hop', () => {
    const element = create();
    element.setData([['Coffee, beans', 'line 1\nline 2']]);
    document.body.append(element);

    const cells = [...(element.shadowRoot?.querySelectorAll('td') ?? [])];
    expect(cells.map((cell) => cell.textContent)).toEqual(['Coffee, beans', 'line 1\nline 2']);
  });

  it('renders cell values as text rather than HTML', () => {
    const element = create();
    element.setData([['<img src=x onerror=alert(1)>']]);
    document.body.append(element);

    expect(element.shadowRoot?.querySelector('img')).toBeNull();
    expect(element.shadowRoot?.querySelector('td')?.textContent).toBe(
      '<img src=x onerror=alert(1)>'
    );
  });

  it('truncates excess rows with an accurate accessible notice', () => {
    const rows = Array.from({ length: 1001 }, (_, index) => [String(index)]);
    const element = create();
    element.setData(rows);
    document.body.append(element);

    expect(element.shadowRoot?.querySelectorAll('tbody tr')).toHaveLength(1000);
    expect(element.shadowRoot?.querySelector('[role="status"]')?.textContent).toBe(
      'Showing first 1,000 of 1,001 rows.'
    );
    expect(
      element.shadowRoot?.querySelector('.sheet-surface__scroll')?.getAttribute('aria-describedby')
    ).toBe('sheet-truncation-notice');
  });

  it('hard-fails structured rows wider than the product limit', () => {
    const element = create();
    element.setData([Array.from({ length: 257 }, () => '')]);
    document.body.append(element);

    expect(element.shadowRoot?.querySelector('[role="alert"]')?.textContent).toContain(
      'exceeds 256 columns'
    );
    expect(element.shadowRoot?.querySelector('table')).toBeNull();
  });

  it('renders a keyboard-reachable labelled scroll region', () => {
    const element = create();
    element.setData([['value']]);
    document.body.append(element);

    const scroll = element.shadowRoot?.querySelector('.sheet-surface__scroll');
    expect(scroll?.getAttribute('tabindex')).toBe('0');
    expect(scroll?.getAttribute('aria-label')).toBe('Data grid');
  });

  it('renders rectangular ranges with native spans and restores covered cells', () => {
    const element = create();
    element.setData(
      [
        ['anchor', ''],
        ['', ''],
      ],
      {
        presentation: {
          merges: [{ startRow: 0, endRow: 2, startColumn: 0, endColumn: 2 }],
        },
      }
    );
    document.body.append(element);

    const anchor = element.shadowRoot?.querySelector('td');
    expect(anchor?.rowSpan).toBe(2);
    expect(anchor?.colSpan).toBe(2);
    expect(anchor?.dataset).toMatchObject({ row: '0', column: '0' });
    expect(element.shadowRoot?.querySelectorAll('tbody td')).toHaveLength(1);

    element.setData([
      ['anchor', ''],
      ['', ''],
    ]);
    expect(element.shadowRoot?.querySelectorAll('tbody td')).toHaveLength(4);
  });

  it('uses colgroup semantics for a merged promoted header', () => {
    const element = create();
    element.setData(
      [
        ['Group', '', 'Other'],
        ['one', 'two', 'three'],
      ],
      {
        headerRow: true,
        presentation: {
          merges: [{ startRow: 0, endRow: 1, startColumn: 0, endColumn: 2 }],
        },
      }
    );
    document.body.append(element);

    const headers = [...(element.shadowRoot?.querySelectorAll('thead th') ?? [])];
    expect(headers).toHaveLength(2);
    expect(headers[0]?.getAttribute('scope')).toBe('colgroup');
    expect((headers[0] as HTMLTableCellElement).colSpan).toBe(2);
    expect(element.shadowRoot?.querySelectorAll('colgroup')).toHaveLength(2);
    expect(element.shadowRoot?.querySelectorAll('col')).toHaveLength(3);
  });

  it('falls back atomically, reports once, and composes accessible notices', () => {
    const report = vi.fn();
    setErrorHandler(report);
    const rows = Array.from({ length: 1001 }, (_, index) => [String(index), '']);
    const element = create();
    element.setData(rows, {
      presentation: {
        merges: [{ startRow: 999, endRow: 1001, startColumn: 0, endColumn: 1 }],
      },
    });
    document.body.append(element);

    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0]?.[1]).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'truncated_range' })])
    );
    expect(element.shadowRoot?.querySelectorAll('tbody td')).toHaveLength(2000);
    expect(element.shadowRoot?.querySelectorAll('[role="status"]')).toHaveLength(2);
    expect(
      element.shadowRoot?.querySelector('.sheet-surface__scroll')?.getAttribute('aria-describedby')
    ).toBe('sheet-truncation-notice sheet-presentation-notice');
  });

  it('snapshots presentation input and validates against resolved header precedence', () => {
    const range = { startRow: 0, endRow: 1, startColumn: 0, endColumn: 2 };
    const element = create();
    element.setAttribute('header-row', '');
    element.setData(
      [
        ['Header', ''],
        ['Value', ''],
      ],
      { headerRow: false, presentation: { merges: [range] } }
    );
    range.endColumn = 1;
    document.body.append(element);

    expect(element.shadowRoot?.querySelector('thead')).toBeNull();
    expect(element.shadowRoot?.querySelector('td')?.colSpan).toBe(2);
  });

  it('inherits, suppresses, and replaces embedded document merges', () => {
    const parsed = parseSheetDocument(
      [
        '---',
        'sheet: stillpoint/v1',
        'presentation:',
        '  merges:',
        '    - range: A1:B1',
        '---',
        'anchor,',
        ',',
        ',',
      ].join('\n')
    );
    if (!parsed.ok) throw new Error('expected document parse to succeed');
    const element = create();
    document.body.append(element);

    element.setDocument(parsed.document);
    expect(element.shadowRoot?.querySelector('td')?.colSpan).toBe(2);

    element.setDocument(parsed.document, { presentation: null });
    expect(element.shadowRoot?.querySelectorAll('td')).toHaveLength(6);

    element.setDocument(parsed.document, { presentation: {} });
    expect(element.shadowRoot?.querySelector('td')?.colSpan).toBe(2);

    element.setDocument(parsed.document, { presentation: { merges: undefined } });
    expect(element.shadowRoot?.querySelector('td')?.colSpan).toBe(2);

    element.setDocument(parsed.document, { presentation: { merges: [] } });
    expect(element.shadowRoot?.querySelectorAll('td')).toHaveLength(6);

    element.setDocument(parsed.document, {
      presentation: {
        merges: [{ startRow: 0, endRow: 2, startColumn: 0, endColumn: 1 }],
      },
    });
    expect(element.shadowRoot?.querySelector('td')?.rowSpan).toBe(2);
    expect(element.shadowRoot?.querySelector('td')?.colSpan).toBe(1);

    element.setContent('plain,again');
    expect(element.shadowRoot?.querySelectorAll('td')).toHaveLength(2);
  });

  it('snapshots parsed document data and presentation before rendering', () => {
    const parsed = parseSheetDocument(
      '---\nsheet: stillpoint/v1\npresentation:\n  merges:\n    - range: A1:B1\n---\nanchor,'
    );
    if (!parsed.ok) throw new Error('expected document parse to succeed');
    const element = create();
    element.setDocument(parsed.document);
    parsed.document.data.rows[0][0] = 'mutated';
    parsed.document.presentation.merges[0].endColumn = 1;
    document.body.append(element);

    const anchor = element.shadowRoot?.querySelector<HTMLTableCellElement>('td');
    expect(anchor?.textContent).toBe('anchor');
    expect(anchor?.colSpan).toBe(2);
  });
});
