// Copy the built web app (../dist) and the CORS proxy (../proxy) into the desktop package.
// Run `pnpm build` in the repo root first (or set PB_BUILD=1 to build here).
import { execSync } from 'node:child_process';
import { cpSync, existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(dirname(fileURLToPath(import.meta.url)));
const root = dirname(here);
if (process.env.PB_BUILD || !existsSync(join(root, 'dist/index.html'))) execSync('pnpm build', { cwd: root, stdio: 'inherit' });
if (!existsSync(join(root, 'dist/fonts/NotoSerifSC-Regular.ttf'))) throw new Error('dist/fonts is missing the CJK font — run `pnpm build` in the repo root');
for (const dir of ['web', 'proxy']) rmSync(join(here, dir), { recursive: true, force: true });
cpSync(join(root, 'dist'), join(here, 'web'), { recursive: true });
for (const f of ['server.mjs', 'worker.js']) cpSync(join(root, 'proxy', f), join(here, 'proxy', f));
console.log('desktop: copied dist/ → web/, proxy/ → proxy/');
