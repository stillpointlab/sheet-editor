import { afterEach, describe, expect, it, vi } from 'vitest';

import { parseSheetDocument } from '../document';

import { SheetEditor } from './sheet-editor';

import type { SheetContentOptions } from '../presentation';

describe('sheet-editor value formatting', () => {
  afterEach(() => document.body.replaceChildren());

  it('renders formatted navigation text while editing the exact raw value', () => {
    const element = createDocument(
      documentSource(
        '1234.5,2026-08-10T14:05:06',
        [
          '  valueFormats:',
          '    - range: A1',
          '      kind: currency',
          '      currency: USD',
          '      decimalPlaces: 2',
          '    - range: B1',
          '      kind: datetime',
        ].join('\n')
      )
    );

    expect(cellText(element, 0, 0)).toBe('$1,234.50');
    expect(cellText(element, 0, 1)).toBe('8/10/2026 2:05:06 PM');

    activeCell(element).dispatchEvent(key('Enter'));
    expect(editControl(element).value).toBe('1234.5');
    editControl(element).dispatchEvent(key('Escape'));
    expect(cellText(element, 0, 0)).toBe('$1,234.50');
    expect(element.getContent()).toContain('1234.5,2026-08-10T14:05:06');
  });

  it('applies Currency and Percent as direct setters and repeats as a no-op', () => {
    const element = createDocument(sheet('1234.5,0.125'));
    const changed = vi.fn();
    element.addEventListener('content-change', changed);
    activeCell(element).dispatchEvent(key('ArrowRight', { shiftKey: true }));

    valueButton(element, 'value-currency').click();

    expect(changed).toHaveBeenCalledTimes(1);
    expect(presentation(element).valueFormats).toEqual([
      {
        range: { startRow: 0, endRow: 1, startColumn: 0, endColumn: 2 },
        kind: 'currency',
        currency: 'USD',
        decimalPlaces: 2,
      },
    ]);
    expect(cellText(element, 0, 0)).toBe('$1,234.50');
    expect(cellText(element, 0, 1)).toBe('$0.13');
    expect(valueButton(element, 'value-currency').hasAttribute('aria-pressed')).toBe(false);

    valueButton(element, 'value-currency').click();
    expect(changed).toHaveBeenCalledTimes(1);

    valueButton(element, 'value-percent').click();
    expect(changed).toHaveBeenCalledTimes(2);
    expect(presentation(element).valueFormats).toEqual([
      {
        range: { startRow: 0, endRow: 1, startColumn: 0, endColumn: 2 },
        kind: 'percent',
        decimalPlaces: 2,
      },
    ]);
    expect(cellText(element, 0, 1)).toBe('12.50%');
  });

  it('reports mixed state, homogenizes menu choices, and clears back to Automatic', () => {
    const element = createDocument(
      documentSource(
        '1.2,3.4',
        [
          '  valueFormats:',
          '    - range: A1',
          '      kind: number',
          '      decimalPlaces: 1',
          '    - range: B1',
          '      kind: number',
          '      decimalPlaces: 3',
        ].join('\n')
      )
    );
    const changed = vi.fn();
    element.addEventListener('content-change', changed);
    activeCell(element).dispatchEvent(key('ArrowRight', { shiftKey: true }));

    expect(valueTrigger(element).getAttribute('aria-label')).toBe(
      'Value format: Number, mixed decimal places'
    );
    valueTrigger(element).click();
    expect(valueItem(element, 'number').getAttribute('aria-checked')).toBe('true');
    valueItem(element, 'currency').click();

    expect(changed).toHaveBeenCalledTimes(1);
    expect(valueTrigger(element).getAttribute('aria-label')).toBe(
      'Value format: Currency USD, 2 decimal places'
    );
    expect(element.shadowRoot?.activeElement).toBe(valueTrigger(element));
    expect(presentation(element).valueFormats).toEqual([
      {
        range: { startRow: 0, endRow: 1, startColumn: 0, endColumn: 2 },
        kind: 'currency',
        currency: 'USD',
        decimalPlaces: 2,
      },
    ]);

    valueTrigger(element).click();
    valueItem(element, 'automatic').click();
    expect(changed).toHaveBeenCalledTimes(2);
    expect(presentation(element).valueFormats).toBeUndefined();
    expect(cellText(element, 0, 0)).toBe('1.2');
    expect(cellText(element, 0, 1)).toBe('3.4');
    expect(valueTrigger(element).getAttribute('aria-label')).toBe('Value format: Automatic');
  });

  it('adjusts each numeric descriptor independently and infers Automatic precision', () => {
    const element = createDocument(
      documentSource(
        '12.34,0.125,1.2',
        [
          '  valueFormats:',
          '    - range: A1',
          '      kind: currency',
          '      currency: CAD',
          '      decimalPlaces: 2',
          '    - range: B1',
          '      kind: percent',
          '      decimalPlaces: 1',
        ].join('\n')
      )
    );
    activeCell(element).dispatchEvent(key('ArrowRight', { shiftKey: true }));
    activeCell(element).dispatchEvent(key('ArrowRight', { shiftKey: true }));

    valueButton(element, 'decimal-decrease').click();

    expect(presentation(element).valueFormats).toEqual([
      {
        range: { startRow: 0, endRow: 1, startColumn: 0, endColumn: 1 },
        kind: 'currency',
        currency: 'CAD',
        decimalPlaces: 1,
      },
      {
        range: { startRow: 0, endRow: 1, startColumn: 1, endColumn: 2 },
        kind: 'percent',
        decimalPlaces: 0,
      },
      {
        range: { startRow: 0, endRow: 1, startColumn: 2, endColumn: 3 },
        kind: 'number',
        decimalPlaces: 0,
      },
    ]);
    expect(cellText(element, 0, 0)).toBe('CA$12.3');
    expect(cellText(element, 0, 1)).toBe('13%');
    expect(cellText(element, 0, 2)).toBe('1');

    valueButton(element, 'decimal-increase').click();
    expect(presentation(element).valueFormats?.map((rule) => rule.kind)).toEqual([
      'currency',
      'percent',
      'number',
    ]);
    expect(
      presentation(element).valueFormats?.map((rule) =>
        'decimalPlaces' in rule ? rule.decimalPlaces : undefined
      )
    ).toEqual([2, 1, 1]);
  });

  it('makes Automatic incompatible text explicit on a successful decimal increase', () => {
    const element = createDocument(sheet('not numeric'));
    expect(valueButton(element, 'decimal-decrease').disabled).toBe(true);
    expect(valueButton(element, 'decimal-increase').disabled).toBe(false);

    valueButton(element, 'decimal-increase').click();

    expect(presentation(element).valueFormats).toEqual([
      {
        range: { startRow: 0, endRow: 1, startColumn: 0, endColumn: 1 },
        kind: 'number',
        decimalPlaces: 1,
      },
    ]);
    expect(cellText(element, 0, 0)).toBe('not numeric');
  });

  it('disables decimal actions at bounds and whenever any selected kind is temporal', () => {
    const lower = createDocument(
      documentSource(
        '1',
        ['  valueFormats:', '    - range: A1', '      kind: number', '      decimalPlaces: 0'].join(
          '\n'
        )
      )
    );
    expect(valueButton(lower, 'decimal-decrease').disabled).toBe(true);
    expect(valueButton(lower, 'decimal-increase').disabled).toBe(false);

    const upper = createDocument(
      documentSource(
        '1',
        [
          '  valueFormats:',
          '    - range: A1',
          '      kind: number',
          '      decimalPlaces: 10',
        ].join('\n')
      )
    );
    expect(valueButton(upper, 'decimal-decrease').disabled).toBe(false);
    expect(valueButton(upper, 'decimal-increase').disabled).toBe(true);

    const temporal = createDocument(
      documentSource(
        '2026-08-10,1.2',
        ['  valueFormats:', '    - range: A1', '      kind: date'].join('\n')
      )
    );
    activeCell(temporal).dispatchEvent(key('ArrowRight', { shiftKey: true }));
    expect(valueButton(temporal, 'decimal-decrease').disabled).toBe(true);
    expect(valueButton(temporal, 'decimal-increase').disabled).toBe(true);
  });

  it('supports value-menu keyboard navigation and enforces one open toolbar flyout', () => {
    const element = createDocument(sheet('1'));
    const trigger = valueTrigger(element);

    trigger.focus();
    trigger.dispatchEvent(key('ArrowDown'));
    expect(valueMenu(element).hidden).toBe(false);
    expect(element.shadowRoot?.activeElement).toBe(valueItem(element, 'automatic'));
    valueItem(element, 'automatic').dispatchEvent(key('ArrowDown'));
    expect(element.shadowRoot?.activeElement).toBe(valueItem(element, 'number'));
    valueItem(element, 'number').dispatchEvent(key('End'));
    expect(element.shadowRoot?.activeElement).toBe(valueItem(element, 'datetime'));
    valueItem(element, 'datetime').dispatchEvent(key('Home'));
    expect(element.shadowRoot?.activeElement).toBe(valueItem(element, 'automatic'));
    valueItem(element, 'automatic').dispatchEvent(key('Escape'));
    expect(valueMenu(element).hidden).toBe(true);
    expect(element.shadowRoot?.activeElement).toBe(trigger);

    trigger.click();
    alignmentTrigger(element).click();
    expect(valueMenu(element).hidden).toBe(true);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');

    trigger.click();
    document.body.dispatchEvent(
      new MouseEvent('pointerdown', { bubbles: true, cancelable: true, composed: true, button: 0 })
    );
    expect(valueMenu(element).hidden).toBe(true);

    trigger.dispatchEvent(key(' '));
    valueItem(element, 'date').dispatchEvent(key('Enter'));
    expect(presentation(element).valueFormats?.[0]?.kind).toBe('date');
    expect(element.shadowRoot?.activeElement).toBe(valueTrigger(element));
  });

  it('keeps value-format authoring scoped to owned, mutable document presentation', () => {
    const masked = createDocument(sheet('1'), { presentation: { valueFormats: [] } });
    expect(valueControls(masked).every((button) => button.disabled)).toBe(true);
    expect(alignmentTrigger(masked).disabled).toBe(false);

    const readonly = createDocument(sheet('1'));
    readonly.setAttribute('readonly', 'true');
    expect(valueControls(readonly)).toHaveLength(5);
    expect(valueControls(readonly).every((button) => button.disabled)).toBe(true);

    const csv = createCsv('1');
    expect(csv.shadowRoot?.querySelector('[data-sheet-value-format-trigger]')).toBeNull();
    expect(csv.shadowRoot?.querySelector('[data-sheet-value-format-menu]')).toBeNull();
  });

  it('targets complete merges and missing ragged fields without materializing values', () => {
    const merged = createDocument(
      [
        '---',
        'sheet: stillpoint/v1',
        'presentation:',
        '  merges:',
        '    - range: A1:B1',
        '---',
        '1,',
      ].join('\n')
    );
    valueTrigger(merged).click();
    valueItem(merged, 'number').click();
    expect(presentation(merged).valueFormats?.[0]?.range).toEqual({
      startRow: 0,
      endRow: 1,
      startColumn: 0,
      endColumn: 2,
    });

    const ragged = createDocument(sheet('1\n2,3'));
    activeCell(ragged).dispatchEvent(key('ArrowRight', { shiftKey: true }));
    valueButton(ragged, 'value-percent').click();
    expect(rows(ragged)).toEqual([['1'], ['2', '3']]);
    expect(presentation(ragged).valueFormats?.[0]?.range).toEqual({
      startRow: 0,
      endRow: 1,
      startColumn: 0,
      endColumn: 2,
    });
  });

  it('commits a raw draft first and undoes format and value as separate transactions', () => {
    const element = createDocument(sheet('1.2'));
    activeCell(element).dispatchEvent(key('Enter'));
    input(editControl(element), '12.345');

    valueButton(element, 'value-currency').click();
    expect(cellText(element, 0, 0)).toBe('$12.35');
    expect(rows(element)).toEqual([['12.345']]);

    activeCell(element).dispatchEvent(key('z', { ctrlKey: true }));
    expect(cellText(element, 0, 0)).toBe('12.345');
    expect(rows(element)).toEqual([['12.345']]);
    activeCell(element).dispatchEvent(key('z', { ctrlKey: true }));
    expect(rows(element)).toEqual([['1.2']]);
  });

  it('updates decimal availability from the raw draft that will be committed', () => {
    const element = createDocument(sheet('1.1234567890'));
    expect(valueButton(element, 'decimal-increase').disabled).toBe(true);

    activeCell(element).dispatchEvent(key('Enter'));
    input(editControl(element), '2');
    expect(valueButton(element, 'decimal-increase').disabled).toBe(false);
    valueButton(element, 'decimal-increase').click();

    expect(rows(element)).toEqual([['2']]);
    expect(presentation(element).valueFormats).toEqual([
      {
        range: { startRow: 0, endRow: 1, startColumn: 0, endColumn: 1 },
        kind: 'number',
        decimalPlaces: 1,
      },
    ]);
    expect(cellText(element, 0, 0)).toBe('2.0');
  });
});

