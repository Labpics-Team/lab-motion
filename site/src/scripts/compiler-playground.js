import { play as playCompilerRecipe } from 'virtual:lab-motion-compiler-playground';

let disposeActivePlayground = () => {};

export function installCompilerPlayground() {
  disposeActivePlayground();

  const target = document.querySelector('[data-preview="compiler-object"]');
  const button = document.querySelector('[data-action="run-compiler-recipe"]');
  const status = document.querySelector('[data-compiler-status]');
  if (!target || !button || !status) return () => {};

  let controls;
  let disposed = false;

  const setState = (state) => {
    if (disposed) return;
    status.dataset.kind = state;
    status.textContent = state;
  };

  const stop = () => {
    const current = controls;
    controls = undefined;
    current?.cancel();
  };

  const reduced = () => document.documentElement.dataset.motion === 'reduced';

  const reset = () => {
    stop();
    target.style.removeProperty('opacity');
    setState('ready');
  };

  const run = () => {
    if (disposed || document.hidden) return;
    reset();

    if (reduced()) {
      target.style.opacity = '0.5';
      setState('reduced');
      return;
    }

    const current = playCompilerRecipe(target);
    controls = current;
    setState('running');
    void current.finished.then(
      () => {
        if (disposed || controls !== current) return;
        controls = undefined;
        setState('complete');
      },
      () => {
        if (disposed || controls !== current) return;
        controls = undefined;
        setState('ready');
      },
    );
  };

  const onMotionPolicyChange = () => {
    if (reduced()) {
      stop();
      target.style.opacity = '0.5';
      setState('reduced');
    } else if (status.dataset.kind === 'reduced') {
      reset();
    }
  };
  const motionObserver = new MutationObserver(onMotionPolicyChange);
  motionObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-motion'],
  });

  const onVisibilityChange = () => {
    if (document.hidden) stop();
    else if (status.dataset.kind === 'running') reset();
  };
  button.addEventListener('click', run);
  document.addEventListener('visibilitychange', onVisibilityChange);

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    stop();
    motionObserver.disconnect();
    button.removeEventListener('click', run);
    document.removeEventListener('visibilitychange', onVisibilityChange);
    if (disposeActivePlayground === dispose) disposeActivePlayground = () => {};
  };
  disposeActivePlayground = dispose;

  onMotionPolicyChange();
  return dispose;
}
