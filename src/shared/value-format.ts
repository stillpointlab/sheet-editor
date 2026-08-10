import type { SheetPresentation, SheetValueFormatRule } from '../presentation/presentation';

export type EffectiveSheetValueFormat =
  | { kind: 'automatic' }
  | { kind: 'number'; decimalPlaces: number }
  | { kind: 'currency'; currency: string; decimalPlaces: number }
  | { kind: 'percent'; decimalPlaces: number }
  | { kind: 'date' | 'time' | 'datetime' };

export interface SheetValueFormatIndex {
  formatAt(row: number, column: number): EffectiveSheetValueFormat;
}

const AUTOMATIC_FORMAT: Readonly<EffectiveSheetValueFormat> = Object.freeze({
  kind: 'automatic',
});
const DECIMAL_PATTERN = /^[+-]?(0|[1-9][0-9]*)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$/;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_PATTERN = /^(\d{2}):(\d{2})(?::(\d{2})(?:\.([0-9]+))?)?$/;
const SECONDS_PER_DAY = 86_400;
const MILLISECONDS_PER_DAY = SECONDS_PER_DAY * 1000;
const SHEET_EPOCH_MILLISECONDS = Date.UTC(1899, 11, 30);
const numberFormatters = new Map<string, Intl.NumberFormat>();

interface ParsedDecimal {
  value: number;
  fractionalDigits: number;
}

interface TemporalParts {
  hasDate: boolean;
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

type NumberFormatOptionsWithRoundingMode = Intl.NumberFormatOptions & {
  roundingMode: 'halfExpand';
};

export function createSheetValueFormatIndex(
  presentation: SheetPresentation
): SheetValueFormatIndex {
  const rows = buildRowIndex(presentation.valueFormats ?? []);
  return {
    formatAt(row, column) {
      assertCoordinate(row, column);
      const rule = findRule(rows[row], column);
      return rule ? descriptorFromRule(rule) : { ...AUTOMATIC_FORMAT };
    },
  };
}

export function formatSheetCellValue(rawValue: string, format: EffectiveSheetValueFormat): string {
  if (rawValue === '' || format.kind === 'automatic') return rawValue;
  if (format.kind === 'number' || format.kind === 'currency' || format.kind === 'percent') {
    const parsed = parseDecimal(rawValue);
    if (!parsed) return rawValue;
    try {
      return numberFormatter(format).format(parsed.value);
    } catch {
      return rawValue;
    }
  }

  const temporal = parseTemporal(rawValue);
  if (!temporal) return rawValue;
  if ((format.kind === 'date' || format.kind === 'datetime') && !temporal.hasDate) {
    return rawValue;
  }
  if (format.kind === 'date') return formatDate(temporal);
  if (format.kind === 'time') return formatTime(temporal);
  return `${formatDate(temporal)} ${formatTime(temporal)}`;
}

export function inferAutomaticDecimalPlaces(rawValue: string): number {
  return Math.min(10, parseDecimal(rawValue)?.fractionalDigits ?? 0);
}

export function isCompatibleNumericValue(rawValue: string): boolean {
  return parseDecimal(rawValue) !== null;
}

function parseDecimal(rawValue: string): ParsedDecimal | null {
  const match = DECIMAL_PATTERN.exec(rawValue);
  if (!match) return null;
  const mantissaDigits = rawValue
    .replace(/^[+-]/, '')
    .replace(/[eE].*$/, '')
    .replace('.', '');
  const significant = mantissaDigits.replace(/^0+/, '');
  if (significant.length > 15) return null;

  const value = Number(rawValue);
  if (!Number.isFinite(value)) return null;
  if (value === 0 && /[1-9]/.test(mantissaDigits)) return null;

  const fractionLength = match[2]?.length ?? 0;
  const exponent = Number(match[3] ?? 0);
  if (!Number.isSafeInteger(exponent)) return null;
  return {
    value,
    fractionalDigits: Math.max(0, fractionLength - exponent),
  };
}

function numberFormatter(
  format: Exclude<EffectiveSheetValueFormat, { kind: 'automatic' | 'date' | 'time' | 'datetime' }>
): Intl.NumberFormat {
  const currency = format.kind === 'currency' ? format.currency : '';
  const key = `${format.kind}:${currency}:${format.decimalPlaces}`;
  const cached = numberFormatters.get(key);
  if (cached) return cached;

  const shared: NumberFormatOptionsWithRoundingMode = {
    minimumFractionDigits: format.decimalPlaces,
    maximumFractionDigits: format.decimalPlaces,
    roundingMode: 'halfExpand',
    useGrouping: true,
  };
  const formatter = new Intl.NumberFormat(
    'en-US',
    format.kind === 'currency'
      ? { ...shared, style: 'currency', currency: format.currency }
      : format.kind === 'percent'
        ? { ...shared, style: 'percent' }
        : { ...shared, style: 'decimal' }
  );
  numberFormatters.set(key, formatter);
  return formatter;
}

function parseTemporal(rawValue: string): TemporalParts | null {
  const decimal = parseDecimal(rawValue);
  if (decimal) return temporalFromSerial(decimal.value);

  const separatorIndex = rawValue.search(/[T ]/);
  if (separatorIndex >= 0) {
    const date = parseCivilDate(rawValue.slice(0, separatorIndex));
    const time = parseCivilTime(rawValue.slice(separatorIndex + 1));
    if (!date || !time) return null;
    const normalized = normalizeCivilTemporal({ ...date, ...time, hasDate: true });
    return normalized.year <= 9999 ? normalized : null;
  }

  const date = parseCivilDate(rawValue);
  if (date) {
    return { ...date, hasDate: true, hour: 0, minute: 0, second: 0 };
  }
  const time = parseCivilTime(rawValue);
  if (!time) return null;
  const normalized = normalizeCivilTemporal({
    hasDate: false,
    year: 1,
    month: 1,
    day: 1,
    ...time,
  });
  return normalized.year <= 9999 ? normalized : null;
}

function temporalFromSerial(serial: number): TemporalParts | null {
  let wholeDays = Math.floor(serial);
  let seconds = Math.round((serial - wholeDays) * SECONDS_PER_DAY);
  if (seconds >= SECONDS_PER_DAY) {
    wholeDays += 1;
    seconds = 0;
  }
  const milliseconds = SHEET_EPOCH_MILLISECONDS + wholeDays * MILLISECONDS_PER_DAY + seconds * 1000;
  if (!Number.isFinite(milliseconds)) return null;
  const date = new Date(milliseconds);
  const year = date.getUTCFullYear();
  if (Number.isNaN(date.getTime()) || year < 1 || year > 9999) return null;
  return {
    hasDate: true,
    year,
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: date.getUTCHours(),
    minute: date.getUTCMinutes(),
    second: date.getUTCSeconds(),
  };
}

function parseCivilDate(value: string): Pick<TemporalParts, 'year' | 'month' | 'day'> | null {
  const match = DATE_PATTERN.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || year > 9999 || month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;
  return { year, month, day };
}

function parseCivilTime(
  value: string
): (Pick<TemporalParts, 'hour' | 'minute' | 'second'> & { roundSecond?: boolean }) | null {
  const match = TIME_PATTERN.exec(value);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3] ?? 0);
  if (hour > 23 || minute > 59 || second > 59) return null;
  return {
    hour,
    minute,
    second,
    ...(match[4]?.[0] && match[4][0] >= '5' ? { roundSecond: true } : {}),
  };
}

