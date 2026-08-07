export interface CsvLimits {
  maxInputBytes: number;
  maxMaterializedRows: number;
  maxColumns: number;
  maxCellBytes: number;
}

export type CsvParseErrorCode =
  'input_too_large' | 'too_many_columns' | 'cell_too_large' | 'invalid_csv';

export interface CsvParseError {
  code: CsvParseErrorCode;
  message: string;
}

export interface CsvSourceStyle {
  bom: boolean;
  lineEnding: '\r\n' | '\n';
  finalRecordTerminated: boolean;
}

export type CsvParseResult =
  | {
      ok: true;
      rows: string[][];
      totalRows: number;
      maxColumns: number;
      truncated: boolean;
      sourceStyle: CsvSourceStyle;
    }
  | {
      ok: false;
      error: CsvParseError;
    };

export interface CsvSerializeOptions {
  bom?: boolean;
  escapeFormulas?: boolean;
  lineEnding?: '\r\n' | '\n';
  terminateFinalRecord?: boolean;
}

export const DEFAULT_CSV_LIMITS: Readonly<CsvLimits> = Object.freeze({
  maxInputBytes: 256 * 1024,
  maxMaterializedRows: 1000,
  maxColumns: 256,
  maxCellBytes: 64 * 1024,
});

const textEncoder = new TextEncoder();

export function utf8ByteLength(value: string): number {
  return textEncoder.encode(value).byteLength;
}

export function parseCsv(source: string, overrides: Partial<CsvLimits> = {}): CsvParseResult {
  const limits = resolveLimits(overrides);
  const inputBytes = utf8ByteLength(source);
  if (inputBytes > limits.maxInputBytes) {
    return failure(
      'input_too_large',
      `CSV is ${inputBytes} bytes; the preview limit is ${limits.maxInputBytes} bytes.`
    );
  }

  const bom = source.startsWith('\uFEFF');
  const input = bom ? source.slice(1) : source;
  if (input === '') {
    return {
      ok: true,
      rows: [],
      totalRows: 0,
      maxColumns: 0,
      truncated: false,
      sourceStyle: defaultSourceStyle(bom),
    };
  }

  const rows: string[][] = [];
  let totalRows = 0;
  let maxColumns = 0;
  let currentRow: string[] | null = [];
  let currentField = '';
  let currentFieldBytes = 0;
  let columnsInRow = 0;
  let fieldStarted = false;
  let inQuotes = false;
  let closedQuote = false;
  let endedWithRecordDelimiter = false;
  let parseFailure: CsvParseResult | null = null;
  let lfCount = 0;
  let crlfCount = 0;
  let firstLineEnding: '\r\n' | '\n' | null = null;

  const location = (): string => `row ${totalRows + 1}, column ${columnsInRow + 1}`;

  const append = (value: string, bytes: number): void => {
    currentFieldBytes += bytes;
    if (currentFieldBytes > limits.maxCellBytes) {
      parseFailure = failure(
        'cell_too_large',
        `CSV cell at ${location()} exceeds ${limits.maxCellBytes} bytes.`
      );
      return;
    }
    if (currentRow) currentField += value;
  };

  const finishField = (): void => {
    columnsInRow += 1;
    if (columnsInRow > limits.maxColumns) {
      parseFailure = failure(
        'too_many_columns',
        `CSV row ${totalRows + 1} exceeds ${limits.maxColumns} columns.`
      );
      return;
    }
    currentRow?.push(currentField);
    currentField = '';
    currentFieldBytes = 0;
    fieldStarted = false;
    closedQuote = false;
  };

  const finishRow = (): void => {
    finishField();
    if (parseFailure) return;
    maxColumns = Math.max(maxColumns, columnsInRow);
    if (currentRow) rows.push(currentRow);
    totalRows += 1;
    currentRow = totalRows < limits.maxMaterializedRows ? [] : null;
    columnsInRow = 0;
  };

  const recordLineEnding = (lineEnding: '\r\n' | '\n'): void => {
    firstLineEnding ??= lineEnding;
    if (lineEnding === '\r\n') crlfCount += 1;
    else lfCount += 1;
  };

  let index = 0;
  while (index < input.length && !parseFailure) {
    const ch = input[index];

    if (inQuotes) {
      if (ch === '"') {
        if (input[index + 1] === '"') {
          append('"', 1);
          index += 2;
        } else {
          inQuotes = false;
          closedQuote = true;
          index += 1;
        }
        continue;
      }

      const codePoint = input.codePointAt(index);
      if (codePoint === undefined) break;
      const value = String.fromCodePoint(codePoint);
      append(value, utf8BytesForCodePoint(codePoint));
      index += value.length;
      continue;
    }

    if (closedQuote) {
      if (ch === ',') {
        finishField();
        endedWithRecordDelimiter = false;
        index += 1;
        continue;
      }
      if (ch === '\n') {
        finishRow();
        recordLineEnding('\n');
        endedWithRecordDelimiter = true;
        index += 1;
        continue;
      }
      if (ch === '\r' && input[index + 1] === '\n') {
        finishRow();
        recordLineEnding('\r\n');
        endedWithRecordDelimiter = true;
        index += 2;
        continue;
      }
      parseFailure = failure(
        'invalid_csv',
        `Unexpected character after closing quote at ${location()}.`
      );
      break;
    }

    if (ch === '"') {
      if (fieldStarted) {
        parseFailure = failure(
          'invalid_csv',
          `Unexpected quote in unquoted field at ${location()}.`
        );
        break;
      }
      fieldStarted = true;
      inQuotes = true;
      endedWithRecordDelimiter = false;
      index += 1;
      continue;
    }

    if (ch === ',') {
      finishField();
      endedWithRecordDelimiter = false;
      index += 1;
      continue;
    }

    if (ch === '\n') {
      finishRow();
      recordLineEnding('\n');
      endedWithRecordDelimiter = true;
      index += 1;
      continue;
    }

    if (ch === '\r') {
      if (input[index + 1] !== '\n') {
        parseFailure = failure(
          'invalid_csv',
          `Bare carriage return outside a quoted field at ${location()}.`
        );
        break;
      }
      finishRow();
      recordLineEnding('\r\n');
      endedWithRecordDelimiter = true;
      index += 2;
      continue;
    }

    const codePoint = input.codePointAt(index);
    if (codePoint === undefined) break;
    const value = String.fromCodePoint(codePoint);
    append(value, utf8BytesForCodePoint(codePoint));
    fieldStarted = true;
    endedWithRecordDelimiter = false;
    index += value.length;
  }

  if (parseFailure) return parseFailure;
  if (inQuotes) {
    return failure('invalid_csv', `Unclosed quoted field at ${location()}.`);
  }
  if (!endedWithRecordDelimiter) {
    finishRow();
    if (parseFailure) return parseFailure;
  }

  return {
    ok: true,
    rows,
    totalRows,
    maxColumns,
    truncated: totalRows > rows.length,
    sourceStyle: {
      bom,
      lineEnding:
        crlfCount === lfCount ? (firstLineEnding ?? '\r\n') : crlfCount > lfCount ? '\r\n' : '\n',
      finalRecordTerminated: endedWithRecordDelimiter,
    },
  };
}

