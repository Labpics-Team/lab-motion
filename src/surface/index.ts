/**
 * src/surface/index.ts — приватный executor compiled surface-артефактов.
 *
 * Это build-tool деталь, не runtime-tier: сюда попадают ТОЛЬКО вызовы
 * animate(el, { width: [w0, w1] }, { layout: 'project' }), которые compiler
 * доказанно понизил (статические концы/пружина/политики; артефакт
 * сертифицирован НА СБОРКЕ: позитивность minWidth>0 и reciprocal-бюджет
 * ≤0.25 CSS px — tryCompileSurfaceArtifact отказывает иначе). В модуле нет
 * solver'а, parser'а, observer'а и coordinator'а: движение исполняют пять
 * CSS-анимаций same-document View Transition pseudo-tree, как в runtime-пути
 * (будущее layout коммитится один раз; пиксели догоняют сопряжёнными
 * snapshot-плоскостями G·F·R=1).
 *
 * Blend-траектория A(t) сериализуется в артефакт вместе с P и Q: SSOT всех
 * трёх строк — компилятор (tryCompileSurfaceArtifact). Executor ничего не
 * восстанавливает и не выводит: прежний regex по Q дополнял пары вместо
 * замены, и compiled crossfade расходился с runtime до 0.738 между стопами.
 *
 * Fail-closed деградации (ни одна не оставляет Infinity/NaN в CSS и ни одна
 * не откатывает committed DOM):
 *   • reduced-motion или нет VT → snap: мгновенный коммит конечной ширины;
 *   • pseudo-модель недоказуема (group-бокс ≠ committed ширина ±0.5 px,
 *     нет placement-transform) → skipTransition: раскрытие committed DOM;
 *   • не-Element цель (селектор/список) — семантика обычного runtime path:
 *     прямой width-tween тем же precomputed easing/duration (SSOT-кривая),
 *     fill:'both' держит финал; без WAAPI — мгновенный коммит.
 */

export interface CompiledSurfaceCall {
  /** Авторская ширина from, CSS px. */
  readonly w0: number;
  /** Коммитнутая ширина to (база B), CSS px. */
  readonly w1: number;
  /** Длительность сертифицированного перехода, ms. */
  readonly d: number;
  /** Serialized P: linear() фактически исполняемой пружины. */
  readonly p: string;
  /** Serialized Q: reciprocal-компаньон из serialized P. */
  readonly q: string;
  /** Serialized blend A: монотонный crossfade на тех же стопах (SSOT — компилятор). */
  readonly a: string;
}

export interface CompiledSurfaceControls {
  /** Резолвится в терминальном состоянии (finished/canceled/snap). */
  readonly finished: Promise<void>;
  /** Раскрывает committed DOM немедленно (как cancel runtime-пути). */
  cancel(): void;
}

interface ElementLike {
  style: { setProperty?(n: string, v: string): void; width?: string; viewTransitionName?: string };
  animate?: (keyframes: unknown, timing: unknown) => unknown;
}

interface ViewTransitionLike {
  readonly ready: Promise<void>;
  readonly finished: Promise<void>;
  skipTransition(): void;
}

interface DocumentLike {
  createElement(tag: 'style'): { textContent: string; remove(): void };
  readonly head: { appendChild(node: unknown): void };
  querySelectorAll?(selector: string): ArrayLike<ElementLike>;
  startViewTransition?(update: () => void): ViewTransitionLike;
}

let seq = 0;

