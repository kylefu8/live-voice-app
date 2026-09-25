import {build} from 'esbuild';
import {copyFile, mkdir, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join, resolve} from 'node:path';

const desktopRoot = resolve(fileURLToPath(new URL('../', import.meta.url)));
const runDir = process.env.LIVE_VOICE_STRESS_RUN_DIR;
if (typeof runDir !== 'string' || !runDir.trim()) {
  throw new Error('stress_run_dir_missing');
}

const outputRoot = resolve(runDir, 'app');
await mkdir(outputRoot, {recursive: true});

await build({
  entryPoints: [join(desktopRoot, 'scripts', 'live-stress-main.mjs')],
  outfile: join(outputRoot, 'main.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron', 'bufferutil', 'utf-8-validate'],
  logLevel: 'warning',
});

await build({
  entryPoints: [join(desktopRoot, 'scripts', 'live-stress-renderer.mjs')],
  outfile: join(outputRoot, 'renderer.js'),
  bundle: true,
  platform: 'browser',
  format: 'esm',
  target: 'chrome140',
  logLevel: 'warning',
});

await copyFile(
  join(desktopRoot, 'scripts', 'live-stress-preload.cjs'),
  join(outputRoot, 'preload.cjs'),
);

const index = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; media-src 'self' blob:; connect-src 'self'; base-uri 'none'; form-action 'none'; object-src 'none">
    <title>Live Voice stress harness</title>
  </head>
  <body>
    <audio id="stress-remote-audio" autoplay muted></audio>
    <audio id="stress-prompt-audio" preload="auto"></audio>
    <script type="module" src="renderer.js"></script>
  </body>
</html>
`;
await writeFile(join(outputRoot, 'index.html'), index, 'utf8');

console.log('STRESS_BUILD_READY');
