import { beforeAll, describe, expect, it } from 'vitest';

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
});
