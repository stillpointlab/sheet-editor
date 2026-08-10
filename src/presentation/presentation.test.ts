import { describe, expect, it } from 'vitest';

import {
  MAX_SHEET_ALIGNMENT_RULES,
  MAX_SHEET_FORMAT_RULES,
  MAX_SHEET_MERGES,
  MAX_SHEET_VALUE_FORMAT_RULES,
  resolveSheetPresentation,
  validateSheetPresentation,
  type SheetCellRange,
  type SheetFormatRule,
  type SheetValueFormatRule,
} from './presentation';

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
    expect(Object.isFrozen(result.presentation)).toBe(true);
    expect(Object.isFrozen(result.presentation.merges)).toBe(true);
    expect(Object.isFrozen(result.presentation.merges[0])).toBe(true);
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

  it('resolves overlapping format and alignment properties independently in source order', () => {
    const result = validateSheetPresentation(
      {
        formats: [
          {
            range: { startRow: 0, endRow: 2, startColumn: 0, endColumn: 3 },
            bold: true,
            italic: true,
          },
          {
            range: { startRow: 0, endRow: 2, startColumn: 1, endColumn: 2 },
            bold: false,
            strikethrough: true,
          },
          {
            range: { startRow: 0, endRow: 1, startColumn: 0, endColumn: 3 },
            italic: false,
          },
        ],
        alignments: [
          {
            range: { startRow: 0, endRow: 2, startColumn: 0, endColumn: 3 },
            horizontal: 'center',
            vertical: 'top',
          },
          {
            range: { startRow: 0, endRow: 1, startColumn: 0, endColumn: 3 },
            vertical: 'middle',
          },
          {
            range: { startRow: 0, endRow: 2, startColumn: 1, endColumn: 2 },
            horizontal: 'right',
          },
        ],
      },
      {
        rows: [
          ['a', 'b', 'c'],
          ['d', 'e', 'f'],
        ],
        totalRows: 2,
        maxColumns: 3,
        headerRow: false,
      }
    );
    expect(result).toEqual({
      ok: true,
      presentation: {
        merges: [],
        formats: [
          { range: { startRow: 0, endRow: 1, startColumn: 0, endColumn: 1 }, bold: true },
          {
            range: { startRow: 0, endRow: 1, startColumn: 1, endColumn: 2 },
            strikethrough: true,
          },
          { range: { startRow: 0, endRow: 1, startColumn: 2, endColumn: 3 }, bold: true },
          {
            range: { startRow: 1, endRow: 2, startColumn: 0, endColumn: 1 },
            bold: true,
            italic: true,
          },
          {
            range: { startRow: 1, endRow: 2, startColumn: 1, endColumn: 2 },
            italic: true,
            strikethrough: true,
          },
          {
            range: { startRow: 1, endRow: 2, startColumn: 2, endColumn: 3 },
            bold: true,
            italic: true,
          },
        ],
        alignments: [
          {
            range: { startRow: 0, endRow: 1, startColumn: 0, endColumn: 1 },
            horizontal: 'center',
          },
          {
            range: { startRow: 0, endRow: 1, startColumn: 1, endColumn: 2 },
            horizontal: 'right',
          },
          {
            range: { startRow: 0, endRow: 1, startColumn: 2, endColumn: 3 },
            horizontal: 'center',
          },
          {
            range: { startRow: 1, endRow: 2, startColumn: 0, endColumn: 1 },
            horizontal: 'center',
            vertical: 'top',
          },
          {
            range: { startRow: 1, endRow: 2, startColumn: 1, endColumn: 2 },
            horizontal: 'right',
            vertical: 'top',
          },
          {
            range: { startRow: 1, endRow: 2, startColumn: 2, endColumn: 3 },
            horizontal: 'center',
            vertical: 'top',
          },
        ],
      },
    });
  });

  it('removes false and default-only state without mutating caller input', () => {
    const presentation = {
      formats: [
        {
          range: { startRow: 0, endRow: 1, startColumn: 0, endColumn: 1 },
          bold: false,
          italic: false,
        },
      ],
      alignments: [
        {
          range: { startRow: 0, endRow: 1, startColumn: 0, endColumn: 1 },
          horizontal: 'left' as const,
          vertical: 'middle' as const,
        },
      ],
    };
    const snapshot = structuredClone(presentation);

    expect(
      validateSheetPresentation(presentation, {
        rows: [['a']],
        totalRows: 1,
        maxColumns: 1,
        headerRow: false,
      })
    ).toEqual({ ok: true, presentation: { merges: [] } });
    expect(presentation).toEqual(snapshot);
  });

  it('inherits, suppresses, clears, and replaces each presentation section independently', () => {
    const range = { startRow: 0, endRow: 1, startColumn: 0, endColumn: 1 };
    const embedded = {
      formats: [{ range, bold: true }],
      alignments: [{ range, horizontal: 'center' as const }],
    };

    expect(resolveSheetPresentation(embedded, {})).toEqual(embedded);
    expect(resolveSheetPresentation(embedded, null)).toEqual({});
    expect(resolveSheetPresentation(embedded, { formats: [] })).toEqual({
      formats: [],
      alignments: embedded.alignments,
    });
    expect(resolveSheetPresentation(embedded, { alignments: undefined })).toEqual(embedded);
  });

  it('enforces raw format/alignment caps and the normalized fragmentation cap', () => {
    const overFormats = validateSheetPresentation(
      { formats: Array.from({ length: MAX_SHEET_FORMAT_RULES + 1 }, () => null) as never },
      context
    );
    expect(overFormats).toEqual(
      expect.objectContaining({
        ok: false,
        issues: expect.arrayContaining([expect.objectContaining({ code: 'too_many_formats' })]),
      })
    );

    const overAlignments = validateSheetPresentation(
      {
        alignments: Array.from({ length: MAX_SHEET_ALIGNMENT_RULES + 1 }, () => null) as never,
      },
      context
    );
    expect(overAlignments).toEqual(
      expect.objectContaining({
        ok: false,
        issues: expect.arrayContaining([expect.objectContaining({ code: 'too_many_alignments' })]),
      })
    );

    const formats: SheetFormatRule[] = [
      {
        range: { startRow: 0, endRow: 1000, startColumn: 0, endColumn: 9 },
        bold: true,
      },
    ];
    for (let row = 0; row < 1000; row += 1) {
      const columns = row % 2 === 0 ? [1, 3, 5, 7] : [0, 2, 4, 6];
      for (const column of columns) {
        formats.push({
          range: { startRow: row, endRow: row + 1, startColumn: column, endColumn: column + 1 },
          bold: false,
        });
      }
    }
    const fragmented = validateSheetPresentation(
      { formats },
      {
        rows: Array.from({ length: 1000 }, () => Array<string>(9).fill('')),
        totalRows: 1000,
        maxColumns: 9,
        headerRow: false,
      }
    );
    expect(fragmented).toEqual(
      expect.objectContaining({
        ok: false,
        issues: expect.arrayContaining([expect.objectContaining({ code: 'too_many_formats' })]),
      })
    );
  });

  it('resolves complete value-format descriptors in source order and removes Automatic state', () => {
    const result = validateSheetPresentation(
      {
        valueFormats: [
          {
            range: { startRow: 0, endRow: 2, startColumn: 0, endColumn: 3 },
            kind: 'currency',
            currency: 'USD',
            decimalPlaces: 2,
          },
          {
            range: { startRow: 0, endRow: 2, startColumn: 1, endColumn: 2 },
            kind: 'percent',
            decimalPlaces: 1,
          },
          {
            range: { startRow: 0, endRow: 1, startColumn: 2, endColumn: 3 },
            kind: 'automatic',
          },
        ],
      },
      {
        rows: [
          ['a', 'b', 'c'],
          ['d', 'e', 'f'],
        ],
        totalRows: 2,
        maxColumns: 3,
        headerRow: false,
      }
    );

    expect(result).toEqual({
      ok: true,
      presentation: {
        merges: [],
        valueFormats: [
          {
            range: { startRow: 0, endRow: 2, startColumn: 0, endColumn: 1 },
            kind: 'currency',
            currency: 'USD',
            decimalPlaces: 2,
          },
          {
            range: { startRow: 0, endRow: 2, startColumn: 1, endColumn: 2 },
            kind: 'percent',
            decimalPlaces: 1,
          },
          {
            range: { startRow: 1, endRow: 2, startColumn: 2, endColumn: 3 },
            kind: 'currency',
            currency: 'USD',
            decimalPlaces: 2,
          },
        ],
      },
    });
  });

  it.each([
    [[{ range: { startRow: 0, endRow: 1, startColumn: 0, endColumn: 1 } }]],
    [
      [
        {
          range: { startRow: 0, endRow: 1, startColumn: 0, endColumn: 1 },
          kind: 'number',
        },
      ],
    ],
    [
      [
        {
          range: { startRow: 0, endRow: 1, startColumn: 0, endColumn: 1 },
          kind: 'number',
          decimalPlaces: 11,
        },
      ],
    ],
    [
      [
        {
          range: { startRow: 0, endRow: 1, startColumn: 0, endColumn: 1 },
          kind: 'currency',
          currency: 'usd',
          decimalPlaces: 2,
        },
      ],
    ],
    [
      [
        {
          range: { startRow: 0, endRow: 1, startColumn: 0, endColumn: 1 },
          kind: 'date',
          decimalPlaces: 2,
        },
      ],
    ],
  ])('rejects an invalid value-format discriminated union %#', (valueFormats) => {
    const result = validateSheetPresentation({ valueFormats } as never, context);
    expect(result).toEqual(
      expect.objectContaining({
        ok: false,
        issues: expect.arrayContaining([
          expect.objectContaining({ code: 'invalid_value_format', valueFormatIndex: 0 }),
        ]),
      })
    );
  });

  it('inherits, clears, and snapshots value-format overrides independently', () => {
    const range = { startRow: 0, endRow: 1, startColumn: 0, endColumn: 1 };
    const embedded = {
      formats: [{ range, bold: true }],
      valueFormats: [{ range, kind: 'number' as const, decimalPlaces: 2 }],
    };

    expect(resolveSheetPresentation(embedded, { valueFormats: undefined })).toEqual(embedded);
    expect(resolveSheetPresentation(embedded, { valueFormats: [] })).toEqual({
      formats: embedded.formats,
      valueFormats: [],
    });

    const overLimit = validateSheetPresentation(
      {
        valueFormats: Array.from({ length: MAX_SHEET_VALUE_FORMAT_RULES + 1 }, () => null) as never,
      },
      context
    );
    expect(overLimit).toEqual(
      expect.objectContaining({
        ok: false,
        issues: expect.arrayContaining([
          expect.objectContaining({ code: 'too_many_value_formats' }),
        ]),
      })
    );
  });

  it('rejects value-format partitions that exceed the normalized rule cap', () => {
    const rows = Array.from({ length: 1000 }, () => Array<string>(256).fill(''));
    const cancellations = Array.from({ length: 1000 }, (_, row) => {
      const start = (row * 7) % 200;
      return [1, 3, 5, 7].map((offset): SheetValueFormatRule => ({
        range: {
          startRow: row,
          endRow: row + 1,
          startColumn: start + offset,
          endColumn: start + offset + 1,
        },
        kind: 'automatic',
      }));
    }).flat();
    const result = validateSheetPresentation(
      {
        valueFormats: [
          {
            range: { startRow: 0, endRow: 1000, startColumn: 0, endColumn: 256 },
            kind: 'number',
            decimalPlaces: 2,
          },
          ...cancellations,
        ],
      },
      { rows, totalRows: 1000, maxColumns: 256, headerRow: false }
    );

    expect(result).toEqual(
      expect.objectContaining({
        ok: false,
        issues: expect.arrayContaining([
          expect.objectContaining({ code: 'too_many_value_formats' }),
        ]),
      })
    );
  });
});