function sheet(body: string): string {
  return `---\nsheet: stillpoint/v1\n---\n${body}`;
}

function documentSource(body: string, presentationLines: string): string {
  return `---\nsheet: stillpoint/v1\npresentation:\n${presentationLines}\n---\n${body}`;
}

function createDocument(source: string, options: SheetContentOptions = {}): SheetEditor {
  const element = new SheetEditor();
  element.setDocumentSource(source, options);
  document.body.append(element);
  return element;
}

function createCsv(source: string): SheetEditor {
  const element = new SheetEditor();
  element.setContent(source);
  document.body.append(element);
  return element;
}

function valueButton(element: SheetEditor, command: string): HTMLButtonElement {
  const button = element.shadowRoot?.querySelector<HTMLButtonElement>(
    `[data-sheet-toolbar-command="${command}"]`
  );
  if (!button) throw new Error(`expected ${command} button`);
  return button;
}

function valueControls(element: SheetEditor): HTMLButtonElement[] {
  return [
    ...(element.shadowRoot?.querySelectorAll<HTMLButtonElement>(
      '[data-sheet-value-format-action], [data-sheet-value-format-trigger]'
    ) ?? []),
  ];
}

function valueTrigger(element: SheetEditor): HTMLButtonElement {
  const button = element.shadowRoot?.querySelector<HTMLButtonElement>(
    '[data-sheet-value-format-trigger]'
  );
  if (!button) throw new Error('expected value format trigger');
  return button;
}

