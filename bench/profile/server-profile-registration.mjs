// Серверная диагностическая клетка PROFILE-01. Устройства, энергия, GPU и
// частота физического экрана требуют отдельных доказательств и здесь не выводятся.
import { isDeepStrictEqual } from 'node:util';
import { sha256Bytes } from '../compare/provenance.mjs';

function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

export const SERVER_PROFILE = freeze({
  schema: 1,
  rawEncoding: 'compact-json-stream-v1/native-cpu-rle-v1; каждый образец и точно восстановленное поле CPU сохраняются; внешний digest и журнал связывают точные байты файла',
  id: 'PROFILE-01-server',
  baselineRevision: '0b6f537e148b7dadadfb9e3ce7c446d014975958',
  candidateSamplesObservedScope: 'На момент регистрации ещё нет зарегистрированных образцов стоимости CPU/API текущей эпохи протокола; прежние исследовательские измерения прошедшего времени stock и семантические проверки и проверки памяти кандидата уже известны',
  exploratoryPrehistory: {
    kind: 'Существующее измерение прошедшего времени stock C; исследовательское основание выбора области до нового протокола CPU, не зарегистрированные образцы CPU',
    baselineReportedMedian: '7.2k ns', candidateReportedMedian: '8.3k ns',
    baselineStdoutSha256: '28b5cdb758254fba1c49b658541a2ecfe0e840e0ed53d108cfe03f82e8ca205b',
    candidateStdoutSha256: '1ccde5b80240f0abdf9806d0543a6782fe4b5799af80083b933775e578973b73',
    helperSemanticReceiptSha256: '010140351e9b3e2f17b1be6bd632a9ee21be67cf41220adcb86f1aec51010686',
    selectionScope: 'N выводится только из нового пилота базовой версии по прежнему закону; 1.05/MDE/power/counts не подгоняются к исследовательскому эффекту',
  },
  browsers: ['chromium', 'firefox', 'webkit'],
  viewport: { width: 800, height: 200 },
  deviceScaleFactor: 1,
  headless: true,
  cpuThrottle: 1,
  engineScenes: [
    { id: 'scalar-live-100', lifecycle: 'live', count: 100, channels: 1 },
    { id: 'transform-fresh-1000', lifecycle: 'fresh', count: 1000, channels: 7 },
    { id: 'motion-value-default-stock-c', workload: 'stock-c', callsPerRepetition: 2000, warmupBatches: 2,
      expectedFrames: 47, initial: 0, target: 100, spring: { mass: 1, stiffness: 170, damping: 26 }, metrics: ['operationNs'] },
  ],
  browserScenes: [
    { id: 's2', targetsPerCall: 100, staggerGapMs: 0 },
    { id: 's3', targetsPerCall: 200, staggerGapMs: 5 },
  ],
  comparators: ['motion', 'gsap', 'anime', 'waapi-ctl', 'motion-mini', 'anime-waapi'],
  durationMs: 128,
  toPx: 300,
  repetitions: 8,
  browserBatchCalls: 32,
  browserSemanticCalls: 1,
  browserSemantics: { movementThresholdPx: 0.5, finalTolerancePx: 2, requireFreshStart: true, fromPx: 0, requireDocumentFrame: true,
    temporalOracle: 'Наблюдаемое свежее начало движения 0→300 до/после API; фаза связана с началом вызова. Полный интервал смещения разрешающей пары находится внутри прежнего допуска CSS. Время начала движения ограничено фактическими часами пакета вызовов и чтения; CSS наблюдается в фактическом стабильном кадре документа, связанном с rAF. Хронология performance сохранена, без расширения при неопределённости' },
  warmupRuns: 4,
  pilotRuns: 8,
  minRuns: 292,
  maxRuns: 1024,
  seed: 0x53525652,
  statistics: 'точные биномиальные интервалы порядковых статистик по среднему стоимости двух противоположных runs',
  familyAlpha: 0.05,
  familySize: 11,
  nonInferiorityUpper: 1.05,
  positiveLower: 1.5,
  positiveWorkMultiplier: 2,
  mdeRelative: 0.05,
  power: 0.8,
  zPower: 0.8416212335729143,
  // Bonferroni: 11 клеток × p50/p95, двухсторонняя 95% полоса для всего семейства.
  zFamily: 3.052065201864885,
  metrics: {
    engine: ['operationNs', 'meanFrameNs', 'cancelDrainNs'],
    browser: ['startMs', 'cancelMs'],
  },
  clock: { engine: 'Linux CLOCK_THREAD_CPUTIME_ID: сообщённое время исполнения текущего потока по планировщику, наносекунды', browser: 'performance.now локального контекста исполнения, миллисекунды' },
  engineRawLineage: 'Без потерь сохраняются нативные CLOCK_THREAD_CPUTIME_ID (секунды/наносекунды/PID/TID) и упорядоченные трассы планировщика/CSS. Для прежнего API (legacy) — 16 конечных меток; для stockC — 2 метки, все исходы 47 кадров и конечное значение 100. Существующий измеритель пересчитывает метки BigInt, интервалы и знаменатель',
  samplingUnit: 'Средняя стоимость парного блока двух запусков в противоположном порядке; повторы/кадры зависимы; p95 относится к распределению средних блоков',
  denominator: 'Стоимость полезного вызова с зарегистрированными целями: пакет браузерных вызовов/32; положительный контроль — 64 фактических вызова. Прежний знаменатель engine не меняется. Для stockC: пакет/2000; положительный контроль — 4000 фактических вызовов/2000, без деления на два',
  participantImports: {
    baseline: { browserExport: './animate', browserOwner: 'lab-legacy', stockExport: '.' },
    candidate: { browserExport: '.', browserOwner: 'lab', stockExport: './driver' },
  },
  stockCpuScope: 'Штатный макросценарий прежнего stockC MotionValue: базовая версия — корневой экспорт установленного пакета, кандидат — повторный экспорт driver; новый корневой объект не используется. Вне CPU-измерения: фабрика, два прогрева по 2000 вызовов, RLE и независимая проверка. Внутри, одинаково для обеих ролей: чтение часов, завершение очереди, создание объекта, onChange/setTarget/destroy и запись last/getFrameCount каждой операции в заранее выделенную память. Это не покадровый p99 и не сценарий со 100 каналами.',
  stoppingRule: 'Один пилот только базовой версии → замороженный N; невозможная мощность немедленно сохраняет UNPROVEN без A/A, 2×work и A/B. Иначе один A/A и 2×work → A/B только при годной калибровке; добор и повтор ради успешного результата запрещены',
  preservedGuards: 'size-gate, численные/семантические допуски и защищённая верхняя граница p95 ≤1.05 не меняются',
  scope: 'Сервер без графического интерфейса: CPU потока движка и API браузера при 128 ms. Число целей и разнесение запусков закреплены. Конечная позиция, запуск, кадр, смена цели и отмена измеряются отдельно; защитные проверки 1200 ms независимы',
  unproven: ['mobile Android/iOS', 'physical 60/120 Hz', 'whole-page energy', 'GPU', 'M-04 physical-device envelope', 'M-05 product scene families'],
  forcedGc: 'Только отдельный дочерний процесс проверки удержаний после завершения оборота цикла событий хоста, затем два GC для каждого снимка кучи; в измерениях времени отсутствует',
  rawControls: 'Базовая версия без движения: два одинаковых PNG; reduced-motion: конечное состояние без rAF/WAAPI; проверки кандидата только после калибровки PASS',
  resourcePolicy: 'Домен процессов cgroup v2: SCHED_OTHER, /sys/kernel/sched_ext/state=disabled, ABI sched-ext Linux v6.18.44/v7.0. Ошибка или отсутствие состояния — unknown, не disabled. Каждый предок, кроме корня, проверяется отдельно. Требуется одно немаскированное монтирование с доказанным корнем; неизвестное покрытие, псевдонимы и threaded дают отказ. Топология, ограничения и привязка CPU связаны с регистрацией и проверяются до/после каждого парного блока. В каждой области приращения nr_throttled/throttled_usec равны 0; время использования CPU (usage_usec) по вложенным областям не суммируется. Конечная проверка не исключает ABA; внешняя переконфигурация эпохи запрещена. Все образцы сохраняются; нарушение — UNPROVEN без исключений по результатам.',
  browserOperationTimeoutMs: 30_000,
  clockError: {
    id: 'azure7.0.0-1017-thread-scheduled-runtime-node24.19-chromium149-isolated',
    kernelRelease: '7.0.0-1017-azure',
    kernelBuild: {
      sourcePackage: 'linux-azure-7.0', sourceVersion: '7.0.0-1017.17~24.04.1', upstreamVersion: '7.0.14', architecture: 'amd64',
      configSha256: '59b49d17af9e7049b5d1c0de5451d8afbeac39420b5086bfaa39f16cd1dec10b',
      preparationReceiptDigest: 'a4ec913f2a90e4f50b72037642a00a0d3591e922e076051b0e8d21d297e09a50',
      sourceReconstruction: 'Ubuntu Format1.0: исходный архив linux-7.0/ и точная разница, strip1, fuzz0. Приведённые хеши относятся к итоговым файлам, а не байтам архива.',
      sourceFiles: {
        'kernel/time/posix-cpu-timers.c': '205aca87c575d5338ac8ae0975dce7c71bc5bb2a4bd232af5dd5d1c003cd694a',
        'kernel/time/posix-timers.c': '38783f38c3a7cc23d2f7ab7dc504ed666d4a99818d2799ab6be8b9a3bd309fac',
        'kernel/time/time.c': '886e06524ba6afa1ebf32da62afd5bfb56c404957c0b528e9d6721e143e142ff',
        'kernel/sched/core.c': '8a4c000ddf69ab5334452e55f67346ba7c8fc6e46f382a9c93e61befbbc17cbc',
        'kernel/sched/fair.c': '786ef7027e28d72c8acaba3a6b023703818afc7dd39b642c71915e433e725338',
        'kernel/sched/cputime.c': 'b7fb24b5eff60bfe22eb621ddd7e9ac58a16bb4d63a14ff0668c7ede12cce1d3',
        'kernel/sched/clock.c': 'efea491eb3617f77cd57349b7a3902678fdc848911ec8372631e3a4cf6315de7',
        'kernel/sched/sched.h': '8793436044d20d4d4d8c5f21321a8f11f2ffdbd25f3fa2060aae4d5560506d25',
        'init/Kconfig': 'c94d452b20157fd93b4cdce2147d5f4c777f65b97ea7c98bddbd1a6a30c567a7',
        'include/linux/posix-timers.h': '5aa804807519b6f26918c7dab72a3e22bd50e898763f434ab51b2c58c275988c',
        'include/linux/time_namespace.h': 'fe02ec6f5b131dbb47be6d883c7a13b1f7a87a487a5239b54e48051d6d1aa151',
        'include/uapi/linux/time.h': 'b0364314ca37dcaf82d18ed6e7bd201fb658cff80f40637dae192ec8665a9eea',
        'kernel/time/timekeeping.c': '937979765ffe34625680830dad5b31a56ac0f7909651ce2caad652c614aee1d3',
        'kernel/time/namespace.c': '77b3e5af958400754d2505a065dfd0d125588e6e67b7b30e13dde96fb5fac047',
        'kernel/time/vsyscall.c': 'c48d298e8a73f298917337fd2305b4366130140d9819175d4c934f5c060970af',
        'lib/vdso/gettimeofday.c': '20581b599c8c4107b974b7a41028c335eded6bca586417b8a87a084abf770d33',
        'arch/x86/include/asm/vdso/gettimeofday.h': '2b8ed9bd114062b33cb78b1da45697c0c894c2d6b4ceb2be2daaa5aba92874de',
      },
      applicability: 'Доверенный CI: фактические version_signature, пакет и конфигурация связаны с квитанцией подготовки. Требуются SCHED_OTHER и sched_ext=disabled; CONFIG_SCHED_CLASS_EXT=y исключает CONFIG_SCHED_PROXY_EXEC. Пространства имён self/time_for_children одинаковы, монотонные смещения self/init равны 0; идентичность пространству init не требуется. Отсутствие переопределения часов — прежняя предпосылка, не новая аттестация.',
    },
    nodeVersion: 'v24.19.0',
    nodeExecutableSha256: 'bc17c508ffeed0ec622934f9b7fa72f8e78da65350e63c3eceb56fa688aa5e12',
    browser: 'chromium',
    browserVersion: '149.0.7827.55',
    browserExecutableSha256: '2d18db9d8608b052b6a552ee00ec1e830f93692e928b65ecc67d693bd33fe801',
    browserClampErrorPerTimestampMs: 0.005,
    browserTickTruncationPerTimestampMs: 0.001,
    monotonicCounterLimitMs: 2 ** 42,
    engineClock: 'CLOCK_THREAD_CPUTIME_ID',
    engineCounterOutwardPaddingNs: 2_000,
    engineCounterScope: 'Сообщённое Linux время исполнения текущего главного потока по планировщику. Прежний консервативный запас 2us расширяет границы сообщённого счётчика наружу; он не гарантирует физическую точность и не выводится из номинального clock_getres. Накладные расходы функции чтения не вычитаются.',
    nativeSourceFiles: {
      'bench/profile/server-thread-cpu-clock.c': '4f32f23c2409c3e83943121a587c8d9f5e19af7f308ac987323ff4189ddd14c0',
      'bench/profile/native-clock/include/js_native_api.h': '8808ef8899a1691411928ef5dd7dae0537aedc93d3a34e223b2d89692e79c788',
      'bench/profile/native-clock/include/js_native_api_types.h': '4f19cb90d240765cc0961d92a1ee20f65fdc50db7de1ab0a5cb6bc227224e1a0',
      'bench/profile/native-clock/include/node_api.h': '2d4560831e525b47b060ec8a0864ab73993df9e20215ce9f0fe7b24cd31af32a',
      'bench/profile/native-clock/include/node_api_types.h': 'a25356630d3058f0a0c8937d9f297e9471e037fda58c2696d8a505c2bd99cb00',
    },
    sources: {
      timeClamper: { url: 'https://chromium.googlesource.com/chromium/src/+/149.0.7827.55/third_party/blink/renderer/core/timing/time_clamper.cc', sha256: '2491cb64f50a54ccd10f778c058f0960ad4d9fa0861e39212bc27b8343bd103c' },
      timeClamperHeader: { url: 'https://chromium.googlesource.com/chromium/src/+/149.0.7827.55/third_party/blink/renderer/core/timing/time_clamper.h', sha256: 'f8065edb3ba8da66d58eb7042523fba44b6d515c04d482614670a5414a684944' },
      performance: { url: 'https://raw.githubusercontent.com/chromium/chromium/149.0.7827.55/third_party/blink/renderer/core/timing/performance.cc', sha256: '62de6788c9361958757f47a173369cc668f3691ec58f27e2d2edfab780efe200' },
      windowPerformance: { url: 'https://raw.githubusercontent.com/chromium/chromium/149.0.7827.55/third_party/blink/renderer/core/timing/window_performance.cc', sha256: '5916501d9960c6355f1b2b0cee7cbc10091bf63ac64b0bf6397d96e495f71983' },
      timeTicks: { url: 'https://raw.githubusercontent.com/chromium/chromium/149.0.7827.55/base/time/time_now_posix.cc', sha256: '6a7b898ec4a2eedbfcc2173ca3cac17b188829b9531ba3febcfe942925ed5796' },
      documentTimeline: { url: 'https://chromium.googlesource.com/chromium/src/+/149.0.7827.55/third_party/blink/renderer/core/animation/document_timeline.cc', sha256: 'e8e405492b4f49f6be850e68c3431d1e2107ac032ea4ff11c433cc726642c702' },
      animationClock: { url: 'https://chromium.googlesource.com/chromium/src/+/149.0.7827.55/third_party/blink/renderer/core/animation/animation_clock.cc', sha256: 'f3290008c81dab4f17c7ae8439de25c1c95d0204be6dbb16dada0fd1a8e584eb' },
      animationTimeline: { url: 'https://chromium.googlesource.com/chromium/src/+/149.0.7827.55/third_party/blink/renderer/core/animation/animation_timeline.cc', sha256: '6745f06a855d19691098929b29a5d28331d814c6ae21f1cdf12368eeb7ab5c90' },
      documentAnimations: { url: 'https://chromium.googlesource.com/chromium/src/+/149.0.7827.55/third_party/blink/renderer/core/animation/document_animations.cc', sha256: '6b20e0668cc740d1e2c9a9828b5316c81b7c43f2eb907af686729e51d10855d2' },
      pageAnimator: { url: 'https://chromium.googlesource.com/chromium/src/+/149.0.7827.55/third_party/blink/renderer/core/page/page_animator.cc', sha256: 'ba6157ecdc92b5e3375e0239c3b79f39050f5ea3a84d27f65e60b03f1b676e03' },
      cssComputedStyle: { url: 'https://chromium.googlesource.com/chromium/src/+/149.0.7827.55/third_party/blink/renderer/core/css/css_computed_style_declaration.cc', sha256: 'fc8f9580c1fd1bc2c28d753083925118c38134c37406dcd2f55d98a8ea2bbfb6' },
      documentStyle: { url: 'https://chromium.googlesource.com/chromium/src/+/149.0.7827.55/third_party/blink/renderer/core/dom/document.cc', sha256: '8a09dd50bdbbca54b11af849376c4f76df2fd62b14ae665c4c208553b4941dd6' },
      nodeProcess: { url: 'https://raw.githubusercontent.com/nodejs/node/v24.19.0/src/node_process_methods.cc', sha256: '6f2d27513a933dd3d076c0ffe2f95a1846ba1d1060f7ccfbc6eb2df6692a34eb' },
      libuvCore: { url: 'https://raw.githubusercontent.com/nodejs/node/v24.19.0/deps/uv/src/unix/core.c', sha256: '18bfd5f2045417f8ace5d76e222bf7441b31ead5fc2cbaf6225965e0afea8767' },
      libuvLinux: { url: 'https://raw.githubusercontent.com/nodejs/node/v24.19.0/deps/uv/src/unix/linux.c', sha256: '215185d94697e05cd75ba9466bb9ea93076769a7767218d4183eaf0723ccf2d2' },
      linuxAzureDescriptor: { url: 'https://archive.ubuntu.com/ubuntu/pool/main/l/linux-azure-7.0/linux-azure-7.0_7.0.0-1017.17~24.04.1.dsc', sha256: '3865ffd4abd23c255fb1103cf04ad7b266adad80eebaa168db0093c451da1a69' },
      linuxAzureOrig: { url: 'https://archive.ubuntu.com/ubuntu/pool/main/l/linux-azure-7.0/linux-azure-7.0_7.0.0.orig.tar.gz', sha256: 'c6343795c8c7e4feff55f5b309365c8e0eaf49cd6abcb412e32315313f149536' },
      linuxAzureDiff: { url: 'https://archive.ubuntu.com/ubuntu/pool/main/l/linux-azure-7.0/linux-azure-7.0_7.0.0-1017.17~24.04.1.diff.gz', sha256: '067230d08d88c8cb4218a9b154c78d060b61ec925961cc08db1e42af07a26635' },
      linuxAzureBuildinfo: { url: 'https://archive.ubuntu.com/ubuntu/pool/main/l/linux-azure-7.0/linux-buildinfo-7.0.0-1017-azure_7.0.0-1017.17~24.04.1_amd64.deb', sha256: '6a6610af63bdd1fc9af7ba7a3fcfad57d069b0655d89f901ffe8d5d583da7ad4' },
      linuxAzureSignedDescriptor: { url: 'https://archive.ubuntu.com/ubuntu/pool/main/l/linux-signed-azure-7.0/linux-signed-azure-7.0_7.0.0-1017.17~24.04.1.dsc', sha256: '63ced201ca362205724d4e2b0a6a12683f217402db6e188e7be436e244acebbd' },
    },
    documentFrame: 'Chromium149: PageAnimator снижает точность кадровых TimeTicks тем же изолированным TimeClamper. DocumentTimeline начинается с навигации; AnimationClock стабилен при отрисовке и выполнении задачи; пересчёт CSS обновляет по нему время анимации. Часы публикации равны до/после API запуска и связывают начало свежего движения. Часы контрольной точки равны до/после чтения CSS и связаны с наблюдаемым rAF. Кадровая метка может предшествовать исполнению; фактическая хронология учитывается отдельно. Сопоставление с performance.now использует три метки сниженной точности: frame/now/origin. Граница округляется вверх: 1.5×прежняя граница двух конечных меток; границы стоимости API неизменны. Нет квалификации или часы противоречат друг другу — отказ. Это часы публикации CSS, не внутренний таймер JS/native API.',
    scope: 'Linux CLOCK_THREAD_CPUTIME_ID: разность точных секунд и наносекунд сообщённого времени исполнения по планировщику с прежним запасом 2us, расширяющим границы наружу. Изолированный Chromium TimeClamper может округлять в обе стороны на 5us; TimeTicks отбрасывает остаток до 1us. Оба чтения браузерных часов и погрешность binary64 входят в границы каждого наблюдения до построения доверительных интервалов; повторы и N не сужают погрешность часов',
    assumption: 'Закреплённые официальные браузер и Node, закрытая нативная функция часов и точный Ubuntu Azure kernelBuild исполняют подтверждённую исходниками модель. Node hrtime и браузерные TimeTicks используют общий Linux CLOCK_MONOTONIC без переопределения пространства имён/часов. Время исполнения по планировщику — не физическое прошедшее время; номинальное разрешение и наблюдаемый квант не удостоверяют погрешность. Другие исполняемые файлы/модели или небезопасные счётчики дают отказ.',
  },
  browserCancellationWitness: { frames: 2, transformTolerancePx: 0.000001,
    scope: 'Подключённые цели после cancel: нет WAAPI, transform неизменен два rAF; синхронная cancelMs и прошедшее время cancel→drain измеряются раздельно; подавленные исключения сторонней реализации в нормализованном адаптере не наблюдаются' },
  stationarityAssumption: 'Независимые одинаково распределённые средние парных блоков при закреплённой среде; A/A и ресурсные проверки проверяют разрешимость, перенос за пределы этой клетки не доказан',
});

