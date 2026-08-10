import { describe, expect, it } from 'vitest';

import {
  createSheetValueFormatIndex,
  formatSheetCellValue,
  inferAutomaticDecimalPlaces,
  isCompatibleNumericValue,
  type EffectiveSheetValueFormat,
} from './value-format';

const number = (decimalPlaces: number): EffectiveSheetValueFormat => ({
  kind: 'number',
  decimalPlaces,
});

describe('sheet value formatting', () => {
  it('indexes normalized range rules and defaults to automatic', () => {
    const index = createSheetValueFormatIndex({
      valueFormats: [
        {
          range: { startRow: 0, endRow: 2, startColumn: 1, endColumn: 3 },
          kind: 'currency',
          currency: 'USD',
          decimalPlaces: 2,
        },
      ],
    });

    expect(index.formatAt(0, 0)).toEqual({ kind: 'automatic' });
    expect(index.formatAt(1, 2)).toEqual({
      kind: 'currency',
      currency: 'USD',
      decimalPlaces: 2,
    });
    expect(() => index.formatAt(-1, 0)).toThrow(RangeError);
  });

  it.each([
    ['1234.5', number(2), '1,234.50'],
    ['12', number(3), '12.000'],
    ['1.005', number(2), '1.01'],
    ['-0.004', number(2), '-0.00'],
    ['1234.5', { kind: 'currency', currency: 'USD', decimalPlaces: 2 } as const, '$1,234.50'],
    ['0.125', { kind: 'percent', decimalPlaces: 2 } as const, '12.50%'],
    ['12', { kind: 'percent', decimalPlaces: 2 } as const, '1,200.00%'],
  ])('renders compatible numeric input %#', (raw, format, expected) => {
    expect(formatSheetCellValue(raw, format)).toBe(expected);
  });

  it.each([
    '',
    '0012',
    '1,234.5',
    '$12',
    '12%',
    ' 12',
    '.5',
    '1.',
    '9007199254740993',
    '1e999',
    '1e-999',
    '=A1+1',
    '<img src=x onerror=alert(1)>',
  ])('preserves incompatible numeric text %j', (raw) => {
    expect(formatSheetCellValue(raw, number(2))).toBe(raw);
  });

  it('infers bounded automatic decimal places after expanding exponents', () => {
    expect(inferAutomaticDecimalPlaces('12')).toBe(0);
    expect(inferAutomaticDecimalPlaces('12.3400')).toBe(4);
    expect(inferAutomaticDecimalPlaces('1.2e3')).toBe(0);
    expect(inferAutomaticDecimalPlaces('1e-3')).toBe(3);
    expect(inferAutomaticDecimalPlaces('1e-99')).toBe(10);
    expect(inferAutomaticDecimalPlaces('not a number')).toBe(0);
    expect(isCompatibleNumericValue('123456789012345')).toBe(true);
    expect(isCompatibleNumericValue('1234567890123456')).toBe(false);
  });

  it.each([
    ['2026-08-10', { kind: 'date' } as const, '8/10/2026'],
    ['14:05', { kind: 'time' } as const, '2:05:00 PM'],
    ['2026-08-10T14:05:06', { kind: 'datetime' } as const, '8/10/2026 2:05:06 PM'],
    ['2026-08-10 00:00', { kind: 'time' } as const, '12:00:00 AM'],
    ['2026-08-10', { kind: 'time' } as const, '12:00:00 AM'],
    ['2026-08-10', { kind: 'datetime' } as const, '8/10/2026 12:00:00 AM'],
    ['2.625', { kind: 'datetime' } as const, '1/1/1900 3:00:00 PM'],
    ['0', { kind: 'date' } as const, '12/30/1899'],
    ['60', { kind: 'date' } as const, '2/28/1900'],
    ['-0.25', { kind: 'datetime' } as const, '12/29/1899 6:00:00 PM'],
    ['2024-02-29', { kind: 'date' } as const, '2/29/2024'],
    ['2026-12-31T23:59:59.5', { kind: 'datetime' } as const, '1/1/2027 12:00:00 AM'],
  ])('renders compatible temporal input %#', (raw, format, expected) => {
    expect(formatSheetCellValue(raw, format)).toBe(expected);
  });

  it.each([
    ['2026-02-29', { kind: 'date' } as const],
    ['0000-01-01', { kind: 'date' } as const],
    ['10000-01-01', { kind: 'date' } as const],
    ['2/3/2026', { kind: 'date' } as const],
    ['2026-01-01Z', { kind: 'date' } as const],
    ['14:05Z', { kind: 'time' } as const],
    ['14:05', { kind: 'datetime' } as const],
    ['24:00', { kind: 'time' } as const],
    ['23:59:60', { kind: 'time' } as const],
    [' 2026-01-01', { kind: 'date' } as const],
    ['not scheduled', { kind: 'date' } as const],
  ])('preserves incompatible temporal text %#', (raw, format) => {
    expect(formatSheetCellValue(raw, format)).toBe(raw);
  });
});
