export interface SheetCellRange {
  startRow: number;
  endRow: number;
  startColumn: number;
  endColumn: number;
}

export interface SheetPresentation {
  merges?: readonly SheetCellRange[];
}

export interface SheetContentOptions {
  presentation?: SheetPresentation | null;
}

export interface SheetPresentationValidationContext {
  rows: readonly (readonly string[])[];
  totalRows: number;
  maxColumns: number;
  headerRow: boolean;
}

export const MAX_SHEET_MERGES = 4096;

export type SheetPresentationIssueCode =
  | 'unknown_property'
  | 'too_many_merges'
  | 'invalid_coordinate'
  | 'invalid_range'
  | 'out_of_bounds'
  | 'truncated_range'
  | 'overlapping_merges'
  | 'non_empty_covered_cell'
  | 'header_boundary';

export interface SheetPresentationIssue {
  code: SheetPresentationIssueCode;
  message: string;
  mergeIndex?: number;
  conflictingMergeIndex?: number;
}

export type SheetPresentationValidationResult =
  | { ok: true; presentation: { merges: SheetCellRange[] } }
  | { ok: false; issues: SheetPresentationIssue[] };

const RANGE_KEYS = new Set(['startRow', 'endRow', 'startColumn', 'endColumn']);

export function validateSheetPresentation(
  presentation: SheetPresentation,
  context: SheetPresentationValidationContext
): SheetPresentationValidationResult {
  assertValidationContext(context);

  const issues: SheetPresentationIssue[] = [];
  if (!isRecord(presentation)) {
    return invalid('invalid_range', 'Sheet presentation must be an object.');
  }

  for (const property of Object.keys(presentation)) {
    if (property !== 'merges') {
      issues.push({
        code: 'unknown_property',
        message: `Unknown sheet presentation property: ${property}.`,
      });
    }
  }

  const rawMerges = presentation.merges;
  if (rawMerges === undefined) {
    return issues.length > 0 ? { ok: false, issues } : success([]);
  }
  if (!Array.isArray(rawMerges)) {
    issues.push({ code: 'invalid_range', message: 'Sheet presentation merges must be an array.' });
    return { ok: false, issues };
  }
  if (rawMerges.length > MAX_SHEET_MERGES) {
    issues.push({
      code: 'too_many_merges',
      message: `Sheet presentation exceeds ${MAX_SHEET_MERGES} merged ranges.`,
    });
    return { ok: false, issues };
  }

  const normalized: SheetCellRange[] = [];
  const comparable: Array<{ range: SheetCellRange; mergeIndex: number }> = [];

  for (let mergeIndex = 0; mergeIndex < rawMerges.length; mergeIndex += 1) {
    const rawRange: unknown = rawMerges[mergeIndex];
    if (!isRecord(rawRange)) {
      issues.push({
        code: 'invalid_range',
        message: `Merged range ${mergeIndex} must be an object.`,
        mergeIndex,
      });
      continue;
    }

    for (const property of Object.keys(rawRange)) {
      if (!RANGE_KEYS.has(property)) {
        issues.push({
          code: 'unknown_property',
          message: `Merged range ${mergeIndex} has unknown property: ${property}.`,
          mergeIndex,
        });
      }
    }

    const coordinates = [
      rawRange.startRow,
      rawRange.endRow,
      rawRange.startColumn,
      rawRange.endColumn,
    ];
    if (!coordinates.every(isCoordinate)) {
      issues.push({
        code: 'invalid_coordinate',
        message: `Merged range ${mergeIndex} must use finite, non-negative safe-integer coordinates.`,
        mergeIndex,
      });
      continue;
    }

    const range: SheetCellRange = {
      startRow: rawRange.startRow as number,
      endRow: rawRange.endRow as number,
      startColumn: rawRange.startColumn as number,
      endColumn: rawRange.endColumn as number,
    };
    const rowSpan = range.endRow - range.startRow;
    const columnSpan = range.endColumn - range.startColumn;
    if (rowSpan <= 0 || columnSpan <= 0 || (rowSpan === 1 && columnSpan === 1)) {
      issues.push({
        code: 'invalid_range',
        message: `Merged range ${mergeIndex} must cover at least two cells in a non-empty rectangle.`,
        mergeIndex,
      });
      continue;
    }

    normalized.push({ ...range });
    comparable.push({ range, mergeIndex });

    if (range.endRow > context.totalRows || range.endColumn > context.maxColumns) {
      issues.push({
        code: 'out_of_bounds',
        message: `Merged range ${mergeIndex} extends outside the sheet.`,
        mergeIndex,
      });
      continue;
    }
    if (range.endRow > context.rows.length) {
      issues.push({
        code: 'truncated_range',
        message: `Merged range ${mergeIndex} reaches rows that were not materialized.`,
        mergeIndex,
      });
      continue;
    }
    if (context.headerRow && range.startRow === 0 && range.endRow > 1) {
      issues.push({
        code: 'header_boundary',
        message: `Merged range ${mergeIndex} crosses the promoted header boundary.`,
        mergeIndex,
      });
      continue;
    }

    if (hasNonEmptyCoveredCell(range, context.rows)) {
      issues.push({
        code: 'non_empty_covered_cell',
        message: `Merged range ${mergeIndex} would cover a non-empty source cell.`,
        mergeIndex,
      });
    }
  }

  for (let index = 0; index < comparable.length; index += 1) {
    const current = comparable[index];
    for (let previousIndex = 0; previousIndex < index; previousIndex += 1) {
      const previous = comparable[previousIndex];
      if (rangesOverlap(current.range, previous.range)) {
        issues.push({
          code: 'overlapping_merges',
          message: `Merged range ${current.mergeIndex} overlaps merged range ${previous.mergeIndex}.`,
          mergeIndex: current.mergeIndex,
          conflictingMergeIndex: previous.mergeIndex,
        });
      }
    }
  }

  return issues.length > 0 ? { ok: false, issues } : success(normalized);
}

