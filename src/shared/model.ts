import { DEFAULT_CSV_LIMITS, utf8ByteLength, type CsvLimits, type CsvParseResult } from '../csv';

export function modelFromRows(
  sourceRows: readonly (readonly string[])[],
  overrides: Partial<CsvLimits> = {}
): CsvParseResult {
  const limits = { ...DEFAULT_CSV_LIMITS, ...overrides };
  const rows: string[][] = [];
  let maxColumns = 0;

  for (let rowIndex = 0; rowIndex < sourceRows.length; rowIndex += 1) {
    const sourceRow = sourceRows[rowIndex];
    if (sourceRow.length > limits.maxColumns) {
      return {
        ok: false,
        error: {
          code: 'too_many_columns',
          message: `Grid row ${rowIndex + 1} exceeds ${limits.maxColumns} columns.`,
        },
      };
    }
    maxColumns = Math.max(maxColumns, sourceRow.length);

    const materialized: string[] | null = rowIndex < limits.maxMaterializedRows ? [] : null;
    for (let columnIndex = 0; columnIndex < sourceRow.length; columnIndex += 1) {
      const value = String(sourceRow[columnIndex]);
      if (utf8ByteLength(value) > limits.maxCellBytes) {
        return {
          ok: false,
          error: {
            code: 'cell_too_large',
            message: `Grid cell at row ${rowIndex + 1}, column ${columnIndex + 1} exceeds ${limits.maxCellBytes} bytes.`,
          },
        };
      }
      materialized?.push(value);
    }
    if (materialized) rows.push(materialized);
  }

  return {
    ok: true,
    rows,
    totalRows: sourceRows.length,
    maxColumns,
    truncated: sourceRows.length > rows.length,
  };
}

export function snapshotSuccessfulModel(
  source: Extract<CsvParseResult, { ok: true }>
): CsvParseResult {
  return {
    ok: true,
    rows: source.rows.map((row) => [...row]),
    totalRows: source.totalRows,
    maxColumns: source.maxColumns,
    truncated: source.truncated,
  };
}
