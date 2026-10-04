import { createReorder, type ReorderSession, type ReorderStep } from '@labpics/motion/behaviors/reorder';
import { createDomProjection } from '@labpics/motion/projection';
import './style.css';

type Scene = { id: string; title: string; place: string; minutes: number; done: boolean };
const scenes: Scene[] = [
  { id: 'window', title: 'Свет в мастерской', place: 'Павильон 2', minutes: 35, done: false },
  { id: 'portrait', title: 'Портрет архитектора', place: 'Ателье', minutes: 50, done: false },
  { id: 'quay', title: 'Разговор на набережной', place: 'Северный причал', minutes: 40, done: false },
  { id: 'detail', title: 'Детали города', place: 'Старый квартал', minutes: 25, done: true },
];
let order = scenes.map(scene => scene.id);
let filter: 'all' | 'ready' | 'done' = 'all';
let noMotion = false;
let rtl = false;
let session: ReorderSession | undefined;
let keyboardStart: string[] | undefined;
let pointer: number | undefined;
let origin = { x: 0, y: 0 };
let rendering = false;
const sceneById = new Map(scenes.map(scene => [scene.id, scene]));
const byId = (id: string) => sceneById.get(id)!;
const shown = () => order.filter(id => filter === 'all' || byId(id).done === (filter === 'done'));
const list = document.querySelector<HTMLElement>('#schedule')!;
const status = document.querySelector<HTMLElement>('#status')!;
const filterInput = document.querySelector<HTMLSelectElement>('#filter')!;
const quietButton = document.querySelector<HTMLButtonElement>('#quiet')!;
const direction = document.querySelector<HTMLButtonElement>('#direction')!;
const empty = document.querySelector<HTMLElement>('#empty')!;
const finishLabel = document.querySelector<HTMLElement>('#finish-label')!;
const media = matchMedia('(prefers-reduced-motion: reduce)');
const projection = createDomProjection({ radius: false, matchMedia: () => ({ matches: media.matches || noMotion }) });
const rows = () => Array.from(list.querySelectorAll<HTMLElement>('[data-id]'));
const measure = () => { const rendered = new Map(rows().map(row => [row.dataset.id!, row])); return shown().map(id => ({ key: id, rect: rendered.get(id)?.getBoundingClientRect() })); };
const formatTime = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
function times() {
  let cursor = 8 * 60 + 30;
  const result = new Map<string, string>();
  for (const id of order) { result.set(id, formatTime(cursor)); cursor += byId(id).minutes + 10; }
  finishLabel.textContent = `Окончание ${formatTime(cursor - 10)}`;
  return result;
}
function updateTimes() {
  const clock = times();
  for (const row of rows()) row.querySelector<HTMLElement>('[data-time]')!.textContent = clock.get(row.dataset.id!)!;
}
const announce = (id: string) => { status.textContent = `${byId(id).title}: ${shown().indexOf(id) + 1} из ${shown().length}; начало ${times().get(id)}`; };
let controller = makeController();
function makeController() {
  return createReorder({ items: measure(), axis: 'y', direction: rtl ? 'rtl' : 'ltr', onReorder(next, proposal) {
    if (!controller.isCurrent(proposal)) return;
    const focused = document.activeElement as HTMLElement | null;
    if (!noMotion && !media.matches) projection.capture(rows());
    const visibleKeys = new Set(shown());
    const positions = order.map((id, index) => ({ id, index })).filter(item => visibleKeys.has(item.id)).map(item => item.index);
    next.forEach((id, index) => { order[positions[index]!] = id; });
    render();
    if (!noMotion && !media.matches) projection.play();
    focused?.focus({ preventScroll: true });
    announce(proposal.key);
  } });
}
function finish() {
  session?.end(); session = undefined; keyboardStart = undefined;
  const captured = pointer; pointer = undefined;
  if (captured !== undefined && list.hasPointerCapture(captured)) list.releasePointerCapture(captured);
  list.querySelectorAll('[data-grip]').forEach(node => node.setAttribute('aria-pressed', 'false'));
}
function createRow(id: string): HTMLElement {
  const scene = byId(id);
  const row = document.createElement('div'); row.className = 'row'; row.dataset.id = id;
  const time = document.createElement('span'); time.className = 'time'; time.dataset.time = '';
  const identity = document.createElement('div'); identity.className = 'identity';
  const title = document.createElement('textarea'); title.dataset.title = ''; title.dir = 'auto'; title.value = scene.title; title.maxLength = 90; title.rows = 1; title.setAttribute('aria-label', `Название сцены ${scene.title}`);
  const place = document.createElement('span'); place.className = 'place'; place.textContent = scene.place; identity.append(title, place);
  const duration = document.createElement('label'); duration.className = 'duration'; duration.textContent = 'Минут ';
  const minutes = document.createElement('input'); minutes.dataset.minutes = ''; minutes.type = 'number'; minutes.min = '5'; minutes.max = '240'; minutes.value = String(scene.minutes); minutes.setAttribute('aria-label', `Длительность сцены ${scene.title} в минутах`); duration.append(minutes);
  const actions = document.createElement('div'); actions.className = 'actions';
  const grip = document.createElement('button'); grip.type = 'button'; grip.dataset.grip = ''; grip.textContent = 'Переместить'; grip.setAttribute('aria-label', `Переместить «${scene.title}»`); grip.setAttribute('aria-pressed', 'false');
  const previous = document.createElement('button'); previous.type = 'button'; previous.dataset.move = 'previous'; previous.textContent = 'Раньше';
  const next = document.createElement('button'); next.type = 'button'; next.dataset.move = 'next'; next.textContent = 'Позже';
  const done = document.createElement('button'); done.type = 'button'; done.dataset.done = ''; done.textContent = scene.done ? 'Снято' : 'В работе'; done.setAttribute('aria-pressed', String(scene.done));
  const remove = document.createElement('button'); remove.type = 'button'; remove.dataset.remove = ''; remove.textContent = 'Удалить'; remove.setAttribute('aria-label', `Удалить «${scene.title}»`);
  actions.append(grip, previous, next, done, remove); row.append(time, identity, duration, actions); return row;
}
function render() {
  const old = new Map(rows().map(row => [row.dataset.id!, row]));
  const nodes = shown().map(id => {
    const existing = old.get(id);
    if (existing) { const done = existing.querySelector<HTMLButtonElement>('[data-done]')!; done.textContent = byId(id).done ? 'Снято' : 'В работе'; done.setAttribute('aria-pressed', String(byId(id).done)); return existing; }
    return createRow(id);
  });
  rendering = true; try { list.replaceChildren(...nodes); } finally { rendering = false; }
  empty.hidden = nodes.length !== 0; updateTimes(); controller.update(measure());
}
function reset() { finish(); controller.destroy(); controller = makeController(); render(); }
const rowFor = (target: EventTarget | null) => target instanceof Element ? target.closest<HTMLElement>('[data-id]') : null;
list.addEventListener('input', event => {
  const input = event.target as HTMLTextAreaElement; if (!input.matches('[data-title]')) return;
  const row = rowFor(input); if (!row) return;
  byId(row.dataset.id!).title = input.value;
  input.setAttribute('aria-label', `Название сцены ${input.value}`);
  row.querySelector('[data-grip]')!.setAttribute('aria-label', `Переместить «${input.value}»`);
  row.querySelector('[data-minutes]')!.setAttribute('aria-label', `Длительность сцены ${input.value} в минутах`);
  row.querySelector('[data-remove]')!.setAttribute('aria-label', `Удалить «${input.value}»`);
});
list.addEventListener('change', event => {
  const input = event.target as HTMLInputElement; if (!input.matches('[data-minutes]')) return;
  const row = rowFor(input); if (!row) return;
  const value = Number(input.value); if (!Number.isInteger(value) || value < 5 || value > 240) { input.value = String(byId(row.dataset.id!).minutes); status.textContent = 'Длительность должна быть от 5 до 240 минут'; return; }
  byId(row.dataset.id!).minutes = value; updateTimes(); status.textContent = 'Время начала пересчитано';
});
list.addEventListener('click', event => {
  const target = event.target as Element; const row = rowFor(target); if (!row) return;
  const id = row.dataset.id!;
  if (target.closest('[data-remove]')) { finish(); scenes.splice(scenes.findIndex(scene => scene.id === id), 1); sceneById.delete(id); order = order.filter(key => key !== id); render(); document.querySelector<HTMLInputElement>('#new-scene')!.focus(); status.textContent = 'Сцена удалена'; return; }
  if (target.closest('[data-done]')) { finish(); byId(id).done = !byId(id).done; render(); if (!row.isConnected) filterInput.focus(); status.textContent = 'Состояние сцены обновлено'; return; }
  const move = target.closest<HTMLElement>('[data-move]')?.dataset.move as ReorderStep | undefined;
  if (move) { finish(); controller.update(measure()); session = controller.start(id); session?.step(move); finish(); }
});
list.addEventListener('keydown', event => {
  const target = event.target as Element; if (!target.matches('[data-grip]')) return;
  const id = rowFor(target)?.dataset.id; if (!id) return;
  if (event.key === 'Escape') { event.preventDefault(); const original = keyboardStart; finish(); if (original) { projection.cancel(); order = original; render(); list.querySelector<HTMLElement>(`[data-id="${id}"] [data-grip]`)?.focus({ preventScroll: true }); status.textContent = 'Перемещение отменено'; } return; }
  if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); if (session?.active && controller.activeKey === id) finish(); else { finish(); controller.update(measure()); session = controller.start(id); if (session) keyboardStart = [...order]; target.setAttribute('aria-pressed', String(!!session)); announce(id); } return; }
  const steps: Record<string, ReorderStep> = { ArrowUp: 'up', ArrowDown: 'down', Home: 'first', End: 'last' };
  if (session?.active && steps[event.key]) { event.preventDefault(); controller.update(measure()); session.step(steps[event.key]!); }
});
list.addEventListener('focusout', event => { if (!rendering && (event.target as Element).matches('[data-grip]') && session?.active && pointer === undefined) finish(); });
list.addEventListener('pointerdown', event => {
  if (event.button !== 0 || pointer !== undefined || !(event.target as Element).closest('[data-grip]')) return;
  const row = rowFor(event.target); if (!row) return;
  finish(); controller.update(measure()); session = controller.start(row.dataset.id!); if (!session) return;
  event.preventDefault(); const rect = row.getBoundingClientRect(); origin = { x: rect.x + rect.width / 2 - event.clientX, y: rect.y + rect.height / 2 - event.clientY };
  pointer = event.pointerId; list.setPointerCapture(pointer); row.querySelector<HTMLElement>('[data-grip]')!.focus({ preventScroll: true }); row.querySelector('[data-grip]')!.setAttribute('aria-pressed', 'true');
});
list.addEventListener('pointermove', event => { if (event.pointerId === pointer) session?.move({ x: event.clientX + origin.x, y: event.clientY + origin.y }); });
for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) list.addEventListener(type, event => { if ((event as PointerEvent).pointerId === pointer) finish(); });
filterInput.addEventListener('change', () => { filter = filterInput.value as typeof filter; reset(); status.textContent = `Показано ${shown().length} сцен`; });
direction.addEventListener('click', () => { rtl = !rtl; list.dir = rtl ? 'rtl' : 'ltr'; direction.setAttribute('aria-pressed', String(rtl)); reset(); });
quietButton.addEventListener('click', () => { noMotion = !noMotion; quietButton.setAttribute('aria-pressed', String(noMotion)); projection.cancel(); });
media.addEventListener('change', () => { if (media.matches) projection.cancel(); });
document.querySelector<HTMLFormElement>('#add-form')!.addEventListener('submit', event => {
  event.preventDefault(); const title = document.querySelector<HTMLInputElement>('#new-scene')!; const duration = document.querySelector<HTMLInputElement>('#new-minutes')!;
  const name = title.value.trim(), minutes = Number(duration.value); if (!name || !Number.isInteger(minutes) || minutes < 5 || minutes > 240) return;
  const id = crypto.randomUUID(); const scene = { id, title: name, place: 'Новая площадка', minutes, done: false }; scenes.push(scene); sceneById.set(id, scene); order.push(id); title.value = ''; filter = 'all'; filterInput.value = 'all'; finish(); render(); list.querySelector<HTMLElement>(`[data-id="${id}"] [data-title]`)!.focus(); status.textContent = `Добавлена сцена «${name}»`;
});
window.addEventListener('pagehide', () => { finish(); controller.destroy(); projection.cancel(); });
window.addEventListener('pageshow', event => { if (event.persisted) { controller = makeController(); render(); } });
render();
