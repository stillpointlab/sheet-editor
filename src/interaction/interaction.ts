import { createSheetMergeIndex, type SheetMergeIndex } from '../shared/merge-index';

import type { SheetCellRange } from '../presentation';

export interface SheetCoordinate {
  row: number;
  column: number;
}

export interface SheetCanvasBounds {
  rowCount: number;
  columnCount: number;
}

export type SheetMoveDirection = 'up' | 'down' | 'left' | 'right';

export interface SheetSelection {
  anchor: SheetCoordinate;
  active: SheetCoordinate;
  range: SheetCellRange;
}

export { createSheetMergeIndex };
export type { SheetMergeIndex };

export function resolveSheetCoordinate(
  coordinate: SheetCoordinate,
  mergeIndex: SheetMergeIndex
): SheetCoordinate {
  assertCoordinate(coordinate);
  const unit = mergeIndex.unitAt(coordinate.row, coordinate.column);
  return { row: unit.startRow, column: unit.startColumn };
}

export function resolveSheetUnit(
  coordinate: SheetCoordinate,
  mergeIndex: SheetMergeIndex
): SheetCellRange {
  assertCoordinate(coordinate);
  return { ...mergeIndex.unitAt(coordinate.row, coordinate.column) };
}

export function createSheetSelection(
  anchor: SheetCoordinate,
  active: SheetCoordinate,
  mergeIndex: SheetMergeIndex
): SheetSelection {
  const resolvedAnchor = resolveSheetCoordinate(anchor, mergeIndex);
  const resolvedActive = resolveSheetCoordinate(active, mergeIndex);
  return {
    anchor: resolvedAnchor,
    active: resolvedActive,
    range: expandSelectionRange(resolvedAnchor, resolvedActive, mergeIndex.ranges),
  };
}

export function moveSheetSelection(
  selection: SheetSelection,
  direction: SheetMoveDirection,
  bounds: SheetCanvasBounds,
  mergeIndex: SheetMergeIndex,
  extend = false
): SheetSelection {
  assertBounds(bounds);
  const anchor = clampCoordinate(resolveSheetCoordinate(selection.anchor, mergeIndex), bounds);
  const active = clampCoordinate(resolveSheetCoordinate(selection.active, mergeIndex), bounds);
  const unit = mergeIndex.unitAt(active.row, active.column);
  const candidate = movementCandidate(unit, direction);
  const destination = resolveSheetCoordinate(clampCoordinate(candidate, bounds), mergeIndex);
  return createSheetSelection(extend ? anchor : destination, destination, mergeIndex);
}

export function sheetRangesIntersect(left: SheetCellRange, right: SheetCellRange): boolean {
  return (
    left.startRow < right.endRow &&
    right.startRow < left.endRow &&
    left.startColumn < right.endColumn &&
    right.startColumn < left.endColumn
  );
}

function expandSelectionRange(
  anchor: SheetCoordinate,
  active: SheetCoordinate,
  merges: readonly SheetCellRange[]
): SheetCellRange {
  const range: SheetCellRange = {
    startRow: Math.min(anchor.row, active.row),
    endRow: Math.max(anchor.row, active.row) + 1,
    startColumn: Math.min(anchor.column, active.column),
    endColumn: Math.max(anchor.column, active.column) + 1,
  };

  let changed = true;
  while (changed) {
    changed = false;
    for (const merge of merges) {
      if (!sheetRangesIntersect(range, merge)) continue;
      const expanded = {
        startRow: Math.min(range.startRow, merge.startRow),
        endRow: Math.max(range.endRow, merge.endRow),
        startColumn: Math.min(range.startColumn, merge.startColumn),
        endColumn: Math.max(range.endColumn, merge.endColumn),
      };
      if (
        expanded.startRow !== range.startRow ||
        expanded.endRow !== range.endRow ||
        expanded.startColumn !== range.startColumn ||
        expanded.endColumn !== range.endColumn
      ) {
        Object.assign(range, expanded);
        changed = true;
      }
    }
  }
  return range;
}

function movementCandidate(unit: SheetCellRange, direction: SheetMoveDirection): SheetCoordinate {
  switch (direction) {
    case 'up':
      return { row: unit.startRow - 1, column: unit.startColumn };
    case 'down':
      return { row: unit.endRow, column: unit.startColumn };
    case 'left':
      return { row: unit.startRow, column: unit.startColumn - 1 };
    case 'right':
      return { row: unit.startRow, column: unit.endColumn };
  }
}

function clampCoordinate(coordinate: SheetCoordinate, bounds: SheetCanvasBounds): SheetCoordinate {
  return {
    row: Math.min(Math.max(coordinate.row, 0), bounds.rowCount - 1),
    column: Math.min(Math.max(coordinate.column, 0), bounds.columnCount - 1),
  };
}

function assertCoordinate(coordinate: SheetCoordinate): void {
  if (
    !Number.isSafeInteger(coordinate.row) ||
    coordinate.row < 0 ||
    !Number.isSafeInteger(coordinate.column) ||
    coordinate.column < 0
  ) {
    throw new RangeError('Sheet coordinates must be non-negative safe integers.');
  }
}

function assertBounds(bounds: SheetCanvasBounds): void {
  if (
    !Number.isSafeInteger(bounds.rowCount) ||
    bounds.rowCount <= 0 ||
    !Number.isSafeInteger(bounds.columnCount) ||
    bounds.columnCount <= 0
  ) {
    throw new RangeError('Sheet canvas bounds must be positive safe integers.');
  }
}
