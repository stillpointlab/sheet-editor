import { isAlias, isMap, parseDocument, visit } from 'yaml';

import {
  parseCsv,
  serializeCsv,
  utf8ByteLength,
  type CsvLimits,
  type CsvParseResult,
} from '../csv';
import {
  formatA1CellRange,
  formatA1Range,
  parseA1CellRange,
  parseA1Range,
} from '../presentation/a1-range';
import {
  MAX_SHEET_ALIGNMENT_RULES,
  MAX_SHEET_FORMAT_RULES,
  MAX_SHEET_MERGES,
  validateSheetPresentation,
  type SheetAlignmentRule,
  type SheetCellRange,
  type SheetFormatRule,
  type SheetHorizontalAlignment,
  type SheetPresentation,
  type SheetVerticalAlignment,
} from '../presentation/presentation';

type CsvParseSuccess = Extract<CsvParseResult, { ok: true }>;

export interface ParsedSheetDocument {
  sheet: 'stillpoint/v1';
  format: 'csv';
  data: CsvParseSuccess;
  presentation: {
    merges: SheetCellRange[];
    formats?: SheetFormatRule[];
    alignments?: SheetAlignmentRule[];
  };
}

export type SheetDocumentErrorCode =
  | 'invalid_envelope'
  | 'frontmatter_too_large'
  | 'too_many_merges'
  | 'too_many_formats'
  | 'too_many_alignments'
  | 'invalid_frontmatter'
  | 'unsupported_version'
  | 'unsupported_format'
  | 'invalid_presentation'
  | 'invalid_body';

export interface SheetDocumentError {
  code: SheetDocumentErrorCode;
  message: string;
  cause?: unknown;
}

export type SheetDocumentParseResult =
  { ok: true; document: ParsedSheetDocument } | { ok: false; error: SheetDocumentError };

export interface ParseSheetDocumentOptions {
  maxFrontmatterBytes?: number;
  maxMerges?: number;
  maxFormats?: number;
  maxAlignments?: number;
  csvLimits?: Partial<CsvLimits>;
}

export interface SheetDocumentInput {
  format?: 'csv';
  rows: readonly (readonly string[])[];
  presentation?: SheetPresentation;
}

export interface SerializeSheetDocumentOptions {
  lineEnding?: '\n' | '\r\n';
}

const SHEET_VERSION = 'stillpoint/v1';
const DEFAULT_MAX_FRONTMATTER_BYTES = 64 * 1024;
const ROOT_KEYS = new Set(['sheet', 'format', 'presentation']);
const PRESENTATION_KEYS = new Set(['merges', 'formats', 'alignments']);
const MERGE_KEYS = new Set(['range']);
const FORMAT_KEYS = new Set(['range', 'bold', 'italic', 'strikethrough']);
const ALIGNMENT_KEYS = new Set(['range', 'horizontal', 'vertical']);
const HORIZONTAL_ALIGNMENTS = new Set<SheetHorizontalAlignment>(['left', 'center', 'right']);
const VERTICAL_ALIGNMENTS = new Set<SheetVerticalAlignment>(['top', 'middle', 'bottom']);
const STANDARD_TAGS = new Set([
  'tag:yaml.org,2002:map',
  'tag:yaml.org,2002:seq',
  'tag:yaml.org,2002:str',
]);

