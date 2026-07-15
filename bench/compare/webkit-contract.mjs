function fail(message) {
  throw new Error(`WebKit freeze evidence: ${message}`);
}

const SHA256 = /^[0-9a-f]{64}$/;

function assertSha(value, label) {
  if (typeof value !== 'string' || !SHA256.test(value)) fail(`${label}: нужен SHA-256`);
}

export function summarizeBusyPoints(points) {
  if (!Array.isArray(points) || points.length < 10) fail('нужно не менее 10 busy-window кадров');
  for (let index = 0; index < points.length; index++) {
    const point = points[index];
    if (!Number.isSafeInteger(point?.red) || !Number.isSafeInteger(point?.blue)) {
      fail(`кадр ${index + 1} не содержит целые red/blue позиции`);
    }
  }
  const summarize = (color) => {
    const values = points.map((point) => point[color]);
    return {
      uniquePositions: new Set(values).size,
      rangePx: Math.max(...values) - Math.min(...values),
    };
  };
  return { frames: points.length, red: summarize('red'), blue: summarize('blue') };
}

export function validateWebkitFreezeEvidence(report) {
  if (report?.schema !== 2) fail('неподдерживаемая schema');
  const generatedAt = Date.parse(report.generatedAt);
  if (!Number.isFinite(generatedAt) || new Date(generatedAt).toISOString() !== report.generatedAt) {
    fail('невалидный generatedAt');
  }
  const provenance = report.provenance;
  if (provenance?.dirty !== false || !/^[0-9a-f]{40}$/.test(provenance.revision ?? '')) {
    fail('provenance обязан фиксировать clean revision');
  }
  assertSha(provenance.worktreeSha256, 'worktree');
  assertSha(provenance.distRuntime?.sha256, 'dist');
  assertSha(provenance.environment?.nodeExecutableSha256, 'Node executable');
  if (!/^v24\./.test(provenance.environment?.node ?? '') || provenance.environment?.pnpm !== '11.11.0') {
    fail('неверный Node/pnpm toolchain');
  }
  for (const name of ['esbuild', 'playwright', 'pngjs']) {
    const pkg = provenance.environment?.packages?.[name];
    if (typeof pkg?.version !== 'string' || !Number.isSafeInteger(pkg.files) || pkg.files <= 0) {
      fail(`${name}: нет фактической версии/дерева`);
    }
    assertSha(pkg.sha256, `${name} package tree`);
  }
  for (const name of [
    'bench/webkit-freeze.mjs',
    'bench/webkit-contract.mjs',
    'bench/entries/lab-spring.entry.mjs',
  ]) assertSha(provenance.inputs?.[name], name);

  const toolchain = report.toolchain;
  if (
    typeof toolchain?.browser?.version !== 'string' ||
    toolchain.browser.version !== report.customLinear?.browserVersion ||
    toolchain.browser.version !== report.production?.browserVersion
  ) fail('browser version расходится между прогонами');
  if (!/^\d+$/.test(toolchain.browser.revision ?? '') || !Number.isSafeInteger(toolchain.browser.files) || toolchain.browser.files <= 0) {
    fail('невалидный WebKit runtime tree');
  }
  if (!/^\d+$/.test(toolchain.ffmpeg?.revision ?? '')) fail('невалидная ffmpeg revision');
  assertSha(toolchain.browser.executableSha256, 'browser executable');
  assertSha(toolchain.browser.treeSha256, 'browser runtime tree');
  assertSha(toolchain.ffmpeg.executableSha256, 'ffmpeg executable');
  assertSha(toolchain.playwrightRegistry?.bundleSha256, 'Playwright registry bundle');
  assertSha(toolchain.playwrightRegistry?.browsersManifestSha256, 'Playwright browsers manifest');
  assertSha(toolchain.adapterRuntimeSha256, 'runtime adapter');

  for (const kind of ['customLinear', 'production']) {
    const measurement = report[kind];
    const expectedVideo = kind === 'customLinear' ? 'custom-linear.webm' : 'production.webm';
    if (measurement?.video?.file !== expectedVideo) fail(`${kind}: неверное имя video artifact`);
    assertSha(measurement.video.sha256, `${kind} video`);
    const recomputed = summarizeBusyPoints(measurement?.busyPoints);
    if (JSON.stringify(recomputed) !== JSON.stringify(measurement.summary)) {
      fail(`${kind}: summary не пересчитывается из busyPoints`);
    }
    if (recomputed.blue.uniquePositions < 8 || recomputed.blue.rangePx < 30) {
      fail(`${kind}: WAAPI-control не доказал движение`);
    }
  }
  const custom = report.customLinear.summary.red;
  if (custom.uniquePositions > 2 || custom.rangePx > 2) {
    fail('контрфакт custom linear не замер во время freeze');
  }
  const production = report.production.summary.red;
  if (production.uniquePositions < 8 || production.rangePx < 30) {
    fail('production explicit keyframes не доказали движение');
  }
  return report;
}
