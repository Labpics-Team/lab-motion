import { expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { layout } from '../src/motion/layout.js';

function environment() {
  const dom = new JSDOM('<main></main>'), document = dom.window.document, root = document.querySelector('main')!;
  Object.defineProperty(dom.window, 'CSS', { value: { supports: () => true } });
  Object.defineProperty(document, 'getAnimations', { value: () => [] });
  const transitions: Array<{ skipTransition(): void }> = [];
  Object.defineProperty(document, 'startViewTransition', { value: (callback: () => Promise<void>) => {
    let finish!: () => void;
    const finished = new Promise<void>(resolve => { finish = resolve; });
    const updateCallbackDone = Promise.resolve().then(callback);
    const transition = { ready: updateCallbackDone, updateCallbackDone, finished,
      skipTransition() { void updateCallbackDone.then(finish, finish); } };
    transitions.push(transition); return transition;
  } });
  return { dom, document, root, transitions };
}

it('перехват layout восстанавливает имя приложения вместо имени прежнего перехода', async () => {
  const h = environment(); h.root.style.setProperty('view-transition-name', 'app-card', 'important');
  const calls: number[] = [];
  try {
    const a = layout(h.root, () => { calls.push(1); }, { duration: 100 });
    const b = layout(h.root, () => { calls.push(2); }, { duration: 100 });
    const c = layout(h.root, () => { calls.push(3); }, { duration: 100 });
    c.finish();
    expect(await a.finished).toEqual({ status: 'stopped' });
    expect(await b.finished).toEqual({ status: 'stopped' });
    expect(await c.finished).toEqual({ status: 'finished' });
    expect(calls).toEqual([1, 2, 3]);
    expect(h.root.style.getPropertyValue('view-transition-name')).toBe('app-card');
    expect(h.root.style.getPropertyPriority('view-transition-name')).toBe('important');
    expect(h.document.querySelectorAll('style')).toHaveLength(0);
  } finally { h.dom.window.close(); }
});
it('stop отзывает временную стилизацию до завершения ожидающего app-update', async () => {
  const h = environment(); let resolve!: () => void, entered!: () => void;
  const started = new Promise<void>(r => { entered = r; });
  const completion = new Promise<void>(r => { resolve = r; });
  try {
    const a = layout(h.root, async () => { entered(); await completion; }, { duration: 100 });
    await started; a.stop();
    expect(h.root.style.getPropertyValue('view-transition-name')).toBe('');
    expect(h.document.querySelectorAll('style')).toHaveLength(0);
    resolve(); expect(await a.finished).toEqual({ status: 'stopped' });
  } finally { resolve?.(); h.dom.window.close(); }
});
it('cleanup не перезаписывает новое имя, заданное приложением', async () => {
  const h = environment();
  try {
    const a = layout(h.root, () => { h.root.style.setProperty('view-transition-name', 'new-app-name'); }, { duration: 100 });
    await Promise.resolve(); await Promise.resolve(); a.finish(); await a.finished;
    expect(h.root.style.getPropertyValue('view-transition-name')).toBe('new-app-name');
    expect(h.document.querySelectorAll('style')).toHaveLength(0);
  } finally { h.dom.window.close(); }
});
