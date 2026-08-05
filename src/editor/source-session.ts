import { parseCsv, serializeCsv, type CsvParseResult, type CsvSourceStyle } from '../csv';
import {
  snapshotSheetPresentation,
  type SheetContentOptions,
  type SheetPresentation,
} from '../presentation/presentation';

export interface SheetEditorSourceSession {
  readonly originalSource: string;
  readonly model: CsvParseResult;
  readonly baselineRows: readonly (readonly string[])[];
  readonly embeddedPresentation: SheetPresentation;
  readonly resolvedPresentation: SheetPresentation;
  readonly editable: boolean;
  serialize(rows: readonly (readonly string[])[]): string;
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

  return {
    originalSource: source,
    model,
    baselineRows,
    embeddedPresentation: {},
    resolvedPresentation,
    editable: model.ok && !model.truncated,
    serialize(rows): string {
      if (rowsEqual(rows, baselineRows)) return source;
      return serializeCsv(rows, {
        bom: sourceStyle.bom,
        lineEnding: sourceStyle.lineEnding,
        terminateFinalRecord: sourceStyle.finalRecordTerminated,
        escapeFormulas: false,
      });
    },
  };
}

function snapshotRows(rows: readonly (readonly string[])[]): string[][] {
  return rows.map((row) => [...row]);
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
