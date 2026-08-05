import '../src/grid';
import '../src/editor';
import '../src/preview';

import { parseSheetDocument } from '../src/document';

import type { SheetEditor } from '../src/editor';
import type { SheetGrid } from '../src/grid';
import type { SheetPresentation } from '../src/presentation';
import type { SheetPreview } from '../src/preview';

const regular = [
  'Name,Description,Value',
  '"Coffee, beans","Line one',
  'continues here",12',
  'Tea,"A ""quoted"" note"',
].join('\r\n');

interface Fixture {
  source: string;
  presentation?: SheetPresentation;
  documentSource?: string;
  documentOverride?: SheetPresentation | null;
}

const fixtures: Record<string, Fixture> = {
  empty: { source: '' },
  'bom-lf': { source: '\uFEFFName,Value\nCoffee,12\n' },
  regular: { source: regular },
  wide: { source: Array.from({ length: 30 }, (_, index) => `Column ${index + 1}`).join(',') },
  truncated: {
    source: Array.from({ length: 1001 }, (_, index) => `${index},Item ${index}`).join('\n'),
  },
  malformed: { source: '"Unclosed quoted field' },
  oversized: { source: 'x'.repeat(256 * 1024 + 1) },
  horizontal: {
    source: 'Header A,Header B,Header C\nWide value,,Tail\nOne,Two,Three',
    presentation: {
      merges: [{ startRow: 1, endRow: 2, startColumn: 0, endColumn: 2 }],
    },
  },
  vertical: {
    source: 'Header A,Header B\nTall value,One\n,Two',
    presentation: {
      merges: [{ startRow: 1, endRow: 3, startColumn: 0, endColumn: 1 }],
    },
  },
  rectangle: {
    source: 'Header A,Header B,Header C\nRectangle,,Tail\n,,Other',
    presentation: {
      merges: [{ startRow: 1, endRow: 3, startColumn: 0, endColumn: 2 }],
    },
  },
  'promoted-header': {
    source: 'Grouped heading,,Other\nOne,Two,Three',
    presentation: {
      merges: [{ startRow: 0, endRow: 1, startColumn: 0, endColumn: 2 }],
    },
  },
  rejected: {
    source: 'Header A,Header B\nVisible,Would be hidden',
    presentation: {
      merges: [{ startRow: 1, endRow: 2, startColumn: 0, endColumn: 2 }],
    },
  },
  'document-default': {
    source: '',
    documentSource:
      '---\nsheet: stillpoint/v1\npresentation:\n  merges:\n    - range: A1:B1\n---\nEmbedded merge,\nOne,Two',
  },
  'document-explicit': {
    source: '',
    documentSource:
      '---\nsheet: stillpoint/v1\nformat: csv\npresentation:\n  merges:\n    - range: A2:A3\n---\nHeader A,Header B\nTall value,One\n,Two',
  },
  'document-override': {
    source: '',
    documentSource:
      '---\nsheet: stillpoint/v1\npresentation:\n  merges:\n    - range: A1:B1\n---\nHeader A,\nReplacement,One\n,Two',
    documentOverride: {
      merges: [{ startRow: 1, endRow: 3, startColumn: 0, endColumn: 1 }],
    },
  },
  'document-invalid': {
    source: '',
    documentSource:
      '---\nsheet: stillpoint/v1\npresentation:\n  merges:\n    - range: A2:B2\n---\nHeader A,Header B\nVisible,Would be hidden',
  },
};

const preview = document.querySelector('#preview') as SheetPreview;
const grid = document.querySelector('#grid') as SheetGrid;
const editor = document.querySelector('#editor') as SheetEditor;
const editorContent = document.querySelector('#editor-content') as HTMLElement;
const fixture = document.querySelector('#fixture') as HTMLSelectElement;
const panes = [...document.querySelectorAll('.pane')];

function render(): void {
  const selected = fixtures[fixture.value] ?? fixtures.regular;
  if (selected.documentSource !== undefined) {
    const parsed = parseSheetDocument(selected.documentSource);
    if (!parsed.ok) throw new Error(parsed.error.message);
    preview.setDocument(parsed.document, { presentation: selected.documentOverride });
    grid.setDocument(parsed.document, { presentation: selected.documentOverride });
    editor.setDocumentSource(selected.documentSource, {
      presentation: selected.documentOverride,
    });
    editorContent.textContent = editor.getContent();
    return;
  }
  preview.setContent(selected.source, { presentation: selected.presentation });
  grid.setContent(selected.source, { presentation: selected.presentation });
  editor.setContent(selected.source, { presentation: selected.presentation });
  editorContent.textContent = editor.getContent();
}

editor.addEventListener('content-change', () => {
  editorContent.textContent = editor.getContent();
});

fixture.addEventListener('change', render);
document.querySelector('#width')?.addEventListener('click', () => {
  for (const pane of panes) pane.classList.toggle('narrow');
});
document.querySelector('#theme')?.addEventListener('click', () => {
  document.body.classList.toggle('dark');
});

render();
