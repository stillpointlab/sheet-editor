import { DEFAULT_CSV_LIMITS, utf8ByteLength, type CsvLimits } from '../csv';

import type { SheetCoordinate } from '../interaction';
import type { SheetCellRange } from '../presentation';

export type TabularClipboardErrorCode =
  'input_too_large' | 'too_many_rows' | 'too_many_columns' | 'cell_too_large' | 'invalid_tsv';

export interface TabularClipboardError {
  code: TabularClipboardErrorCode;
  message: string;
}

export type TabularClipboardParseResult =
  | {
      ok: true;
      rows: string[][];
      rowCount: number;
      columnCount: number;
    }
  | {
      ok: false;
      error: TabularClipboardError;
    };

export function serializeTabularClipboard(rows: readonly (readonly string[])[]): string {
  return rows
    .map((row) => row.map((value) => quoteTabularField(String(value))).join('\t'))
    .join('\n');
}

export function parseTabularClipboard(
  source: string,
  overrides: Partial<CsvLimits> = {}
): TabularClipboardParseResult {
  const limits = resolveLimits(overrides);
  const inputBytes = utf8ByteLength(source);
  if (inputBytes > limits.maxInputBytes) {
    return failure(
      'input_too_large',
      `Clipboard content is ${inputBytes.toLocaleString('en-US')} bytes; the paste limit is ${limits.maxInputBytes.toLocaleString('en-US')} bytes.`
    );
  }
  if (source === '') return success([['']]);

  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentField = '';
  let currentFieldBytes = 0;
  let fieldStarted = false;
  let inQuotes = false;
  let closedQuote = false;
  let endedWithRecordDelimiter = false;
  let parseFailure: TabularClipboardParseResult | null = null;

  const location = (): string => `row ${rows.length + 1}, column ${currentRow.length + 1}`;

  const append = (value: string): void => {
    currentFieldBytes += utf8ByteLength(value);
    if (currentFieldBytes > limits.maxCellBytes) {
      parseFailure = failure(
        'cell_too_large',
        `Clipboard cell at ${location()} exceeds the ${limits.maxCellBytes.toLocaleString('en-US')}-byte limit.`
      );
      return;
    }
    currentField += value;
  };

  const finishField = (): void => {
    if (currentRow.length >= limits.maxColumns) {
      parseFailure = failure(
        'too_many_columns',
        `Clipboard row ${rows.length + 1} exceeds the ${limits.maxColumns.toLocaleString('en-US')}-column limit.`
      );
      return;
    }
    currentRow.push(currentField);
    currentField = '';
    currentFieldBytes = 0;
    fieldStarted = false;
    closedQuote = false;
  };

  const finishRow = (): void => {
    finishField();
    if (parseFailure) return;
    if (rows.length >= limits.maxMaterializedRows) {
      parseFailure = failure(
        'too_many_rows',
        `Clipboard content exceeds the ${limits.maxMaterializedRows.toLocaleString('en-US')}-row limit.`
      );
      return;
    }
    rows.push(currentRow);
    currentRow = [];
  };

  let index = 0;
  while (index < source.length && !parseFailure) {
    const character = source[index];

    if (inQuotes) {
      if (character === '"') {
        if (source[index + 1] === '"') {
          append('"');
          index += 2;
        } else {
          inQuotes = false;
          closedQuote = true;
          index += 1;
        }
        continue;
      }
      const codePoint = source.codePointAt(index);
      if (codePoint === undefined) break;
      const value = String.fromCodePoint(codePoint);
      append(value);
      index += value.length;
      continue;
    }

    if (closedQuote) {
      if (character === '\t') {
        finishField();
        endedWithRecordDelimiter = false;
        index += 1;
        continue;
      }
      if (character === '\n') {
        finishRow();
        endedWithRecordDelimiter = true;
        index += 1;
        continue;
      }
      if (character === '\r' && source[index + 1] === '\n') {
        finishRow();
        endedWithRecordDelimiter = true;
        index += 2;
        continue;
      }
      parseFailure = failure(
        'invalid_tsv',
        `Unexpected character after closing quote at ${location()}.`
      );
      break;
    }

    if (character === '"') {
      if (fieldStarted) {
        parseFailure = failure(
          'invalid_tsv',
          `Unexpected quote in unquoted clipboard field at ${location()}.`
        );
        break;
      }
      fieldStarted = true;
      inQuotes = true;
      endedWithRecordDelimiter = false;
      index += 1;
      continue;
    }

    if (character === '\t') {
      finishField();
      endedWithRecordDelimiter = false;
      index += 1;
      continue;
    }
    if (character === '\n') {
      finishRow();
      endedWithRecordDelimiter = true;
      index += 1;
      continue;
    }
    if (character === '\r') {
      if (source[index + 1] !== '\n') {
        parseFailure = failure(
          'invalid_tsv',
          `Bare carriage return outside a quoted clipboard field at ${location()}.`
        );
        break;
      }
      finishRow();
      endedWithRecordDelimiter = true;
      index += 2;
      continue;
    }

    const codePoint = source.codePointAt(index);
    if (codePoint === undefined) break;
    const value = String.fromCodePoint(codePoint);
    append(value);
    fieldStarted = true;
    endedWithRecordDelimiter = false;
    index += value.length;
  }

  if (parseFailure) return parseFailure;
  if (inQuotes) {
    return failure('invalid_tsv', `Unclosed quoted clipboard field at ${location()}.`);
  }
  if (!endedWithRecordDelimiter) {
    finishRow();
    if (parseFailure) return parseFailure;
  }
  return success(rows);
}

