// electron-builder afterPack hook: give the Windows exe the PaperBridge icon and version info.
// Pure JS (resedit), so packaging for Windows works on Linux / macOS without Wine.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as ResEdit from 'resedit';

/** An .ico holding the given PNG images (PNG-compressed entries, Vista+). */
function icoFromPngs(pngs) {
  const header = Buffer.alloc(6 + 16 * pngs.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  let offset = header.length;
  pngs.forEach(({ size, data }, i) => {
    const e = 6 + 16 * i;
    header.writeUInt8(size >= 256 ? 0 : size, e);
    header.writeUInt8(size >= 256 ? 0 : size, e + 1);
    header.writeUInt16LE(1, e + 4);
    header.writeUInt16LE(32, e + 6);
    header.writeUInt32LE(data.length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...pngs.map((p) => p.data)]);
}

export default async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;
  const { productFilename, version } = context.packager.appInfo;
  const exe = join(context.appOutDir, `${productFilename}.exe`);
  const here = join(context.packager.info.projectDir, 'build');
  const ico = icoFromPngs([{ size: 256, data: readFileSync(join(here, 'icon-256.png')) }]);
  const pe = ResEdit.NtExecutable.from(readFileSync(exe));
  const res = ResEdit.NtExecutableResource.from(pe);
  const icon = ResEdit.Data.IconFile.from(ico);
  const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, groups[0]?.id ?? 1, groups[0]?.lang ?? 1033, icon.icons.map((i) => i.data));
  const versions = ResEdit.Resource.VersionInfo.fromEntries(res.entries);
  const v = versions[0] ?? ResEdit.Resource.VersionInfo.createEmpty();
  const [a, b, c] = (version ?? '0.0.0').split('.').map(Number);
  v.setFileVersion(a, b, c, 0, 1033);
  v.setProductVersion(a, b, c, 0, 1033);
  v.setStringValues({ lang: 1033, codepage: 1200 }, { ProductName: 'PaperBridge', FileDescription: 'PaperBridge 文献阅读翻译', CompanyName: 'PaperBridge', OriginalFilename: `${productFilename}.exe`, InternalName: 'PaperBridge', FileVersion: version, ProductVersion: version, LegalCopyright: 'MIT License' });
  v.outputToResourceEntries(res.entries);
  res.outputResource(pe);
  writeFileSync(exe, Buffer.from(pe.generate()));
  console.log('  • afterPack: icon and version info written to', exe);
}
