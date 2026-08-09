import type { SheetCellRange } from './presentation';

const A1_RANGE = /^([A-Z]+)([1-9][0-9]*):([A-Z]+)([1-9][0-9]*)$/u;
const A1_CELL = /^([A-Z]+)([1-9][0-9]*)$/u;

export function parseA1Range(value: string): SheetCellRange | null {
  if (typeof value !== 'string') return null;
  const match = A1_RANGE.exec(value);
  if (!match) return null;

  const range = rangeFromMatch(match[1], match[2], match[3], match[4]);
  if (range === null) return null;
  return rangeArea(range) >= 2 ? range : null;
}

export function parseA1CellRange(value: string): SheetCellRange | null {
  if (typeof value !== 'string') return null;
  const cellMatch = A1_CELL.exec(value);
  if (cellMatch) {
    return rangeFromMatch(cellMatch[1], cellMatch[2], cellMatch[1], cellMatch[2]);
  }
  const rangeMatch = A1_RANGE.exec(value);
  if (!rangeMatch) return null;
  const range = rangeFromMatch(rangeMatch[1], rangeMatch[2], rangeMatch[3], rangeMatch[4]);
  if (range === null || rangeArea(range) === 1) return null;
  return range;
}

function rangeFromMatch(
  startColumnLabel: string,
  startRowLabel: string,
  endColumnLabel: string,
  endRowLabel: string
): SheetCellRange | null {
  const startColumnNumber = parseColumnNumber(startColumnLabel);
  const endColumnNumber = parseColumnNumber(endColumnLabel);
  const startRowNumber = Number(startRowLabel);
  const endRowNumber = Number(endRowLabel);

  if (
    startColumnNumber === null ||
    endColumnNumber === null ||
    !Number.isSafeInteger(startRowNumber) ||
    !Number.isSafeInteger(endRowNumber)
  ) {
    return null;
  }
  if (startRowNumber > endRowNumber || startColumnNumber > endColumnNumber) return null;

  const range: SheetCellRange = {
    startRow: startRowNumber - 1,
    endRow: endRowNumber,
    startColumn: startColumnNumber - 1,
    endColumn: endColumnNumber,
  };
  return range;
}

export function formatA1Range(range: SheetCellRange): string {
  if (!isValidRuntimeRange(range) || rangeArea(range) < 2) {
    throw new RangeError('A sheet range must use valid half-open coordinates covering two cells.');
  }
  return formatRange(range);
}

export function formatA1CellRange(range: SheetCellRange): string {
  if (!isValidRuntimeRange(range)) {
    throw new RangeError('A sheet cell range must use valid non-empty half-open coordinates.');
  }
  if (rangeArea(range) === 1) {
    return `${formatColumn(range.startColumn)}${range.startRow + 1}`;
  }
  return formatRange(range);
}

function formatRange(range: SheetCellRange): string {
  return `${formatColumn(range.startColumn)}${range.startRow + 1}:${formatColumn(range.endColumn - 1)}${range.endRow}`;
}

function parseColumnNumber(label: string): number | null {
  let value = 0;
  for (const character of label) {
    value = value * 26 + (character.charCodeAt(0) - 64);
    if (!Number.isSafeInteger(value)) return null;
  }
  return value;
}

function formatColumn(index: number): string {
  let value = index + 1;
  let label = '';
  while (value > 0) {
    const remainder = (value - 1) % 26;
    label = String.fromCharCode(65 + remainder) + label;
    value = Math.floor((value - 1) / 26);
  }
  return label;
}

function isValidRuntimeRange(range: SheetCellRange): boolean {
  if (typeof range !== 'object' || range === null) return false;
  const coordinates = [range.startRow, range.endRow, range.startColumn, range.endColumn];
  if (!coordinates.every((coordinate) => Number.isSafeInteger(coordinate) && coordinate >= 0)) {
    return false;
  }
  const rowSpan = range.endRow - range.startRow;
  const columnSpan = range.endColumn - range.startColumn;
  return rowSpan > 0 && columnSpan > 0;
}

function rangeArea(range: SheetCellRange): number {
  return (range.endRow - range.startRow) * (range.endColumn - range.startColumn);
}
