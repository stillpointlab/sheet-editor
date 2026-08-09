import {
  DEFAULT_CSV_LIMITS,
  parseCsv,
  serializeCsv,
  type CsvParseResult,
  type CsvSourceStyle,
} from '../csv';
import { parseSheetDocument, serializeSheetDocument } from '../document';
import {
  snapshotSheetPresentation,
  validateSheetPresentation,
  type SheetContentOptions,
  type SheetPresentation,
  type SheetPresentationIssue,
} from '../presentation/presentation';

export type SheetPresentationOverride = SheetPresentation | null | undefined;

export interface SheetEditorSourceSession {
  readonly kind: 'csv' | 'document';
  readonly originalSource: string;
  readonly model: CsvParseResult;
  readonly baselineRows: readonly (readonly string[])[];
  readonly embeddedPresentation: SheetPresentation;
  readonly presentationOverride: SheetPresentationOverride;
  readonly presentationIssues: readonly SheetPresentationIssue[];
  readonly editable: boolean;
  serialize(rows: readonly (readonly string[])[], embeddedPresentation: SheetPresentation): string;
  serializeRowsForLimit(rows: readonly (readonly string[])[]): string;
  validateCandidate(
    rows: readonly (readonly string[])[],
    embeddedPresentation: SheetPresentation
  ): boolean;
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
  const presentationOverride = snapshotPresentationOverride(options.presentation);
  const serializeRows = (rows: readonly (readonly string[])[]): string =>
    serializeCsv(rows, {
      bom: sourceStyle.bom,
      lineEnding: sourceStyle.lineEnding,
      terminateFinalRecord: sourceStyle.finalRecordTerminated,
      escapeFormulas: false,
    });

  return {
    kind: 'csv',
    originalSource: source,
    model,
    baselineRows,
    embeddedPresentation: {},
    presentationOverride,
    presentationIssues: [],
    editable: model.ok && !model.truncated,
    serialize(rows): string {
      if (rowsEqual(rows, baselineRows)) return source;
      return serializeRows(rows);
    },
    serializeRowsForLimit: serializeRows,
    validateCandidate(rows): boolean {
      const reparsed = parseCsv(serializeRows(rows), DEFAULT_CSV_LIMITS);
      return reparsed.ok && !reparsed.truncated && rowsEqual(reparsed.rows, rows);
    },
  };
}

export function createDocumentSourceSession(
  source: string,
  options: SheetContentOptions = {}
): SheetEditorSourceSession {
  const presentationOverride = snapshotPresentationOverride(options.presentation);
  const parsed = parseSheetDocument(source, { csvLimits: DEFAULT_CSV_LIMITS });
  if (!parsed.ok) {
    return {
      kind: 'document',
      originalSource: source,
      model: {
        ok: false,
        error: { code: 'invalid_csv', message: parsed.error.message },
      },
      baselineRows: [],
      embeddedPresentation: {},
      presentationOverride,
      presentationIssues: [],
      editable: false,
      serialize: () => source,
      serializeRowsForLimit: () => '',
      validateCandidate: () => false,
    };
  }

  const model = snapshotSuccessfulModel(parsed.document.data);
  const baselineRows = snapshotRows(model.rows);
  const parsedPresentation = snapshotSheetPresentation(parsed.document.presentation);
  const validation = validateSheetPresentation(parsedPresentation, {
    rows: model.rows,
    totalRows: model.totalRows,
    maxColumns: model.maxColumns,
    headerRow: false,
  });
  const embeddedPresentation = validation.ok ? validation.presentation : parsedPresentation;
  const editable = !model.truncated && validation.ok;
  const lineEnding = source.startsWith('---\r\n') ? '\r\n' : '\n';
  const serializeRows = (rows: readonly (readonly string[])[]): string =>
    serializeCsv(rows, { lineEnding, bom: false, escapeFormulas: false });

  return {
    kind: 'document',
    originalSource: source,
    model,
    baselineRows,
    embeddedPresentation,
    presentationOverride,
    presentationIssues: validation.ok ? [] : validation.issues,
    editable,
    serialize(rows, currentPresentation): string {
      if (
        (rowsEqual(rows, baselineRows) &&
          presentationsEqual(currentPresentation, embeddedPresentation)) ||
        !editable
      ) {
        return source;
      }
      return serializeSheetDocument(
        { format: 'csv', rows, presentation: currentPresentation },
        { lineEnding }
      );
    },
    serializeRowsForLimit: serializeRows,
    validateCandidate(rows, currentPresentation): boolean {
      try {
        const candidate = serializeSheetDocument(
          { format: 'csv', rows, presentation: currentPresentation },
          { lineEnding }
        );
        const reparsed = parseSheetDocument(candidate, { csvLimits: DEFAULT_CSV_LIMITS });
        return (
          reparsed.ok &&
          !reparsed.document.data.truncated &&
          rowsEqual(reparsed.document.data.rows, rows) &&
          presentationsEqual(reparsed.document.presentation, currentPresentation)
        );
      } catch {
        return false;
      }
    },
  };
}

export function snapshotPresentationOverride(
  presentation: SheetPresentationOverride
): SheetPresentationOverride {
  if (presentation === null || presentation === undefined) return presentation;
  return snapshotSheetPresentation(presentation);
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

function presentationsEqual(left: SheetPresentation, right: SheetPresentation): boolean {
  const leftMerges = sortedMerges(left);
  const rightMerges = sortedMerges(right);
  if (leftMerges.length !== rightMerges.length) return false;
  if (
    !leftMerges.every((range, index) => {
      const other = rightMerges[index];
      return (
        other !== undefined &&
        range.startRow === other.startRow &&
        range.endRow === other.endRow &&
        range.startColumn === other.startColumn &&
        range.endColumn === other.endColumn
      );
    })
  )
    return false;
  return (
    JSON.stringify(left.formats ?? []) === JSON.stringify(right.formats ?? []) &&
    JSON.stringify(left.alignments ?? []) === JSON.stringify(right.alignments ?? [])
  );
}

function sortedMerges(presentation: SheetPresentation) {
  return [...(presentation.merges ?? [])].sort(
    (left, right) =>
      left.startRow - right.startRow ||
      left.startColumn - right.startColumn ||
      left.endRow - right.endRow ||
      left.endColumn - right.endColumn
  );
}
