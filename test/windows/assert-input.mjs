import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

const names = ['mouse-hold', 'mouse-interrupt', 'pointer-out', 'keyboard', 'disable-animation', 'reduced-motion'];
const require = (condition, message) => { if (!condition) throw new Error(message); };
const near = (value, target) => Number.isFinite(value) && Math.abs(value - target) <= .001;
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
const readLines = (path) => readFileSync(path, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean).map(JSON.parse);

// Ожидаемые исходы заданы сценарием ввода; ответы CLI не заменяют события приложения.
export function verifyTrace(events, scenarios) {
  require(Array.isArray(events) && events.length > 0, 'Нет событий приложения.');
  events.forEach((event, index) => {
    require(event.sequence === index + 1 && Number.isFinite(event.seconds) && event.seconds >= 0 &&
      (index === 0 || event.seconds >= events[index - 1].seconds) && typeof event.kind === 'string' &&
      event.data && typeof event.data === 'object', 'Нарушена структура или последовательность трассы.');
    require(!['error', 'truncated'].includes(event.kind), `Трасса содержит ${event.kind}.`);
    if (event.kind === 'intent') require(Number.isSafeInteger(event.data.operation) && event.data.operation > 0 &&
      ['pressed', 'enabled', 'localAnimation', 'systemAnimation'].every(key => typeof event.data[key] === 'boolean') &&
      event.data.target === Number(event.data.pressed), 'Повреждён intent.');
    if (event.kind === 'motion') require(['position', 'readbackPosition', 'nativeSeconds'].every(key => Number.isFinite(event.data[key])) &&
      ['pageOperation', 'nativeOperation'].every(key => Number.isSafeInteger(event.data[key]) && event.data[key] >= 0) && typeof event.data.phase === 'string' &&
      ['Animation', 'Input', 'Initial', 'Snap', 'Stop'].includes(event.data.origin),
      'Повреждено наблюдение движения.');
    if (event.kind === 'completed') require(['operation', 'nativeOperation'].every(key => Number.isSafeInteger(event.data[key]) && event.data[key] > 0) &&
      ['Finished', 'Stopped'].includes(event.data.end) && typeof event.data.reason === 'string' && typeof event.data.isCurrent === 'boolean', 'Повреждён исход движения.');
  });
  require(Array.isArray(scenarios) && scenarios.length === names.length &&
    [...scenarios.map(s => s.name)].sort().join() === [...names].sort().join(), 'Не совпал набор сценариев.');
  const ordered = [...scenarios].sort((a, b) => a.after - b.after);
  ordered.forEach((scenario, index) => require(Number.isSafeInteger(scenario.after) && Number.isSafeInteger(scenario.through) &&
    scenario.after >= 0 && scenario.through > scenario.after && scenario.through <= events.length &&
    (index === 0 || scenario.after >= ordered[index - 1].through), 'Нарушены границы сценария.'));

  return names.map(name => {
    const { after, through } = scenarios.find(s => s.name === name);
    const slice = events.filter(e => e.sequence > after && e.sequence <= through);
    const select = (kind, predicate = () => true) => slice.filter(e => e.kind === kind && predicate(e.data));
    const need = (kind, predicate, message) => {
      const result = select(kind, predicate)[0];
      require(result, `${name}: ${message}`);
      return result;
    };
    const input = (event, device, extra = () => true) => need('input', d => d.event === event && d.device === device && extra(d), `нет ${device} ${event}`);
    const ended = intent => {
      const completion = need('completed', d => d.operation === intent.data.operation && d.end === 'Finished' && d.reason === 'settled' && d.isCurrent === true,
        'нет завершения актуальной операции');
      need('motion', d => d.nativeOperation === completion.data.nativeOperation && d.pageOperation === intent.data.operation &&
        d.phase === 'idle' && near(d.position, intent.data.target) && near(d.readbackPosition, intent.data.target), 'нет покоя у цели');
      return completion;
    };
    const snap = intent => {
      need('snapRequested', d => d.operation === intent.data.operation && d.target === intent.data.target, 'нет запроса SnapTo');
      need('snapReadback', d => d.operation === intent.data.operation && d.target === intent.data.target && near(d.position, intent.data.target), 'нет readback у цели SnapTo');
      const observations = select('motion', d => d.pageOperation === intent.data.operation);
      require(observations.every(e => e.data.origin === 'Snap' && ['requested', 'value', 'idle'].includes(e.data.phase)),
        `${name}: анимация при отключённом движении`);
      need('motion', d => d.pageOperation === intent.data.operation && d.origin === 'Snap' && d.phase === 'requested', 'нет наблюдения запроса SnapTo');
      require(observations.filter(e => e.data.phase !== 'requested').every(e =>
        near(e.data.position, intent.data.target) && near(e.data.readbackPosition, intent.data.target)), `${name}: нет readback у цели SnapTo`);
    };
    if (name === 'disable-animation') {
      const pressed = input('pointerPressed', 'Mouse', d => Number.isSafeInteger(d.pointerId));
      const released = input('pointerReleased', 'Mouse', d => d.pointerId === pressed.data.pointerId);
      require(released.sequence > pressed.sequence, `${name}: нарушен порядок указателя`);
      const preference = need('intent', d => d.trigger === 'localPreference' && d.localAnimation === false && d.pressed === false,
        'не наблюдалось выключение локальной анимации');
      const down = need('intent', d => d.trigger === 'pressed' && d.pressed === true && d.localAnimation === true, 'нет предшествующего нажатия');
      const up = select('intent', d => d.trigger === 'pressed' && d.pressed === false && d.localAnimation === true)
        .find(e => e.sequence > down.sequence && e.sequence < preference.sequence);
      require(up, `${name}: нет отпускания перед сменой предпочтения`);
      need('motion', d => d.pageOperation === up.data.operation && d.phase === 'requested', 'нет движения отпускания');
      require(select('motion', d => d.pageOperation === up.data.operation && d.phase === 'value' && d.position > 0 && d.position < 1)
        .some(e => e.sequence < preference.sequence), `${name}: отпускание не двигалось до смены предпочтения`);
      snap(preference);
      const interrupted = need('completed', d => d.operation === up.data.operation && d.end === 'Stopped' && d.reason === 'snap', 'смена предпочтения не прервала движение');
      require(interrupted.sequence > preference.sequence, `${name}: прерывание предшествует смене предпочтения`);
      return { name, passed: true, observed: 'mid-flight-localPreference', checkboxKeyRouting: 'not-observed' };
    }
    const down = need('intent', d => d.trigger === 'pressed' && d.pressed === true && d.enabled === true, 'нет состояния нажатия');
    const up = select('intent', d => d.trigger === 'pressed' && d.pressed === false).find(e => e.sequence > down.sequence);
    require(up, `${name}: нет отпускания после нажатия`);
    if (name === 'keyboard') {
      const keyDown = input('keyDown', 'Keyboard', d => d.key === 'Space');
      const keyUp = input('keyUp', 'Keyboard', d => d.key === 'Space');
      require(keyUp.sequence > keyDown.sequence, `${name}: нарушен порядок Space`);
    } else {
      const pressed = input('pointerPressed', 'Mouse', d => Number.isSafeInteger(d.pointerId));
      if (name !== 'pointer-out') {
        const released = input('pointerReleased', 'Mouse', d => d.pointerId === pressed.data.pointerId);
        require(released.sequence > pressed.sequence, `${name}: нарушен порядок указателя`);
      }
    }
    if (name === 'reduced-motion') {
      require(!down.data.localAnimation && !up.data.localAnimation, `${name}: локальная анимация осталась включена`);
      snap(down); snap(up);
      return { name, passed: true, observed: 'input-and-snap-readback' };
    }
    const final = ended(up);
    if (name === 'mouse-hold') {
      ended(down);
      const intermediate = new Set(select('motion', d => d.pageOperation === down.data.operation && d.phase === 'value' && d.position > 0 && d.position < 1).map(e => e.data.position));
      require(intermediate.size >= 3, `${name}: нет трёх промежуточных значений движения`);
      return { name, passed: true, intermediateValues: intermediate.size };
    }
    if (name === 'mouse-interrupt') {
      require(select('motion', d => d.pageOperation === down.data.operation && d.phase === 'value' && d.position > 0 && d.position < 1)
        .some(e => e.sequence < up.sequence), `${name}: до новой цели движение не началось`);
      const stopped = need('completed', d => d.operation === down.data.operation && d.end === 'Stopped' && d.reason === 'replaced', 'нажатие не было прервано новой целью');
      require(stopped.sequence < final.sequence, `${name}: конечная операция не следует за прерванной`);
    }
    if (name === 'pointer-out') {
      const exited = input('pointerExited', 'Mouse');
      const released = select('input', d => d.event === 'pointerReleased' && d.device === 'Mouse')[0];
      return { name, passed: true, exitedSequence: exited.sequence, unpressedSequence: up.sequence,
        releasedSequence: released?.sequence ?? null, unpressedBeforeRelease: released ? up.sequence < released.sequence : null };
    }
    return { name, passed: true };
  });
}

