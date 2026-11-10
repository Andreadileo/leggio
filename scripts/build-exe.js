// SPDX-License-Identifier: AGPL-3.0-only
// Costruisce dist/Leggio.exe (Windows x64) con icona e informazioni di versione.
// Uso: npm run build:exe   (funziona anche da Linux/macOS)
//
// L'icona va messa nel binario Node di base PRIMA di impacchettare: modificare l'.exe finale
// romperebbe il contenuto che pkg attacca in coda. Il binario modificato va in una cache
// separata come "built-*", che pkg usa così com'è.
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ResEdit = require('resedit');

const ROOT = path.join(__dirname, '..');
const pkgJson = require(path.join(ROOT, 'package.json'));
const NODE_RANGE = 'node22';
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';

// 1. Scarica (o trova in cache) il binario Node per Windows.
const baseCache = process.env.PKG_CACHE_PATH || path.join(os.homedir(), '.pkg-cache');
execFileSync(npx, ['pkg', '.', '--targets', `${NODE_RANGE}-win-x64`, '--output', path.join(os.tmpdir(), 'leggio-prefetch.exe')], { cwd: ROOT, stdio: 'inherit', env: { ...process.env, PKG_CACHE_PATH: baseCache } });
const findFetched = (dir) => {
  for (const sub of fs.readdirSync(dir)) {
    const p = path.join(dir, sub);
    if (fs.statSync(p).isDirectory()) { const r = findFetched(p); if (r) return r; }
    else if (/^fetched-v22\.[\d.]+-win-x64$/.test(sub)) return p;
  }
  return null;
};
const fetched = findFetched(baseCache);
if (!fetched) throw new Error('Binario Node per Windows non trovato in ' + baseCache);
const nodeVersion = path.basename(fetched).match(/v(22\.[\d.]+)/)[1];

// 2. Copia in una cache separata come "built-*" e mette icona e versione.
const customCache = path.join(os.tmpdir(), 'leggio-pkg-cache');
const customDir = path.join(customCache, path.basename(path.dirname(fetched)));
fs.mkdirSync(customDir, { recursive: true });
const built = path.join(customDir, path.basename(fetched).replace(/^fetched-/, 'built-'));
// Riusa gli altri binari già scaricati (es. quello del sistema su cui si costruisce): niente download doppi.
for (const f of fs.readdirSync(path.dirname(fetched))) {
  const dest = path.join(customDir, f);
  if (f.startsWith('fetched-') && !fs.existsSync(dest)) fs.copyFileSync(path.join(path.dirname(fetched), f), dest);
}

const exe = ResEdit.NtExecutable.from(fs.readFileSync(fetched), { ignoreCert: true });
const res = ResEdit.NtExecutableResource.from(exe);
const icon = ResEdit.Data.IconFile.from(fs.readFileSync(path.join(ROOT, 'leggio.ico')));
ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, 1, 1033, icon.icons.map(i => i.data));
const [vi] = ResEdit.Resource.VersionInfo.fromEntries(res.entries);
const [a, b, c] = pkgJson.version.split('.').map(Number);
vi.setFileVersion(a, b, c, 0, 1033);
vi.setProductVersion(a, b, c, 0, 1033);
vi.setStringValues({ lang: 1033, codepage: 1200 }, {
  FileDescription: 'Leggio — read-only email for AI agents',
  ProductName: 'Leggio',
  CompanyName: 'Andrea Di Leo',
  LegalCopyright: '© 2026 Andrea Di Leo — AGPL-3.0',
  OriginalFilename: 'Leggio.exe',
  InternalName: 'Leggio',
});
vi.removeStringValue({ lang: 1033, codepage: 1200 }, 'Comments');
vi.outputToResourceEntries(res.entries);
res.outputResource(exe);
fs.writeFileSync(built, Buffer.from(exe.generate()));
console.log(`Binario Node ${nodeVersion} con icona Leggio: ${built}`);

// 3. Impacchetta con il binario modificato.
const out = path.join(ROOT, 'dist', 'Leggio.exe');
fs.mkdirSync(path.dirname(out), { recursive: true });
execFileSync(npx, ['pkg', '.', '--targets', `${NODE_RANGE}-win-x64`, '--output', out], { cwd: ROOT, stdio: 'inherit', env: { ...process.env, PKG_CACHE_PATH: customCache } });
console.log(`\nFatto: ${out} (${(fs.statSync(out).size / 1048576).toFixed(1)} MB)`);
