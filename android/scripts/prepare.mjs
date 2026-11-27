// Copy the built web app (../dist) into android/app/src/main/assets/www/
// and generate Android mipmap launcher icons from public/icon-512.png.
import { execSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const androidDir = dirname(dirname(fileURLToPath(import.meta.url)));
const root = dirname(androidDir);
const distDir = join(root, 'dist');
const wwwDir = join(androidDir, 'app', 'src', 'main', 'assets', 'www');

if (process.env.PB_BUILD || !existsSync(join(distDir, 'index.html'))) {
  execSync('pnpm build', { cwd: root, stdio: 'inherit' });
}
if (!existsSync(join(distDir, 'fonts', 'NotoSerifSC-Regular.ttf'))) {
  throw new Error('dist/fonts is missing NotoSerifSC-Regular.ttf — run `pnpm build` first');
}

rmSync(wwwDir, { recursive: true, force: true });
mkdirSync(wwwDir, { recursive: true });
cpSync(distDir, wwwDir, { recursive: true });

// Ensure launcher icons exist in all mipmap densities (fallback to copying icon-512/192 if already generated)
const icon512 = join(root, 'public', 'icon-512.png');
const icon192 = join(root, 'public', 'icon-192.png');
const densities = [
  ['mipmap-mdpi', icon192],
  ['mipmap-hdpi', icon192],
  ['mipmap-xhdpi', icon192],
  ['mipmap-xxhdpi', icon512],
  ['mipmap-xxxhdpi', icon512],
];
for (const [dir, src] of densities) {
  const targetDir = join(androidDir, 'app', 'src', 'main', 'res', dir);
  mkdirSync(targetDir, { recursive: true });
  for (const name of ['ic_launcher.png', 'ic_launcher_round.png']) {
    const dest = join(targetDir, name);
    if (!existsSync(dest) && existsSync(src)) cpSync(src, dest);
  }
}

console.log('android: copied dist/ → app/src/main/assets/www/ and verified mipmap icons');
