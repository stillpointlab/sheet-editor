import '../src/grid';
import '../src/preview';

import type { SheetGrid } from '../src/grid';
import type { SheetPreview } from '../src/preview';

const regular = [
  'Name,Description,Value',
  '"Coffee, beans","Line one',
  'continues here",12',
  'Tea,"A ""quoted"" note"',
].join('\r\n');

const fixtures: Record<string, string> = {
  regular,
  wide: Array.from({ length: 30 }, (_, index) => `Column ${index + 1}`).join(','),
  truncated: Array.from({ length: 1001 }, (_, index) => `${index},Item ${index}`).join('\n'),
  malformed: '"Unclosed quoted field',
  oversized: 'x'.repeat(256 * 1024 + 1),
};

const preview = document.querySelector('#preview') as SheetPreview;
const grid = document.querySelector('#grid') as SheetGrid;
const fixture = document.querySelector('#fixture') as HTMLSelectElement;
const panes = [...document.querySelectorAll('.pane')];

function render(): void {
  const source = fixtures[fixture.value] ?? regular;
  preview.setContent(source);
  grid.setContent(source);
}

fixture.addEventListener('change', render);
document.querySelector('#width')?.addEventListener('click', () => {
  for (const pane of panes) pane.classList.toggle('narrow');
});
document.querySelector('#theme')?.addEventListener('click', () => {
  document.body.classList.toggle('dark');
});

render();