export function serializeCsv(
  rows: readonly (readonly string[])[],
  options: CsvSerializeOptions = {}
): string {
  const lineEnding = options.lineEnding ?? '\r\n';
  if (lineEnding !== '\r\n' && lineEnding !== '\n') {
    throw new RangeError('lineEnding must be CRLF or LF');
  }

  const content = rows
    .map((row, rowIndex) => {
      const serialized = row
        .map((rawCell) => {
          const cell = options.escapeFormulas ? escapeFormula(String(rawCell)) : String(rawCell);
          return quoteCell(cell);
        })
        .join(',');
      const isFinalAmbiguousBlank =
        rowIndex === rows.length - 1 &&
        !options.terminateFinalRecord &&
        (row.length === 0 || (row.length === 1 && String(row[0]) === ''));
      return isFinalAmbiguousBlank ? '""' : serialized;
    })
    .join(lineEnding);

  const terminated =
    options.terminateFinalRecord && rows.length > 0 ? `${content}${lineEnding}` : content;
  return `${options.bom ? '\uFEFF' : ''}${terminated}`;
}

function defaultSourceStyle(bom: boolean): CsvSourceStyle {
  return { bom, lineEnding: '\r\n', finalRecordTerminated: false };
}

function resolveLimits(overrides: Partial<CsvLimits>): CsvLimits {
  const resolved: CsvLimits = {
    ...DEFAULT_CSV_LIMITS,
    ...overrides,
  };
  for (const [name, value] of Object.entries(resolved)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RangeError(`${name} must be a positive safe integer`);
    }
  }
  return resolved;
}

function failure(code: CsvParseErrorCode, message: string): CsvParseResult {
  return { ok: false, error: { code, message } };
}

function utf8BytesForCodePoint(codePoint: number): number {
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}

function escapeFormula(value: string): string {
  return /^[\t\r]/u.test(value) || /^\s*[=+\-@]/u.test(value) ? `'${value}` : value;
}

function quoteCell(value: string): string {
  if (!/[",\r\n]/u.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}
