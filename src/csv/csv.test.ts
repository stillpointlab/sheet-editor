import { describe, expect, it } from 'vitest';

import { DEFAULT_CSV_LIMITS, parseCsv, serializeCsv, utf8ByteLength } from './csv';

describe('parseCsv', () => {
  it('parses RFC-4180 quoting, escaped quotes, embedded newlines, and empty fields', () => {
    const parsed = parseCsv('name,notes,empty\r\n"Coffee, beans","line 1\r\nline ""2""",');

    expect(parsed).toEqual({
      ok: true,
      rows: [
        ['name', 'notes', 'empty'],
        ['Coffee, beans', 'line 1\r\nline "2"', ''],
      ],
      totalRows: 2,
      maxColumns: 3,
      truncated: false,
    });
  });

  it('accepts LF, strips one BOM, and does not invent a row after a trailing newline', () => {
    expect(parseCsv('\uFEFFa,b\nc,d\n')).toMatchObject({
      ok: true,
      rows: [
        ['a', 'b'],
        ['c', 'd'],
      ],
      totalRows: 2,
    });
  });

  it('treats an empty source or BOM-only source as zero rows', () => {
    expect(parseCsv('')).toMatchObject({ ok: true, rows: [], totalRows: 0, maxColumns: 0 });
    expect(parseCsv('\uFEFF')).toMatchObject({ ok: true, rows: [], totalRows: 0, maxColumns: 0 });
  });

  it('preserves ragged row shape and reports the widest row', () => {
    expect(parseCsv('a,b,c\n1\n2,3')).toMatchObject({
      ok: true,
      rows: [['a', 'b', 'c'], ['1'], ['2', '3']],
      maxColumns: 3,
    });
  });

  it('counts all rows while materializing only the configured prefix', () => {
    const source = Array.from({ length: 8 }, (_, index) => `${index},value`).join('\n');
    const parsed = parseCsv(source, { maxMaterializedRows: 3 });

    expect(parsed).toMatchObject({
      ok: true,
      rows: [
        ['0', 'value'],
        ['1', 'value'],
        ['2', 'value'],
      ],
      totalRows: 8,
      maxColumns: 2,
      truncated: true,
    });
  });

  it('measures input and cells as UTF-8 bytes', () => {
    expect(utf8ByteLength('café ☕')).toBe(9);
    expect(parseCsv('☕', { maxCellBytes: 2 })).toEqual({
      ok: false,
      error: {
        code: 'cell_too_large',
        message: 'CSV cell at row 1, column 1 exceeds 2 bytes.',
      },
    });
    expect(parseCsv('☕', { maxInputBytes: 2 })).toEqual({
      ok: false,
      error: {
        code: 'input_too_large',
        message: 'CSV is 3 bytes; the preview limit is 2 bytes.',
      },
    });
  });

  it('hard-fails excess width even after the materialized row cap', () => {
    const parsed = parseCsv('kept\none,two,three', {
      maxMaterializedRows: 1,
      maxColumns: 2,
    });

    expect(parsed).toMatchObject({
      ok: false,
      error: { code: 'too_many_columns' },
    });
  });

  it.each([
    ['unclosed quoted field', '"value', 'Unclosed quoted field'],
    ['quote in an unquoted field', 'va"lue', 'Unexpected quote'],
    ['characters after a closing quote', '"value"x', 'Unexpected character'],
    ['bare carriage return', 'a\rb', 'Bare carriage return'],
  ])('returns invalid_csv for %s', (_label, source, message) => {
    expect(parseCsv(source)).toMatchObject({
      ok: false,
      error: { code: 'invalid_csv', message: expect.stringContaining(message) },
    });
  });

  it('rejects invalid limit overrides as programmer errors', () => {
    expect(() => parseCsv('a', { maxColumns: 0 })).toThrow(RangeError);
  });

  it('uses the specified product defaults', () => {
    expect(DEFAULT_CSV_LIMITS).toEqual({
      maxInputBytes: 256 * 1024,
      maxMaterializedRows: 1000,
      maxColumns: 256,
      maxCellBytes: 64 * 1024,
    });
  });
});

describe('serializeCsv', () => {
  it('serializes with RFC-4180 quoting and CRLF by default', () => {
    expect(
      serializeCsv([
        ['name', 'notes'],
        ['Coffee, beans', 'line 1\nline "2"'],
      ])
    ).toBe('name,notes\r\n"Coffee, beans","line 1\nline ""2"""');
  });

  it('supports LF output', () => {
    expect(serializeCsv([['a'], ['b']], { lineEnding: '\n' })).toBe('a\nb');
  });

  it('keeps BOM opt-in and emits it exactly once before the first record', () => {
    expect(serializeCsv([['café']])).toBe('café');
    expect(serializeCsv([['café']], { bom: true })).toBe('\uFEFFcafé');
    expect(serializeCsv([], { bom: true })).toBe('\uFEFF');
  });

  it('escapes formula-trigger values only when requested', () => {
    const dangerous = [['=SUM(A1)', '+1', '-1', '@cmd', '\tcommand', '\rcommand', '  =later']];

    expect(serializeCsv(dangerous)).toBe('=SUM(A1),+1,-1,@cmd,\tcommand,"\rcommand",  =later');
    expect(serializeCsv(dangerous, { escapeFormulas: true })).toBe(
      `'=SUM(A1),'+1,'-1,'@cmd,'\tcommand,"'\rcommand",'  =later`
    );
  });
});
