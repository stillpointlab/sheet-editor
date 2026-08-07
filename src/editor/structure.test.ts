import { describe, expect, it } from 'vitest';

import { applySheetStructure, transformSheetPresentation } from './structure';

describe('sheet structure rows and columns', () => {
  it('inserts a full-width blank row without mutating ragged input', () => {
    const rows = [['a'], ['b', 'c', 'd']];

    expect(applySheetStructure(rows, { axis: 'row', kind: 'insert', index: 1 })).toEqual([
      ['a'],
      ['', '', ''],
      ['b', 'c', 'd'],
    ]);
    expect(rows).toEqual([['a'], ['b', 'c', 'd']]);
  });

  it('clamps row insertion to append and uses one field for an empty sheet', () => {
    expect(applySheetStructure([['a']], { axis: 'row', kind: 'insert', index: 9 })).toEqual([
      ['a'],
      [''],
    ]);
    expect(applySheetStructure([], { axis: 'row', kind: 'insert', index: 1 })).toEqual([['']]);
  });

  it('deletes a materialized row and rejects a virtual row', () => {
    expect(applySheetStructure([['a'], ['b']], { axis: 'row', kind: 'delete', index: 0 })).toEqual([
      ['b'],
    ]);
    expect(() => applySheetStructure([['a']], { axis: 'row', kind: 'delete', index: 1 })).toThrow(
      'virtual sheet row'
    );
  });

  it('inserts and deletes at top, middle, and bottom row boundaries', () => {
    const rows = [['top'], ['middle'], ['bottom']];

    expect(applySheetStructure(rows, { axis: 'row', kind: 'insert', index: 0 })[0]).toEqual(['']);
    expect(applySheetStructure(rows, { axis: 'row', kind: 'insert', index: 2 })[2]).toEqual(['']);
    expect(applySheetStructure(rows, { axis: 'row', kind: 'insert', index: 3 })[3]).toEqual(['']);
    expect(applySheetStructure(rows, { axis: 'row', kind: 'delete', index: 0 })).toEqual([
      ['middle'],
      ['bottom'],
    ]);
    expect(applySheetStructure(rows, { axis: 'row', kind: 'delete', index: 1 })).toEqual([
      ['top'],
      ['bottom'],
    ]);
    expect(applySheetStructure(rows, { axis: 'row', kind: 'delete', index: 2 })).toEqual([
      ['top'],
      ['middle'],
    ]);
  });

  it('rectangularizes ragged rows and shifts values for column insertion', () => {
    expect(
      applySheetStructure([['a'], ['b', 'c']], {
        axis: 'column',
        kind: 'insert',
        index: 1,
      })
    ).toEqual([
      ['a', '', ''],
      ['b', '', 'c'],
    ]);
  });

  it('clamps virtual-edge column insertion and materializes an empty sheet minimally', () => {
    expect(applySheetStructure([['a', 'b']], { axis: 'column', kind: 'insert', index: 9 })).toEqual(
      [['a', 'b', '']]
    );
    expect(applySheetStructure([], { axis: 'column', kind: 'insert', index: 1 })).toEqual([['']]);
  });

  it('deletes one global column and normalizes final-column deletion to an empty matrix', () => {
    expect(
      applySheetStructure([['a'], ['b', 'c']], {
        axis: 'column',
        kind: 'delete',
        index: 0,
      })
    ).toEqual([[''], ['c']]);
    expect(
      applySheetStructure([['a'], ['b']], { axis: 'column', kind: 'delete', index: 0 })
    ).toEqual([]);
    expect(() =>
      applySheetStructure([['a']], { axis: 'column', kind: 'delete', index: 1 })
    ).toThrow('virtual sheet column');
  });

  it('inserts and deletes at top, middle, and bottom column boundaries', () => {
    const rows = [['left', 'middle', 'right']];

    expect(applySheetStructure(rows, { axis: 'column', kind: 'insert', index: 0 })).toEqual([
      ['', 'left', 'middle', 'right'],
    ]);
    expect(applySheetStructure(rows, { axis: 'column', kind: 'insert', index: 2 })).toEqual([
      ['left', 'middle', '', 'right'],
    ]);
    expect(applySheetStructure(rows, { axis: 'column', kind: 'insert', index: 3 })).toEqual([
      ['left', 'middle', 'right', ''],
    ]);
    expect(applySheetStructure(rows, { axis: 'column', kind: 'delete', index: 0 })).toEqual([
      ['middle', 'right'],
    ]);
    expect(applySheetStructure(rows, { axis: 'column', kind: 'delete', index: 1 })).toEqual([
      ['left', 'right'],
    ]);
    expect(applySheetStructure(rows, { axis: 'column', kind: 'delete', index: 2 })).toEqual([
      ['left', 'middle'],
    ]);
  });

  it('rejects invalid operation descriptors without changing input', () => {
    const rows = [['value']];

    expect(() => applySheetStructure(rows, { axis: 'row', kind: 'insert', index: -1 })).toThrow(
      'non-negative safe-integer'
    );
    expect(rows).toEqual([['value']]);
  });
});

