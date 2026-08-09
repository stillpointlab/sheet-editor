# @stillpointlab/sheet-editor

Spreadsheet-style CSV grid web components and side-effect-free sheet codecs for Stillpoint Lab
editor surfaces.

## Entrypoints

- `@stillpointlab/sheet-editor/csv` — isomorphic bounded CSV parser and serializer
- `@stillpointlab/sheet-editor/grid` — registers `<sheet-grid>`, a gutterless data table
- `@stillpointlab/sheet-editor/preview` — registers `<sheet-preview>`, an A1-style cells pane
- `@stillpointlab/sheet-editor/presentation` — side-effect-free merge and cell-style validation
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

Both elements accept zero-based, half-open merge and cell-style ranges as atomic presentation
input:

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
      formats: [
        {
          range: { startRow: 0, endRow: 1, startColumn: 0, endColumn: 2 },
          bold: true,
        },
      ],
      alignments: [
        {
          range: { startRow: 0, endRow: 1, startColumn: 0, endColumn: 2 },
          horizontal: 'center',
          vertical: 'bottom',
        },
      ],
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
| Ctrl/Cmd+Z          | Undo a committed edit transaction |

Quick edit assigns Escape to cancel, Enter/Shift+Enter to commit and move down/up, and an unmodified
arrow to commit and move in that direction. F2 or double-click switches to caret edit, where arrows,
Home/End, text selection, clipboard commands, and native undo remain ordinary textarea behavior.
Alt/Option+Enter inserts one LF line break without leaving the cell. Plain Enter still commits and
moves down. Ctrl/Command+Enter remains unassigned for a future range-fill command.

Tab commits through ordinary focus traversal rather than trapping focus inside the grid.

`getContent()` and `content-change` include the open draft so hosts can autosave safely. No-op,
cancel, and undo-to-baseline restore the original CSV byte-for-byte. A real edit preserves BOM,
dominant record ending, and final-record termination while safely canonicalizing CSV quoting.

## Editor toolbar

Every editor toolbar inserts one row above or below the current selection, inserts one column before
or after it, and deletes the active row or column. Insertions use the outside edge of a rectangular
selection; deletion uses its active endpoint. A command collapses selection onto the inserted line
or nearest surviving cell and returns focus to the grid.

Explicit `.sheet` document sessions additionally show Bold, Italic, Strikethrough, and two compact
alignment flyouts. The flyouts contain Left/Center/Right and Top/Middle/Bottom choices. They report
homogeneous or mixed selection state, target the complete merge-expanded stored selection, and do
not pad ragged rows. Plain `setContent()` CSV sessions never show or persist these controls.

The trailing virtual row and column are not stored dimensions. Inserting from either side of a
virtual edge appends one materialized line, while deleting a virtual line is disabled. Column
commands are global spreadsheet operations, so they pad ragged rows to the widest stored row before
inserting or deleting a field. Deleting the only stored row or column produces the empty matrix.

Tab reaches the toolbar through one roving tab stop. Left/Right and Home/End move among enabled
buttons, and Escape returns to the active grid cell. Read-only editors retain the visible toolbar
with disabled controls; malformed and truncated sources omit it.

Each successful command emits one complete `content-change` and is one Ctrl/Cmd+Z transaction.
Clicking a command during cell editing first commits that cell, leaving the commit and structural
or presentation action as two undo steps. Structural changes preserve CSV source style and update
all embedded `.sheet` presentation coordinates atomically.

## `.sheet` documents

The versioned `.sheet` envelope keeps a CSV body and range-based presentation in one text document:

```text
---
sheet: stillpoint/v1
format: csv
presentation:
  merges:
    - range: A1:C1
  formats:
    - range: A1:C1
      bold: true
    - range: B2
      italic: true
      strikethrough: true
  alignments:
    - range: A1:C1
      horizontal: center
      vertical: bottom
---
Quarter,Revenue,Cost
Q1,1200,800
```

Select document handling explicitly. Preview/grid callers parse once and pass the structured result;
the editor accepts the original source so it can preserve an unchanged document byte-for-byte. Plain
CSV remains plain CSV and is never sniffed for an envelope.

```ts
import { parseSheetDocument } from '@stillpointlab/sheet-editor/document';
import '@stillpointlab/sheet-editor/editor';
import '@stillpointlab/sheet-editor/preview';

const parsed = parseSheetDocument(source);
if (parsed.ok) preview.setDocument(parsed.document);

const editor = document.createElement('sheet-editor');
editor.setDocumentSource(source);
```

An optional call-site presentation resolves `merges`, `formats`, and `alignments` independently.
Omitted or `undefined` sections inherit embedded presentation, `null` suppresses all presentation,
an empty section clears only that section, and a supplied section replaces it. Call-site overrides
remain view-only; an editor disables authoring for a format/alignment section masked by an override.

Format rules support `bold`, `italic`, and `strikethrough`; alignment rules support physical
`left`/`center`/`right` and `top`/`middle`/`bottom`. A later overlapping rule wins only for the
properties it supplies. Canonical serialization removes false/default-only state and writes stable,
non-overlapping rectangles. Persisted style ranges use `A1` for a singleton or `A1:C3` for a
rectangle, while merge ranges continue requiring at least two cells.

`getContent()` returns the exact original `.sheet` source until a value changes, including after
cancel or undo-to-baseline. A real value edit returns one canonical document while retaining its
embedded merged ranges and original LF or CRLF family. Call-site presentation remains view-only and
is never serialized.

Editing the `.sheet` envelope itself, formulas, workbook formats, and direct Merge/Unmerge remain
outside this package surface.

## Theming

All three elements follow host theme changes through the Stillpoint tokens
`--spl-text-primary`, `--spl-text-muted`, `--spl-background-primary`, `--spl-header-bg`,
`--spl-border-light`, `--spl-primary-blue`, and `--spl-error-color`. Standalone consumers receive
contrasting light/dark fallbacks through `prefers-color-scheme`.

Owners can override individual sheet surfaces with `--spl-sheet-text`, `--spl-sheet-muted`,
`--spl-sheet-background`, `--spl-sheet-header-background`, `--spl-sheet-border`,
`--spl-sheet-focus`, `--spl-sheet-selection`, and `--spl-sheet-danger`.

## Scripts

- `npm run build` — generate styles and bundle ESM/CJS plus declarations
- `npm run dev` — run the standalone fixture harness
- `npm test` — run Vitest/jsdom coverage
- `npm run typecheck`, `npm run lint`, `npm run format`