export function parseSheetDocument(
  source: string,
  options: ParseSheetDocumentOptions = {}
): SheetDocumentParseResult {
  if (typeof source !== 'string') throw new TypeError('Sheet document source must be a string.');
  const limits = resolveParserLimits(options);
  const envelope = splitEnvelope(source);
  if (!envelope.ok) return envelope.result;
  if (utf8ByteLength(envelope.frontmatter) > limits.maxFrontmatterBytes) {
    return failure(
      'frontmatter_too_large',
      `Sheet frontmatter exceeds ${limits.maxFrontmatterBytes} bytes.`
    );
  }

  const parsed = parseFrontmatter(envelope.frontmatter);
  if (!parsed.ok) return parsed.result;
  const root = parsed.value;

  const unknownRootKey = firstUnknownKey(root, ROOT_KEYS);
  if (unknownRootKey !== null) {
    return failure('invalid_frontmatter', `Unknown sheet frontmatter key: ${unknownRootKey}.`);
  }
  if (typeof root.sheet !== 'string') {
    return failure(
      'invalid_frontmatter',
      'Sheet frontmatter requires a string sheet discriminator.'
    );
  }
  if (root.sheet !== SHEET_VERSION) {
    return failure('unsupported_version', 'This sheet document version is not supported.');
  }

  const format = root.format ?? 'csv';
  if (typeof format !== 'string') {
    return failure('invalid_frontmatter', 'Sheet format must be a string.');
  }
  if (format !== 'csv') {
    return failure('unsupported_format', 'This sheet body format is not supported.');
  }

  const presentation = parsePresentation(
    root.presentation,
    limits.maxMerges,
    limits.maxFormats,
    limits.maxAlignments
  );
  if (!presentation.ok) return presentation.result;

  const data = parseCsv(envelope.body, options.csvLimits);
  if (!data.ok) {
    return failure('invalid_body', 'The sheet CSV body is invalid.', data.error);
  }

  return {
    ok: true,
    document: {
      sheet: SHEET_VERSION,
      format: 'csv',
      data,
      presentation: presentation.value,
    },
  };
}

export function serializeSheetDocument(
  document: SheetDocumentInput,
  options: SerializeSheetDocumentOptions = {}
): string {
  if (!isRecord(document) || !Array.isArray(document.rows)) {
    throw new TypeError('Sheet document input must contain rows.');
  }
  if (document.format !== undefined && document.format !== 'csv') {
    throw new RangeError('Only the csv sheet body format is supported.');
  }
  const lineEnding = options.lineEnding ?? '\n';
  if (lineEnding !== '\n' && lineEnding !== '\r\n') {
    throw new RangeError('lineEnding must be LF or CRLF.');
  }

  const rows = snapshotStringRows(document.rows);
  const maxColumns = rows.reduce((maximum, row) => Math.max(maximum, row.length), 0);
  const presentation = document.presentation === undefined ? {} : document.presentation;
  const validation = validateSheetPresentation(presentation, {
    rows,
    totalRows: rows.length,
    maxColumns,
    headerRow: false,
  });
  if (!validation.ok) {
    throw new RangeError('Sheet document presentation is invalid.', { cause: validation.issues });
  }

  const merges = [...validation.presentation.merges].sort(compareRanges);
  const formats = validation.presentation.formats ?? [];
  const alignments = validation.presentation.alignments ?? [];
  const envelope = ['---', `sheet: ${SHEET_VERSION}`, 'format: csv'];
  if (merges.length > 0 || formats.length > 0 || alignments.length > 0) {
    envelope.push('presentation:');
  }
  if (merges.length > 0) {
    envelope.push('  merges:');
    for (const range of merges) envelope.push(`    - range: ${formatA1Range(range)}`);
  }
  if (formats.length > 0) {
    envelope.push('  formats:');
    for (const rule of formats) {
      envelope.push(`    - range: ${formatA1CellRange(rule.range)}`);
      if (rule.bold !== undefined) envelope.push(`      bold: ${String(rule.bold)}`);
      if (rule.italic !== undefined) envelope.push(`      italic: ${String(rule.italic)}`);
      if (rule.strikethrough !== undefined) {
        envelope.push(`      strikethrough: ${String(rule.strikethrough)}`);
      }
    }
  }
  if (alignments.length > 0) {
    envelope.push('  alignments:');
    for (const rule of alignments) {
      envelope.push(`    - range: ${formatA1CellRange(rule.range)}`);
      if (rule.horizontal !== undefined) envelope.push(`      horizontal: ${rule.horizontal}`);
      if (rule.vertical !== undefined) envelope.push(`      vertical: ${rule.vertical}`);
    }
  }
  envelope.push('---');

  const frontmatter = `${envelope.slice(1, -1).join(lineEnding)}${lineEnding}`;
  if (utf8ByteLength(frontmatter) > DEFAULT_MAX_FRONTMATTER_BYTES) {
    throw new RangeError(`Sheet frontmatter exceeds ${DEFAULT_MAX_FRONTMATTER_BYTES} bytes.`);
  }

  const body = serializeCsv(rows, { lineEnding, bom: false, escapeFormulas: false });
  return `${envelope.join(lineEnding)}${lineEnding}${body}`;
}

