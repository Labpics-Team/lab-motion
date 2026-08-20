import { animate } from '@labpics/motion/animate';

const spring = { mass: 1, stiffness: 170, damping: 26 };
const reducedMotionQuery = '(prefers-reduced-motion: reduce)';
let disposeActiveShowcase = () => {};

export function installShowcase() {
  disposeActiveShowcase();

  let disposed = false;
  let forcedReduced = false;
  let heroControls;
  let heroTimer;
  let lastReduced;
  let springControls;
  let staggerControls;
  let retargetControls;
  let retargetTimer;
  let heroVisible = true;
  let heroObserver;
  const cleanups = [];
  const motionQuery = typeof window.matchMedia === 'function'
    ? window.matchMedia(reducedMotionQuery)
    : undefined;

  const listen = (target, type, handler) => {
    target.addEventListener(type, handler);
    cleanups.push(() => target.removeEventListener(type, handler));
  };

  const systemReduced = () => forcedReduced || motionQuery?.matches === true;

  const options = (extra = {}) => ({
    spring,
    ...extra,
    matchMedia: () => ({ matches: systemReduced() }),
  });

  const cardState = (name, state) => {
    if (disposed) return;
    const label = document.querySelector(`[data-card="${name}"] [data-state]`);
    if (!label) return;
    label.dataset.kind = state;
    label.textContent = state;
  };

  const whenFinished = (controls, name, current) => {
    void controls.finished.then(() => {
      if (!disposed && current() === controls) cardState(name, systemReduced() ? 'reduced' : 'complete');
    });
  };

  const stopHero = () => {
    if (heroTimer !== undefined) window.clearTimeout(heroTimer);
    heroTimer = undefined;
    const controls = heroControls;
    heroControls = undefined;
    controls?.cancel();
  };

  const stopSpring = () => {
    const controls = springControls;
    springControls = undefined;
    controls?.cancel();
  };

  const stopStagger = () => {
    const controls = staggerControls;
    staggerControls = undefined;
    controls?.cancel();
  };

  const stopRetarget = () => {
    if (retargetTimer !== undefined) window.clearTimeout(retargetTimer);
    retargetTimer = undefined;
    const controls = retargetControls;
    retargetControls = undefined;
    controls?.cancel();
  };

  const stopPreviews = () => {
    stopHero();
    stopSpring();
    stopStagger();
    stopRetarget();
  };

  const replayHero = () => {
    const orb = document.querySelector('[data-preview="hero-orb"]');
    if (disposed || document.hidden || !heroVisible || !orb) return;
    stopHero();
    const controls = animate(orb, { x: [0, 34], y: [0, -18], rotate: [0, 8], scale: [.96, 1] }, options());
    heroControls = controls;
    if (!systemReduced()) {
      void controls.finished.then(() => {
        if (disposed || document.hidden || !heroVisible || heroControls !== controls || systemReduced()) return;
        heroTimer = window.setTimeout(() => {
          heroTimer = undefined;
          if (!disposed && !document.hidden && heroVisible && heroControls === controls && !systemReduced()) replayHero();
        }, 700);
      });
    }
  };

  const replaySpring = () => {
    const object = document.querySelector('[data-preview="spring-object"]');
    if (disposed || document.hidden || !object) return;
    stopSpring();
    const controls = animate(object, { x: [-112, 112], rotate: [-5, 5], scale: [.92, 1] }, options());
    springControls = controls;
    cardState('spring', systemReduced() ? 'reduced' : 'running');
    whenFinished(controls, 'spring', () => springControls);
  };

  const replayStagger = () => {
    const items = document.querySelectorAll('[data-stagger-item]');
    if (disposed || document.hidden || items.length === 0) return;
    stopStagger();
    const controls = animate(items, { y: [26, 0], scale: [.72, 1], opacity: [0.2, 1] }, options({ stagger: 44 }));
    staggerControls = controls;
    cardState('stagger', systemReduced() ? 'reduced' : 'running');
    whenFinished(controls, 'stagger', () => staggerControls);
  };

  const resetRetarget = () => {
    stopRetarget();
    const object = document.querySelector('[data-preview="retarget-object"]');
    const copy = document.querySelector('[data-retarget-copy]');
    if (object) object.style.transform = 'translateX(-112px)';
    if (copy) copy.textContent = 'Start a transition, then redirect it without a teleport.';
    cardState('retarget', 'ready');
  };

  const startRetarget = () => {
    const object = document.querySelector('[data-preview="retarget-object"]');
    const copy = document.querySelector('[data-retarget-copy]');
    if (disposed || document.hidden || !object) return;
    resetRetarget();
    const controls = animate(object, { x: [-112, 112] }, options());
    retargetControls = controls;
    cardState('retarget', systemReduced() ? 'reduced' : 'running');
    if (copy) copy.textContent = systemReduced() ? 'Reduced motion: the target snaps by policy.' : 'Target A is moving. Redirecting to Target B…';
    if (!systemReduced()) {
      retargetTimer = window.setTimeout(() => {
        if (disposed || document.hidden || retargetControls !== controls) return;
        const redirected = animate(object, { x: -34, scale: [.88, 1] }, options());
        retargetControls = redirected;
        if (copy) copy.textContent = 'Retargeted mid-flight. Position and velocity continue together.';
        cardState('retarget', 'running');
        whenFinished(redirected, 'retarget', () => retargetControls);
      }, 260);
    }
  };

  const replayPreviews = () => {
    resetRetarget();
    if (disposed || document.hidden) {
      stopPreviews();
      return;
    }
    replayHero();
    replaySpring();
    replayStagger();
  };

  const toggle = document.querySelector('[data-action="toggle-motion"]');
  const siteStatus = document.querySelector('[data-site-status]');
  const syncMotionUi = () => {
    const systemManaged = motionQuery?.matches === true;
    const reduced = systemManaged || forcedReduced;
    const changed = lastReduced !== undefined && lastReduced !== reduced;
    lastReduced = reduced;
    document.documentElement.dataset.motion = reduced ? 'reduced' : 'full';
    if (toggle) {
      toggle.disabled = systemManaged;
      toggle.setAttribute('aria-disabled', String(systemManaged));
      toggle.setAttribute('aria-pressed', String(reduced));
      toggle.textContent = systemManaged
        ? 'System setting: reduced motion'
        : forcedReduced
          ? 'Use full motion'
          : 'Reduce motion';
    }
    if (siteStatus) {
      siteStatus.textContent = systemManaged
        ? 'Your system reduced-motion preference is active; the preview follows it.'
        : forcedReduced
        ? 'Reduced motion preview is on. New previews resolve without animated travel.'
        : 'Animations are live. Use the control above to preview reduced motion.';
    }
    return changed;
  };

  syncMotionUi();
  if (toggle) {
    listen(toggle, 'click', () => {
      if (motionQuery?.matches === true) return;
      forcedReduced = !forcedReduced;
      syncMotionUi();
      replayPreviews();
    });
  }

  const onSystemChange = () => {
    if (syncMotionUi()) replayPreviews();
  };
  if (typeof motionQuery?.addEventListener === 'function') {
    motionQuery.addEventListener('change', onSystemChange);
    cleanups.push(() => motionQuery.removeEventListener('change', onSystemChange));
  } else if (motionQuery?.addListener) {
    motionQuery.addListener(onSystemChange);
    cleanups.push(() => motionQuery.removeListener?.(onSystemChange));
  }

  const copyButton = document.querySelector('[data-copy]');
  const copySource = document.querySelector('[data-copy-source]');
  const copyStatus = document.querySelector('[data-copy-status]');
  if (copyButton) {
    listen(copyButton, 'click', async () => {
      const text = copySource?.textContent?.trim();
      if (!text || !copyStatus) return;
      try {
        await navigator.clipboard.writeText(text);
        if (!disposed) copyStatus.textContent = 'Copied to clipboard.';
      } catch {
        if (!disposed) copyStatus.textContent = 'Clipboard access is unavailable in this context.';
      }
    });
  }

  const action = (name, handler) => {
    const element = document.querySelector(`[data-action="${name}"]`);
    if (element) listen(element, 'click', handler);
  };
  action('replay-spring', replaySpring);
  action('replay-stagger', replayStagger);
  action('retarget', startRetarget);
  action('reset-retarget', resetRetarget);

  listen(document, 'visibilitychange', () => {
    if (document.hidden) stopPreviews();
    else replayPreviews();
  });
  listen(window, 'pagehide', stopPreviews);
  listen(window, 'pageshow', () => {
    if (!document.hidden) replayPreviews();
  });

  const hero = document.querySelector('[data-preview="hero-orb"]')?.closest('.hero-stage');
  if (hero && typeof IntersectionObserver === 'function') {
    heroObserver = new IntersectionObserver(([entry]) => {
      const visible = entry?.isIntersecting === true;
      if (heroVisible === visible || disposed) return;
      heroVisible = visible;
      if (visible) replayHero();
      else stopHero();
    }, { threshold: 0.01 });
    heroObserver.observe(hero);
    cleanups.push(() => heroObserver?.disconnect());
  }

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    stopPreviews();
    heroObserver?.disconnect();
    while (cleanups.length > 0) cleanups.pop()();
    if (disposeActiveShowcase === dispose) disposeActiveShowcase = () => {};
  };
  disposeActiveShowcase = dispose;

  replayPreviews();
  return dispose;
}
