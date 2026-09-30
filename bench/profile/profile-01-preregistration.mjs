// PROFILE-01: замороженная preregistration измерительного протокола.
// Действует ДО любых candidate samples. Любое измерение, проведённое без
// этой регистрации, не является доказательством и не допускается к admission.
// Файл bench-only: production source, exports, бюджеты и гейты не меняются.
// Неизвестное железо — отдельная affected cell (UNPROVEN), а не удачный профиль
// после результата. Повтор опыта до green запрещён.

import { createHash } from 'node:crypto';

function invariant(condition, message) {
  if (!condition) throw new Error(`PROFILE-01 preregistration: ${message}`);
}

// Точный продуктовый base, на котором зафиксирован старый cost vector.
export const PRODUCT_BASE = Object.freeze({
  repo: 'Labpics-Team/lab-motion',
  mainSha: '0912acd875a67bed8f165e345626fd00082e258e',
  mergeOf: 'PR #390; current main before PROFILE measurements',
  registeredFrom: '0fb23264a93a18a8242fd15a2375e9f75845dbdf',
  mergedAtUtc: '2026-09-29T17:24:51Z',
});

// Полный старый cost vector: потолки кода, а не новые оценки.
// Provenance: scripts/size-gate.mjs, blob 4b0f181212b65a881e750e84564778f5828448a3
// на PRODUCT_BASE. Архивные фактические размеры новым измерением не являются:
// метод повторного снятия — node scripts/size-gate.mjs на exact base.
export const OLD_COST_VECTOR_GZIP_BYTES = Object.freeze({
  core: 2220,
  subpath: 4608,
  fullCoreConsumer: 2330,
  nano: 1024,
  compiledRuntime: 341,
  compilerSurface: 1024,
  inView: 1839,
  inViewConsumer: 1908,
  compositorCapability: 6600,
  fullAnimate: 15600,
  animateCompositorMixed: 17500,
  bespoke: Object.freeze({
    './behaviors/reorder': 1518,
    './utils': 1400,
    './compiler/vite': 9163,
    './compiler/runtime': 341,
    './compositor': 6450,
    './compositor/stagger': 6450,
    './tokens': 1650,
    './projection': 5750,
    './smart': 7450,
    './presets': 5600,
    './animate': 15600,
    './nano': 1024,
    './compiler/surface': 1024,
    './in-view': 1839,
    './behaviors': 4600,
  }),
  scenarios: Object.freeze({
    'reorder-controlled': 1522,
    'nano spring-to': 1024,
    'surface executor': 1024,
    'in-view one-liner': 1908,
    'only-spring': 920,
    'projection-core-only': 720,
    'projection-dom-one-liner': 5750,
    'only-MotionValue': 1660,
    'full-core': 2330,
    'compositor-stagger capability': 6600,
    'animate + compositor': 17500,
    'only-clamp (utils tree-shake)': 340,
    'animate-one-liner (фасад)': 15600,
    'animate component scope': 15700,
    'behaviors-sheet-one-liner': 3700,
  }),
  brotliAndTotals: 'initial+reachable total, CSS/data/lazy chunks и Brotli снимаются тем же прогоном size-gate на exact base; знаменатели не смешиваются',
});

// Roster классов устройств/браузеров/сцен по r11 §PROFILE-01.
// Конкретные модели/OS/browser builds выбираются из доступного
// репрезентативного inventory ДО candidate results и замораживаются
// в первом sample-артефакте. Здесь — классы и правило отбора, а не
// выдуманные модели. Флагман не заменяет mid-range.
export const ROSTER = Object.freeze({
  classes: Object.freeze([
    Object.freeze({ id: 'android-mid-60', device: 'physical mid-range Android', refreshHz: 60, browsers: ['chromium-webview-stable'], status: 'UNPROVEN' }),
    Object.freeze({ id: 'android-mid-120', device: 'physical mid-range Android with 120 Hz display', refreshHz: 120, browsers: ['chromium-webview-stable'], status: 'UNPROVEN' }),
    Object.freeze({ id: 'ios-60', device: 'physical iOS', refreshHz: 60, browsers: ['webkit-stable'], status: 'UNPROVEN' }),
    Object.freeze({ id: 'ios-120', device: 'physical iOS with ProMotion', refreshHz: 120, browsers: ['webkit-stable'], status: 'UNPROVEN' }),
    Object.freeze({ id: 'desktop-chromium', device: 'desktop Linux self-hosted runner', refreshHz: null, browsers: ['chromium-stable'], status: 'UNPROVEN' }),
    Object.freeze({ id: 'desktop-firefox', device: 'desktop Linux self-hosted runner', refreshHz: null, browsers: ['firefox-stable'], status: 'UNPROVEN' }),
    Object.freeze({ id: 'desktop-webkit', device: 'desktop Linux self-hosted runner', refreshHz: null, browsers: ['webkit-stable'], status: 'UNPROVEN' }),
  ]),
  selectionRule: 'конкретные модели/OS builds — первые доступные репрезентативные из inventory self-hosted парка на момент первого sample; выбор фиксируется в артефакте и не меняется после candidate results',
  no120HzRule: 'когда device не умеет 120 Hz, 120 Hz target ему не приписывается, но 60 Hz задача остаётся',
  cpuThrottleNote: 'CPU-throttle desktop — диагностический контроль, не mobile proof; порог M-04 не выводится из быстрого сервера',
  fixedConditions: Object.freeze([
    'thermal/power/display state', 'workloads', 'backgrounds', 'viewport/DPR/content',
    'clocks', 'warm/cold режимы', 'sampling units', 'N/iterations/seed', 'все знаменатели',
  ]),
});

