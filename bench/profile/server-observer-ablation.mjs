// Диагностическое плечо H1 не используется для квалификации.
// Три прохода сохраняют порядок DOM-чтений и исключений прежнего наблюдателя.
const seed = 0x4f425331;
let state = seed;
const first = ['left', 'left', 'left', 'left', 'right', 'right', 'right', 'right'];
for (let index = first.length - 1; index > 0; index--) {
  state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
  const other = (state >>> 0) % (index + 1);
  [first[index], first[other]] = [first[other], first[index]];
}
export const OBSERVER_ABLATION = Object.freeze({
  id: 'observer-allocation-ablation-1', qualification: false, seed,
  pairs: 8, scenes: ['s2', 's3'], orders: first.map(arm => [arm, arm === 'left' ? 'right' : 'left']),
  arms: { left: 'H0', right: 'H1' },
  estimand: 'Парное среднее cancelMs в свежем контексте исполнения по всем 8 повторам после 1 прогрева; наблюдатель после отмены может влиять только на последующую кучу/состояние',
  retry: false, tracing: false,
});