describe('sheet structure merge transformations', () => {
  const rectangular = {
    merges: [{ startRow: 1, endRow: 3, startColumn: 1, endColumn: 4 }],
  };

  it.each([
    [
      { axis: 'row', kind: 'insert', index: 1 } as const,
      { startRow: 2, endRow: 4, startColumn: 1, endColumn: 4 },
    ],
    [
      { axis: 'row', kind: 'insert', index: 2 } as const,
      { startRow: 1, endRow: 4, startColumn: 1, endColumn: 4 },
    ],
    [
      { axis: 'row', kind: 'insert', index: 3 } as const,
      { startRow: 1, endRow: 3, startColumn: 1, endColumn: 4 },
    ],
    [
      { axis: 'column', kind: 'insert', index: 1 } as const,
      { startRow: 1, endRow: 3, startColumn: 2, endColumn: 5 },
    ],
    [
      { axis: 'column', kind: 'insert', index: 2 } as const,
      { startRow: 1, endRow: 3, startColumn: 1, endColumn: 5 },
    ],
  ])('shifts, expands, or leaves a merge for %o', (operation, expected) => {
    expect(transformSheetPresentation(rectangular, operation)).toEqual({ merges: [expected] });
  });

  it('contracts merges and keeps valid horizontal/vertical results', () => {
    expect(
      transformSheetPresentation(rectangular, { axis: 'row', kind: 'delete', index: 1 })
    ).toEqual({
      merges: [{ startRow: 1, endRow: 2, startColumn: 1, endColumn: 4 }],
    });
    expect(
      transformSheetPresentation(rectangular, { axis: 'column', kind: 'delete', index: 2 })
    ).toEqual({
      merges: [{ startRow: 1, endRow: 3, startColumn: 1, endColumn: 3 }],
    });
  });

  it('shifts later merges and drops empty or 1x1 results', () => {
    const presentation = {
      merges: [
        { startRow: 0, endRow: 1, startColumn: 0, endColumn: 2 },
        { startRow: 2, endRow: 4, startColumn: 2, endColumn: 3 },
      ],
    };

    expect(
      transformSheetPresentation(presentation, { axis: 'row', kind: 'delete', index: 0 })
    ).toEqual({
      merges: [{ startRow: 1, endRow: 3, startColumn: 2, endColumn: 3 }],
    });
    expect(presentation).toEqual({
      merges: [
        { startRow: 0, endRow: 1, startColumn: 0, endColumn: 2 },
        { startRow: 2, endRow: 4, startColumn: 2, endColumn: 3 },
      ],
    });
  });

  it('transforms horizontal, vertical, and disjoint merges independently', () => {
    const presentation = {
      merges: [
        { startRow: 0, endRow: 1, startColumn: 0, endColumn: 3 },
        { startRow: 1, endRow: 4, startColumn: 3, endColumn: 4 },
      ],
    };

    expect(
      transformSheetPresentation(presentation, { axis: 'column', kind: 'delete', index: 1 })
    ).toEqual({
      merges: [
        { startRow: 0, endRow: 1, startColumn: 0, endColumn: 2 },
        { startRow: 1, endRow: 4, startColumn: 2, endColumn: 3 },
      ],
    });
    expect(
      transformSheetPresentation(presentation, { axis: 'row', kind: 'delete', index: 1 })
    ).toEqual({
      merges: [
        { startRow: 0, endRow: 1, startColumn: 0, endColumn: 3 },
        { startRow: 1, endRow: 3, startColumn: 3, endColumn: 4 },
      ],
    });
  });

  it('drops a horizontal or vertical merge after its last supporting line is deleted', () => {
    expect(
      transformSheetPresentation(
        { merges: [{ startRow: 0, endRow: 1, startColumn: 0, endColumn: 2 }] },
        { axis: 'column', kind: 'delete', index: 0 }
      )
    ).toEqual({ merges: [] });
    expect(
      transformSheetPresentation(
        { merges: [{ startRow: 0, endRow: 2, startColumn: 0, endColumn: 1 }] },
        { axis: 'row', kind: 'delete', index: 0 }
      )
    ).toEqual({ merges: [] });
  });

  it('preserves an omitted merges property', () => {
    expect(transformSheetPresentation({}, { axis: 'row', kind: 'insert', index: 0 })).toEqual({});
  });
});
