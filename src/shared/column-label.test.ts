import { describe, expect, it } from 'vitest';

import { columnLabel } from './column-label';

describe('columnLabel', () => {
  it.each([
    [0, 'A'],
    [25, 'Z'],
    [26, 'AA'],
    [27, 'AB'],
    [51, 'AZ'],
    [52, 'BA'],
    [255, 'IV'],
  ])('maps column %i to %s', (index, label) => {
    expect(columnLabel(index)).toBe(label);
  });

  it('rejects invalid indexes', () => {
    expect(() => columnLabel(-1)).toThrow(RangeError);
  });
});
