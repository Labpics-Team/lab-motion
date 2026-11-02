import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const names = ['y-down', 'y-up'];
export const limits = Object.freeze({
  dragProgressError: .08,
  positionError: .001,
  nativeAxisLeak: 1,
  velocityNominalRatio: [.25, 2.5],
  settleSeconds: 5,
});
const require = (condition, message) => { if (!condition) throw new Error(message); };
const finite = Number.isFinite;
const near = (a, b, tolerance = limits.positionError) => finite(a) && Math.abs(a - b) <= tolerance;
const vector = value => value && ['x', 'y', 'z'].every(axis => finite(value[axis]));
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const readJson = path => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
const readLines = path => readFileSync(path, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean).map(JSON.parse);

function validateScenario(scenario) {
  require(object(scenario) && scenario.schema === 2 && scenario.coordinates === 'native' && names.includes(scenario.name), 'Неизвестный сценарий.');
  const [axis, directionName] = scenario.name.split('-');
  require(scenario.axis === axis && scenario.direction === (directionName === 'down' ? 1 : -1), 'Ось или направление не совпали с именем.');
  require(scenario.gesture === 'swipe' && scenario.durationMs === 300 && scenario.coordinateSpace === 'viewport-dip', 'Сценарий не соответствует протоколу swipe 300 ms.');
  const { start, end, viewport, injection } = scenario;
  require(object(viewport) && viewport.width === 480 && viewport.height === 320 && finite(viewport.scale) && viewport.scale > 0, 'Повреждена геометрия viewport.');
  for (const point of [start, end]) require(object(point) && finite(point.x) && finite(point.y) &&
    point.x > 0 && point.x < viewport.width && point.y > 0 && point.y < viewport.height, 'Точка жеста вне viewport.');
  require(near(start.x, end.x) && near(start.x, viewport.width / 2) &&
    near((start.y + end.y) / 2, viewport.height / 2) && near(end.y - start.y, scenario.direction * 80), 'Жест не является центральным вертикальным перемещением на 80 DIP.');
  require(object(injection) && injection.coordinateSpace === 'screen-pixel' && injection.exitCode === 0, 'Инъектор не подтвердил отправку жеста.');
  for (const point of [injection.start, injection.end]) require(object(point) && finite(point.x) && finite(point.y), 'Нет физических координат инъекции.');
  require(near(injection.end.x - injection.start.x, 0, 1) &&
    near(injection.end.y - injection.start.y, (end.y - start.y) * viewport.scale, 2), 'Инъекция не сохранила направление, расстояние или DPI.');
}

