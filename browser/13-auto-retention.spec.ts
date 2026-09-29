/** Проверки освобождения памяти: отдельный процесс с прежними параметрами браузера. */
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/harness';

// launchOptions задаётся на процесс: переопределение отделяет проверки памяти,
// сохраняя параметры движка, устройства и диагностику. История других сценариев
// не должна влиять на проверку освобождения ресурсов сохранённого controls.
test.use({
  launchOptions: async ({ launchOptions }, use) => { await use(launchOptions); },
});

const nextTask = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

async function expectCollected(page: Page, hasRetainedNodes: () => boolean): Promise<void> {
  // requestGC запрашивает сборку, но не гарантирует её завершение. Проверяем
  // освобождение в прежнем таймауте, а не произвольное число попыток сборщика.
  await expect.poll(async () => {
    await page.evaluate(nextTask);
    await page.requestGC();
    return page.evaluate(hasRetainedNodes);
  }).toBe(false);
}

test('retained controls после disconnect не удерживают parent', async ({ page }) => {
  await page.evaluate(async () => {
    const { autoAnimate } = await import('/dist/auto/index.js');
    let parent: HTMLDivElement | undefined = document.createElement('div');
    let child: HTMLDivElement | undefined = document.createElement('div');
    parent.appendChild(child);
    document.body.appendChild(parent);
    const controls = autoAnimate(parent as never);
    child.remove();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const weakParent = new WeakRef(parent);
    const weakChild = new WeakRef(child);
    controls.disconnect();
    parent.remove();
    parent = undefined;
    child = undefined;
    const retained = window as unknown as {
      __autoControls: typeof controls;
      __autoParent: WeakRef<HTMLDivElement>;
      __autoChild: WeakRef<HTMLDivElement>;
    };
    retained.__autoControls = controls;
    retained.__autoParent = weakParent;
    retained.__autoChild = weakChild;
  });

  await expectCollected(page, () => {
    const retained = window as unknown as {
      __autoParent: WeakRef<HTMLDivElement>;
      __autoChild: WeakRef<HTMLDivElement>;
    };
    return retained.__autoParent.deref() !== undefined ||
      retained.__autoChild.deref() !== undefined;
  });
});

test('reentrant disconnect в snapshot не публикует stale strong-cache', async ({ page }) => {
  await page.evaluate(async () => {
    const { autoAnimate } = await import('/dist/auto/index.js');
    let parent: HTMLDivElement | undefined = document.createElement('div');
    let child: HTMLDivElement | undefined = document.createElement('div');
    let trigger: HTMLDivElement | undefined = document.createElement('div');
    parent.appendChild(child);
    document.body.appendChild(parent);
    const controls = autoAnimate(parent as never);
    const rect = child.getBoundingClientRect.bind(child);
    child.getBoundingClientRect = () => {
      controls.disconnect();
      return rect();
    };
    parent.appendChild(trigger);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const weakParent = new WeakRef(parent);
    const weakChild = new WeakRef(child);
    const weakTrigger = new WeakRef(trigger);
    parent.remove();
    parent = undefined;
    child = undefined;
    trigger = undefined;
    const retained = window as unknown as {
      __staleControls: typeof controls;
      __staleParent: WeakRef<HTMLDivElement>;
      __staleChild: WeakRef<HTMLDivElement>;
      __staleTrigger: WeakRef<HTMLDivElement>;
    };
    retained.__staleControls = controls;
    retained.__staleParent = weakParent;
    retained.__staleChild = weakChild;
    retained.__staleTrigger = weakTrigger;
  });

  await expectCollected(page, () => {
    const retained = window as unknown as {
      __staleParent: WeakRef<HTMLDivElement>;
      __staleChild: WeakRef<HTMLDivElement>;
      __staleTrigger: WeakRef<HTMLDivElement>;
    };
    return retained.__staleParent.deref() !== undefined ||
      retained.__staleChild.deref() !== undefined ||
      retained.__staleTrigger.deref() !== undefined;
  });
});
