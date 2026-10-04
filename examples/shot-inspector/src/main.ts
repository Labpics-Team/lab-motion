import { createDomProjection } from '@labpics/motion/projection';
import './style.css';

type Shot = { id: string; number: string; title: string; place: string; note: string; tone: string };
const shots: Shot[] = [
  { id: 'arrival', number: '01', title: 'Прибытие', place: 'Северный вход', note: 'Общий план до появления группы.', tone: 'amber' },
  { id: 'portrait', number: '02', title: 'Портрет мастера', place: 'Мастерская', note: 'Оставить свет из окна и место для титра.', tone: 'lilac' },
  { id: 'detail', number: '03', title: 'Детали работы', place: 'Рабочий стол', note: 'Руки, инструмент и звук материала.', tone: 'green' },
];
const list = document.querySelector<HTMLElement>('#list')!;
const inspector = document.querySelector<HTMLElement>('#inspector')!;
const status = document.querySelector<HTMLElement>('#status')!;
const motionButton = document.querySelector<HTMLButtonElement>('#motion')!;
const direction = document.querySelector<HTMLSelectElement>('#direction')!;
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
let noMotion = false;
let selected: string | null = null;
let placeholder: HTMLElement | null = null;
let resizeFrame = 0;
const projection = createDomProjection({ radius: false, matchMedia: () => ({ matches: noMotion || reduced.matches }) });
const all = () => Array.from(document.querySelectorAll<HTMLElement>('.shot'));
const shot = (id: string) => document.querySelector<HTMLElement>(`.shot[data-id="${id}"]`)!;

function makeShot(item: Shot): HTMLElement {
  const article = document.createElement('article');
  article.className = `shot ${item.tone}`; article.dataset.id = item.id;
  const number = document.createElement('span'); number.className = 'number'; number.textContent = item.number;
  const title = document.createElement('h2'); title.textContent = item.title;
  const place = document.createElement('p'); place.className = 'place'; place.textContent = item.place;
  const open = document.createElement('button'); open.type = 'button'; open.className = 'open';
  open.textContent = 'Открыть инспектор'; open.setAttribute('aria-label', `Открыть кадр «${item.title}»`);
  const editor = document.createElement('div'); editor.className = 'editor'; editor.hidden = true;
  const label = document.createElement('label'); label.textContent = 'Подпись к кадру';
  const textarea = document.createElement('textarea'); textarea.value = item.note; textarea.rows = 4;
  label.append(textarea);
  const close = document.createElement('button'); close.type = 'button'; close.className = 'close'; close.textContent = 'Вернуться к плану';
  editor.append(label, close);
  article.append(number, title, place, open, editor);
  return article;
}
list.append(...shots.map(makeShot));

function refreshGeometry(): void {
  if (resizeFrame || !projection.playing) return;
  resizeFrame = requestAnimationFrame(() => {
    resizeFrame = 0;
    if (projection.playing) { projection.capture(all()); projection.play(); }
  });
}

function select(next: string | null): void {
  if (next === selected) return;
  projection.capture(all());
  const old = selected;
  if (old !== null && placeholder) {
    const previous = shot(old);
    previous.classList.remove('selected');
    previous.querySelector<HTMLElement>('.editor')!.hidden = true;
    previous.querySelector<HTMLButtonElement>('.open')!.hidden = false;
    placeholder.replaceWith(previous);
    placeholder = null;
  }
  selected = next;
  if (next !== null) {
    const active = shot(next);
    placeholder = document.createElement('div');
    placeholder.className = 'source-slot'; placeholder.dataset.slot = next;
    active.replaceWith(placeholder);
    inspector.replaceChildren(active);
    active.classList.add('selected');
    active.querySelector<HTMLElement>('.editor')!.hidden = false;
    active.querySelector<HTMLButtonElement>('.open')!.hidden = true;
    active.querySelector<HTMLTextAreaElement>('textarea')!.focus({ preventScroll: true });
    status.textContent = `Редактируется кадр «${shots.find(value => value.id === next)!.title}»`;
  } else {
    const empty = document.createElement('p'); empty.className = 'empty'; empty.textContent = 'Выберите кадр для редактирования.';
    inspector.replaceChildren(empty);
    if (old !== null) shot(old).querySelector<HTMLButtonElement>('.open')!.focus({ preventScroll: true });
    status.textContent = 'Показан план съёмки';
  }
  projection.play();
}

document.addEventListener('click', event => {
  const target = event.target as Element;
  if (target.closest('.close')) select(null);
  else if (target.closest('.open')) select(target.closest<HTMLElement>('.shot')!.dataset.id!);
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && selected !== null) { event.preventDefault(); select(null); }
});
motionButton.addEventListener('click', () => {
  noMotion = !noMotion;
  motionButton.setAttribute('aria-pressed', String(noMotion));
  motionButton.textContent = noMotion ? 'Включить движение' : 'Без движения';
  if (noMotion) projection.cancel();
  status.textContent = noMotion ? 'Движение выключено' : 'Движение включено';
});
direction.addEventListener('change', () => {
  projection.capture(all()); document.querySelector<HTMLElement>('#workspace')!.dir = direction.value;
  projection.play();
});
window.addEventListener('resize', refreshGeometry);
new ResizeObserver(refreshGeometry).observe(document.querySelector<HTMLElement>('#workspace')!);
reduced.addEventListener('change', () => { if (reduced.matches) projection.cancel(); });
window.addEventListener('pagehide', () => { cancelAnimationFrame(resizeFrame); resizeFrame = 0; projection.cancel(); });
