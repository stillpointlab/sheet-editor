import { describe, expect, it } from 'vitest';

import { formatSheetCellValue, type EffectiveSheetValueFormat } from './index';

describe('presentation public entrypoint', () => {
  it('exports the fixed-locale formatter and descriptor type without changing raw input', () => {
    const raw = '1234.565';
    const format: EffectiveSheetValueFormat = {
      kind: 'currency',
      currency: 'USD',
      decimalPlaces: 2,
    };

    expect(formatSheetCellValue(raw, format)).toBe('$1,234.57');
    expect(raw).toBe('1234.565');
  });

  it('returns raw text for incompatible values and invalid currency designators', () => {
    expect(
      formatSheetCellValue('not-a-number', {
        kind: 'currency',
        currency: 'USD',
        decimalPlaces: 2,
      })
    ).toBe('not-a-number');
    expect(
      formatSheetCellValue('12.345', {
        kind: 'currency',
        currency: 'not a currency',
        decimalPlaces: 2,
      })
    ).toBe('12.345');
  });
});
