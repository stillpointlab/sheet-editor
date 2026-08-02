import type { SheetCellRange } from './presentation';

const A1_RANGE = /^([A-Z]+)([1-9][0-9]*):([A-Z]+)([1-9][0-9]*)$/u;

export function parseA1Range(value: string): SheetCellRange | null {
  if (typeof value !== 'string') return null;
  const match = A1_RANGE.exec(value);
  if (!match) return null;

  const startColumnNumber = parseColumnNumber(match[1]);
  const endColumnNumber = parseColumnNumber(match[3]);
  const startRowNumber = Number(match[2]);
  const endRowNumber = Number(match[4]);
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
  const area = (range.endRow - range.startRow) * (range.endColumn - range.startColumn);
  return area >= 2 ? range : null;
}

export function formatA1Range(range: SheetCellRange): string {
  if (!isValidRuntimeRange(range)) {
    throw new RangeError('A sheet range must use valid half-open coordinates covering two cells.');
  }
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
  return rowSpan > 0 && columnSpan > 0 && rowSpan * columnSpan >= 2;
}
