export interface SheetCellRange {
  startRow: number;
  endRow: number;
  startColumn: number;
  endColumn: number;
}

export type SheetHorizontalAlignment = 'left' | 'center' | 'right';
export type SheetVerticalAlignment = 'top' | 'middle' | 'bottom';

export interface SheetFormatRule {
  range: SheetCellRange;
  bold?: boolean;
  italic?: boolean;
  strikethrough?: boolean;
}

export interface SheetAlignmentRule {
  range: SheetCellRange;
  horizontal?: SheetHorizontalAlignment;
  vertical?: SheetVerticalAlignment;
}

export interface SheetPresentation {
  merges?: readonly SheetCellRange[];
  formats?: readonly SheetFormatRule[];
  alignments?: readonly SheetAlignmentRule[];
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
export const MAX_SHEET_FORMAT_RULES = 4096;
export const MAX_SHEET_ALIGNMENT_RULES = 4096;

export type SheetPresentationIssueCode =
  | 'unknown_property'
  | 'too_many_merges'
  | 'too_many_formats'
  | 'too_many_alignments'
  | 'invalid_coordinate'
  | 'invalid_range'
  | 'invalid_format'
  | 'invalid_alignment'
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
  formatIndex?: number;
  alignmentIndex?: number;
}

export interface NormalizedSheetPresentation {
  merges: readonly SheetCellRange[];
  formats?: readonly SheetFormatRule[];
  alignments?: readonly SheetAlignmentRule[];
}

export type SheetPresentationValidationResult =
  | { ok: true; presentation: NormalizedSheetPresentation }
  | { ok: false; issues: SheetPresentationIssue[] };

const PRESENTATION_SECTIONS = ['merges', 'formats', 'alignments'] as const;
const RANGE_KEYS = new Set(['startRow', 'endRow', 'startColumn', 'endColumn']);
const FORMAT_KEYS = new Set(['range', 'bold', 'italic', 'strikethrough']);
const ALIGNMENT_KEYS = new Set(['range', 'horizontal', 'vertical']);
const HORIZONTAL_ALIGNMENTS = new Set<SheetHorizontalAlignment>(['left', 'center', 'right']);
const VERTICAL_ALIGNMENTS = new Set<SheetVerticalAlignment>(['top', 'middle', 'bottom']);

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
    if (!PRESENTATION_SECTIONS.some((section) => section === property)) {
      issues.push({
        code: 'unknown_property',
        message: `Unknown sheet presentation property: ${property}.`,
      });
    }
  }

  const merges = validateMerges(presentation.merges, context, issues);
  const formats = validateFormats(presentation.formats, context, issues);
  const alignments = validateAlignments(presentation.alignments, context, issues);
  if (issues.length > 0) return { ok: false, issues };

  const normalizedFormats = normalizeFormats(formats, context.rows.length, context.maxColumns);
  if (normalizedFormats.length > MAX_SHEET_FORMAT_RULES) {
    issues.push({
      code: 'too_many_formats',
      message: `Normalized sheet presentation exceeds ${MAX_SHEET_FORMAT_RULES} format rules.`,
    });
  }
  const normalizedAlignments = normalizeAlignments(
    alignments,
    context.rows.length,
    context.maxColumns
  );
  if (normalizedAlignments.length > MAX_SHEET_ALIGNMENT_RULES) {
    issues.push({
      code: 'too_many_alignments',
      message: `Normalized sheet presentation exceeds ${MAX_SHEET_ALIGNMENT_RULES} alignment rules.`,
    });
  }
  if (issues.length > 0) return { ok: false, issues };

  const normalized: NormalizedSheetPresentation = {
    merges: freezeRanges(merges),
    ...(normalizedFormats.length > 0 ? { formats: freezeRules(normalizedFormats) } : {}),
    ...(normalizedAlignments.length > 0 ? { alignments: freezeRules(normalizedAlignments) } : {}),
  };
  return { ok: true, presentation: Object.freeze(normalized) };
}

function freezeRanges(ranges: readonly SheetCellRange[]): readonly SheetCellRange[] {
  return Object.freeze(ranges.map((range) => Object.freeze({ ...range })));
}

