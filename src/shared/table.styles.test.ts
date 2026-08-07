import { describe, expect, it } from 'vitest';

import { tableStyles } from './table.styles';

describe('shared table styles', () => {
  it('inherits the host theme tokens with standalone light and dark fallbacks', () => {
    for (const token of [
      '--spl-text-primary',
      '--spl-text-muted',
      '--spl-background-primary',
      '--spl-header-bg',
      '--spl-border-light',
      '--spl-primary-blue',
      '--spl-error-color',
    ]) {
      expect(tableStyles).toContain(token);
    }
    expect(tableStyles).not.toContain('--color-');
  });

  it('reserves the sticky addressed gutters as scroll padding', () => {
    expect(tableStyles).toContain('scroll-padding-block-start');
    expect(tableStyles).toContain('scroll-padding-inline-start');
    expect(tableStyles).toContain('--spl-sheet-row-gutter-width');
  });

  it('keeps the editor toolbar above the independently scrolling grid', () => {
    expect(tableStyles).toContain('.sheet-surface--editor');
    expect(tableStyles).toContain('grid-template-rows:auto minmax(0, 1fr) auto');
    expect(tableStyles).toContain('.sheet-editor__toolbar');
    expect(tableStyles).toContain('overflow-x:auto');
    expect(tableStyles).toContain('.sheet-editor__toolbar-button--delete');
    expect(tableStyles).toContain('--spl-sheet-danger');
  });
});
