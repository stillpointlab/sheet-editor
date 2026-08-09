import { describe, expect, it } from 'vitest';

import {
  applyTabularPaste,
  clearTabularRange,
  extractTabularSelection,
  parseTabularClipboard,
  serializeTabularClipboard,
} from './clipboard';

describe('tabular clipboard codec', () => {
  it('serializes literal scalar and rectangular values as deterministic TSV', () => {
    const rows = [
      ['plain', ' leading ', '=SUM(A1)', '<b>text</b>'],
      ['tab\tvalue', 'line\r\nvalue', 'say "hello"', ''],
    ];

    const serialized = serializeTabularClipboard(rows);

    expect(serialized).toBe(
      'plain\t leading \t=SUM(A1)\t<b>text</b>\n"tab\tvalue"\t"line\r\nvalue"\t"say ""hello"""\t'
    );
    expect(parseTabularClipboard(serialized)).toEqual({
      ok: true,
      rows,
      rowCount: 2,
      columnCount: 4,
    });
  });

  it('accepts LF and CRLF records while preserving record characters inside quotes', () => {
    expect(parseTabularClipboard('"one\nline"\t"two\r\nline"\r\nlast\trow\r\n')).toEqual({
      ok: true,
      rows: [
        ['one\nline', 'two\r\nline'],
        ['last', 'row'],
      ],
      rowCount: 2,
      columnCount: 2,
    });
  });

  it('treats an empty payload as one cell, ignores one terminal delimiter, and pads ragged rows', () => {
    expect(parseTabularClipboard('')).toMatchObject({ rows: [['']], rowCount: 1, columnCount: 1 });
    expect(parseTabularClipboard('\n')).toMatchObject({
      rows: [['']],
      rowCount: 1,
      columnCount: 1,
    });
    expect(parseTabularClipboard('a\tb\nc\n')).toMatchObject({
      rows: [
        ['a', 'b'],
        ['c', ''],
      ],
      rowCount: 2,
      columnCount: 2,
    });
    expect(parseTabularClipboard('a\t')).toMatchObject({ rows: [['a', '']] });
  });

  it.each([
    ['unclosed quote', '"open'],
    ['quote in an unquoted field', 'a"b'],
    ['character after a closing quote', '"a"x'],
    ['bare carriage return', 'a\rb'],
  ])('rejects %s atomically', (_label, source) => {
    expect(parseTabularClipboard(source)).toMatchObject({
      ok: false,
      error: { code: 'invalid_tsv' },
    });
  });

  it.each([
    ['input bytes', 'abcd', { maxInputBytes: 3 }, 'input_too_large'],
    ['UTF-8 cell bytes', 'é', { maxCellBytes: 1 }, 'cell_too_large'],
    ['rows', 'a\nb', { maxMaterializedRows: 1 }, 'too_many_rows'],
    ['columns', 'a\tb', { maxColumns: 1 }, 'too_many_columns'],
  ])('enforces bounded %s before returning a matrix', (_label, source, limits, code) => {
    expect(parseTabularClipboard(source, limits)).toMatchObject({
      ok: false,
      error: { code },
    });
  });

  it('extracts a rectangular logical selection with covered and virtual coordinates blank', () => {
    expect(
      extractTabularSelection(
        [['anchor', '', 'x'], ['ragged']],
        { startRow: 0, endRow: 3, startColumn: 0, endColumn: 4 },
        (row, column) => row === 0 && column === 1
      )
    ).toEqual([
      ['anchor', '', 'x', ''],
      ['ragged', '', '', ''],
      ['', '', '', ''],
    ]);
  });

  it('applies supplied values without materializing missing empty fields', () => {
    expect(
      applyTabularPaste([['a'], ['b', 'c', '']], { row: 0, column: 1 }, [
        ['', 'x'],
        ['y', ''],
      ])
    ).toEqual([
      ['a', '', 'x'],
      ['b', 'y', ''],
    ]);
    expect(applyTabularPaste([], { row: 2, column: 2 }, [['', '']])).toEqual([]);
    expect(applyTabularPaste([], { row: 2, column: 0 }, [[''], ['x']])).toEqual([
      [],
      [],
      [],
      ['x'],
    ]);
  });

  it('clears only materialized fields and retains every row length', () => {
    expect(
      clearTabularRange([['a', 'b', ''], ['c'], []], {
        startRow: 0,
        endRow: 3,
        startColumn: 1,
        endColumn: 3,
      })
    ).toEqual([['a', '', ''], ['c'], []]);
  });
});
