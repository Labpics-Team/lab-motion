/**
 * Воспроизводимый стенд выбора исполняемой формы для WebKit.
 *
 * Видео пишет процесс браузера, поэтому кадры compositor видны даже во время
 * блокировки страницы на 900 мс. Синий маркер — стандартный контроль WAAPI;
 * красный — проверяемая кривая. В окне, где синий маркер продолжает двигаться,
 * многостоповый CSS linear() должен замереть, а текущий план пакета — двигаться.
 *
 * Запуск (корневой dist стенд пересобирает сам):
 *   cd bench/compare
 *   pnpm exec playwright install webkit
 *   node webkit-freeze.mjs
 */

import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import esbuild from 'esbuild';
import { webkit } from 'playwright';
import { PNG } from 'pngjs';
import {
  assertFileHashesUnchanged,
  assertCheckoutUnchanged,
  hashFileTree,
  prepareBenchmarkCheckout,
  sha256File,
} from './provenance.mjs';
import {
  summarizeBusyPoints,
  validateWebkitFreezeEvidence,
} from './webkit-contract.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const ENTRY = path.join(HERE, 'entries', 'lab-native.entry.mjs');

function fail(message) {
  throw new Error(`WebKit freeze-бенч: ${message}`);
}

async function resolvePlaywrightTools() {
  // Registry из фактически установленного playwright учитывает host-specific
  // revision override; лексикографический поиск по общему cache брал чужой ffmpeg.
  const playwrightRoot = realpathSync(path.join(HERE, 'node_modules', 'playwright'));
  const coreRoot = path.join(path.dirname(playwrightRoot), 'playwright-core');
  const registryBundle = path.join(coreRoot, 'lib', 'coreBundle.js');
  const registryModule = await import(pathToFileURL(registryBundle).href);
  const ffmpegDescriptor = registryModule.registry.registry.findExecutable('ffmpeg');
  const webkitDescriptor = registryModule.registry.registry.findExecutable('webkit');
  const ffmpeg = ffmpegDescriptor.executablePathOrDie('javascript');
  return {
    ffmpeg,
    ffmpegRevision: ffmpegDescriptor.revision,
    webkitDirectory: webkitDescriptor.directory,
    webkitRevision: webkitDescriptor.revision,
    registryBundle,
    browsersManifest: path.join(coreRoot, 'browsers.json'),
  };
}

function coloredLeftEdge(buffer, color) {
  const image = PNG.sync.read(buffer);
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const i = (y * image.width + x) << 2;
      const r = image.data[i];
      const g = image.data[i + 1];
      const b = image.data[i + 2];
      const match = color === 'red'
        ? r > 180 && g < 100 && b < 100
        : b > 180 && r < 100 && g < 100;
      if (match) return x;
    }
  }
  return null;
}

function buildAdapter(directory) {
  const outfile = path.join(directory, 'lab-native.iife.js');
  esbuild.buildSync({
    entryPoints: [ENTRY],
    bundle: true,
    format: 'iife',
    globalName: '__adapterModule',
    platform: 'browser',
    outfile,
    logLevel: 'silent',
  });
  return { path: outfile, sha256: sha256File(outfile) };
}

async function record(kind, adapterPath, ffmpeg, artifactDirectory) {
  const temp = mkdtempSync(path.join(os.tmpdir(), `lab-webkit-${kind}-`));
  const framesDir = path.join(temp, 'frames');
  mkdirSync(framesDir);
  const browser = await webkit.launch({ headless: true });
  const browserVersion = browser.version();
  const context = await browser.newContext({
    viewport: { width: 800, height: 100 },
    recordVideo: { dir: temp, size: { width: 800, height: 100 } },
  });
  const page = await context.newPage();
  await page.setContent(`<!doctype html><style>
    body { margin: 0 }
    .red, .blue { position: absolute; left: 0; width: 12px; height: 12px }
    .red { top: 10px; background: #f00 }
    .blue { top: 40px; background: #00f }
  </style><div class="red"></div><div class="blue"></div>`);
  if (kind === 'production') await page.addScriptTag({ path: adapterPath });
  await page.evaluate((mode) => {
    const red = document.querySelector('.red');
    const blue = document.querySelector('.blue');
    const endpoints = [{ transform: 'translateX(0px)' }, { transform: 'translateX(600px)' }];
    blue.animate(endpoints, { duration: 2400, easing: 'linear', fill: 'both' });
    if (mode === 'production') {
      window.__adapterModule.start([red], 600);
    } else {
      red.animate(endpoints, {
        duration: 2400,
        easing: 'linear(0 0%, .2 20%, .5 40%, 1.2 60%, .9 80%, 1 100%)',
        fill: 'both',
      });
    }
    setTimeout(() => {
      const end = performance.now() + 900;
      while (performance.now() < end) { /* воспроизводимый main-thread freeze */ }
    }, 300);
  }, kind);

  await new Promise((resolve) => setTimeout(resolve, 1700));
  const video = page.video();
  await page.close();
  await context.close();
  await browser.close();
  const videoPath = await video.path();
  const preservedVideo = path.join(artifactDirectory, `${kind}.webm`);
  copyFileSync(videoPath, preservedVideo);
  execFileSync(ffmpeg, [
    '-y',
    '-i', videoPath,
    path.join(framesDir, '%04d.png'),
  ], { stdio: 'ignore' });

  const points = readdirSync(framesDir)
    .sort()
    .map((name) => {
      const frame = readFileSync(path.join(framesDir, name));
      return {
        red: coloredLeftEdge(frame, 'red'),
        blue: coloredLeftEdge(frame, 'blue'),
      };
    })
    .filter((point) => point.red !== null && point.blue !== null);
  // Синий x=100…275 соответствует внутренней части busy-окна; края исключены.
  const busy = points.filter((point) => point.blue >= 100 && point.blue <= 275);
  if (busy.length < 10) fail(`${kind}: видео дало только ${busy.length} кадров busy-окна`);
  const result = {
    browserVersion,
    busyPoints: busy,
    summary: summarizeBusyPoints(busy),
    video: {
      file: path.basename(preservedVideo),
      sha256: sha256File(preservedVideo),
    },
  };
  rmSync(temp, { recursive: true, force: true });
  return result;
}

