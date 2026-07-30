import { beforeAll, describe, expect, it } from 'vitest';

import { SheetGrid } from './sheet-grid';

describe('sheet-grid', () => {
  beforeAll(() => {
    expect(customElements.get('sheet-grid')).toBe(SheetGrid);
  });

  const create = (): SheetGrid => document.createElement('sheet-grid') as SheetGrid;

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
});