interface ResolvedParserLimits {
  maxFrontmatterBytes: number;
  maxMerges: number;
  maxFormats: number;
  maxAlignments: number;
}

function resolveParserLimits(options: ParseSheetDocumentOptions): ResolvedParserLimits {
  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    throw new TypeError('Sheet document options must be an object.');
  }
  const maxFrontmatterBytes = options.maxFrontmatterBytes ?? DEFAULT_MAX_FRONTMATTER_BYTES;
  const maxMerges = options.maxMerges ?? MAX_SHEET_MERGES;
  const maxFormats = options.maxFormats ?? MAX_SHEET_FORMAT_RULES;
  const maxAlignments = options.maxAlignments ?? MAX_SHEET_ALIGNMENT_RULES;
  if (!Number.isSafeInteger(maxFrontmatterBytes) || maxFrontmatterBytes <= 0) {
    throw new RangeError('maxFrontmatterBytes must be a positive safe integer.');
  }
  if (!Number.isSafeInteger(maxMerges) || maxMerges <= 0 || maxMerges > MAX_SHEET_MERGES) {
    throw new RangeError(`maxMerges must be between 1 and ${MAX_SHEET_MERGES}.`);
  }
  if (!Number.isSafeInteger(maxFormats) || maxFormats <= 0 || maxFormats > MAX_SHEET_FORMAT_RULES) {
    throw new RangeError(`maxFormats must be between 1 and ${MAX_SHEET_FORMAT_RULES}.`);
  }
  if (
    !Number.isSafeInteger(maxAlignments) ||
    maxAlignments <= 0 ||
    maxAlignments > MAX_SHEET_ALIGNMENT_RULES
  ) {
    throw new RangeError(`maxAlignments must be between 1 and ${MAX_SHEET_ALIGNMENT_RULES}.`);
  }
  return { maxFrontmatterBytes, maxMerges, maxFormats, maxAlignments };
}

type EnvelopeResult =
  { ok: true; frontmatter: string; body: string } | { ok: false; result: SheetDocumentParseResult };

function splitEnvelope(source: string): EnvelopeResult {
  const openingLength = source.startsWith('---\r\n') ? 5 : source.startsWith('---\n') ? 4 : 0;
  if (openingLength === 0) {
    return {
      ok: false,
      result: failure('invalid_envelope', 'A sheet document must begin with a YAML envelope.'),
    };
  }

  let lineStart = openingLength;
  while (lineStart < source.length) {
    const newline = source.indexOf('\n', lineStart);
    if (newline === -1) break;
    const rawLine = source.slice(lineStart, newline);
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line === '---') {
      return {
        ok: true,
        frontmatter: source.slice(openingLength, lineStart),
        body: source.slice(newline + 1),
      };
    }
    lineStart = newline + 1;
  }

  return {
    ok: false,
    result: failure('invalid_envelope', 'The sheet YAML envelope is not closed.'),
  };
}

type FrontmatterResult =
  { ok: true; value: Record<string, unknown> } | { ok: false; result: SheetDocumentParseResult };

function parseFrontmatter(frontmatter: string): FrontmatterResult {
  try {
    return parseFrontmatterUnsafe(frontmatter);
  } catch (cause) {
    return {
      ok: false,
      result: failure('invalid_frontmatter', 'The sheet YAML frontmatter is invalid.', cause),
    };
  }
}

function parseFrontmatterUnsafe(frontmatter: string): FrontmatterResult {
  const document = parseDocument(frontmatter, {
    customTags: [],
    merge: false,
    prettyErrors: false,
    schema: 'core',
    strict: true,
    stringKeys: true,
    uniqueKeys: true,
  });
  if (document.errors.length > 0 || document.warnings.length > 0) {
    return {
      ok: false,
      result: failure(
        'invalid_frontmatter',
        'The sheet YAML frontmatter is invalid.',
        document.errors.length > 0 ? document.errors : document.warnings
      ),
    };
  }

  let unsafeNode = false;
  visit(document, (_key, node) => {
    const annotated = node as { anchor?: string; tag?: string };
    if (
      isAlias(node) ||
      annotated.anchor !== undefined ||
      (annotated.tag !== undefined && !STANDARD_TAGS.has(annotated.tag))
    ) {
      unsafeNode = true;
      return visit.BREAK;
    }
    return undefined;
  });
  if (unsafeNode) {
    return {
      ok: false,
      result: failure(
        'invalid_frontmatter',
        'Sheet frontmatter cannot contain aliases, anchors, or custom tags.'
      ),
    };
  }
  if (!isMap(document.contents)) {
    return {
      ok: false,
      result: failure('invalid_frontmatter', 'Sheet frontmatter must be a YAML mapping.'),
    };
  }

  const value: unknown = document.toJS({ maxAliasCount: 0 });
  if (!isRecord(value)) {
    return {
      ok: false,
      result: failure('invalid_frontmatter', 'Sheet frontmatter must be a YAML mapping.'),
    };
  }
  return { ok: true, value };
}