function evaluate(events, scenario) {
  validateScenario(scenario);
  require(Array.isArray(events) && events.length > 0, 'Нет трассы приложения.');
  events.forEach((event, index) => {
    require(object(event) && event.sequence === index + 1 && finite(event.seconds) && event.seconds >= 0 &&
      (index === 0 || event.seconds >= events[index - 1].seconds) && typeof event.kind === 'string' && object(event.data), 'Нарушена структура или последовательность трассы.');
    require(!['error', 'truncated'].includes(event.kind), `Трасса содержит ${event.kind}.`);
  });
  const select = (kind, predicate = () => true) => events.filter(event => event.kind === kind && predicate(event.data));
  const exactlyOne = (kind, predicate, message) => {
    const values = select(kind, predicate);
    require(values.length === 1, `${message} Получено: ${values.length}.`);
    return values[0];
  };
  const metadata = exactlyOne('metadata', () => true, 'Ожидалась одна запись параметров опыта.');
  const m = metadata.data;
  require(m.axis === scenario.axis && m.direction === scenario.direction && m.width === scenario.viewport.width &&
    m.height === scenario.viewport.height && m.scale === scenario.viewport.scale && m.coordinates === 'native' && m.unitsPerProgress === -m.height &&
    m.minimum === -2 * m.height && m.maximum === m.height && m.initial === -m.height / 2 && m.target === (scenario.direction > 0 ? -m.height : 0) &&
    m.responseMilliseconds === 350 && m.bounce === 0 && m.positionYSourceMode === 'EnabledWithInertia', 'Настройки приложения не совпали со сценарием.');
  const axis = scenario.axis;
  const otherAxes = ['x', 'y', 'z'].filter(value => value !== axis);
  const positions = data => {
    require(vector(data.position) && vector(data.readbackPosition) && near(data.progress, -data.position[axis] / m.height, .00001) &&
      near(data.readbackProgress, -data.readbackPosition[axis] / m.height, .00001), 'Повреждены native position или progress.');
    require(otherAxes.every(other => Math.abs(data.position[other]) <= limits.nativeAxisLeak &&
      Math.abs(data.readbackPosition[other]) <= limits.nativeAxisLeak), 'Движение утекло в неактивную ось.');
  };
  const motions = select('motion');
  motions.forEach(({ data }) => {
    require(['value', 'inertia', 'interacting', 'idle', 'customAnimation', 'ignored'].includes(data.phase) &&
      Number.isSafeInteger(data.requestId) && data.requestId >= 0, 'Повреждено состояние native motion.');
    positions(data);
    if (data.phase === 'value') require(data.positionOrigin === 'event', 'Позиция движения не получена из native ValuesChanged.');
    if (data.phase === 'inertia') {
      require(vector(data.nativeVelocity) && near(data.progressVelocity, -data.nativeVelocity[axis] / m.height, .00001), 'Нет конечной native release velocity.');
      require(otherAxes.every(other => Math.abs(data.nativeVelocity[other]) <= limits.nativeAxisLeak), 'Release velocity осталась в неактивной оси.');
    }
  });
  const ready = exactlyOne('ready', () => true, 'Нет единственной подтверждённой начальной готовности.');
  const r = ready.data;
  require(metadata.sequence < ready.sequence && Number.isSafeInteger(r.requestId) && r.requestId > 0 && vector(r.position) && near(r.progress, .5) &&
    near(r.position[axis], -m.height / 2, 1) && otherAxes.every(other => Math.abs(r.position[other]) <= 1) &&
    r.width === m.width && r.height === m.height && r.scale === m.scale && r.unitsPerProgress === -m.height, 'Ready не подтверждает начальную позицию и геометрию.');
  require(motions.some(event => event.sequence < ready.sequence && event.data.phase === 'value' &&
    event.data.requestId === r.requestId && near(event.data.progress, .5) && near(event.data.readbackProgress, .5)), 'Нет начального native ValuesChanged с readback до Ready.');
  require(motions.filter(event => event.sequence < ready.sequence).every(event => ['value', 'idle'].includes(event.data.phase)), 'До Ready началось непредусмотренное движение.');
  const pressed = select('input', data => data.event === 'pointerPressed' && data.device === 'Touch');
  if (pressed.length === 0) return { name: scenario.name, status: 'INCOMPLETE', reason: 'Touch PointerPressed не доставлен приложению; результат CLI этого не заменяет.' };
  require(pressed.length === 1, 'Доставлено больше одного touch-нажатия.');
  const down = pressed[0];
  require(down.sequence > ready.sequence && down.data.ready === true && Number.isSafeInteger(down.data.pointerId) &&
    down.data.pointerId >= 0 && finite(down.data.pointerTimestamp) && down.data.pointerTimestamp >= 0 &&
    near(down.data.x, scenario.start.x, 2) && near(down.data.y, scenario.start.y, 2), 'Touch не соответствует готовому viewport или началу сценария.');
  const redirected = exactlyOne('redirect', data => data.pointerId === down.data.pointerId && data.result === 'returned', 'Нет возврата TryRedirectForManipulation для доставленного touch.');
  require(redirected.sequence > down.sequence && select('redirect', data => data.result === 'error').length === 0, 'Нарушен исход перенаправления touch.');
  const gestureMotion = motions.filter(event => event.sequence > down.sequence);
  require(gestureMotion.every(event => event.data.requestId === 0), 'После ввода наблюдался программный requestId вместо чистого native touch.');
  require(!gestureMotion.some(event => ['ignored', 'customAnimation'].includes(event.data.phase)), 'Нативный жест прерван или заменён программной анимацией.');
  const interacting = exactlyOne('motion', data => data.phase === 'interacting' && data.requestId === 0, 'Нет native Interacting с requestId 0.');
  const inertia = exactlyOne('motion', data => data.phase === 'inertia' && data.requestId === 0, 'Нет native Inertia с requestId 0.');
  require(interacting.sequence > down.sequence && inertia.sequence > interacting.sequence && inertia.sequence > redirected.sequence, 'Нарушен порядок touch → Interacting → Inertia.');
  const drag = gestureMotion.filter(event => event.sequence > interacting.sequence && event.sequence < inertia.sequence && event.data.phase === 'value');
  require(new Set(drag.map(event => event.data.progress)).size >= 2, 'Нет изменения позиции во время native touch.');
  const lastDrag = drag.at(-1);
  const expectedDelta = (scenario.end.y - scenario.start.y) / m.height;
  const delta = lastDrag.data.progress - .5;
  require(near(delta, expectedDelta, limits.dragProgressError) && delta * scenario.direction > 0, 'Drag имеет неверный знак или масштаб.');
  const nominalVelocity = expectedDelta / (scenario.durationMs / 1000);
  const velocity = -inertia.data.nativeVelocity[axis] / m.height;
  const velocityRatio = velocity / nominalVelocity;
  require(finite(velocityRatio) && velocityRatio >= limits.velocityNominalRatio[0] && velocityRatio <= limits.velocityNominalRatio[1], 'Release velocity имеет неверный знак, нулевую величину или грубую ошибку масштаба.');
  const idle = gestureMotion.find(event => event.sequence > inertia.sequence && event.data.phase === 'idle');
  require(idle && idle.seconds - inertia.seconds <= limits.settleSeconds && near(idle.data.progress, -m.target / m.height) &&
    near(idle.data.readbackProgress, -m.target / m.height), 'Нет native Idle и readback у цели в пределах пяти секунд.');
  const releaseValues = gestureMotion.filter(event => event.sequence > inertia.sequence && event.sequence < idle.sequence && event.data.phase === 'value');
  // Live readback в Inertia может опережать поставленный в очередь ValuesChanged.
  // Сравниваем последовательные native event positions, сохраняя порядок событий.
  const continued = releaseValues.find(event => Math.abs(event.data.progress - lastDrag.data.progress) > limits.positionError);
  require(continued && (continued.data.progress - lastDrag.data.progress) * scenario.direction > 0, 'Первое изменившееся значение после release не продолжило движение.');
  return { name: scenario.name, status: 'PASS', axis, direction: scenario.direction, dragProgress: delta,
    expectedDragProgress: expectedDelta, releaseProgressPerSecond: velocity, nominalProgressPerSecond: nominalVelocity,
    velocityNominalRatio: velocityRatio, settleMilliseconds: (idle.seconds - inertia.seconds) * 1000,
    dragValues: drag.length, releaseValues: releaseValues.length };
}

export function verifyTouchTrace(events, scenario) {
  try { return evaluate(events, scenario); }
  catch (error) { return { name: scenario?.name ?? 'unknown', status: 'FAIL', reason: error.message }; }
}

export function verifyTouch(directory) {
  const scenarios = names.map(name => {
    try {
      const scenario = readJson(join(directory, name, 'scenario.json'));
      require(scenario.name === name, 'Имя каталога не совпало со сценарием.');
      return verifyTouchTrace(readLines(join(directory, name, 'trace.jsonl')), scenario);
    } catch (error) {
      return { name, status: error.code === 'ENOENT' ? 'INCOMPLETE' : 'FAIL', reason: error.message };
    }
  });
  return { schema: 2, status: scenarios.some(result => result.status === 'FAIL') ? 'FAIL'
    : scenarios.every(result => result.status === 'PASS') ? 'PASS' : 'INCOMPLETE',
  scope: 'Родная ось Y, фиксированная геометрия/DPI, доставленный touch и грубая передача release velocity; без точной калибровки скорости и performance.', limits, scenarios };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const directory = resolve(process.argv[2]);
  const result = verifyTouch(directory);
  writeFileSync(join(directory, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
  if (result.status !== 'PASS') process.exitCode = 1;
}