// Missing hardware — отдельные affected cells. Ячейка без устройства остаётся
// UNPROVEN и блокирует A/B admission своей клетки; unit/browser подготовка
// при этом не останавливается, платная закупка без допуска запрещена.
export const AFFECTED_CELLS_MISSING_HW = Object.freeze([
  Object.freeze({ cell: 'android-mid-120', blocks: 'A/B admission 120 Hz Android-клетки; 60 Hz задача независима' }),
  Object.freeze({ cell: 'ios-120', blocks: 'A/B admission 120 Hz iOS-клетки; 60 Hz задача независима' }),
  Object.freeze({ cell: 'whole-page energy/GPU', blocks: 'M-04/M-05 full-device cost claims; frame CPU-time клетки независимы' }),
]);

// Замороженные сцены измерения (выбор ДО samples, смена выбора = новая регистрация).
// M-04: 100 активных скалярных каналов, p99 собственного CPU-time Lab Motion ≤0,5 ms/frame;
// полный 120 Hz сценарий: верхняя 95% граница доли пропущенных кадров ≤0,1%.
// M-05: две тяжёлые сцены разных семейств, верхняя 95% граница candidate/best ≤0,50.
export const SCENES = Object.freeze({
  m04channels: Object.freeze({
    id: 'm04-100-scalar-channels',
    channels: 100,
    fixture: 'behaviors-sheet heavy scene (createBottomSheet, snapPoints [0, 300, 600])',
    acceptance: 'p99 собственного CPU-time Lab Motion ≤0,5 ms/frame; OS/browser/render отдельно; deliberate extra work различается стендом',
  }),
  m04full120: Object.freeze({
    id: 'm04-full-120hz',
    acceptance: 'верхняя 95% граница доли пропущенных кадров ≤0,1% выбранного 120 Hz сценария',
  }),
  m05a: Object.freeze({
    id: 'm05-sheet',
    family: 'непосредственное управление (sheet)',
    fixture: 'behaviors-sheet-one-liner consumer (gate 3700 B gzip)',
    acceptance: 'верхняя 95% граница candidate/best ≤0,50 по доминирующей устранимой стоимости; protected клетки не хуже',
  }),
  m05b: Object.freeze({
    id: 'm05-list',
    family: 'изменяемая коллекция (фильтруемый/переставляемый список)',
    fixture: 'reorder-controlled consumer (gate 1522 B gzip)',
    acceptance: 'верхняя 95% граница candidate/best ≤0,50 по доминирующей устранимой стоимости; protected клетки не хуже',
  }),
  rawControlRule: 'для raw control с нулевой стоимостью отношение не вычисляется: требуется совпадение границы и выигрыш другой содержательной метрики',
});

// Raw controls: каждый A/B обязан сопровождаться полным набором.
export const RAW_CONTROLS = Object.freeze({
  noMotion: 'no-motion still control (статический кадр обязан совпадать попиксельно с точностью oracle)',
  reducedMotion: 'reduced-motion control (частые действия имеют no-motion path)',
  waapi: 'raw platform control (bench/compare waapi-control.entry)',
  oldLab: 'old-Lab profile на том же стенде (PRODUCT_BASE без кандидата)',
  bestComparator: 'best-comparator: Motion, Anime Animatable/Layout и raw platform; Rive только в совпадающих authoring/handoff задачах',
  aa: 'A/A: тот же build дважды; обязан различить отсутствие изменения в non-inferiority полосе',
  positive: 'deliberate 2×work положительный контроль обязан детектироваться',
});

