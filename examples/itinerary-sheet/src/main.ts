import { CompositorSpring } from '@labpics/motion/compositor';
import { createDecay } from '@labpics/motion/decay';
import { createVelocityTracker } from '@labpics/motion/gestures';
import './style.css';

type Place = { id: string; number: string; title: string; time: string; description: string; duration: string; next: string; note: string };
const places: Place[] = [
  { id: 'garden', number: '01', title: 'Городской сад', time: '10:00', description: 'Начните прогулку среди старых деревьев и тихих аллей.', duration: '45 минут', next: 'Музей · 12 минут пешком', note: '' },
  { id: 'museum', number: '02', title: 'Музей графики', time: '11:00', description: 'Небольшая коллекция плакатов и книжной графики. Загляните в зал временной выставки.', duration: '60 минут', next: 'Набережная · 18 минут пешком', note: '' },
  { id: 'quay', number: '03', title: 'Старая набережная', time: '12:30', description: 'Закончите маршрут у воды: здесь удобно остановиться и пересмотреть сделанные заметки.', duration: '40 минут', next: 'Конец маршрута', note: '' },
];
let current = places[0]!;
let noMotion = false;
let lastSnap = 2;
const sheet = document.querySelector<HTMLElement>('#sheet')!;
const sheetTop = document.querySelector<HTMLElement>('.sheet-top')!;
const handle = document.querySelector<HTMLButtonElement>('#handle')!;
const content = document.querySelector<HTMLElement>('#sheet-content')!;
const open = document.querySelector<HTMLButtonElement>('#open-sheet')!;
const quietButton = document.querySelector<HTMLButtonElement>('#quiet')!;
const quietSheetButton = document.querySelector<HTMLButtonElement>('#quiet-sheet')!;
const status = document.querySelector<HTMLElement>('#motion-status')!;
const noteStatus = document.querySelector<HTMLElement>('#note-status')!;
const note = document.querySelector<HTMLTextAreaElement>('#note')!;
const reduced = matchMedia('(prefers-reduced-motion: reduce)');

function renderPlace() {
  document.querySelector<HTMLElement>('#place-number')!.textContent = current.number;
  document.querySelector<HTMLElement>('#place-title')!.textContent = current.title;
  document.querySelector<HTMLElement>('#place-time')!.textContent = current.time;
  document.querySelector<HTMLElement>('#place-description')!.textContent = current.description;
  document.querySelector<HTMLElement>('#place-duration')!.textContent = current.duration;
  document.querySelector<HTMLElement>('#place-next')!.textContent = current.next;
  note.value = current.note; noteStatus.textContent = '';
  const position = places.indexOf(current);
  document.querySelector<HTMLButtonElement>('[data-select-place="previous"]')!.disabled = position === 0;
  document.querySelector<HTMLButtonElement>('[data-select-place="next"]')!.disabled = position === places.length - 1;
  document.querySelectorAll<HTMLButtonElement>('[data-place]').forEach(button => button.setAttribute('aria-current', String(button.dataset.place === current.id)));
}