// Число -0 в JSON сохраняет свидетельство Object.is без новой схемы координат.
export function serverProfileStringify(value) {
  return JSON.stringify(value, (_key, number) => Object.is(number, -0) ? JSON.rawJSON('-0') : number);
}

export function serverProfileDigest(value) {
  const text = serverProfileStringify(value);
  // Нативная SHA-функция читает строку UTF-8 без отдельной копии Buffer.
  // Значение undefined сохраняет прежний TypeError после одного чтения JSON.
  return sha256Bytes(text === undefined ? Buffer.from(text) : text);
}

export function verifyServerProfile(value) {
  if (!isDeepStrictEqual(value, SERVER_PROFILE)) throw new Error('server profile: изменён зарегистрированный протокол');
}

export function serverTailPolicy() {
  // Для семейства alpha = 1/20; рациональный знаменатель исключает лишнюю
  // операцию с плавающей точкой, дающую соседнее binary64 вместо точного 1/1760.
  const alphaPerTail = 1 / (SERVER_PROFILE.familySize * 2 * 2 * 2 * 20);
  return { alphaPerTail, quantiles: [0.5, 0.95], minimumBlocks: Math.ceil(Math.log(alphaPerTail) / Math.log(0.95)),
    correction: 'Поправка Бонферрони: 11 клеток × 2 квантиля × 2 участника × 2 хвоста; доверительный уровень для всего семейства 95%' };
}