type ParsedPresentation = {
  merges: SheetCellRange[];
  formats?: SheetFormatRule[];
  alignments?: SheetAlignmentRule[];
};

type PresentationResult =
  { ok: true; value: ParsedPresentation } | { ok: false; result: SheetDocumentParseResult };

function parsePresentation(
  value: unknown,
  maxMerges: number,
  maxFormats: number,
  maxAlignments: number
): PresentationResult {
  if (value === undefined) return { ok: true, value: { merges: [] } };
  if (!isRecord(value)) {
    return {
      ok: false,
      result: failure('invalid_presentation', 'Sheet presentation must be a mapping.'),
    };
  }
  const unknownPresentationKey = firstUnknownKey(value, PRESENTATION_KEYS);
  if (unknownPresentationKey !== null) {
    return {
      ok: false,
      result: failure(
        'invalid_presentation',
        `Unknown sheet presentation key: ${unknownPresentationKey}.`
      ),
    };
  }
  const mergesResult = parseMerges(value.merges, maxMerges);
  if (!mergesResult.ok) return mergesResult;
  const formatsResult = parseFormats(value.formats, maxFormats);
  if (!formatsResult.ok) return formatsResult;
  const alignmentsResult = parseAlignments(value.alignments, maxAlignments);
  if (!alignmentsResult.ok) return alignmentsResult;

  const presentation: ParsedPresentation = { merges: mergesResult.value };
  if (formatsResult.value.length > 0) presentation.formats = formatsResult.value;
  if (alignmentsResult.value.length > 0) presentation.alignments = alignmentsResult.value;
  return { ok: true, value: presentation };
}

type SectionResult<T> = { ok: true; value: T[] } | { ok: false; result: SheetDocumentParseResult };

function parseMerges(value: unknown, maxMerges: number): SectionResult<SheetCellRange> {
  if (value === undefined) return { ok: true, value: [] };
  if (!Array.isArray(value)) {
    return {
      ok: false,
      result: failure('invalid_presentation', 'Sheet presentation merges must be a sequence.'),
    };
  }
  if (value.length > maxMerges) {
    return {
      ok: false,
      result: failure('too_many_merges', `Sheet presentation exceeds ${maxMerges} merged ranges.`),
    };
  }

  const merges: SheetCellRange[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || firstUnknownKey(entry, MERGE_KEYS) !== null) {
      return {
        ok: false,
        result: failure(
          'invalid_presentation',
          'Every sheet merge must be a mapping containing only range.'
        ),
      };
    }
    if (typeof entry.range !== 'string') {
      return {
        ok: false,
        result: failure('invalid_presentation', 'Every sheet merge range must be a string.'),
      };
    }
    const range = parseA1Range(entry.range);
    if (range === null) {
      return {
        ok: false,
        result: failure('invalid_presentation', 'A sheet merge contains an invalid A1 range.'),
      };
    }
    merges.push(range);
  }
  return { ok: true, value: merges };
}

