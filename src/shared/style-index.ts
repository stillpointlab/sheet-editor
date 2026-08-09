import type {
  SheetAlignmentRule,
  SheetFormatRule,
  SheetHorizontalAlignment,
  SheetPresentation,
  SheetVerticalAlignment,
} from '../presentation/presentation';

export interface EffectiveSheetCellStyle {
  bold: boolean;
  italic: boolean;
  strikethrough: boolean;
  horizontal: SheetHorizontalAlignment;
  vertical: SheetVerticalAlignment;
}

export interface SheetStyleIndex {
  styleAt(row: number, column: number): EffectiveSheetCellStyle;
}

const DEFAULT_STYLE: Readonly<EffectiveSheetCellStyle> = Object.freeze({
  bold: false,
  italic: false,
  strikethrough: false,
  horizontal: 'left',
  vertical: 'middle',
});

export function createSheetStyleIndex(presentation: SheetPresentation): SheetStyleIndex {
  const formatRows = buildRowIndex(presentation.formats ?? []);
  const alignmentRows = buildRowIndex(presentation.alignments ?? []);
  return {
    styleAt(row, column) {
      if (!Number.isSafeInteger(row) || row < 0 || !Number.isSafeInteger(column) || column < 0) {
        throw new RangeError('Sheet style coordinates must be non-negative safe integers.');
      }
      const format = findRule(formatRows[row], column);
      const alignment = findRule(alignmentRows[row], column);
      if (!format && !alignment) return { ...DEFAULT_STYLE };
      return {
        bold: format?.bold ?? false,
        italic: format?.italic ?? false,
        strikethrough: format?.strikethrough ?? false,
        horizontal: alignment?.horizontal ?? 'left',
        vertical: alignment?.vertical ?? 'middle',
      };
    },
  };
}

function buildRowIndex<T extends SheetFormatRule | SheetAlignmentRule>(
  rules: readonly T[]
): Array<T[] | undefined> {
  const rows: Array<T[] | undefined> = [];
  for (const rule of rules) {
    for (let row = rule.range.startRow; row < rule.range.endRow; row += 1) {
      const entries = rows[row] ?? [];
      entries.push(rule);
      rows[row] = entries;
    }
  }
  for (const entries of rows) {
    entries?.sort(
      (left, right) =>
        left.range.startColumn - right.range.startColumn ||
        left.range.endColumn - right.range.endColumn
    );
  }
  return rows;
}

function findRule<T extends SheetFormatRule | SheetAlignmentRule>(
  rules: readonly T[] | undefined,
  column: number
): T | undefined {
  if (!rules || rules.length === 0) return undefined;
  let low = 0;
  let high = rules.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const rule = rules[middle];
    if (column < rule.range.startColumn) high = middle - 1;
    else if (column >= rule.range.endColumn) low = middle + 1;
    else return rule;
  }
  return undefined;
}
