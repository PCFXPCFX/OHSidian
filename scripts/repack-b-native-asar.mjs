// Lead-only local repack: replace the B renderer block inside the CURRENT
// Obsidian asar (which already contains the offer-system-player native patch).
// This keeps the persistent-entry patch while updating the renderer bridge.
import fs from 'node:fs';
import path from 'node:path';
import * as asar from '@electron/asar';

const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const asarPath = path.join(repo, 'web_engine/src/main/resources/resfile/resources/app/obsidian.asar');
const tmp = path.join(repo, '.cache/b-asar-repack');
// The renderer patch text now lives in scripts/patches/touch-mode.js.
const patchSrc = fs.readFileSync(path.join(repo, 'scripts/patches/touch-mode.js'), 'utf8');

// Start at the FIRST native-video symbol, not at the sequence counter:
// ohsidianResolveMediaPath() lives above __ohsidianNativeVideoSeq, and
// slicing from the counter silently dropped every change to path
// resolution (the standalone media-view route never reached the asar).
const fnStart = patchSrc.indexOf('var __ohsidianMediaNotices=0;');
// Include the B error/play/loadedmetadata listeners too. Ending at the first
// `document.addEventListener("error"` silently dropped the 8s HEVC watcher
// and its audio guard from every repack.
const fnEnd = patchSrc.indexOf('/* Back-press consumer', fnStart);
if (fnStart < 0 || fnEnd < 0) throw new Error('B renderer function not found in scripts/patches/touch-mode.js');
const bFunctions = patchSrc.slice(fnStart, fnEnd);

fs.rmSync(tmp, { recursive: true, force: true });
fs.mkdirSync(tmp, { recursive: true });
asar.extractAll(asarPath, tmp);
const appPath = path.join(tmp, 'app.js');
let app = fs.readFileSync(appPath, 'utf8');

const start = app.indexOf('var __ohsidianMediaNotices=0;');
const end = app.indexOf('/* Back-press consumer', start);
if (start < 0 || end < 0 || end <= start) throw new Error('existing B block not found in app.js');
app = app.slice(0, start) + bFunctions + '\n' + app.slice(end);
fs.writeFileSync(appPath, app, 'utf8');

const out = path.join(repo, '.cache/b-obsidian.asar');
await asar.createPackage(tmp, out);
const bytes = fs.statSync(out).size;
fs.copyFileSync(out, asarPath);
console.log('repacked B renderer asar:', bytes, 'bytes');