export function runSurface(
  target: unknown,
  art: CompiledSurfaceCall,
): CompiledSurfaceControls {
  const g = globalThis as {
    document?: DocumentLike;
    matchMedia?: (q: string) => { matches: boolean };
    getComputedStyle?: (el: unknown, pseudo?: string) => { width: string; transform: string };
  };
  const doc = g.document;
  const w1px = `${art.w1}px`;
  let fin!: () => void; // назначается синхронно исполнителем Promise
  const finished = new Promise<void>((r) => { fin = r; });
  let done = false;
  let styleEl: { remove(): void } | undefined;
  let vt: ViewTransitionLike | undefined;
  let vtEl: ElementLike | undefined;
  let vtName = '';

  // Единый терминальный путь (cancel/certify-fail/finished): стиль и имя
  // снимаются ровно один раз, skipTransition раскрывает committed DOM.
  // Присваивание CSS-свойства на живом CSSStyleDeclaration не бросает;
  // skipTransition может (завершённый transition) — он в try.
  const end = (): void => {
    if (done) return;
    done = true;
    // remove() собственного style-узла не бросает (no-op вне документа).
    styleEl?.remove();
    // Имя снимается, только если цель ещё носит НАШЕ имя.
    if (vtEl !== undefined && vtEl.style.viewTransitionName === vtName) {
      vtEl.style.viewTransitionName = '';
    }
    try { vt?.skipTransition(); } catch { /* transition уже завершён */ }
    fin();
  };

  const controls: CompiledSurfaceControls = { finished, cancel: end };

  const reduced = g.matchMedia?.('(prefers-reduced-motion:reduce)').matches === true;

  // style отличает единый Element от строки/списка (у NodeList и массивов
  // свойства style нет).
  const isElement = (value: unknown): value is ElementLike =>
    value !== null && typeof value === 'object' && !!(value as ElementLike).style;

  if (isElement(target)) {
    // Единая bounded-цель: surface VT-путь.
    if (reduced || typeof doc?.startViewTransition !== 'function') {
      target.style.width = w1px;
      fin();
      return controls;
    }
    vtEl = target;
    vtName = `lm${++seq}`;
    target.style.viewTransitionName = vtName;
    let t: ViewTransitionLike;
    try {
      t = doc.startViewTransition(() => {
        target.style.width = w1px;
      });
    } catch {
      // Hostile host: синхронный бросок не должен оставлять ни имени, ни
      // незакоммиченного DOM. Fail-closed snap — как путь без VT.
      target.style.width = w1px;
      end();
      return controls;
    }
    vt = t;
    const certify = (): void => {
      if (done) return;
      // Сертификация pseudo-модели ПОСЛЕ ready (как runtime-путь): group-бокс
      // равен committed ширине ±0.5 px, placement существует; иначе skip.
      // (NaN-ширина проваливает сравнение допуска — отдельный guard избыточен.)
      let placement = '';
      try {
        // Псевдоэлемент document-scoped: любой элемент цели достаточен.
        const cs = g.getComputedStyle!(target, `::view-transition-group(${vtName})`);
        const gw = parseFloat(cs.width);
        if ((gw - art.w1) * (gw - art.w1) <= 0.25) {
          const tf = cs.transform;
          placement = tf !== '' && tf !== 'none' ? tf : 'translate(0px,0px)';
        }
      } catch { /* модель недоказуема */ }
      if (placement === '') { end(); return; }
      // 5 generated CSS-анимаций псевдодерева (постоянное число effects):
      // group scale G(t) c easing P; old/new counter-scale R(t) c easing Q;
      // old/new opacity crossfade c monotonic blend A на Q-stops.
      const s0 = art.w0 / art.w1;
      const dur = `${art.d}ms`;
      // Blend A приходит сериализованной из артефакта: SSOT — компилятор.
      // Прежний regex по Q дополнял пары вместо замены, и crossfade расходился
      // с runtime до 0.738 между стопами (пилообразный фликер).
      const aCss = art.a;
      const style = doc.createElement('style');
      style.textContent =
        `@keyframes ${vtName}-g { from { transform: ${placement} scaleX(${s0}); } to { transform: ${placement} scaleX(1); } }\n`
        + `@keyframes ${vtName}-os { from { transform: scaleX(1); } to { transform: scaleX(${s0}); } }\n`
        + `@keyframes ${vtName}-oo { from { opacity: 1; } to { opacity: 0; } }\n`
        + `@keyframes ${vtName}-ns { from { transform: scaleX(${art.w1 / art.w0}); } to { transform: scaleX(1); } }\n`
        + `@keyframes ${vtName}-no { from { opacity: 0; } to { opacity: 1; } }\n`
        + `::view-transition-group(${vtName}) { transform-origin: left top; animation: ${vtName}-g ${dur} ${art.p} both; }\n`
        + `::view-transition-image-pair(${vtName}) { overflow: hidden; }\n`
        + `::view-transition-old(${vtName}) { transform-origin: left top; animation: ${vtName}-os ${dur} ${art.q} both, ${vtName}-oo ${dur} ${aCss} both; }\n`
        + `::view-transition-new(${vtName}) { transform-origin: left top; animation: ${vtName}-ns ${dur} ${art.q} both, ${vtName}-no ${dur} ${aCss} both; }`;
      doc.head.appendChild(style);
      styleEl = style;
      t.finished.then(end, end);
    };
    t.ready.then(certify, certify);
    return controls;
  }

  // Не-Element цель (селектор/список): семантика обычного runtime path —
  // прямой width-tween, не поверхность. Та же precomputed кривая (SSOT).
  const source: ArrayLike<ElementLike> = typeof target === 'string' && doc?.querySelectorAll
    ? doc.querySelectorAll(target)
    : target !== null && typeof target === 'object'
      && typeof (target as ArrayLike<ElementLike>).length === 'number'
      ? target as ArrayLike<ElementLike>
      : [];
  for (const el of Array.from(source)) {
    if (!isElement(el)) continue;
    if (reduced || typeof el.animate !== 'function') {
      el.style.width = w1px;
    } else {
      el.animate(
        { width: [`${art.w0}px`, w1px] },
        { duration: art.d, easing: art.p, fill: 'both' },
      );
    }
  }
  fin();
  return controls;
}