function parseFormats(value: unknown, maxFormats: number): SectionResult<SheetFormatRule> {
  if (value === undefined) return { ok: true, value: [] };
  if (!Array.isArray(value)) {
    return {
      ok: false,
      result: failure('invalid_presentation', 'Sheet presentation formats must be a sequence.'),
    };
  }
  if (value.length > maxFormats) {
    return {
      ok: false,
      result: failure('too_many_formats', `Sheet presentation exceeds ${maxFormats} format rules.`),
    };
  }

  const formats: SheetFormatRule[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || firstUnknownKey(entry, FORMAT_KEYS) !== null) {
      return {
        ok: false,
        result: failure(
          'invalid_presentation',
          'Every sheet format must be a mapping containing only range and format properties.'
        ),
      };
    }
    const range = parsePresentationCellRange(entry.range, 'format');
    if (!range.ok) return range;
    const properties = ['bold', 'italic', 'strikethrough'] as const;
    const supplied = properties.filter((property) => Object.hasOwn(entry, property));
    if (
      supplied.length === 0 ||
      supplied.some((property) => typeof entry[property] !== 'boolean')
    ) {
      return {
        ok: false,
        result: failure(
          'invalid_presentation',
          'Every sheet format must contain at least one boolean format property.'
        ),
      };
    }
    const rule: SheetFormatRule = { range: range.value };
    for (const property of supplied) rule[property] = entry[property] as boolean;
    formats.push(rule);
  }
  return { ok: true, value: formats };
}

function parseAlignments(value: unknown, maxAlignments: number): SectionResult<SheetAlignmentRule> {
  if (value === undefined) return { ok: true, value: [] };
  if (!Array.isArray(value)) {
    return {
      ok: false,
      result: failure('invalid_presentation', 'Sheet presentation alignments must be a sequence.'),
    };
  }
  if (value.length > maxAlignments) {
    return {
      ok: false,
      result: failure(
        'too_many_alignments',
        `Sheet presentation exceeds ${maxAlignments} alignment rules.`
      ),
    };
  }

  const alignments: SheetAlignmentRule[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || firstUnknownKey(entry, ALIGNMENT_KEYS) !== null) {
      return {
        ok: false,
        result: failure(
          'invalid_presentation',
          'Every sheet alignment must be a mapping containing only range and alignment properties.'
        ),
      };
    }
    const range = parsePresentationCellRange(entry.range, 'alignment');
    if (!range.ok) return range;
    const hasHorizontal = Object.hasOwn(entry, 'horizontal');
    const hasVertical = Object.hasOwn(entry, 'vertical');
    if (
      (!hasHorizontal && !hasVertical) ||
      (hasHorizontal && !HORIZONTAL_ALIGNMENTS.has(entry.horizontal as SheetHorizontalAlignment)) ||
      (hasVertical && !VERTICAL_ALIGNMENTS.has(entry.vertical as SheetVerticalAlignment))
    ) {
      return {
        ok: false,
        result: failure(
          'invalid_presentation',
          'Every sheet alignment must contain a supported horizontal or vertical value.'
        ),
      };
    }
    const rule: SheetAlignmentRule = { range: range.value };
    if (hasHorizontal) rule.horizontal = entry.horizontal as SheetHorizontalAlignment;
    if (hasVertical) rule.vertical = entry.vertical as SheetVerticalAlignment;
    alignments.push(rule);
  }
  return { ok: true, value: alignments };
}

function parsePresentationCellRange(
  value: unknown,
  kind: 'format' | 'alignment'
): { ok: true; value: SheetCellRange } | { ok: false; result: SheetDocumentParseResult } {
  if (typeof value !== 'string') {
    return {
      ok: false,
      result: failure('invalid_presentation', `Every sheet ${kind} range must be a string.`),
    };
  }
  const range = parseA1CellRange(value);
  if (range === null) {
    return {
      ok: false,
      result: failure('invalid_presentation', `A sheet ${kind} contains an invalid A1 range.`),
    };
  }
  return { ok: true, value: range };
}

function snapshotStringRows(rows: readonly (readonly string[])[]): string[][] {
  return rows.map((row) => {
    if (!Array.isArray(row) || !row.every((value) => typeof value === 'string')) {
      throw new TypeError('Sheet document rows and cells must be arrays of strings.');
    }
    return [...row];
  });
}

function compareRanges(left: SheetCellRange, right: SheetCellRange): number {
  return (
    left.startRow - right.startRow ||
    left.startColumn - right.startColumn ||
    left.endRow - right.endRow ||
    left.endColumn - right.endColumn
  );
}

function firstUnknownKey(
  value: Record<string, unknown>,
  known: ReadonlySet<string>
): string | null {
  return Object.keys(value).find((key) => !known.has(key)) ?? null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function failure(
  code: SheetDocumentErrorCode,
  message: string,
  cause?: unknown
): SheetDocumentParseResult {
  return cause === undefined
    ? { ok: false, error: { code, message } }
    : { ok: false, error: { code, message, cause } };
}
