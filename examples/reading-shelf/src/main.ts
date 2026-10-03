import { createReorder, type ReorderSession, type ReorderStep } from '@labpics/motion/behaviors/reorder';
import { createDomProjection } from '@labpics/motion/projection';
import './style.css';

type Stage = 'queue' | 'reading' | 'done';
type Entry = { id: string; title: string; stage: Stage };
const entries: Entry[] = [
  { id: 'a', title: 'Искусство видеть', stage: 'reading' },
  { id: 'b', title: 'Город и память', stage: 'queue' },
  { id: 'c', title: 'Записки о цвете', stage: 'done' },
  { id: 'd', title: 'Короткая история света', stage: 'queue' },
];
let order = entries.map(item => item.id);
let filter: Stage | 'all' = 'all';
let rtl = false;
let noMotion = false;
let session: ReorderSession | undefined;
let pointer: number | undefined;
let origin = { x: 0, y: 0 };
const shelf = document.querySelector<HTMLElement>('#shelf')!;
const status = document.querySelector<HTMLElement>('#status')!;
const empty = document.querySelector<HTMLElement>('#empty')!;
const total = document.querySelector<HTMLElement>('#total-count')!;
const filterInput = document.querySelector<HTMLSelectElement>('#filter')!;
const direction = document.querySelector<HTMLButtonElement>('#direction')!;
const motion = document.querySelector<HTMLButtonElement>('#motion')!;
const media = matchMedia('(prefers-reduced-motion: reduce)');
const projection = createDomProjection({ radius: false, matchMedia: () => ({ matches: noMotion || media.matches }) });
const byId = (id: string) => entries.find(item => item.id === id)!;
const visible = () => order.filter(id => filter === 'all' || byId(id).stage === filter);
const cards = () => Array.from(shelf.querySelectorAll<HTMLElement>('[data-id]'));
const measure = () => visible().map(id => ({ key: id, rect: shelf.querySelector<HTMLElement>(`[data-id="${id}"]`)?.getBoundingClientRect() }));
const announce = (id: string) => { status.textContent = `${byId(id).title}: ${visible().indexOf(id) + 1} из ${visible().length}`; };
let controller = makeController();
function makeController() {
  return createReorder({ items: measure(), direction: rtl ? 'rtl' : 'ltr', onReorder(next, proposal) {
    if (!controller.isCurrent(proposal)) return;
    const focused = document.activeElement as HTMLElement | null;
    if (!noMotion && !media.matches) projection.capture(cards());
    const positions = order.map((id, index) => ({ id, index })).filter(item => visible().includes(item.id)).map(item => item.index);
    next.forEach((id, index) => { order[positions[index]!] = id; });
    render();
    if (!noMotion && !media.matches) projection.play();
    focused?.focus({ preventScroll: true });
    announce(proposal.key);
  } });
}
function finish() {
  session?.end(); session = undefined;
  const captured = pointer; pointer = undefined;
  if (captured !== undefined && shelf.hasPointerCapture(captured)) shelf.releasePointerCapture(captured);
  shelf.querySelectorAll('[data-grip]').forEach(node => node.setAttribute('aria-pressed', 'false'));
}
function render() {
  const existing = new Map(cards().map(card => [card.dataset.id!, card]));
  shelf.replaceChildren(...visible().map(id => {
    const item = byId(id);
    const previous = existing.get(id);
    if (previous) {
      previous.querySelector<HTMLElement>('.stage')!.textContent = { queue: 'На очереди', reading: 'Читаю', done: 'Прочитано' }[item.stage];
      previous.querySelector<HTMLSelectElement>('[data-stage]')!.value = item.stage;
      return previous;
    }
    const card = document.createElement('article'); card.className = 'card'; card.dataset.id = id;
    const heading = document.createElement('h3'); heading.textContent = item.title;
    const label = document.createElement('span'); label.className = 'stage'; label.textContent = { queue: 'На очереди', reading: 'Читаю', done: 'Прочитано' }[item.stage];
    const grip = document.createElement('button'); grip.type = 'button'; grip.dataset.grip = ''; grip.textContent = 'Переместить'; grip.setAttribute('aria-label', `Переместить «${item.title}»`); grip.setAttribute('aria-pressed', 'false');
    const before = document.createElement('button'); before.type = 'button'; before.dataset.move = 'previous'; before.textContent = 'Раньше';
    const after = document.createElement('button'); after.type = 'button'; after.dataset.move = 'next'; after.textContent = 'Позже';
    const select = document.createElement('select'); select.setAttribute('aria-label', `Состояние «${item.title}»`);
    for (const [value, text] of [['queue', 'На очереди'], ['reading', 'Читаю'], ['done', 'Прочитано']]) { const option = new Option(text, value); select.add(option); }
    select.value = item.stage; select.dataset.stage = '';
    const remove = document.createElement('button'); remove.type = 'button'; remove.dataset.remove = ''; remove.textContent = 'Удалить'; remove.setAttribute('aria-label', `Удалить «${item.title}»`);
    const actions = document.createElement('div'); actions.className = 'actions'; actions.append(grip, before, after, select, remove);
    card.append(label, heading, actions); return card;
  }));
  empty.hidden = visible().length !== 0; total.textContent = String(entries.length);
  controller.update(measure());
}
function resetView() { finish(); controller.destroy(); controller = makeController(); render(); }
const cardFor = (target: EventTarget | null) => (target instanceof Element ? target.closest<HTMLElement>('[data-id]') : null);
shelf.addEventListener('click', event => {
  const target = event.target as Element; const card = cardFor(target); if (!card) return;
  const id = card.dataset.id!;
  if (target.closest('[data-remove]')) { finish(); entries.splice(entries.findIndex(item => item.id === id), 1); order = order.filter(key => key !== id); render(); document.querySelector<HTMLInputElement>('#new-title')!.focus(); status.textContent = 'Запись удалена'; return; }
  const move = target.closest<HTMLElement>('[data-move]')?.dataset.move as ReorderStep | undefined;
  if (move) { finish(); controller.update(measure()); session = controller.start(id); session?.step(move); finish(); }
});
shelf.addEventListener('change', event => {
  const target = event.target as HTMLSelectElement; if (!target.matches('[data-stage]')) return;
  const card = cardFor(target); if (!card) return;
  finish(); byId(card.dataset.id!).stage = target.value as Stage; render(); if (!card.isConnected) filterInput.focus(); status.textContent = 'Состояние обновлено';
});
shelf.addEventListener('keydown', event => {
  const target = event.target as Element; if (!target.matches('[data-grip]')) return;
  const id = cardFor(target)?.dataset.id; if (!id) return;
  if (event.key === 'Escape') { event.preventDefault(); finish(); return; }
  if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); if (session?.active) finish(); else { controller.update(measure()); session = controller.start(id); target.setAttribute('aria-pressed', 'true'); announce(id); } return; }
  const steps: Record<string, ReorderStep> = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down', Home: 'first', End: 'last' };
  if (session?.active && steps[event.key]) { event.preventDefault(); controller.update(measure()); session.step(steps[event.key]!); }
});
shelf.addEventListener('pointerdown', event => {
  if (event.button !== 0 || pointer !== undefined || !(event.target as Element).closest('[data-grip]')) return;
  const card = cardFor(event.target); if (!card) return;
  finish(); controller.update(measure()); session = controller.start(card.dataset.id!); if (!session) return;
  event.preventDefault(); const rect = card.getBoundingClientRect(); origin = { x: rect.x + rect.width / 2 - event.clientX, y: rect.y + rect.height / 2 - event.clientY };
  pointer = event.pointerId; shelf.setPointerCapture(pointer); card.querySelector('[data-grip]')!.setAttribute('aria-pressed', 'true');
});
shelf.addEventListener('pointermove', event => { if (event.pointerId === pointer) session?.move({ x: event.clientX + origin.x, y: event.clientY + origin.y }); });
for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) shelf.addEventListener(type, event => { if ((event as PointerEvent).pointerId === pointer) finish(); });
filterInput.addEventListener('change', () => { filter = filterInput.value as Stage | 'all'; resetView(); status.textContent = `Показано ${visible().length}`; });
direction.addEventListener('click', () => { rtl = !rtl; shelf.dir = rtl ? 'rtl' : 'ltr'; direction.setAttribute('aria-pressed', String(rtl)); resetView(); });
motion.addEventListener('click', () => { noMotion = !noMotion; motion.setAttribute('aria-pressed', String(noMotion)); projection.cancel(); });
media.addEventListener('change', () => { if (media.matches) projection.cancel(); });
document.querySelector<HTMLFormElement>('#add-form')!.addEventListener('submit', event => {
  event.preventDefault(); const input = document.querySelector<HTMLInputElement>('#new-title')!; const title = input.value.trim(); if (!title) return;
  const id = crypto.randomUUID(); entries.push({ id, title, stage: 'queue' }); order.push(id); input.value = ''; filter = 'all'; filterInput.value = 'all'; finish(); render(); shelf.querySelector<HTMLElement>(`[data-id="${id}"] [data-grip]`)!.focus(); status.textContent = `Добавлено: ${title}`;
});
window.addEventListener('pagehide', () => { finish(); controller.destroy(); projection.cancel(); }, { once: true });
render();
