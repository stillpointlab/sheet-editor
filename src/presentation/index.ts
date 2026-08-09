export { formatA1CellRange, formatA1Range, parseA1CellRange, parseA1Range } from './a1-range';
export {
  MAX_SHEET_ALIGNMENT_RULES,
  MAX_SHEET_FORMAT_RULES,
  MAX_SHEET_MERGES,
  validateSheetPresentation,
} from './presentation';

export type {
  SheetCellRange,
  SheetContentOptions,
  SheetAlignmentRule,
  SheetFormatRule,
  SheetHorizontalAlignment,
  SheetPresentation,
  SheetPresentationIssue,
  SheetPresentationIssueCode,
  SheetPresentationValidationContext,
  SheetPresentationValidationResult,
  SheetVerticalAlignment,
} from './presentation';