function mountSheet() {
  const events = new AbortController();
  const snap = () => {
    const height = sheet.getBoundingClientRect().height;
    return [0, Math.round(height * 0.48), Math.max(1, Math.round(height - sheetTop.getBoundingClientRect().height))];
  };
  let points = snap();
  let selected = lastSnap;
  let pointer: number | undefined;
  let anchor = 0;
  let coordinate = 0;
  let live: ReturnType<CompositorSpring['handoffToLive']> | undefined;
  const velocity = createVelocityTracker();
  const quiet = () => noMotion || reduced.matches;
  const format = (value: number) => `translateY(${value}px)`;
  const motion = new CompositorSpring({
    spring: { mass: 1, stiffness: 240, damping: 28 }, property: 'transform',
    from: points[selected]!, to: points[selected]!, target: sheet, format,
    apply: value => { sheet.style.transform = String(value); },
    matchMedia: () => ({ matches: quiet() }),
  });
  sheet.style.transform = format(points[selected]!);
  const bounded = (value: number) => Math.max(points[0]!, Math.min(points[2]!, value));
  function release() {
    const captured = pointer; pointer = undefined;
    if (captured !== undefined && handle.hasPointerCapture(captured)) handle.releasePointerCapture(captured);
  }
  function select(index: number) {
    if (events.signal.aborted) return;
    release(); live = undefined; selected = Math.max(0, Math.min(2, index)); lastSnap = selected;
    if (quiet()) motion.handoffToLive(points[selected]!).snapTo(points[selected]!);
    else motion.handoffToCompositor(points[selected]!);
    const labels = ['Панель раскрыта', 'Панель наполовину', 'Панель закрыта'];
    document.querySelector<HTMLElement>('#sheet-state')!.textContent = labels[selected]!;
    status.textContent = labels[selected]!;
    open.setAttribute('aria-expanded', String(selected !== 2));
    content.inert = selected === 2;
    content.setAttribute('aria-hidden', String(selected === 2));
    sheet.querySelectorAll<HTMLButtonElement>('[data-snap]').forEach(button => button.setAttribute('aria-pressed', String(Number(button.dataset.snap) === selected)));
    if (selected === 2 && content.contains(document.activeElement)) open.focus({ preventScroll: true });
  }
  const follow = (event: PointerEvent) => {
    if (event.pointerId !== pointer || !live) return;
    coordinate = event.clientY;
    velocity.push({ x: event.clientX, y: event.clientY, t: event.timeStamp / 1000 });
    const goal = bounded(anchor + coordinate);
    if (quiet()) live.snapTo(goal); else live.setTarget(goal);
  };
  const finish = (event: PointerEvent, cancelled: boolean) => {
    if (event.pointerId !== pointer || !live) return;
    if (!cancelled) follow(event);
    // До следующего кадра spring.value и spring.velocity могут быть старыми.
    // Положение и скорость отпускания берём из одного жеста указателя.
    const releaseGoal = bounded(anchor + event.clientY);
    const rest = createDecay({ from: releaseGoal, velocity: velocity.velocity().vy }).rest;
    const next = cancelled ? selected : points.reduce((best, value, index) =>
      Math.abs(value - rest) < Math.abs(points[best]! - rest) ? index : best, 0);
    select(next);
  };
  handle.addEventListener('pointerdown', event => {
    if (!event.isPrimary || event.button !== 0 || pointer !== undefined) return;
    event.preventDefault(); handle.focus({ preventScroll: true });
    live = motion.handoffToLive(); coordinate = event.clientY; anchor = live.value - coordinate;
    velocity.reset(); velocity.push({ x: event.clientX, y: event.clientY, t: event.timeStamp / 1000 });
    pointer = event.pointerId; handle.setPointerCapture(pointer);
  }, { signal: events.signal });
  handle.addEventListener('pointermove', follow, { signal: events.signal });
  handle.addEventListener('pointerup', event => finish(event, false), { signal: events.signal });
  handle.addEventListener('pointercancel', event => finish(event, true), { signal: events.signal });
  handle.addEventListener('lostpointercapture', event => finish(event, true), { signal: events.signal });
  handle.addEventListener('keydown', event => {
    if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? 2 : event.key === 'ArrowUp' ? selected - 1 : event.key === 'ArrowDown' ? selected + 1 : undefined;
    if (next !== undefined) { event.preventDefault(); select(next); }
  }, { signal: events.signal });
  const observer = new ResizeObserver(() => {
    const next = snap();
    if (next.every((point, index) => point === points[index])) return;
    points = next;
    if (pointer !== undefined && live) {
      anchor = live.value - coordinate;
      const goal = bounded(live.value);
      if (quiet()) live.snapTo(goal); else live.setTarget(goal);
    } else select(selected);
  });
  observer.observe(sheet);
  observer.observe(sheetTop);
  select(selected);
  return { select, get selected() { return selected; }, destroy() { events.abort(); observer.disconnect(); release(); live = undefined; motion.destroy(); sheet.style.removeProperty('transform'); } };
}

let controller = mountSheet();
renderPlace();
open.addEventListener('click', () => controller.select(0));
const remount = () => { controller.destroy(); controller = mountSheet(); };
const toggleMotion = () => { noMotion = !noMotion; for (const button of [quietButton, quietSheetButton]) button.setAttribute('aria-pressed', String(noMotion)); remount(); };
quietButton.addEventListener('click', toggleMotion);
quietSheetButton.addEventListener('click', toggleMotion);
reduced.addEventListener('change', remount);
document.querySelectorAll<HTMLButtonElement>('[data-place]').forEach(button => button.addEventListener('click', () => {
  current = places.find(place => place.id === button.dataset.place)!;
  renderPlace(); controller.select(0);
}));
sheet.addEventListener('click', event => {
  const placeButton = (event.target as Element).closest<HTMLButtonElement>('[data-select-place]');
  if (placeButton && sheet.contains(placeButton)) {
    const offset = placeButton.dataset.selectPlace === 'next' ? 1 : -1;
    current = places[places.indexOf(current) + offset] ?? current;
    renderPlace(); placeButton.focus({ preventScroll: true }); return;
  }
  const button = (event.target as Element).closest<HTMLButtonElement>('[data-snap]');
  if (button && sheet.contains(button)) controller.select(Number(button.dataset.snap));
});
document.querySelector<HTMLFormElement>('#note-form')!.addEventListener('submit', event => {
  event.preventDefault(); current.note = note.value; noteStatus.textContent = `Заметка к точке «${current.title}» сохранена`;
});
window.addEventListener('pagehide', () => controller.destroy());
window.addEventListener('pageshow', event => { if (event.persisted) remount(); });
