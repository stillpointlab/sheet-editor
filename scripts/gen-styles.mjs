import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as sass from 'sass';

const here = dirname(fileURLToPath(import.meta.url));
const scssPath = resolve(here, '../src/shared/table.scss');
const outPath = resolve(here, '../src/shared/table.styles.ts');
const { css } = sass.compile(scssPath, { style: 'compressed' });
const banner = '// AUTO-GENERATED from table.scss by scripts/gen-styles.mjs. Do not edit.\n';

writeFileSync(outPath, `${banner}export const tableStyles = ${JSON.stringify(css)};\n`);
console.log(`gen-styles: wrote ${outPath} (${css.length} bytes)`);
