import { readFileSync, writeFileSync } from 'node:fs';

const path = 'src/waapi/index.ts';
let source = readFileSync(path, 'utf8');

const capabilityBefore = `type ScrollTimelineCtor = new (options: {
  source: unknown;
  axis?: WaapiScrollAxis;
}) => unknown;

function scrollTimelineCtor(): ScrollTimelineCtor | undefined {
  const ctor = (globalThis as { ScrollTimeline?: unknown }).ScrollTimeline;
  return typeof ctor === 'function' ? ctor as ScrollTimelineCtor : undefined;
}

/** Capability probe без UA-sniffing и без DOM-глобалов на import. */
export function supportsScrollTimeline(): boolean {
  return scrollTimelineCtor() !== undefined;
}

type ViewTimelineCtor = new (options: {
  subject: unknown;
  axis?: WaapiScrollAxis;
}) => unknown;

function viewTimelineCtor(): ViewTimelineCtor | undefined {
  const ctor = (globalThis as { ViewTimeline?: unknown }).ViewTimeline;
  return typeof ctor === 'function' ? ctor as ViewTimelineCtor : undefined;
}

/** Capability probe view-progress timeline без UA-sniffing. */
export function supportsViewTimeline(): boolean {
  return viewTimelineCtor() !== undefined;
}
`;

const capabilityAfter = `type ProgressTimelineName = 'ScrollTimeline' | 'ViewTimeline';
type ProgressTimelineCtor = new (options: Record<string, unknown>) => unknown;

function progressTimelineCtor(name: ProgressTimelineName): ProgressTimelineCtor | undefined {
  const ctor = (globalThis as Record<string, unknown>)[name];
  return typeof ctor === 'function' ? ctor as ProgressTimelineCtor : undefined;
}

/** Capability probe без UA-sniffing и без DOM-глобалов на import. */
export function supportsScrollTimeline(): boolean {
  return progressTimelineCtor('ScrollTimeline') !== undefined;
}

/** Capability probe view-progress timeline без UA-sniffing. */
export function supportsViewTimeline(): boolean {
  return progressTimelineCtor('ViewTimeline') !== undefined;
}
`;

const commentBefore = `/**
 * Отдать связь scroll progress → property браузеру целиком.
 *
 * Возвращает undefined, если target/ScrollTimeline недоступны. Скрытого
 * scroll-listener/rAF fallback нет: caller может явно выбрать headless ./scroll.
 * На native path после единственного commit Lab Motion не выполняет per-frame JS.
 */
function animateProgressWaapi(
`;

const commentAfter = `/**
 * Общий commit уже созданной progress timeline. Capability/fallback policy
 * остаётся у публичных scroll/view адаптеров; здесь только property compiler.
 */
function animateProgressWaapi(
`;

function replaceExactlyOnce(before, after, label) {
  const first = source.indexOf(before);
  if (first < 0 || source.indexOf(before, first + before.length) >= 0) {
    throw new Error(`${label}: expected exactly one match`);
  }
  source = source.replace(before, after);
}

replaceExactlyOnce(capabilityBefore, capabilityAfter, 'capability block');
replaceExactlyOnce(commentBefore, commentAfter, 'helper comment');
replaceExactlyOnce('const Timeline = scrollTimelineCtor();', "const Timeline = progressTimelineCtor('ScrollTimeline');", 'scroll ctor call');
replaceExactlyOnce('const Timeline = viewTimelineCtor();', "const Timeline = progressTimelineCtor('ViewTimeline');", 'view ctor call');

if (source.includes('scrollTimelineCtor') || source.includes('viewTimelineCtor')) {
  throw new Error('duplicate ctor helper survived');
}

writeFileSync(path, source);
