import { describe, expect, it } from 'vitest';

import { formatA1Range, parseA1Range } from './a1-range';

describe('A1 merged ranges', () => {
  it.each([
    ['A1:C1', { startRow: 0, endRow: 1, startColumn: 0, endColumn: 3 }],
    ['Z2:AA4', { startRow: 1, endRow: 4, startColumn: 25, endColumn: 27 }],
    ['A1:A2', { startRow: 0, endRow: 2, startColumn: 0, endColumn: 1 }],
  ])('parses inclusive %s into half-open coordinates', (source, expected) => {
    expect(parseA1Range(source)).toEqual(expected);
    expect(formatA1Range(expected)).toBe(source);
  });

  it.each([
    'a1:C1',
    ' A1:C1',
    'A1:C1 ',
    '$A$1:$C$1',
    'Sheet1!A1:C1',
    'A:C',
    '1:2',
    'A0:C1',
    'C1:A1',
    'A2:A1',
    'A1:A1',
    'A1',
    'A1:C1,D1:E1',
  ])('rejects non-canonical persisted range %s', (source) => {
    expect(parseA1Range(source)).toBeNull();
  });

  it('rejects coordinates that overflow JavaScript safe integers', () => {
    expect(parseA1Range('A9007199254740992:A9007199254740993')).toBeNull();
    expect(parseA1Range('ZZZZZZZZZZZZZZ1:ZZZZZZZZZZZZZZ2')).toBeNull();
  });

  it('throws when asked to format an invalid programmatic range', () => {
    expect(() =>
      formatA1Range({ startRow: 0, endRow: 1, startColumn: 0, endColumn: 1 })
    ).toThrowError(RangeError);
    expect(() =>
      formatA1Range({ startRow: -1, endRow: 1, startColumn: 0, endColumn: 2 })
    ).toThrowError(RangeError);
  });
});