console.log('=== Подготовка воспроизводимого артефакта: pnpm build ===');
const provenance = prepareBenchmarkCheckout({
  root: ROOT,
  benchDirectory: HERE,
  requiredDist: ['dist/animate/native/index.js'],
  requiredPackages: ['esbuild', 'playwright', 'pngjs'],
  requiredInputs: [
    ['bench/webkit-freeze.mjs', path.join(HERE, 'webkit-freeze.mjs')],
    ['bench/webkit-contract.mjs', path.join(HERE, 'webkit-contract.mjs')],
    ['bench/entries/lab-native.entry.mjs', ENTRY],
  ],
});

const generatedAt = new Date().toISOString();
const outputRoot = process.env.WEBKIT_FREEZE_OUTPUT
  ? path.resolve(process.env.WEBKIT_FREEZE_OUTPUT)
  : path.join(ROOT, 'reports', 'webkit-freeze');
const runName = `${generatedAt.replace(/[:.]/g, '-')}-webkit-${provenance.revisionLabel}-${provenance.distRuntime.sha256.slice(0, 12)}`;
const finalArtifactDirectory = path.join(outputRoot, runName);
mkdirSync(outputRoot, { recursive: true });
const artifactDirectory = mkdtempSync(path.join(outputRoot, '.webkit-freeze-'));
const tools = await resolvePlaywrightTools();
const ffmpeg = tools.ffmpeg;
const browserExecutable = webkit.executablePath();
const preRunFingerprints = {
  browser: { path: browserExecutable, sha256: sha256File(browserExecutable) },
  ffmpeg: { path: ffmpeg, sha256: sha256File(ffmpeg) },
  registryBundle: { path: tools.registryBundle, sha256: sha256File(tools.registryBundle) },
  browsersManifest: { path: tools.browsersManifest, sha256: sha256File(tools.browsersManifest) },
};
const preRunBrowserTree = hashFileTree(tools.webkitDirectory);
const buildDir = mkdtempSync(path.join(os.tmpdir(), 'lab-webkit-adapter-'));
try {
  const adapter = buildAdapter(buildDir);
  // Adapter и executable-байты фиксируются до первого browser launch.
  const preRunAdapter = { ...adapter };
  const custom = await record('custom-linear', adapter.path, ffmpeg, artifactDirectory);
  const production = await record('production', adapter.path, ffmpeg, artifactDirectory);
  assertCheckoutUnchanged(ROOT, provenance);
  const report = {
    schema: 1,
    generatedAt,
    provenance,
    toolchain: {
      browser: {
        version: custom.browserVersion,
        revision: tools.webkitRevision,
        executableSha256: preRunFingerprints.browser.sha256,
        files: preRunBrowserTree.files,
        treeSha256: preRunBrowserTree.sha256,
      },
      ffmpeg: {
        revision: tools.ffmpegRevision,
        executableSha256: preRunFingerprints.ffmpeg.sha256,
      },
      playwrightRegistry: {
        bundleSha256: preRunFingerprints.registryBundle.sha256,
        browsersManifestSha256: preRunFingerprints.browsersManifest.sha256,
      },
      adapterRuntimeSha256: adapter.sha256,
    },
    customLinear: custom,
    production,
  };
  validateWebkitFreezeEvidence(report);
  const postRunBrowserTree = hashFileTree(tools.webkitDirectory);
  if (
    postRunBrowserTree.files !== preRunBrowserTree.files ||
    postRunBrowserTree.sha256 !== preRunBrowserTree.sha256
  ) fail('browser runtime tree изменился во время прогона');
  assertFileHashesUnchanged({
    adapter: preRunAdapter,
    ...preRunFingerprints,
    customVideo: {
      path: path.join(artifactDirectory, custom.video.file),
      sha256: custom.video.sha256,
    },
    productionVideo: {
      path: path.join(artifactDirectory, production.video.file),
      sha256: production.video.sha256,
    },
  });
  const serialized = JSON.stringify(report, null, 2);
  console.log(serialized);
  const reportPath = path.join(artifactDirectory, 'manifest.json');
  writeFileSync(reportPath, `${serialized}\n`, { flag: 'wx' });
  renameSync(artifactDirectory, finalArtifactDirectory);
  console.log(`Аудируемый артефакт: ${finalArtifactDirectory}`);
  console.log('PASS: WebKit production-кривая продолжает движение во время 900-мс main-thread freeze.');
} finally {
  rmSync(buildDir, { recursive: true, force: true });
  rmSync(artifactDirectory, { recursive: true, force: true });
}