function freezeRules<T extends SheetFormatRule | SheetAlignmentRule>(
  rules: readonly T[]
): readonly T[] {
  return Object.freeze(
    rules.map(
      (rule) => Object.freeze({ ...rule, range: Object.freeze({ ...rule.range }) }) as unknown as T
    )
  );
}

function validateMerges(
  rawMerges: unknown,
  context: SheetPresentationValidationContext,
  issues: SheetPresentationIssue[]
): SheetCellRange[] {
  if (rawMerges === undefined) return [];
  if (!Array.isArray(rawMerges)) {
    issues.push({ code: 'invalid_range', message: 'Sheet presentation merges must be an array.' });
    return [];
  }
  if (rawMerges.length > MAX_SHEET_MERGES) {
    issues.push({
      code: 'too_many_merges',
      message: `Sheet presentation exceeds ${MAX_SHEET_MERGES} merged ranges.`,
    });
    return [];
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

    const range = readRuntimeRange(rawRange);
    if (range === null) {
      issues.push({
        code: 'invalid_coordinate',
        message: `Merged range ${mergeIndex} must use finite, non-negative safe-integer coordinates.`,
        mergeIndex,
      });
      continue;
    }
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

    normalized.push(range);
    comparable.push({ range, mergeIndex });
    validateRangeBounds(range, context, issues, { mergeIndex }, `Merged range ${mergeIndex}`);

    if (context.headerRow && range.startRow === 0 && range.endRow > 1) {
      issues.push({
        code: 'header_boundary',
        message: `Merged range ${mergeIndex} crosses the promoted header boundary.`,
        mergeIndex,
      });
      continue;
    }
    if (range.endRow <= context.rows.length && hasNonEmptyCoveredCell(range, context.rows)) {
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
  return normalized;
}

function validateFormats(
  rawFormats: unknown,
  context: SheetPresentationValidationContext,
  issues: SheetPresentationIssue[]
): SheetFormatRule[] {
  if (rawFormats === undefined) return [];
  if (!Array.isArray(rawFormats)) {
    issues.push({
      code: 'invalid_format',
      message: 'Sheet presentation formats must be an array.',
    });
    return [];
  }
  if (rawFormats.length > MAX_SHEET_FORMAT_RULES) {
    issues.push({
      code: 'too_many_formats',
      message: `Sheet presentation exceeds ${MAX_SHEET_FORMAT_RULES} format rules.`,
    });
    return [];
  }

  const formats: SheetFormatRule[] = [];
  for (let formatIndex = 0; formatIndex < rawFormats.length; formatIndex += 1) {
    const rawRule: unknown = rawFormats[formatIndex];
    if (!isRecord(rawRule)) {
      issues.push({
        code: 'invalid_format',
        message: `Format rule ${formatIndex} must be an object.`,
        formatIndex,
      });
      continue;
    }
    for (const property of Object.keys(rawRule)) {
      if (!FORMAT_KEYS.has(property)) {
        issues.push({
          code: 'unknown_property',
          message: `Format rule ${formatIndex} has unknown property: ${property}.`,
          formatIndex,
        });
      }
    }
    const range = readRuleRange(
      rawRule.range,
      issues,
      { formatIndex },
      `Format rule ${formatIndex}`
    );
    const properties = ['bold', 'italic', 'strikethrough'] as const;
    const supplied = properties.filter((property) => Object.hasOwn(rawRule, property));
    if (
      supplied.length === 0 ||
      supplied.some((property) => typeof rawRule[property] !== 'boolean')
    ) {
      issues.push({
        code: 'invalid_format',
        message: `Format rule ${formatIndex} must contain at least one boolean format property.`,
        formatIndex,
      });
      continue;
    }
    if (range === null) continue;
    validateRangeBounds(range, context, issues, { formatIndex }, `Format rule ${formatIndex}`);
    const rule: SheetFormatRule = { range };
    for (const property of supplied) rule[property] = rawRule[property] as boolean;
    formats.push(rule);
  }
  return formats;
}

function validateAlignments(
  rawAlignments: unknown,
  context: SheetPresentationValidationContext,
  issues: SheetPresentationIssue[]
): SheetAlignmentRule[] {
  if (rawAlignments === undefined) return [];
  if (!Array.isArray(rawAlignments)) {
    issues.push({
      code: 'invalid_alignment',
      message: 'Sheet presentation alignments must be an array.',
    });
    return [];
  }
  if (rawAlignments.length > MAX_SHEET_ALIGNMENT_RULES) {
    issues.push({
      code: 'too_many_alignments',
      message: `Sheet presentation exceeds ${MAX_SHEET_ALIGNMENT_RULES} alignment rules.`,
    });
    return [];
  }

  const alignments: SheetAlignmentRule[] = [];
  for (let alignmentIndex = 0; alignmentIndex < rawAlignments.length; alignmentIndex += 1) {
    const rawRule: unknown = rawAlignments[alignmentIndex];
    if (!isRecord(rawRule)) {
      issues.push({
        code: 'invalid_alignment',
        message: `Alignment rule ${alignmentIndex} must be an object.`,
        alignmentIndex,
      });
      continue;
    }
    for (const property of Object.keys(rawRule)) {
      if (!ALIGNMENT_KEYS.has(property)) {
        issues.push({
          code: 'unknown_property',
          message: `Alignment rule ${alignmentIndex} has unknown property: ${property}.`,
          alignmentIndex,
        });
      }
    }
    const range = readRuleRange(
      rawRule.range,
      issues,
      { alignmentIndex },
      `Alignment rule ${alignmentIndex}`
    );
    const hasHorizontal = Object.hasOwn(rawRule, 'horizontal');
    const hasVertical = Object.hasOwn(rawRule, 'vertical');
    const validHorizontal =
      !hasHorizontal || HORIZONTAL_ALIGNMENTS.has(rawRule.horizontal as SheetHorizontalAlignment);
    const validVertical =
      !hasVertical || VERTICAL_ALIGNMENTS.has(rawRule.vertical as SheetVerticalAlignment);
    if ((!hasHorizontal && !hasVertical) || !validHorizontal || !validVertical) {
      issues.push({
        code: 'invalid_alignment',
        message: `Alignment rule ${alignmentIndex} must contain a supported horizontal or vertical value.`,
        alignmentIndex,
      });
      continue;
    }
    if (range === null) continue;
    validateRangeBounds(
      range,
      context,
      issues,
      { alignmentIndex },
      `Alignment rule ${alignmentIndex}`
    );
    const rule: SheetAlignmentRule = { range };
    if (hasHorizontal) rule.horizontal = rawRule.horizontal as SheetHorizontalAlignment;
    if (hasVertical) rule.vertical = rawRule.vertical as SheetVerticalAlignment;
    alignments.push(rule);
  }
  return alignments;
}

function readRuleRange(
  value: unknown,
  issues: SheetPresentationIssue[],
  location: Pick<SheetPresentationIssue, 'formatIndex' | 'alignmentIndex'>,
  label: string
): SheetCellRange | null {
  if (!isRecord(value)) {
    issues.push({
      code: 'invalid_range',
      message: `${label} must contain a range object.`,
      ...location,
    });
    return null;
  }
  for (const property of Object.keys(value)) {
    if (!RANGE_KEYS.has(property)) {
      issues.push({
        code: 'unknown_property',
        message: `${label} range has unknown property: ${property}.`,
        ...location,
      });
    }
  }
  const range = readRuntimeRange(value);
  if (range === null) {
    issues.push({
      code: 'invalid_coordinate',
      message: `${label} must use finite, non-negative safe-integer coordinates.`,
      ...location,
    });
    return null;
  }
  if (range.endRow <= range.startRow || range.endColumn <= range.startColumn) {
    issues.push({
      code: 'invalid_range',
      message: `${label} must cover a non-empty cell rectangle.`,
      ...location,
    });
    return null;
  }
  return range;
}

function readRuntimeRange(value: Record<string, unknown>): SheetCellRange | null {
  const coordinates = [value.startRow, value.endRow, value.startColumn, value.endColumn];
  if (!coordinates.every(isCoordinate)) return null;
  return {
    startRow: value.startRow as number,
    endRow: value.endRow as number,
    startColumn: value.startColumn as number,
    endColumn: value.endColumn as number,
  };
}

function validateRangeBounds(
  range: SheetCellRange,
  context: SheetPresentationValidationContext,
  issues: SheetPresentationIssue[],
  location: Pick<SheetPresentationIssue, 'mergeIndex' | 'formatIndex' | 'alignmentIndex'>,
  label: string
): void {
  if (range.endRow > context.totalRows || range.endColumn > context.maxColumns) {
    issues.push({
      code: 'out_of_bounds',
      message: `${label} extends outside the sheet.`,
      ...location,
    });
    return;
  }
  if (range.endRow > context.rows.length) {
    issues.push({
      code: 'truncated_range',
      message: `${label} reaches rows that were not materialized.`,
      ...location,
    });
  }
}

function normalizeFormats(
  rules: readonly SheetFormatRule[],
  rowCount: number,
  columnCount: number
): SheetFormatRule[] {
  if (rules.length === 0 || rowCount === 0 || columnCount === 0) return [];
  const states = new Uint8Array(rowCount * columnCount);
  paintResolvedProperty(
    states,
    columnCount,
    resolveProperty(rules, (rule) => rule.bold, false, rowCount, columnCount),
    (state) => state | 1
  );
  paintResolvedProperty(
    states,
    columnCount,
    resolveProperty(rules, (rule) => rule.italic, false, rowCount, columnCount),
    (state) => state | 2
  );
  paintResolvedProperty(
    states,
    columnCount,
    resolveProperty(rules, (rule) => rule.strikethrough, false, rowCount, columnCount),
    (state) => state | 4
  );
  return rectanglesForStates(states, rowCount, columnCount).map(({ range, state }) => ({
    range,
    ...(state & 1 ? { bold: true } : {}),
    ...(state & 2 ? { italic: true } : {}),
    ...(state & 4 ? { strikethrough: true } : {}),
  }));
}

function normalizeAlignments(
  rules: readonly SheetAlignmentRule[],
  rowCount: number,
  columnCount: number
): SheetAlignmentRule[] {
  if (rules.length === 0 || rowCount === 0 || columnCount === 0) return [];
  const states = new Uint8Array(rowCount * columnCount);
  paintResolvedProperty(
    states,
    columnCount,
    resolveProperty(rules, (rule) => rule.horizontal, 'left', rowCount, columnCount),
    (state, value) => (state & ~3) | horizontalCode(value)
  );
  paintResolvedProperty(
    states,
    columnCount,
    resolveProperty(rules, (rule) => rule.vertical, 'middle', rowCount, columnCount),
    (state, value) => (state & 3) | (verticalCode(value) << 2)
  );
  return rectanglesForStates(states, rowCount, columnCount).map(({ range, state }) => {
    const horizontal = horizontalFromCode(state & 3);
    const vertical = verticalFromCode(state >> 2);
    return {
      range,
      ...(horizontal === 'left' ? {} : { horizontal }),
      ...(vertical === 'middle' ? {} : { vertical }),
    };
  });
}

interface ResolvedProperty<T> {
  range: SheetCellRange;
  value: T;
}

function resolveProperty<R extends { range: SheetCellRange }, T>(
  rules: readonly R[],
  read: (rule: R) => T | undefined,
  defaultValue: T,
  rowCount: number,
  columnCount: number
): ResolvedProperty<T>[] {
  let unresolved: SheetCellRange[] = [
    { startRow: 0, endRow: rowCount, startColumn: 0, endColumn: columnCount },
  ];
  const resolved: ResolvedProperty<T>[] = [];
  for (let index = rules.length - 1; index >= 0 && unresolved.length > 0; index -= 1) {
    const rule = rules[index];
    const value = read(rule);
    if (value === undefined) continue;
    const next: SheetCellRange[] = [];
    for (const region of unresolved) {
      const intersection = intersectRanges(region, rule.range);
      if (intersection === null) {
        next.push(region);
        continue;
      }
      next.push(...subtractRange(region, intersection));
      if (value !== defaultValue) resolved.push({ range: intersection, value });
    }
    unresolved = next;
  }
  return resolved;
}

function paintResolvedProperty<T>(
  states: Uint8Array,
  columnCount: number,
  properties: readonly ResolvedProperty<T>[],
  paint: (state: number, value: T) => number
): void {
  for (const property of properties) {
    for (let row = property.range.startRow; row < property.range.endRow; row += 1) {
      const rowOffset = row * columnCount;
      for (
        let column = property.range.startColumn;
        column < property.range.endColumn;
        column += 1
      ) {
        const index = rowOffset + column;
        states[index] = paint(states[index], property.value);
      }
    }
  }
}

function intersectRanges(left: SheetCellRange, right: SheetCellRange): SheetCellRange | null {
  const intersection = {
    startRow: Math.max(left.startRow, right.startRow),
    endRow: Math.min(left.endRow, right.endRow),
    startColumn: Math.max(left.startColumn, right.startColumn),
    endColumn: Math.min(left.endColumn, right.endColumn),
  };
  return intersection.startRow < intersection.endRow &&
    intersection.startColumn < intersection.endColumn
    ? intersection
    : null;
}

function subtractRange(source: SheetCellRange, cut: SheetCellRange): SheetCellRange[] {
  const pieces: SheetCellRange[] = [];
  if (source.startRow < cut.startRow) {
    pieces.push({ ...source, endRow: cut.startRow });
  }
  if (cut.endRow < source.endRow) {
    pieces.push({ ...source, startRow: cut.endRow });
  }
  if (source.startColumn < cut.startColumn) {
    pieces.push({
      startRow: cut.startRow,
      endRow: cut.endRow,
      startColumn: source.startColumn,
      endColumn: cut.startColumn,
    });
  }
  if (cut.endColumn < source.endColumn) {
    pieces.push({
      startRow: cut.startRow,
      endRow: cut.endRow,
      startColumn: cut.endColumn,
      endColumn: source.endColumn,
    });
  }
  return pieces;
}

interface StateRectangle {
  range: SheetCellRange;
  state: number;
}

function rectanglesForStates(
  states: Uint8Array,
  rowCount: number,
  columnCount: number
): StateRectangle[] {
  let active = new Map<string, StateRectangle>();
  const completed: StateRectangle[] = [];
  for (let row = 0; row < rowCount; row += 1) {
    const next = new Map<string, StateRectangle>();
    let column = 0;
    while (column < columnCount) {
      const state = states[row * columnCount + column];
      const startColumn = column;
      column += 1;
      while (column < columnCount && states[row * columnCount + column] === state) column += 1;
      if (state === 0) continue;
      const key = `${state}:${startColumn}:${column}`;
      const existing = active.get(key);
      if (existing) {
        existing.range.endRow = row + 1;
        next.set(key, existing);
      } else {
        next.set(key, {
          state,
          range: { startRow: row, endRow: row + 1, startColumn, endColumn: column },
        });
      }
    }
    for (const [key, rectangle] of active) {
      if (!next.has(key)) completed.push(rectangle);
    }
    active = next;
  }
  completed.push(...active.values());
  completed.sort((left, right) => compareRanges(left.range, right.range));
  return completed;
}

function horizontalCode(value: SheetHorizontalAlignment): number {
  return value === 'left' ? 0 : value === 'center' ? 1 : 2;
}

function horizontalFromCode(value: number): SheetHorizontalAlignment {
  return value === 1 ? 'center' : value === 2 ? 'right' : 'left';
}

function verticalCode(value: SheetVerticalAlignment): number {
  return value === 'middle' ? 0 : value === 'top' ? 1 : 2;
}

function verticalFromCode(value: number): SheetVerticalAlignment {
  return value === 1 ? 'top' : value === 2 ? 'bottom' : 'middle';
}

export function snapshotSheetPresentation(
  presentation: SheetPresentation | null | undefined
): SheetPresentation {
  if (presentation === null || presentation === undefined) return {};
  if (!isRecord(presentation)) return presentation;

  const snapshot: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(presentation)) {
    if (PRESENTATION_SECTIONS.some((section) => section === key) && Array.isArray(value)) {
      snapshot[key] = value.map((item) => {
        if (!isRecord(item)) return item;
        return {
          ...item,
          ...(isRecord(item.range) ? { range: { ...item.range } } : {}),
        };
      });
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
  for (const section of PRESENTATION_SECTIONS) {
    if (!Object.hasOwn(override, section) || override[section] === undefined) {
      resolved[section] = embeddedSnapshot[section];
    }
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

function compareRanges(left: SheetCellRange, right: SheetCellRange): number {
  return (
    left.startRow - right.startRow ||
    left.startColumn - right.startColumn ||
    left.endRow - right.endRow ||
    left.endColumn - right.endColumn
  );
}

function isCoordinate(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(
  code: SheetPresentationIssueCode,
  message: string
): SheetPresentationValidationResult {
  return { ok: false, issues: [{ code, message }] };
}