export function verifyCaptureWindow(window, frames) {
  // Часы harness стартуют ДО recorder, поэтому это верхняя граница времени ввода
  // относительно первого кадра; последний кадр должен быть позже всей операции.
  require(Number.isFinite(window.inputStartedMs) && window.inputStartedMs >= 0 &&
    Number.isFinite(window.inputCompletedMs) && window.inputCompletedMs > window.inputStartedMs &&
    window.inputCompletedMs < frames.at(-1)?.elapsedMs, 'Запись не охватила полный ввод.');
}

export function verifyInput(directory) {
  let bytes = 0;
  const count = path => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const file = join(path, entry.name);
      if (entry.isDirectory()) count(file);
      else if (entry.name !== 'result.json') bytes += statSync(file).size;
    }
  };
  count(directory);
  require(bytes <= 10 * 1024 * 1024, 'Артефакты превышают 10 MiB.');
  const scenarios = verifyTrace(readLines(join(directory, 'press.jsonl')), readJson(join(directory, 'scenarios.json')));
  const record = readJson(join(directory, 'record.json'));
  require(record.mode === 'wgc' && Number.isSafeInteger(record.frames) && record.frames >= 10, 'Не подтверждена WGC-запись минимум десяти кадров.');
  require(statSync(join(directory, 'press.mp4')).size > 8, 'Нет записанного видео.');
  const frameDirectory = join(directory, 'press.frames');
  require(readJson(join(frameDirectory, 'manifest.json')).status === 'complete', 'Запись кадров неполная.');
  const frames = readLines(join(frameDirectory, 'frames.ndjson'));
  require(frames.length >= 10, 'Индекс содержит меньше десяти кадров.');
  frames.forEach((frame, index) => require(Number.isSafeInteger(frame.sampleIndex) && Number.isFinite(frame.elapsedMs) && frame.elapsedMs >= 0 &&
    (index === 0 || frame.sampleIndex > frames[index - 1].sampleIndex && frame.elapsedMs >= frames[index - 1].elapsedMs) && typeof frame.file === 'string', 'Повреждён индекс кадров.'));
  verifyCaptureWindow(readJson(join(directory, 'capture-window.json')), frames);
  const images = [...new Set(frames.map(frame => frame.file))];
  for (const image of images) {
    const path = resolve(frameDirectory, image);
    const inside = relative(frameDirectory, path);
    require(!isAbsolute(image) && !inside.startsWith('..') && /\.jpe?g$/i.test(image), 'Кадр не является относительным JPEG.');
    const data = readFileSync(path);
    require(data.length > 4 && data[0] === 255 && data[1] === 216 && data[2] === 255, `Нет JPEG-кадра ${image}.`);
  }
  for (const name of ['rest-before.png', 'rest-after.png']) {
    const data = readFileSync(join(directory, name));
    require(data.length > 8 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), `Нет PNG ${name}.`);
  }
  return { passed: true, scenarios, capture: { mode: record.mode, frames: record.frames, indexedFrames: frames.length, images,
    visualReview: 'required', stopReason: record.stopReason ?? null }, bytes };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const directory = process.argv[2] ? resolve(process.argv[2]) : null;
  let result;
  try { require(process.argv[2], 'Укажите каталог evidence.'); result = verifyInput(directory); }
  catch (error) { result = { passed: false, error: error.message }; process.exitCode = 1; }
  try { if (directory) writeFileSync(join(directory, 'result.json'), `${JSON.stringify(result, null, 2)}\n`); }
  catch (error) { console.error(`Не удалось сохранить result.json: ${error.message}`); process.exitCode = 1; }
  console.log(JSON.stringify(result));
}
