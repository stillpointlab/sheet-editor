import { describe, expect, it } from 'vitest';

import {
  createSheetMergeIndex,
  createSheetSelection,
  moveSheetSelection,
  resolveSheetCoordinate,
  resolveSheetUnit,
} from './interaction';

import type { SheetCellRange } from '../presentation';

const bounds = { rowCount: 8, columnCount: 8 };

describe('sheet interaction geometry', () => {
  it('resolves covered coordinates to the merge anchor and visible unit', () => {
    const range = { startRow: 1, endRow: 3, startColumn: 1, endColumn: 4 };
    const index = createSheetMergeIndex([range]);

    expect(resolveSheetCoordinate({ row: 2, column: 3 }, index)).toEqual({ row: 1, column: 1 });
    expect(resolveSheetUnit({ row: 2, column: 2 }, index)).toEqual(range);
    expect(index.anchorAt(1, 1)).toEqual(range);
    expect(index.isCovered(1, 1)).toBe(false);
    expect(index.isCovered(2, 3)).toBe(true);
  });

  it('snapshots indexed ranges', () => {
    const range = { startRow: 0, endRow: 1, startColumn: 0, endColumn: 2 };
    const index = createSheetMergeIndex([range]);
    range.endColumn = 3;

    expect(index.ranges[0]?.endColumn).toBe(2);
  });

  it.each([
    ['right', { row: 1, column: 4 }],
    ['left', { row: 1, column: 0 }],
    ['down', { row: 3, column: 1 }],
    ['up', { row: 0, column: 1 }],
  ] as const)('moves %s beyond the full edge of a rectangular merge', (direction, expected) => {
    const index = createSheetMergeIndex([{ startRow: 1, endRow: 3, startColumn: 1, endColumn: 4 }]);
    const selection = createSheetSelection({ row: 2, column: 3 }, { row: 2, column: 3 }, index);

    expect(moveSheetSelection(selection, direction, bounds, index).active).toEqual(expected);
  });

  it('canonicalizes movement into a destination merge from every side', () => {
    const index = createSheetMergeIndex([{ startRow: 2, endRow: 4, startColumn: 2, endColumn: 4 }]);

    const cases = [
      [{ row: 2, column: 1 }, 'right'],
      [{ row: 2, column: 4 }, 'left'],
      [{ row: 1, column: 2 }, 'down'],
      [{ row: 4, column: 2 }, 'up'],
    ] as const;
    for (const [start, direction] of cases) {
      const selection = createSheetSelection(start, start, index);
      expect(moveSheetSelection(selection, direction, bounds, index).active).toEqual({
        row: 2,
        column: 2,
      });
    }
  });

  it('clamps movement at all canvas edges without wrapping', () => {
    const index = createSheetMergeIndex([]);
    const topLeft = createSheetSelection({ row: 0, column: 0 }, { row: 0, column: 0 }, index);
    const bottomRight = createSheetSelection({ row: 7, column: 7 }, { row: 7, column: 7 }, index);

    expect(moveSheetSelection(topLeft, 'up', bounds, index).active).toEqual({ row: 0, column: 0 });
    expect(moveSheetSelection(topLeft, 'left', bounds, index).active).toEqual({
      row: 0,
      column: 0,
    });
    expect(moveSheetSelection(bottomRight, 'down', bounds, index).active).toEqual({
      row: 7,
      column: 7,
    });
    expect(moveSheetSelection(bottomRight, 'right', bounds, index).active).toEqual({
      row: 7,
      column: 7,
    });
  });

  it('expands a selection to a fixed point across adjacent merges', () => {
    const merges: SheetCellRange[] = [
      { startRow: 0, endRow: 1, startColumn: 1, endColumn: 3 },
      { startRow: 1, endRow: 3, startColumn: 2, endColumn: 3 },
    ];
    const index = createSheetMergeIndex(merges);

    expect(createSheetSelection({ row: 0, column: 0 }, { row: 1, column: 1 }, index)).toEqual({
      anchor: { row: 0, column: 0 },
      active: { row: 1, column: 1 },
      range: { startRow: 0, endRow: 3, startColumn: 0, endColumn: 3 },
    });
  });

  it('keeps the anchor stable while Shift movement extends and shrinks', () => {
    const index = createSheetMergeIndex([]);
    const initial = createSheetSelection({ row: 1, column: 1 }, { row: 1, column: 1 }, index);
    const extended = moveSheetSelection(initial, 'right', bounds, index, true);
    const extendedAgain = moveSheetSelection(extended, 'right', bounds, index, true);
    const shrunk = moveSheetSelection(extendedAgain, 'left', bounds, index, true);

    expect(extendedAgain.anchor).toEqual({ row: 1, column: 1 });
    expect(extendedAgain.range).toEqual({
      startRow: 1,
      endRow: 2,
      startColumn: 1,
      endColumn: 4,
    });
    expect(shrunk.range).toEqual({
      startRow: 1,
      endRow: 2,
      startColumn: 1,
      endColumn: 3,
    });
  });

  it('rejects invalid coordinates and canvas bounds', () => {
    const index = createSheetMergeIndex([]);
    expect(() => resolveSheetCoordinate({ row: -1, column: 0 }, index)).toThrow(RangeError);
    const selection = createSheetSelection({ row: 0, column: 0 }, { row: 0, column: 0 }, index);
    expect(() =>
      moveSheetSelection(selection, 'right', { rowCount: 0, columnCount: 1 }, index)
    ).toThrow(RangeError);
  });
});
