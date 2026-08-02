# @stillpointlab/sheet-editor

Spreadsheet-style CSV grid web components and side-effect-free sheet codecs for Stillpoint Lab
editor surfaces.

## Entrypoints

- `@stillpointlab/sheet-editor/csv` — isomorphic bounded CSV parser and serializer
- `@stillpointlab/sheet-editor/grid` — registers `<sheet-grid>`, a gutterless data table
- `@stillpointlab/sheet-editor/preview` — registers `<sheet-preview>`, an A1-style cells pane
- `@stillpointlab/sheet-editor/presentation` — side-effect-free merged-range validation
- `@stillpointlab/sheet-editor/document` — side-effect-free strict `.sheet` parsing and serialization
- `@stillpointlab/sheet-editor/interaction` — side-effect-free selection and merged-cell geometry
- `@stillpointlab/sheet-editor/editor` — registers `<sheet-editor>`, an interactive CSV selection grid
- `@stillpointlab/sheet-editor` — registers and exports the grid, preview, and editor elements

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

## Interactive selection

`<sheet-editor>` adds one accessible source-coordinate selection without changing CSV values. Arrow
keys move the active cell, Shift+Arrow extends the range, and pointer dragging selects a rectangle.
Merged ranges are always entered, crossed, and selected as complete units.

```ts
import '@stillpointlab/sheet-editor/editor';

const editor = document.createElement('sheet-editor');
editor.setContent('Name,Value\nCoffee,12', {
  presentation: {
    merges: [{ startRow: 0, endRow: 1, startColumn: 0, endColumn: 2 }],
  },
});
document.body.append(editor);
editor.focus();
```

Empty and ragged CSV expose one bounded virtual authoring row/column, but selection alone never
materializes those cells.

The editor provides a fast-entry keyboard profile:

| Key in navigation   | Result                            |
| ------------------- | --------------------------------- |
| Enter               | Edit the active value             |
| Printable character | Replace the active value and edit |
| Arrow / Shift+Arrow | Move / extend selection           |
| Ctrl/Cmd+Z          | Undo a committed cell transaction |

Quick edit assigns Escape to cancel, Enter/Shift+Enter to commit and move down/up, and an unmodified
arrow to commit and move in that direction. F2 or double-click switches to caret edit, where arrows,
Home/End, text selection, clipboard commands, and native undo remain ordinary textarea behavior.
Alt/Option+Enter inserts one LF line break without leaving the cell. Plain Enter still commits and
moves down. Ctrl/Command+Enter remains unassigned for a future range-fill command.

Tab commits through ordinary focus traversal rather than trapping focus inside the grid.

`getContent()` and `content-change` include the open draft so hosts can autosave safely. No-op,
cancel, and undo-to-baseline restore the original CSV byte-for-byte. A real edit preserves BOM,
dominant record ending, and final-record termination while safely canonicalizing CSV quoting.

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

Plain CSV editing is not yet enabled. Formulas, workbook formats, structural commands, and
presentation editing remain outside this slice.

## Scripts

- `npm run build` — generate styles and bundle ESM/CJS plus declarations
- `npm run dev` — run the standalone fixture harness
- `npm test` — run Vitest/jsdom coverage
- `npm run typecheck`, `npm run lint`, `npm run format`
