import {
  snapshotSheetPresentation,
  type SheetCellRange,
  type SheetPresentation,
} from '../presentation/presentation';

export type SheetStructureAxis = 'row' | 'column';
export type SheetStructureKind = 'insert' | 'delete';

export interface SheetStructureOperation {
  axis: SheetStructureAxis;
  kind: SheetStructureKind;
  index: number;
}

export function applySheetStructure(
  sourceRows: readonly (readonly string[])[],
  operation: SheetStructureOperation
): string[][] {
  assertOperation(operation);
  if (operation.axis === 'row') {
    return operation.kind === 'insert'
      ? insertRow(sourceRows, operation.index)
      : deleteRow(sourceRows, operation.index);
  }
  return operation.kind === 'insert'
    ? insertColumn(sourceRows, operation.index)
    : deleteColumn(sourceRows, operation.index);
}

export function transformSheetPresentation(
  source: SheetPresentation,
  operation: SheetStructureOperation
): SheetPresentation {
  assertOperation(operation);
  const presentation = snapshotSheetPresentation(source);
  if (!presentation.merges) return presentation;

  const merges: SheetCellRange[] = [];
  for (const sourceRange of presentation.merges) {
    const range = { ...sourceRange };
    transformRangeAxis(range, operation);
    const rowSpan = range.endRow - range.startRow;
    const columnSpan = range.endColumn - range.startColumn;
    if (rowSpan <= 0 || columnSpan <= 0 || (rowSpan === 1 && columnSpan === 1)) continue;
    merges.push(range);
  }
  return { ...presentation, merges };
}

function insertRow(sourceRows: readonly (readonly string[])[], requestedIndex: number): string[][] {
  const rows = cloneRows(sourceRows);
  const index = Math.min(requestedIndex, rows.length);
  const width = Math.max(1, widestRow(rows));
  rows.splice(index, 0, Array<string>(width).fill(''));
  return rows;
}

function deleteRow(sourceRows: readonly (readonly string[])[], index: number): string[][] {
  const rows = cloneRows(sourceRows);
  if (index >= rows.length) throw new RangeError('Cannot delete a virtual sheet row.');
  rows.splice(index, 1);
  return rows;
}

function insertColumn(
  sourceRows: readonly (readonly string[])[],
  requestedIndex: number
): string[][] {
  const width = widestRow(sourceRows);
  const rows = sourceRows.length === 0 ? [[]] : rectangularRows(sourceRows, width);
  const index = Math.min(requestedIndex, width);
  for (const row of rows) row.splice(index, 0, '');
  return rows;
}

function deleteColumn(sourceRows: readonly (readonly string[])[], index: number): string[][] {
  const width = widestRow(sourceRows);
  if (index >= width) throw new RangeError('Cannot delete a virtual sheet column.');
  if (width === 1) return [];

  const rows = rectangularRows(sourceRows, width);
  for (const row of rows) row.splice(index, 1);
  return rows;
}

function transformRangeAxis(range: SheetCellRange, operation: SheetStructureOperation): void {
  const startKey = operation.axis === 'row' ? 'startRow' : 'startColumn';
  const endKey = operation.axis === 'row' ? 'endRow' : 'endColumn';
  const start = range[startKey];
  const end = range[endKey];
  const { index } = operation;

  if (operation.kind === 'insert') {
    if (index <= start) {
      range[startKey] = start + 1;
      range[endKey] = end + 1;
    } else if (index < end) {
      range[endKey] = end + 1;
    }
    return;
  }

  if (index < start) {
    range[startKey] = start - 1;
    range[endKey] = end - 1;
  } else if (index < end) {
    range[endKey] = end - 1;
  }
}

function rectangularRows(sourceRows: readonly (readonly string[])[], width: number): string[][] {
  return sourceRows.map((sourceRow) => {
    const row = [...sourceRow];
    while (row.length < width) row.push('');
    return row;
  });
}

function cloneRows(rows: readonly (readonly string[])[]): string[][] {
  return rows.map((row) => [...row]);
}

function widestRow(rows: readonly (readonly string[])[]): number {
  return rows.reduce((widest, row) => Math.max(widest, row.length), 0);
}

function assertOperation(operation: SheetStructureOperation): void {
  if (
    !operation ||
    (operation.axis !== 'row' && operation.axis !== 'column') ||
    (operation.kind !== 'insert' && operation.kind !== 'delete') ||
    !Number.isSafeInteger(operation.index) ||
    operation.index < 0
  ) {
    throw new RangeError('Sheet structure operations require a non-negative safe-integer index.');
  }
}
