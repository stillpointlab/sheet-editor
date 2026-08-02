import { describe, expect, it } from 'vitest';

import { parseCsv } from '../csv';

import { parseSheetDocument, serializeSheetDocument } from './document';

const wrap = (frontmatter: string, body = '', lineEnding: '\n' | '\r\n' = '\n'): string =>
  `---${lineEnding}${frontmatter}${lineEnding}---${lineEnding}${body}`;

describe('parseSheetDocument', () => {
  it('parses the minimal default-format document and an empty body', () => {
    expect(parseSheetDocument(wrap('sheet: stillpoint/v1', 'a,b\n1,2'))).toEqual({
      ok: true,
      document: {
        sheet: 'stillpoint/v1',
        format: 'csv',
        data: {
          ok: true,
          rows: [
            ['a', 'b'],
            ['1', '2'],
          ],
          totalRows: 2,
          maxColumns: 2,
          truncated: false,
          sourceStyle: { bom: false, lineEnding: '\n', finalRecordTerminated: false },
        },
        presentation: { merges: [] },
      },
    });

    const empty = parseSheetDocument(wrap('sheet: stillpoint/v1\nformat: csv'));
    expect(empty).toEqual(
      expect.objectContaining({
        ok: true,
        document: expect.objectContaining({
          data: expect.objectContaining({ rows: [], totalRows: 0 }),
        }),
      })
    );
  });

  it('normalizes strict persisted A1 ranges', () => {
    const result = parseSheetDocument(
      wrap(
        [
          'sheet: stillpoint/v1',
          'presentation:',
          '  merges:',
          '    - range: A1:C1',
          '    - range: B2:B3',
        ].join('\n'),
        'anchor,,\n,value\n,'
      )
    );
    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        document: expect.objectContaining({
          presentation: {
            merges: [
              { startRow: 0, endRow: 1, startColumn: 0, endColumn: 3 },
              { startRow: 1, endRow: 3, startColumn: 1, endColumn: 2 },
            ],
          },
        }),
      })
    );
  });

  it('accepts LF and CRLF envelopes while leaving the CSV body to the codec', () => {
    const crlf = parseSheetDocument(
      wrap('sheet: stillpoint/v1\r\nformat: csv', '\uFEFF"a\r\nb",c\r\n1,2', '\r\n')
    );
    expect(crlf).toEqual(
      expect.objectContaining({
        ok: true,
        document: expect.objectContaining({
          data: expect.objectContaining({
            rows: [
              ['a\r\nb', 'c'],
              ['1', '2'],
            ],
          }),
        }),
      })
    );
  });

  it.each([
    ['\uFEFF' + wrap('sheet: stillpoint/v1'), 'invalid_envelope'],
    [' ' + wrap('sheet: stillpoint/v1'), 'invalid_envelope'],
    ['---\nsheet: stillpoint/v1\n', 'invalid_envelope'],
    ['---\nsheet: stillpoint/v1\n...', 'invalid_envelope'],
    ['---\nsheet: stillpoint/v1\n---', 'invalid_envelope'],
  ])('rejects malformed envelope %#', (source, code) => {
    expect(parseSheetDocument(source)).toEqual(
      expect.objectContaining({ ok: false, error: expect.objectContaining({ code }) })
    );
  });

  it('enforces the frontmatter byte limit before YAML parsing', () => {
    expect(parseSheetDocument(wrap('sheet: stillpoint/v1'), { maxFrontmatterBytes: 10 })).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ code: 'frontmatter_too_large' }),
      })
    );
  });

  it.each([
    ['sheet: [', 'invalid_frontmatter'],
    ['sheet: stillpoint/v1\nsheet: stillpoint/v1', 'invalid_frontmatter'],
    ['sheet: stillpoint/v1\n...\nextra: value', 'invalid_frontmatter'],
    ['sheet: &version stillpoint/v1\ncopy: *version', 'invalid_frontmatter'],
    ['sheet: !custom stillpoint/v1', 'invalid_frontmatter'],
    ['<<: { sheet: stillpoint/v1 }', 'invalid_frontmatter'],
    ['sheet: stillpoint/v1\nunknown: value', 'invalid_frontmatter'],
    ['sheet: true', 'invalid_frontmatter'],
    ['sheet: stillpoint/v2', 'unsupported_version'],
    ['sheet: stillpoint/v1\nformat: 1', 'invalid_frontmatter'],
    ['sheet: stillpoint/v1\nformat: json', 'unsupported_format'],
    ['sheet: stillpoint/v1\npresentation: []', 'invalid_presentation'],
    ['sheet: stillpoint/v1\npresentation:\n  alignment: center', 'invalid_presentation'],
    ['sheet: stillpoint/v1\npresentation:\n  merges: value', 'invalid_presentation'],
    [
      'sheet: stillpoint/v1\npresentation:\n  merges:\n    - range: A1:B1\n      style: bold',
      'invalid_presentation',
    ],
    ['sheet: stillpoint/v1\npresentation:\n  merges:\n    - range: 1', 'invalid_presentation'],
    ['sheet: stillpoint/v1\npresentation:\n  merges:\n    - range: a1:B1', 'invalid_presentation'],
  ])('returns a typed error for invalid frontmatter %#', (frontmatter, code) => {
    expect(parseSheetDocument(wrap(frontmatter))).toEqual(
      expect.objectContaining({ ok: false, error: expect.objectContaining({ code }) })
    );
  });

  it('enforces the caller merge limit before parsing individual ranges', () => {
    const result = parseSheetDocument(
      wrap(
        'sheet: stillpoint/v1\npresentation:\n  merges:\n    - range: invalid\n    - range: also-invalid'
      ),
      { maxMerges: 1 }
    );
    expect(result).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ code: 'too_many_merges' }),
      })
    );
  });

  it('wraps CSV failures and passes CSV limits through at the body boundary', () => {
    const malformed = parseSheetDocument(wrap('sheet: stillpoint/v1', '"unclosed'));
    expect(malformed).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({
          code: 'invalid_body',
          cause: expect.objectContaining({ code: 'invalid_csv' }),
        }),
      })
    );

    const limited = parseSheetDocument(wrap('sheet: stillpoint/v1', 'a,b'), {
      csvLimits: { maxColumns: 1 },
    });
    expect(limited).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({
          code: 'invalid_body',
          cause: expect.objectContaining({ code: 'too_many_columns' }),
        }),
      })
    );
  });

  it('does not make YAML-looking plain CSV into a sheet document', () => {
    const csv = parseCsv('---\nsheet: stillpoint/v1\n---');
    expect(csv).toEqual(
      expect.objectContaining({
        ok: true,
        rows: [['---'], ['sheet: stillpoint/v1'], ['---']],
      })
    );
  });

  it('throws only for invalid parser options', () => {
    expect(() => parseSheetDocument(wrap('sheet: stillpoint/v1'), { maxMerges: 0 })).toThrowError(
      RangeError
    );
    expect(() =>
      parseSheetDocument(wrap('sheet: stillpoint/v1'), { maxFrontmatterBytes: 0 })
    ).toThrowError(RangeError);
  });
});