// Требуемый N выводится только из пилота A/A базовой версии, до любых образцов кандидата.
// Формула планирует средний парный логарифмический контраст; допуск хвостовых
// квантилей проверяется отдельно и не получает гарантии мощности от этой приближённой оценки.
export function planServerSampleSize(pilotPairs) {
  if (!Array.isArray(pilotPairs) || pilotPairs.length !== SERVER_PROFILE.familySize) {
    throw new Error('server profile: неполное семейство null-pilot');
  }
  const cells = pilotPairs.map(({ id, left, right }) => {
    if (typeof id !== 'string' || !Array.isArray(left) || !Array.isArray(right) ||
        left.length !== SERVER_PROFILE.pilotRuns || right.length !== left.length ||
        [...left, ...right].some((x) => !Number.isFinite(x) || x <= 0)) {
      throw new Error('server profile: некорректные образцы пилота только базовой версии');
    }
    const differences = Array.from({ length: left.length / 2 }, (_, block) =>
      (Math.log(left[block * 2]) - Math.log(right[block * 2]) + Math.log(left[block * 2 + 1]) - Math.log(right[block * 2 + 1])) / 2);
    const mean = differences.reduce((a, b) => a + b, 0) / differences.length;
    const variance = differences.reduce((a, b) => a + (b - mean) ** 2, 0) / (differences.length - 1);
    const requiredRuns = 2 * Math.ceil(((SERVER_PROFILE.zFamily + SERVER_PROFILE.zPower) * Math.sqrt(variance) /
      Math.log(1 + SERVER_PROFILE.mdeRelative)) ** 2);
    return { id, logContrastSd: Math.sqrt(variance), requiredRuns };
  });
  if (new Set(cells.map(({ id }) => id)).size !== cells.length) throw new Error('server profile: повторная pilot cell');
  const tail = serverTailPolicy();
  const requiredRuns = Math.max(SERVER_PROFILE.minRuns, tail.minimumBlocks * 2, ...cells.map(({ requiredRuns: n }) => n));
  const runs = Math.min(SERVER_PROFILE.maxRuns, Math.ceil(requiredRuns / 2) * 2);
  return { runs, requiredRuns, feasible: requiredRuns <= SERVER_PROFILE.maxRuns, cells, tail,
    method: 'Нормальное приближение парного блочного логарифмического контраста только базовой версии. Мощность 0.8; минимально обнаружимый эффект (MDE) 5%; поправка Бонферрони для семейства 11×2. N — число запусков; блок — два запуска' };
}
