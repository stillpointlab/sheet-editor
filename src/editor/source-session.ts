import {
  DEFAULT_CSV_LIMITS,
  parseCsv,
  serializeCsv,
  type CsvParseResult,
  type CsvSourceStyle,
} from '../csv';
import { parseSheetDocument, serializeSheetDocument } from '../document';
import {
  resolveSheetPresentation,
  snapshotSheetPresentation,
  validateSheetPresentation,
  type SheetContentOptions,
  type SheetPresentation,
  type SheetPresentationIssue,
} from '../presentation/presentation';

export interface SheetEditorSourceSession {
  readonly originalSource: string;
  readonly model: CsvParseResult;
  readonly baselineRows: readonly (readonly string[])[];
  readonly embeddedPresentation: SheetPresentation;
  readonly resolvedPresentation: SheetPresentation;
  readonly presentationIssues: readonly SheetPresentationIssue[];
  readonly editable: boolean;
  serialize(rows: readonly (readonly string[])[]): string;
  serializeRowsForLimit(rows: readonly (readonly string[])[]): string;
}

const DEFAULT_SOURCE_STYLE: CsvSourceStyle = {
  bom: false,
  lineEnding: '\r\n',
  finalRecordTerminated: false,
};

export function createCsvSourceSession(
  source: string,
  options: SheetContentOptions = {}
): SheetEditorSourceSession {
  const model = parseCsv(source);
  const baselineRows = model.ok ? snapshotRows(model.rows) : [];
  const sourceStyle = model.ok ? { ...model.sourceStyle } : { ...DEFAULT_SOURCE_STYLE };
  const resolvedPresentation = snapshotSheetPresentation(options.presentation);
  const serializeRows = (rows: readonly (readonly string[])[]): string =>
    serializeCsv(rows, {
      bom: sourceStyle.bom,
      lineEnding: sourceStyle.lineEnding,
      terminateFinalRecord: sourceStyle.finalRecordTerminated,
      escapeFormulas: false,
    });

  return {
    originalSource: source,
    model,
    baselineRows,
    embeddedPresentation: {},
    resolvedPresentation,
    presentationIssues: [],
    editable: model.ok && !model.truncated,
    serialize(rows): string {
      if (rowsEqual(rows, baselineRows)) return source;
      return serializeRows(rows);
    },
    serializeRowsForLimit: serializeRows,
  };
}

export function createDocumentSourceSession(
  source: string,
  options: SheetContentOptions = {}
): SheetEditorSourceSession {
  const parsed = parseSheetDocument(source, { csvLimits: DEFAULT_CSV_LIMITS });
  if (!parsed.ok) {
    return {
      originalSource: source,
      model: {
        ok: false,
        error: { code: 'invalid_csv', message: parsed.error.message },
      },
      baselineRows: [],
      embeddedPresentation: {},
      resolvedPresentation: {},
      presentationIssues: [],
      editable: false,
      serialize: () => source,
      serializeRowsForLimit: () => '',
    };
  }

  const model = snapshotSuccessfulModel(parsed.document.data);
  const baselineRows = snapshotRows(model.rows);
  const embeddedPresentation = snapshotSheetPresentation(parsed.document.presentation);
  const validation = validateSheetPresentation(embeddedPresentation, {
    rows: model.rows,
    totalRows: model.totalRows,
    maxColumns: model.maxColumns,
    headerRow: false,
  });
  const editable = !model.truncated && validation.ok;
  const resolvedPresentation = validation.ok
    ? resolveSheetPresentation(embeddedPresentation, options.presentation)
    : {};
  const lineEnding = source.startsWith('---\r\n') ? '\r\n' : '\n';
  const serializeRows = (rows: readonly (readonly string[])[]): string =>
    serializeCsv(rows, { lineEnding, bom: false, escapeFormulas: false });

  return {
    originalSource: source,
    model,
    baselineRows,
    embeddedPresentation,
    resolvedPresentation,
    presentationIssues: validation.ok ? [] : validation.issues,
    editable,
    serialize(rows): string {
      if (rowsEqual(rows, baselineRows) || !editable) return source;
      return serializeSheetDocument(
        { format: 'csv', rows, presentation: embeddedPresentation },
        { lineEnding }
      );
    },
    serializeRowsForLimit: serializeRows,
  };
}

function snapshotRows(rows: readonly (readonly string[])[]): string[][] {
  return rows.map((row) => [...row]);
}

function snapshotSuccessfulModel(
  model: Extract<CsvParseResult, { ok: true }>
): Extract<CsvParseResult, { ok: true }> {
  return {
    ...model,
    rows: snapshotRows(model.rows),
    sourceStyle: { ...model.sourceStyle },
  };
}

function rowsEqual(
  left: readonly (readonly string[])[],
  right: readonly (readonly string[])[]
): boolean {
  if (left.length !== right.length) return false;
  return left.every(
    (row, rowIndex) =>
      row.length === right[rowIndex].length &&
      row.every((value, columnIndex) => value === right[rowIndex][columnIndex])
  );
}