export function extractTabularSelection(
  sourceRows: readonly (readonly string[])[],
  range: SheetCellRange,
  isCovered: (row: number, column: number) => boolean = () => false
): string[][] {
  const rows: string[][] = [];
  for (let row = range.startRow; row < range.endRow; row += 1) {
    const values: string[] = [];
    for (let column = range.startColumn; column < range.endColumn; column += 1) {
      values.push(isCovered(row, column) ? '' : (sourceRows[row]?.[column] ?? ''));
    }
    rows.push(values);
  }
  return rows;
}

export function applyTabularPaste(
  sourceRows: readonly (readonly string[])[],
  start: SheetCoordinate,
  matrix: readonly (readonly string[])[]
): string[][] {
  const rows = cloneRows(sourceRows);
  for (let rowOffset = 0; rowOffset < matrix.length; rowOffset += 1) {
    const values = matrix[rowOffset];
    const targetRow = start.row + rowOffset;
    for (let columnOffset = 0; columnOffset < values.length; columnOffset += 1) {
      const value = values[columnOffset];
      const targetColumn = start.column + columnOffset;
      const existingRow = rows[targetRow];
      if (existingRow && targetColumn < existingRow.length) {
        existingRow[targetColumn] = value;
        continue;
      }
      if (value === '') continue;
      while (rows.length <= targetRow) rows.push([]);
      const row = rows[targetRow];
      while (row.length < targetColumn) row.push('');
      row.push(value);
    }
  }
  return rows;
}

export function clearTabularRange(
  sourceRows: readonly (readonly string[])[],
  range: SheetCellRange
): string[][] {
  const rows = cloneRows(sourceRows);
  const endRow = Math.min(range.endRow, rows.length);
  for (let rowIndex = range.startRow; rowIndex < endRow; rowIndex += 1) {
    const row = rows[rowIndex];
    const endColumn = Math.min(range.endColumn, row.length);
    for (let column = range.startColumn; column < endColumn; column += 1) {
      row[column] = '';
    }
  }
  return rows;
}

function success(rows: string[][]): TabularClipboardParseResult {
  const columnCount = rows.reduce((widest, row) => Math.max(widest, row.length), 0);
  const rectangularRows = rows.map((row) => [
    ...row,
    ...Array.from({ length: columnCount - row.length }, () => ''),
  ]);
  return { ok: true, rows: rectangularRows, rowCount: rows.length, columnCount };
}

function resolveLimits(overrides: Partial<CsvLimits>): CsvLimits {
  const limits = { ...DEFAULT_CSV_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RangeError(`${name} must be a positive safe integer`);
    }
  }
  return limits;
}

function failure(code: TabularClipboardErrorCode, message: string): TabularClipboardParseResult {
  return { ok: false, error: { code, message } };
}

function quoteTabularField(value: string): string {
  if (!/[\t\r\n"]/u.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

function cloneRows(rows: readonly (readonly string[])[]): string[][] {
  return rows.map((row) => [...row]);
}