// Статистика и MDE. Единица независимости — прогон (run); кадры/каналы внутри
// прогона зависимы и не создают фиктивное число участников.
export const STATS_MDE = Object.freeze({
  independenceUnit: 'run (device × build × scene × mode блок)',
  design: 'парный/блочный дизайн, warm+cold режимы',
  sampleSize: 'N из заранее выбранных MDE/power и null-pilot оценки дисперсии; N замораживается до A/B',
  seed: 'фиксированный seed публикуется в артефакте',
  stoppingRule: 'правило остановки фиксировано заранее; добор samples после просмотра запрещён',
  coverage: 'family-wise 95% coverage либо заранее утверждённая multiplicity correction',
  noRepeatToGreen: 'повтор того же опыта до green не допускается; failed A/A = UNPROVEN + baseline RCA, не NO-GO идеи',
});

// Observation policy: сохраняется всё, failures не удаляются.
export const OBSERVATION_POLICY = Object.freeze({
  preserve: Object.freeze(['все samples', 'failures', 'stalls', 'GC/JIT/context switches', 'malformed receipts']),
  rawAndDigest: 'сырые данные + внешний digest (sha256) в артефакте; команды и метод позволяют независимый replay',
  retention: 'истечение Actions artifact не удаляет единственную копию proof: компактный witness у research owner, raw по durable artifact policy',
  forcedGc: 'forced GC допустим только в выделенном retention proof, не в timing',
  denominators: 'initial, reachable total, cold/warm-compile, startup, interruption, frame, teardown, import/build, peak/retained — свои знаменатели',
});

// Fail-closed калибровка: невалидная калибровка = candidate admission не запускается.
export const CALIBRATION = Object.freeze({
  aaBand: 'A/A обязан показать отсутствие изменения в исходной non-inferiority полосе; старый p95 admission upper ≤1,05 и остальные условия не меняются',
  positiveDetection: 'deliberate 2×work обязан детектироваться стендом',
  failClosed: 'invalid calibration → candidate admission не запускается; baseline-only RCA меняет метод лишь с конкретным дефектом/новой предпосылкой',
  staleProfile: 'профиль, снятый не на зарегистрированном roster/base, к admission не допускается',
});

export const PROFILE_01 = Object.freeze({
  node: 'PROFILE-01',
  revision: 'r11',
  productBase: PRODUCT_BASE,
  oldCostVectorGzipBytes: OLD_COST_VECTOR_GZIP_BYTES,
  roster: ROSTER,
  affectedCellsMissingHw: AFFECTED_CELLS_MISSING_HW,
  scenes: SCENES,
  rawControls: RAW_CONTROLS,
  statsMde: STATS_MDE,
  observationPolicy: OBSERVATION_POLICY,
  calibration: CALIBRATION,
  candidateSamplesObservedAtRegistration: false,
});

export function preregistrationDigest(value = PROFILE_01) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