function valueMenu(element: SheetEditor): HTMLElement {
  const menu = element.shadowRoot?.querySelector<HTMLElement>('[data-sheet-value-format-menu]');
  if (!menu) throw new Error('expected value format menu');
  return menu;
}

function valueItem(element: SheetEditor, kind: string): HTMLButtonElement {
  const item = valueMenu(element).querySelector<HTMLButtonElement>(
    `[data-sheet-value-format-kind="${kind}"]`
  );
  if (!item) throw new Error(`expected ${kind} value format item`);
  return item;
}

function alignmentTrigger(element: SheetEditor): HTMLButtonElement {
  const trigger = element.shadowRoot?.querySelector<HTMLButtonElement>(
    '[data-sheet-alignment-trigger="horizontal"]'
  );
  if (!trigger) throw new Error('expected alignment trigger');
  return trigger;
}

function dataCell(element: SheetEditor, row: number, column: number): HTMLTableCellElement {
  const cell = element.shadowRoot?.querySelector<HTMLTableCellElement>(
    `td[data-row="${row}"][data-column="${column}"]`
  );
  if (!cell) throw new Error(`expected cell ${row}:${column}`);
  return cell;
}

function cellText(element: SheetEditor, row: number, column: number): string {
  return dataCell(element, row, column).textContent ?? '';
}

function activeCell(element: SheetEditor): HTMLTableCellElement {
  const cell = element.shadowRoot?.querySelector<HTMLTableCellElement>('td[tabindex="0"]');
  if (!cell) throw new Error('expected active cell');
  return cell;
}

function editControl(element: SheetEditor): HTMLTextAreaElement {
  const textarea = element.shadowRoot?.querySelector<HTMLTextAreaElement>('textarea');
  if (!textarea) throw new Error('expected textarea');
  return textarea;
}

function input(textarea: HTMLTextAreaElement, value: string): void {
  textarea.value = value;
  textarea.setSelectionRange(value.length, value.length);
  textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
}

function key(keyValue: string, init: KeyboardEventInit = {}): KeyboardEvent {
  return new KeyboardEvent('keydown', {
    bubbles: true,
    cancelable: true,
    key: keyValue,
    ...init,
  });
}

function parsed(element: SheetEditor) {
  const result = parseSheetDocument(element.getContent());
  if (!result.ok) throw new Error(result.error.message);
  return result.document;
}

function presentation(element: SheetEditor) {
  return parsed(element).presentation;
}

function rows(element: SheetEditor): string[][] {
  return parsed(element).data.rows;
}