function normalizeCivilTemporal(value: TemporalParts & { roundSecond?: boolean }): TemporalParts {
  if (!value.roundSecond) {
    const { roundSecond: _roundSecond, ...parts } = value;
    return parts;
  }
  let { year, month, day, hour, minute, second } = value;
  second += 1;
  if (second >= 60) {
    second = 0;
    minute += 1;
  }
  if (minute >= 60) {
    minute = 0;
    hour += 1;
  }
  if (hour >= 24) {
    hour = 0;
    if (value.hasDate) {
      day += 1;
      if (day > daysInMonth(year, month)) {
        day = 1;
        month += 1;
      }
      if (month > 12) {
        month = 1;
        year += 1;
      }
    }
  }
  return { hasDate: value.hasDate, year, month, day, hour, minute, second };
}

function descriptorFromRule(rule: SheetValueFormatRule): EffectiveSheetValueFormat {
  if (rule.kind === 'currency') {
    return {
      kind: rule.kind,
      currency: rule.currency,
      decimalPlaces: rule.decimalPlaces,
    };
  }
  if (rule.kind === 'number' || rule.kind === 'percent') {
    return { kind: rule.kind, decimalPlaces: rule.decimalPlaces };
  }
  return { kind: rule.kind };
}

function buildRowIndex(
  rules: readonly SheetValueFormatRule[]
): Array<SheetValueFormatRule[] | undefined> {
  const rows: Array<SheetValueFormatRule[] | undefined> = [];
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

function findRule(
  rules: readonly SheetValueFormatRule[] | undefined,
  column: number
): SheetValueFormatRule | undefined {
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

function formatDate(parts: TemporalParts): string {
  return `${parts.month}/${parts.day}/${String(parts.year).padStart(4, '0')}`;
}

function formatTime(parts: TemporalParts): string {
  const period = parts.hour < 12 ? 'AM' : 'PM';
  const hour = parts.hour % 12 || 12;
  return `${hour}:${String(parts.minute).padStart(2, '0')}:${String(parts.second).padStart(2, '0')} ${period}`;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function assertCoordinate(row: number, column: number): void {
  if (!Number.isSafeInteger(row) || row < 0 || !Number.isSafeInteger(column) || column < 0) {
    throw new RangeError('Sheet value format coordinates must be non-negative safe integers.');
  }
}
