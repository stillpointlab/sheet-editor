import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    csv: 'src/csv/index.ts',
    grid: 'src/grid/index.ts',
    preview: 'src/preview/index.ts',
    presentation: 'src/presentation/index.ts',
    document: 'src/document/index.ts',
    editor: 'src/editor/index.ts',
    interaction: 'src/interaction/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'es2022',
  splitting: false,
});
