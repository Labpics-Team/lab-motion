import { createDomProjection } from '@labpics/motion/projection';
import './style.css';

type Material = { id: string; number: string; category: string; title: string; summary: string; body: string; tone: string };
const materials: Material[] = [
  { id: 'light', number: '01', category: 'Наблюдение', title: 'Свет как материал', summary: 'Как меняется поверхность в течение дня.', body: 'Утренний свет обозначает фактуру, вечерний собирает предметы в силуэты. Сравните один и тот же объект при разных углах освещения и запишите, что оказалось устойчивым.', tone: 'peach' },
  { id: 'space', number: '02', category: 'Пространство', title: 'Место для паузы', summary: 'О расстоянии между предметами.', body: 'Пустое место помогает увидеть отношения между предметами. Отступ служит не украшением, а подсказкой: он отделяет действие от результата и оставляет место взгляду.', tone: 'mint' },
  { id: 'color', number: '03', category: 'Цвет', title: 'Тихая палитра', summary: 'Соседство оттенков и глубина тона.', body: 'Цвет меняется от окружения. Проверьте палитру рядом с реальным содержимым, а затем уберите один оттенок и посмотрите, стало ли чтение яснее.', tone: 'lavender' },
  { id: 'form', number: '04', category: 'Форма', title: 'Контур и ритм', summary: 'Повторение без однообразия.', body: 'Небольшое отклонение от ритма создаёт ориентир. Сначала установите повторяющийся порядок, затем нарушьте его в точке, где читателю нужно сделать выбор.', tone: 'butter' },
];

const gallery = document.querySelector<HTMLElement>('#gallery')!;
const status = document.querySelector<HTMLElement>('#status')!;
const motionButton = document.querySelector<HTMLButtonElement>('#motion')!;
const direction = document.querySelector<HTMLSelectElement>('#direction')!;
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
let noMotion = false;
let selected: string | null = null;
let returnFocus: string | null = null;
const projection = createDomProjection({ radius: false, matchMedia: () => ({ matches: noMotion || reduced.matches }) });
const card = (id: string) => gallery.querySelector<HTMLElement>(`[data-id="${id}"]`);
const cards = () => Array.from(gallery.querySelectorAll<HTMLElement>('[data-id]'));
let geometryFrame = 0;
function rebaseGeometry(): void {
  if (geometryFrame || !projection.playing) return;
  geometryFrame = requestAnimationFrame(() => {
    geometryFrame = 0;
    if (!projection.playing) return;
    projection.capture(cards());
    projection.play();
  });
}

function createCard(item: Material): HTMLElement {
  const article = document.createElement('article');
  article.className = `card ${item.tone}`; article.dataset.id = item.id;
  const badge = document.createElement('span'); badge.className = 'badge'; badge.textContent = item.number;
  const category = document.createElement('span'); category.className = 'category'; category.textContent = item.category;
  const title = document.createElement('h2'); title.textContent = item.title;
  const summary = document.createElement('p'); summary.className = 'summary'; summary.textContent = item.summary;
  const open = document.createElement('button'); open.type = 'button'; open.dataset.open = ''; open.textContent = 'Читать заметку ↗'; open.setAttribute('aria-label', `Читать «${item.title}»`);
  const detail = document.createElement('div'); detail.className = 'detail'; detail.hidden = true;
  const body = document.createElement('p'); body.className = 'body'; body.textContent = item.body;
  const label = document.createElement('label'); label.textContent = 'Ваша заметка';
  const note = document.createElement('textarea'); note.rows = 3; note.placeholder = 'Запишите наблюдение'; note.setAttribute('aria-label', `Ваша заметка к «${item.title}»`);
  const close = document.createElement('button'); close.type = 'button'; close.dataset.close = ''; close.textContent = 'К подборке ↙';
  label.append(note); detail.append(body, label, close); article.append(badge, category, title, summary, open, detail);
  return article;
}
gallery.append(...materials.map(createCard));

function select(next: string | null): void {
  if (selected === next) return;
  const previous = selected;
  if (next !== null) returnFocus = next;
  projection.capture(cards());
  selected = next;
  for (const element of cards()) {
    const expanded = element.dataset.id === next;
    element.classList.toggle('expanded', expanded);
    element.querySelector<HTMLElement>('.detail')!.hidden = !expanded;
    element.querySelector<HTMLButtonElement>('[data-open]')!.hidden = expanded;
  }
  gallery.classList.toggle('has-selection', next !== null);
  projection.play();
  if (next !== null) {
    card(next)?.querySelector<HTMLButtonElement>('[data-close]')?.focus({ preventScroll: true });
    status.textContent = `Открыта заметка «${materials.find(item => item.id === next)!.title}»`;
  } else {
    const focusId = returnFocus ?? previous;
    card(focusId ?? '')?.querySelector<HTMLButtonElement>('[data-open]')?.focus({ preventScroll: true });
    returnFocus = null;
    status.textContent = 'Показана подборка';
  }
}

gallery.addEventListener('click', event => {
  const target = event.target as Element;
  const item = target.closest<HTMLElement>('[data-id]');
  if (!item) return;
  if (target.closest('[data-open]')) select(item.dataset.id!);
  if (target.closest('[data-close]')) select(null);
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && selected !== null) { event.preventDefault(); select(null); }
});
motionButton.addEventListener('click', () => {
  noMotion = !noMotion;
  motionButton.setAttribute('aria-pressed', String(noMotion));
  if (noMotion) projection.cancel();
  status.textContent = noMotion ? 'Движение выключено' : 'Движение включено';
});
direction.addEventListener('change', () => {
  projection.capture(cards()); gallery.dir = direction.value; projection.play();
  status.textContent = direction.value === 'rtl' ? 'Направление справа налево' : 'Направление слева направо';
});
window.addEventListener('resize', rebaseGeometry);
new ResizeObserver(rebaseGeometry).observe(gallery);
reduced.addEventListener('change', () => { if (reduced.matches) projection.cancel(); });
window.addEventListener('pagehide', () => { cancelAnimationFrame(geometryFrame); geometryFrame = 0; projection.cancel(); });
