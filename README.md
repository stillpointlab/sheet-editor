# @stillpointlab/sheet-editor

Read-only spreadsheet-style CSV preview and grid web components for Stillpoint Lab editor
surfaces.

## Entrypoints

- `@stillpointlab/sheet-editor/csv` — isomorphic bounded CSV parser and serializer
- `@stillpointlab/sheet-editor/grid` — registers `<sheet-grid>`, a gutterless data table
- `@stillpointlab/sheet-editor/preview` — registers `<sheet-preview>`, an A1-style cells pane
- `@stillpointlab/sheet-editor/presentation` — side-effect-free merged-range validation
- `@stillpointlab/sheet-editor/document` — side-effect-free strict `.sheet` parsing and serialization
- `@stillpointlab/sheet-editor` — registers and exports both preview-facing elements

## Usage

```ts
import '@stillpointlab/sheet-editor/preview';

const preview = document.createElement('sheet-preview');
preview.setContent('Name,Value\r\nCoffee,12');
document.body.append(preview);
```

Structured consumers can bypass CSV:

```ts
import '@stillpointlab/sheet-editor/grid';

const grid = document.createElement('sheet-grid');
grid.setData(
  [
    ['Name', 'Value'],
    ['Coffee', '12'],
  ],
  { headerRow: true }
);
document.body.append(grid);
```

Both elements accept zero-based, half-open merged ranges as atomic presentation input:

```ts
grid.setData(
  [
    ['Grouped heading', ''],
    ['One', 'Two'],
  ],
  {
    headerRow: true,
    presentation: {
      merges: [{ startRow: 0, endRow: 1, startColumn: 0, endColumn: 2 }],
    },
  }
);
```

## `.sheet` documents

The versioned `.sheet` envelope keeps a CSV body and merged-cell presentation in one text document:

```text
---
sheet: stillpoint/v1
format: csv
presentation:
  merges:
    - range: A1:C1
---
Quarter,Revenue,Cost
Q1,1200,800
```

Parse the document explicitly and pass its structured result to either element. Plain CSV remains
plain CSV and is never sniffed for an envelope.

```ts
import { parseSheetDocument } from '@stillpointlab/sheet-editor/document';
import '@stillpointlab/sheet-editor/preview';

const parsed = parseSheetDocument(source);
if (parsed.ok) preview.setDocument(parsed.document);
```

An optional call-site presentation inherits embedded merges when omitted, suppresses them with
`null` or `{ merges: [] }`, and replaces the complete merge section when ranges are supplied.

The package is preview-only. CSV editing, formulas, cell selection, and workbook formats are
deliberately outside the MVP.

## Scripts

- `npm run build` — generate styles and bundle ESM/CJS plus declarations
- `npm run dev` — run the standalone fixture harness
- `npm test` — run Vitest/jsdom coverage
- `npm run typecheck`, `npm run lint`, `npm run format`
