// Контроль инструмента: голый Element.animate (WAAPI, compositor-eligible).
// Это НЕ библиотека — платформа Chromium. Если ЭТОТ ряд не даёт кадров в окне
// фриза main-thread, значит скринкаст не видит компоситорные кадры и нули S5
// у библиотек — артефакт инструмента, а не их поведение. Если даёт — нули настоящие.
export const name = 'WAAPI (платформа, контроль)';

function norm(anims) {
  return {
    cancel() {
      for (const a of anims) {
        try { a.cancel(); } catch { /* уже отменена */ }
      }
    },
  };
}

export function start(els, px, durMs) {
  return norm(els.map((el) =>
    el.animate(
      [{ transform: 'translateX(0px)' }, { transform: `translateX(${px}px)` }],
      { duration: durMs, easing: 'linear', fill: 'forwards' },
    ),
  ));
}

export function startStagger(els, px, durMs, gapMs) {
  return norm(els.map((el, i) =>
    el.animate(
      [{ transform: 'translateX(0px)' }, { transform: `translateX(${px}px)` }],
      { duration: durMs, delay: i * gapMs, easing: 'linear', fill: 'both' },
    ),
  ));
}
