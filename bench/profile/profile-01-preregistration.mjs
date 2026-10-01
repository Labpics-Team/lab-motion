// Исполняемый контракт PROFILE-01. Версия закрепляется до измерений кандидата.
// Неизмеренные клетки сохраняют UNPROVEN и не дают допуска A/B.

import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

function deepFreeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function invariant(condition, message) {
  if (!condition) throw new Error(`PROFILE-01 preregistration: ${message}`);
}

// Точный main после исправления зависимостей тестов.
// Runtime, размерный измеритель и потолки прежнего baseline сохранены.
export const PRODUCT_BASE = Object.freeze({
  repo: 'Labpics-Team/lab-motion',
  sourceSha: '7d3ed42e5b054a06e4f6ca7f0c2efc02484e20fd',
  upstreamMainSha: '7d3ed42e5b054a06e4f6ca7f0c2efc02484e20fd',
  sizeGateBlob: '4b0f181212b65a881e750e84564778f5828448a3',
  reason: 'исправление безопасности зависимостей; runtime и размерные потолки сохранены',
});

// Полный старый cost vector: потолки кода, а не новые оценки.
// Provenance: scripts/size-gate.mjs, PRODUCT_BASE.sizeGateBlob.
// Архивные фактические размеры новым измерением не являются:
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

// Классы устройств по r11 §PROFILE-01. Конкретные модели и версии выбираются
// до измерений кандидата; флагман не заменяет устройство среднего класса.
export const ROSTER = Object.freeze({
  classes: Object.freeze([
    Object.freeze({ id: 'android-mid-60', device: 'физический Android среднего класса', refreshHz: 60, browsers: ['chromium-webview-stable'], status: 'UNPROVEN' }),
    Object.freeze({ id: 'android-mid-120', device: 'физический Android среднего класса с экраном 120 Гц', refreshHz: 120, browsers: ['chromium-webview-stable'], status: 'UNPROVEN' }),
    Object.freeze({ id: 'ios-60', device: 'физическое устройство iOS', refreshHz: 60, browsers: ['webkit-stable'], status: 'UNPROVEN' }),
    Object.freeze({ id: 'ios-120', device: 'физическое устройство iOS с ProMotion', refreshHz: 120, browsers: ['webkit-stable'], status: 'UNPROVEN' }),
    Object.freeze({ id: 'desktop-chromium', device: 'настольный Linux на собственном runner', refreshHz: null, browsers: ['chromium-stable'], status: 'UNPROVEN' }),
    Object.freeze({ id: 'desktop-firefox', device: 'настольный Linux на собственном runner', refreshHz: null, browsers: ['firefox-stable'], status: 'UNPROVEN' }),
    Object.freeze({ id: 'desktop-webkit', device: 'настольный Linux на собственном runner', refreshHz: null, browsers: ['webkit-stable'], status: 'UNPROVEN' }),
  ]),
  selectionRule: 'модели и версии ОС — первые доступные репрезентативные устройства собственного парка; выбор фиксируется до измерений кандидата',
  no120HzRule: 'когда device не умеет 120 Hz, 120 Hz target ему не приписывается, но 60 Hz задача остаётся',
  cpuThrottleNote: 'CPU-throttle desktop — диагностический контроль, не mobile proof; порог M-04 не выводится из быстрого сервера',
  fixedConditions: Object.freeze([
    'температура, питание и состояние экрана', 'нагрузка', 'фоновые процессы', 'viewport/DPR/content',
    'источники времени', 'warm/cold режимы', 'единицы выборки', 'N/iterations/seed', 'все знаменатели',
  ]),
});

// Отсутствие оборудования затрагивает отдельные клетки. Клетка без устройства остаётся
// UNPROVEN и блокирует A/B admission своей клетки; unit/browser подготовка
// при этом не останавливается, платная закупка без допуска запрещена.
export const AFFECTED_CELLS_MISSING_HW = Object.freeze([
  Object.freeze({ cell: 'android-mid-120', blocks: 'A/B admission 120 Hz Android-клетки; 60 Hz задача независима' }),
  Object.freeze({ cell: 'ios-120', blocks: 'A/B admission 120 Hz iOS-клетки; 60 Hz задача независима' }),
  Object.freeze({ cell: 'whole-page energy/GPU', blocks: 'выводы M-04/M-05 о полной стоимости устройства; frame CPU-time клетки независимы' }),
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

// Каждый A/B сопровождается полным набором контрольных измерений.
export const RAW_CONTROLS = Object.freeze({
  noMotion: 'статический кадр без движения обязан совпадать попиксельно с точностью оракула',
  reducedMotion: 'при reduced-motion частые действия имеют путь без движения',
  waapi: 'платформенный контроль bench/compare/waapi-control.entry',
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

// Неудачные измерения сохраняются вместе с успешными.
export const OBSERVATION_POLICY = Object.freeze({
  preserve: Object.freeze(['все samples', 'отказы', 'зависания', 'GC/JIT/context switches', 'повреждённые квитанции']),
  rawAndDigest: 'сырые данные + внешний digest (sha256) в артефакте; команды и метод позволяют независимый replay',
  retention: 'истечение Actions artifact не удаляет единственную копию proof: компактный witness у research owner, raw по durable artifact policy',
  forcedGc: 'forced GC допустим только в выделенном retention proof, не в timing',
  denominators: 'initial, reachable total, cold/warm-compile, startup, interruption, frame, teardown, import/build, peak/retained — свои знаменатели',
});

// Недействительная калибровка запрещает допуск кандидата.
export const CALIBRATION = Object.freeze({
  aaBand: 'A/A обязан показать отсутствие изменения в исходной non-inferiority полосе; старый p95 admission upper ≤1,05 и остальные условия не меняются',
  positiveDetection: 'deliberate 2×work обязан детектироваться стендом',
  failClosed: 'invalid calibration → candidate admission не запускается; baseline-only RCA меняет метод лишь с конкретным дефектом/новой предпосылкой',
  staleProfile: 'профиль, снятый не на зарегистрированном roster/base, к admission не допускается',
});

export const PROFILE_01 = deepFreeze({
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

// Размер пакета не измеряет временные клетки roster. Имя runner и переменная
// среды не превращают отсутствие измерения в доказательство.
export function unmeasuredCells(cells) {
  invariant(cells === 'desktop' || cells === 'all', 'неизвестный набор клеток');
  return PROFILE_01.roster.classes
    .filter((cell) => cells === 'all' || cell.id.startsWith('desktop-'))
    .map((cell) => ({ cell: cell.id, reason: 'временные метрики и калибровка устройства не измерены', blocks: 'допуск A/B для этой клетки' }))
    .concat([{ cell: 'whole-page energy/GPU', reason: 'энергия и GPU устройства не измерены', blocks: 'выводы M-04/M-05 о полной стоимости устройства' }]);
}

// Вход сравнивается целиком с одним неизменяемым протоколом. Его версию
// закрепляют commit, независимое ревью и CI; копия констант рядом не нужна.
export function verifyPreregistration(value = PROFILE_01) {
  invariant(isDeepStrictEqual(value, PROFILE_01), 'контракт отличается от зарегистрированного протокола');
  return true;
}