describe('serializeSheetDocument', () => {
  it('writes a deterministic BOM-free envelope, sorted ranges, and unchanged CSV strings', () => {
    const source = serializeSheetDocument({
      rows: [
        ['=SUM(A1:A2)', '', '', ''],
        ['', '', '', ''],
        ['', '', '', ''],
        ['', '', '', ''],
      ],
      presentation: {
        merges: [
          { startRow: 2, endRow: 3, startColumn: 1, endColumn: 3 },
          { startRow: 2, endRow: 4, startColumn: 0, endColumn: 1 },
          { startRow: 0, endRow: 2, startColumn: 0, endColumn: 1 },
        ],
      },
    });

    expect(source).toBe(
      [
        '---',
        'sheet: stillpoint/v1',
        'format: csv',
        'presentation:',
        '  merges:',
        '    - range: A1:A2',
        '    - range: A3:A4',
        '    - range: B3:C3',
        '---',
        '=SUM(A1:A2),,,',
        ',,,',
        ',,,',
        ',,,',
      ].join('\n')
    );
    expect(source.startsWith('\uFEFF')).toBe(false);
  });

  it('omits empty presentation and uses one selected line ending throughout', () => {
    expect(serializeSheetDocument({ rows: [] })).toBe(
      '---\nsheet: stillpoint/v1\nformat: csv\n---\n'
    );
    expect(
      serializeSheetDocument(
        {
          format: 'csv',
          rows: [
            ['a', 'b'],
            ['1', '2'],
          ],
        },
        { lineEnding: '\r\n' }
      )
    ).toBe('---\r\nsheet: stillpoint/v1\r\nformat: csv\r\n---\r\na,b\r\n1,2');
  });

  it('round-trips canonical semantics through parse, serialize, and parse', () => {
    const first = parseSheetDocument(
      wrap(
        'sheet: stillpoint/v1\npresentation:\n  merges:\n    - range: A1:B1',
        'anchor,\nvalue,other'
      )
    );
    if (!first.ok) throw new Error('expected first parse to succeed');
    const canonical = serializeSheetDocument({
      rows: first.document.data.rows,
      presentation: first.document.presentation,
    });
    const second = parseSheetDocument(canonical);
    expect(second).toEqual(first);
  });

  it('rejects invalid programmatic input instead of writing a destructive document', () => {
    expect(() =>
      serializeSheetDocument({
        rows: [['anchor', 'hidden']],
        presentation: {
          merges: [{ startRow: 0, endRow: 1, startColumn: 0, endColumn: 2 }],
        },
      })
    ).toThrowError(RangeError);
    expect(() => serializeSheetDocument({ rows: [[1 as never]] })).toThrowError(TypeError);
    expect(() => serializeSheetDocument({ rows: [] }, { lineEnding: '\r' as never })).toThrowError(
      RangeError
    );
  });
});
