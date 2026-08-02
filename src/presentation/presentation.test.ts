import { describe, expect, it } from 'vitest';

import { MAX_SHEET_MERGES, validateSheetPresentation, type SheetCellRange } from './presentation';

const rows = [
  ['anchor', '', '', 'tail'],
  ['', '', '', ''],
  ['', '', '', ''],
];

const context = {
  rows,
  totalRows: rows.length,
  maxColumns: 4,
  headerRow: false,
};

describe('validateSheetPresentation', () => {
  it('normalizes horizontal, vertical, rectangular, and disjoint ranges', () => {
    const merges: SheetCellRange[] = [
      { startRow: 0, endRow: 1, startColumn: 0, endColumn: 2 },
      { startRow: 0, endRow: 3, startColumn: 2, endColumn: 3 },
      { startRow: 1, endRow: 3, startColumn: 0, endColumn: 2 },
    ];

    const result = validateSheetPresentation({ merges }, context);
    expect(result).toEqual({ ok: true, presentation: { merges } });
    if (!result.ok) throw new Error('expected valid presentation');
    expect(result.presentation.merges).not.toBe(merges);
    expect(result.presentation.merges[0]).not.toBe(merges[0]);
  });

  it('allows touching edges but reports overlaps and duplicate ranges', () => {
    const touching = validateSheetPresentation(
      {
        merges: [
          { startRow: 1, endRow: 2, startColumn: 0, endColumn: 2 },
          { startRow: 1, endRow: 2, startColumn: 2, endColumn: 4 },
        ],
      },
      context
    );
    expect(touching.ok).toBe(true);

    const overlapping = validateSheetPresentation(
      {
        merges: [
          { startRow: 0, endRow: 2, startColumn: 0, endColumn: 2 },
          { startRow: 1, endRow: 3, startColumn: 1, endColumn: 3 },
          { startRow: 0, endRow: 2, startColumn: 0, endColumn: 2 },
        ],
      },
      context
    );
    expect(overlapping.ok).toBe(false);
    if (overlapping.ok) throw new Error('expected invalid presentation');
    expect(overlapping.issues.filter(({ code }) => code === 'overlapping_merges')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ mergeIndex: 1, conflictingMergeIndex: 0 }),
        expect.objectContaining({ mergeIndex: 2, conflictingMergeIndex: 0 }),
      ])
    );
  });

  it.each([
    [{ startRow: -1, endRow: 1, startColumn: 0, endColumn: 2 }, 'invalid_coordinate'],
    [{ startRow: 0.5, endRow: 1, startColumn: 0, endColumn: 2 }, 'invalid_coordinate'],
    [
      { startRow: 0, endRow: Number.MAX_SAFE_INTEGER + 1, startColumn: 0, endColumn: 2 },
      'invalid_coordinate',
    ],
    [{ startRow: 0, endRow: 0, startColumn: 0, endColumn: 2 }, 'invalid_range'],
    [{ startRow: 0, endRow: 1, startColumn: 0, endColumn: 1 }, 'invalid_range'],
  ])('rejects malformed range %#', (range, code) => {
    const result = validateSheetPresentation({ merges: [range] }, context);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected invalid presentation');
    expect(result.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code })]));
  });

  it('distinguishes out-of-bounds and truncated rows', () => {
    const outOfBounds = validateSheetPresentation(
      { merges: [{ startRow: 2, endRow: 4, startColumn: 0, endColumn: 1 }] },
      context
    );
    expect(outOfBounds).toEqual(
      expect.objectContaining({
        ok: false,
        issues: expect.arrayContaining([expect.objectContaining({ code: 'out_of_bounds' })]),
      })
    );

    const truncated = validateSheetPresentation(
      { merges: [{ startRow: 1, endRow: 4, startColumn: 0, endColumn: 1 }] },
      { ...context, totalRows: 4 }
    );
    expect(truncated).toEqual(
      expect.objectContaining({
        ok: false,
        issues: expect.arrayContaining([expect.objectContaining({ code: 'truncated_range' })]),
      })
    );
  });

  it('treats missing ragged slots and empty strings as empty, but whitespace as non-empty', () => {
    const range = { startRow: 0, endRow: 2, startColumn: 0, endColumn: 2 };
    expect(
      validateSheetPresentation(
        { merges: [range] },
        { rows: [['anchor'], []], totalRows: 2, maxColumns: 2, headerRow: false }
      ).ok
    ).toBe(true);

    const result = validateSheetPresentation(
      { merges: [range] },
      { rows: [['anchor', ' '], []], totalRows: 2, maxColumns: 2, headerRow: false }
    );
    expect(result).toEqual(
      expect.objectContaining({
        ok: false,
        issues: expect.arrayContaining([
          expect.objectContaining({ code: 'non_empty_covered_cell' }),
        ]),
      })
    );
  });

  it('allows horizontal promoted-header groups and rejects header/body crossings', () => {
    const horizontal = validateSheetPresentation(
      { merges: [{ startRow: 0, endRow: 1, startColumn: 0, endColumn: 2 }] },
      { ...context, headerRow: true }
    );
    expect(horizontal.ok).toBe(true);

    const crossing = validateSheetPresentation(
      { merges: [{ startRow: 0, endRow: 2, startColumn: 0, endColumn: 1 }] },
      { ...context, headerRow: true }
    );
    expect(crossing).toEqual(
      expect.objectContaining({
        ok: false,
        issues: expect.arrayContaining([expect.objectContaining({ code: 'header_boundary' })]),
      })
    );
  });

  it('rejects unknown properties and enforces the merge cap before range work', () => {
    const unknown = validateSheetPresentation(
      {
        merges: [
          {
            startRow: 0,
            endRow: 1,
            startColumn: 0,
            endColumn: 2,
            alignment: 'center',
          } as SheetCellRange,
        ],
        styles: [],
      } as never,
      context
    );
    expect(unknown.ok).toBe(false);
    if (unknown.ok) throw new Error('expected invalid presentation');
    expect(unknown.issues.filter(({ code }) => code === 'unknown_property')).toHaveLength(2);

    const overLimit = validateSheetPresentation(
      { merges: Array.from({ length: MAX_SHEET_MERGES + 1 }, () => null) as never },
      context
    );
    expect(overLimit).toEqual({
      ok: false,
      issues: [expect.objectContaining({ code: 'too_many_merges' })],
    });
  });

  it('throws for invalid validator context rather than treating it as user presentation', () => {
    expect(() => validateSheetPresentation({}, { ...context, totalRows: 1 })).toThrowError(
      RangeError
    );
    expect(() =>
      validateSheetPresentation({}, { ...context, headerRow: 'yes' as never })
    ).toThrowError(TypeError);
  });
});
