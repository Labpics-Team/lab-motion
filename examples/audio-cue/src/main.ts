import { CompositorSpring } from '@labpics/motion/compositor';
import './style.css';

type Cue = { at: number; title: string; copy: string; note: string };
const cues: Cue[] = [
  { at: 0, title: 'Вступление', copy: 'Знакомство с героем и улицей, на которой он вырос.', note: '' },
  { at: 40, title: 'Мастерская', copy: 'История о старых инструментах и первом заказе.', note: '' },
  { at: 96, title: 'Набережная', copy: 'Звуки воды и воспоминание о вечернем городе.', note: '' },
  { at: 145, title: 'Финал', copy: 'Последняя реплика и место для завершающей паузы.', note: '' },
];
const duration = 180;
const marks = new Set<number>();
let position = 0;
let quiet = false;
let rtl = false;
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
const seek = document.querySelector<HTMLInputElement>('#seek')!;
const cursor = document.querySelector<HTMLElement>('#cursor')!;
const note = document.querySelector<HTMLTextAreaElement>('#note')!;
const status = document.querySelector<HTMLElement>('#status')!;
const track = document.querySelector<HTMLElement>('#track')!;
const quietButton = document.querySelector<HTMLButtonElement>('#quiet')!;
const directionButton = document.querySelector<HTMLButtonElement>('#direction')!;
const previous = document.querySelector<HTMLButtonElement>('#previous')!;
const next = document.querySelector<HTMLButtonElement>('#next')!;
const marksList = document.querySelector<HTMLOListElement>('#marks')!;
const time = (seconds: number) => `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
const cueIndex = () => cues.findLastIndex(cue => cue.at <= position);
// Держим трёхпиксельный курсор внутри дорожки даже на крайних значениях.
const coordinate = () => 1 + (rtl ? 1 - position / duration : position / duration) * 98;
const prefersQuiet = () => quiet || reduced.matches;
function makeMotion() {
  return new CompositorSpring({
    spring: { mass: 1, stiffness: 230, damping: 27 }, property: 'left',
    from: coordinate(), to: coordinate(), target: cursor,
    format: value => `${value}%`, apply: value => { cursor.style.left = String(value); },
    matchMedia: () => ({ matches: prefersQuiet() }),
  });
}
let motion = makeMotion();
function render(animate: boolean) {
  const index = cueIndex();
  const cue = cues[index]!;
  seek.value = String(position);
  seek.setAttribute('aria-valuetext', `${time(position)}, ${cue.title}`);
  document.querySelector<HTMLElement>('#position')!.textContent = time(position);
  document.querySelector<HTMLElement>('#cue-title')!.textContent = cue.title;
  document.querySelector<HTMLElement>('#cue-copy')!.textContent = cue.copy;
  if (document.activeElement !== note) note.value = cue.note;
  previous.disabled = index === 0;
  next.disabled = index === cues.length - 1;
  if (animate && !prefersQuiet()) motion.handoffToCompositor(coordinate());
  else motion.handoffToLive(coordinate()).snapTo(coordinate());
}
function setPosition(value: number, animate = true) {
  const bounded = Math.max(0, Math.min(duration, Math.round(value)));
  const changedCue = cues[cueIndex()] !== cues.findLast(cue => cue.at <= bounded);
  position = bounded;
  if (changedCue && document.activeElement === note) note.blur();
  render(animate);
  status.textContent = `Курсор ${time(position)}; ${cues[cueIndex()]!.title}`;
}
function renderMarks() {
  marksList.replaceChildren(...[...marks].sort((a, b) => a - b).map(at => {
    const item = document.createElement('li');
    const jump = document.createElement('button'); jump.type = 'button'; jump.textContent = `Перейти к ${time(at)}`;
    jump.addEventListener('click', () => { setPosition(at); jump.focus({ preventScroll: true }); });
    const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = 'Удалить';
    remove.setAttribute('aria-label', `Удалить точку ${time(at)}`);
    remove.addEventListener('click', () => { marks.delete(at); renderMarks(); document.querySelector<HTMLButtonElement>('#mark')!.focus({ preventScroll: true }); status.textContent = `Точка ${time(at)} удалена`; });
    item.append(jump, remove); return item;
  }));
  document.querySelector<HTMLElement>('#empty')!.hidden = marks.size > 0;
}
seek.addEventListener('input', () => setPosition(Number(seek.value), false));
previous.addEventListener('click', () => setPosition(cues[Math.max(0, cueIndex() - 1)]!.at));
next.addEventListener('click', () => setPosition(cues[Math.min(cues.length - 1, cueIndex() + 1)]!.at));
note.addEventListener('input', () => { cues[cueIndex()]!.note = note.value; });
document.querySelector<HTMLButtonElement>('#mark')!.addEventListener('click', () => {
  if (marks.has(position)) { status.textContent = `Точка ${time(position)} уже сохранена`; return; }
  marks.add(position); renderMarks(); status.textContent = `Точка ${time(position)} сохранена`;
});
quietButton.addEventListener('click', () => {
  quiet = !quiet; quietButton.setAttribute('aria-pressed', String(quiet));
  if (prefersQuiet()) motion.handoffToLive(coordinate()).snapTo(coordinate());
});
reduced.addEventListener('change', () => { if (reduced.matches) motion.handoffToLive(coordinate()).snapTo(coordinate()); });
directionButton.addEventListener('click', () => {
  rtl = !rtl;
  track.dir = rtl ? 'rtl' : 'ltr'; seek.dir = rtl ? 'rtl' : 'ltr';
  directionButton.setAttribute('aria-pressed', String(rtl));
  motion.destroy(); motion = makeMotion(); render(false);
});
window.addEventListener('pagehide', () => { motion.destroy(); });
window.addEventListener('pageshow', event => { if (event.persisted) { motion = makeMotion(); render(false); } });
render(false);