// Самопроверка замороженного контракта: структура, ТОЧНЫЕ ЗНАЧЕНИЯ
// потолков/сценариев/roster/scenes, fail-closed флаги. Вызывается пробой
// до любых samples. Проверяются именно значения, а не только число ключей:
// частичная проверка (только counts) пропускает тихую подмену значений.
// Якорь заморозки — НЕ этот файл сам по себе, а связка: git ancestry
// (probe доказывает HEAD из PRODUCT_BASE) + exact-head review + CI на
// exact head. Отдельный .sha256-sidecar в том же PR отвергнут сознательно:
// файл в том же trust-domain не добавляет независимости — подмена обновила
// бы оба файла разом. Независимость даёт git-история и ревью, а не второй
// файл рядом.
export function verifyPreregistration(value = PROFILE_01) {
  invariant(value && typeof value === 'object', 'контракт обязан быть объектом');
  invariant(value.node === 'PROFILE-01' && value.revision === 'r11', 'node/revision drifted');
  invariant(value.candidateSamplesObservedAtRegistration === false, 'preregistration обязана предшествовать samples');
  invariant(value.productBase?.repo === 'Labpics-Team/lab-motion', 'product repo drifted');
  invariant(value.productBase?.mainSha === '0912acd875a67bed8f165e345626fd00082e258e', 'product base drifted');
  invariant(value.productBase?.mergedAtUtc === '2026-09-29T17:24:51Z', 'product base время drifted');
  const gates = value.oldCostVectorGzipBytes;
  invariant(gates?.core === 2220 && gates?.subpath === 4608 && gates?.fullCoreConsumer === 2330, 'core/subpath/fullCore ceilings drifted');
  invariant(gates?.nano === 1024 && gates?.compiledRuntime === 341 && gates?.compilerSurface === 1024, 'старые 1024/341/1024 ceilings drifted');
  invariant(gates?.inView === 1839 && gates?.inViewConsumer === 1908, 'in-view ceilings drifted');
  invariant(gates?.compositorCapability === 6600, 'compositor capability ceiling drifted');
  invariant(gates?.fullAnimate === 15600 && gates?.animateCompositorMixed === 17500, 'full/mixed consumer ceilings drifted');
  const bespokeExpected = {
    './behaviors/reorder': 1518, './utils': 1400, './compiler/vite': 9163,
    './compiler/runtime': 341, './compositor': 6450, './compositor/stagger': 6450,
    './tokens': 1650, './projection': 5750, './smart': 7450, './presets': 5600,
    './animate': 15600, './nano': 1024, './compiler/surface': 1024,
    './in-view': 1839, './behaviors': 4600,
  };
  for (const [key, expected] of Object.entries(bespokeExpected)) {
    invariant(gates?.bespoke?.[key] === expected, `bespoke gate ${key} drifted`);
  }
  invariant(Object.keys(gates?.bespoke ?? {}).length === 15, 'bespoke subpath gates drifted');
  const scenariosExpected = {
    'reorder-controlled': 1522, 'nano spring-to': 1024, 'surface executor': 1024,
    'in-view one-liner': 1908, 'only-spring': 920, 'projection-core-only': 720,
    'projection-dom-one-liner': 5750, 'only-MotionValue': 1660, 'full-core': 2330,
    'compositor-stagger capability': 6600, 'animate + compositor': 17500,
    'only-clamp (utils tree-shake)': 340, 'animate-one-liner (фасад)': 15600,
    'animate component scope': 15700, 'behaviors-sheet-one-liner': 3700,
  };
  for (const [key, expected] of Object.entries(scenariosExpected)) {
    invariant(gates?.scenarios?.[key] === expected, `scenario gate ${key} drifted`);
  }
  invariant(Object.keys(gates?.scenarios ?? {}).length === 15, 'consumer scenario gates drifted');
  const rosterIds = (value.roster?.classes ?? []).map((entry) => entry?.id);
  invariant(JSON.stringify(rosterIds) === JSON.stringify(['android-mid-60', 'android-mid-120', 'ios-60', 'ios-120', 'desktop-chromium', 'desktop-firefox', 'desktop-webkit']), 'roster классы drifted');
  invariant((value.affectedCellsMissingHw ?? []).length === 3, 'missing-HW affected cells drifted');
  invariant(value.scenes?.m04channels?.id === 'm04-100-scalar-channels' && value.scenes?.m04channels?.channels === 100, 'M-04 channels сцена drifted');
  invariant(value.scenes?.m04full120?.id === 'm04-full-120hz', 'M-04 120Hz сцена drifted');
  invariant(value.scenes?.m05a?.id === 'm05-sheet' && typeof value.scenes?.m05a?.family === 'string', 'M-05 sheet сцена drifted');
  invariant(value.scenes?.m05b?.id === 'm05-list' && typeof value.scenes?.m05b?.family === 'string', 'M-05 list сцена drifted');
  for (const key of ['noMotion', 'reducedMotion', 'waapi', 'oldLab', 'bestComparator', 'aa', 'positive']) {
    invariant(typeof value.rawControls?.[key] === 'string', `raw control ${key} отсутствует`);
  }
  for (const key of ['independenceUnit', 'design', 'sampleSize', 'seed', 'stoppingRule', 'coverage', 'noRepeatToGreen']) {
    invariant(typeof value.statsMde?.[key] === 'string', `stats/MDE ${key} отсутствует`);
  }
  for (const key of ['preserve', 'rawAndDigest', 'retention', 'forcedGc', 'denominators']) {
    invariant(value.observationPolicy?.[key] !== undefined, `observation policy ${key} отсутствует`);
  }
  for (const key of ['aaBand', 'positiveDetection', 'failClosed', 'staleProfile']) {
    invariant(typeof value.calibration?.[key] === 'string', `calibration ${key} отсутствует`);
  }
  return true;
}
