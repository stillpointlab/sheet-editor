import type { SheetCellRange } from '../presentation';

export interface SheetMergeIndex {
  readonly ranges: readonly SheetCellRange[];
  anchorAt(row: number, column: number): SheetCellRange | undefined;
  isCovered(row: number, column: number): boolean;
  unitAt(row: number, column: number): SheetCellRange;
}

export function createSheetMergeIndex(merges: readonly SheetCellRange[]): SheetMergeIndex {
  const ranges = merges.map((range) => Object.freeze({ ...range }));
  const anchors = new Map<string, SheetCellRange>();
  const units = new Map<string, SheetCellRange>();

  for (const range of ranges) {
    anchors.set(cellKey(range.startRow, range.startColumn), range);
    for (let row = range.startRow; row < range.endRow; row += 1) {
      for (let column = range.startColumn; column < range.endColumn; column += 1) {
        units.set(cellKey(row, column), range);
      }
    }
  }

  return Object.freeze({
    ranges: Object.freeze(ranges),
    anchorAt(row: number, column: number): SheetCellRange | undefined {
      return anchors.get(cellKey(row, column));
    },
    isCovered(row: number, column: number): boolean {
      const unit = units.get(cellKey(row, column));
      return unit !== undefined && (unit.startRow !== row || unit.startColumn !== column);
    },
    unitAt(row: number, column: number): SheetCellRange {
      return (
        units.get(cellKey(row, column)) ?? {
          startRow: row,
          endRow: row + 1,
          startColumn: column,
          endColumn: column + 1,
        }
      );
    },
  });
}

function cellKey(row: number, column: number): string {
  return `${row}:${column}`;
}