export function snapshotSheetPresentation(
  presentation: SheetPresentation | null | undefined
): SheetPresentation {
  if (presentation === null || presentation === undefined) return {};
  if (!isRecord(presentation)) return presentation;

  const snapshot: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(presentation)) {
    if (key === 'merges' && Array.isArray(value)) {
      snapshot[key] = value.map((range) => (isRecord(range) ? { ...range } : range));
    } else {
      snapshot[key] = value;
    }
  }
  return snapshot as SheetPresentation;
}

export function resolveSheetPresentation(
  embedded: SheetPresentation,
  override: SheetPresentation | null | undefined
): SheetPresentation {
  if (override === undefined) return snapshotSheetPresentation(embedded);
  if (override === null) return {};
  if (!isRecord(override)) return snapshotSheetPresentation(override);

  const embeddedSnapshot = snapshotSheetPresentation(embedded) as Record<string, unknown>;
  const overrideSnapshot = snapshotSheetPresentation(override) as Record<string, unknown>;
  const resolved = { ...embeddedSnapshot, ...overrideSnapshot };
  if (!Object.hasOwn(override, 'merges') || override.merges === undefined) {
    resolved.merges = embeddedSnapshot.merges;
  }
  return resolved as SheetPresentation;
}

function assertValidationContext(context: SheetPresentationValidationContext): void {
  if (!isRecord(context) || !Array.isArray(context.rows)) {
    throw new TypeError('Sheet presentation validation context must contain rows.');
  }
  if (!isCoordinate(context.totalRows) || !isCoordinate(context.maxColumns)) {
    throw new RangeError(
      'Sheet presentation validation bounds must be non-negative safe integers.'
    );
  }
  if (typeof context.headerRow !== 'boolean') {
    throw new TypeError('Sheet presentation headerRow must be boolean.');
  }
  if (context.rows.length > context.totalRows) {
    throw new RangeError('Materialized rows cannot exceed totalRows.');
  }
  for (const row of context.rows) {
    if (!Array.isArray(row) || row.length > context.maxColumns) {
      throw new RangeError('Materialized rows must fit maxColumns.');
    }
    if (!row.every((value) => typeof value === 'string')) {
      throw new TypeError('Materialized sheet cell values must be strings.');
    }
  }
}

function hasNonEmptyCoveredCell(
  range: SheetCellRange,
  rows: readonly (readonly string[])[]
): boolean {
  for (let row = range.startRow; row < range.endRow; row += 1) {
    for (let column = range.startColumn; column < range.endColumn; column += 1) {
      if (row === range.startRow && column === range.startColumn) continue;
      if ((rows[row]?.[column] ?? '') !== '') return true;
    }
  }
  return false;
}

function rangesOverlap(left: SheetCellRange, right: SheetCellRange): boolean {
  return (
    left.startRow < right.endRow &&
    right.startRow < left.endRow &&
    left.startColumn < right.endColumn &&
    right.startColumn < left.endColumn
  );
}

function isCoordinate(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function success(merges: SheetCellRange[]): SheetPresentationValidationResult {
  return { ok: true, presentation: { merges } };
}

function invalid(
  code: SheetPresentationIssueCode,
  message: string
): SheetPresentationValidationResult {
  return { ok: false, issues: [{ code, message }] };
}
