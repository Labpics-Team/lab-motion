/**
 * nano/spring-linear.ts — SSOT дефолт-пружины nano: замкнутая форма →
 * длительность и CSS linear()-строка. Общий шов для runtime ./nano и
 * build-time compiler-lowering (#208): компилятор потребляет ровно тот же
 * канонический артефакт, что уходит браузеру, поэтому обе стороны совпадают
 * бит-в-бит по построению. Любое изменение здесь меняет и runtime, и compiled
 * поведение сразу.
 */

import { BASE_GRID_MAX } from '../compositor/segmenter.js';

export interface NanoSpring {
  readonly mass: number;
  readonly stiffness: number;
  readonly damping: number;
}

export function springLinear(input?: NanoSpring): [number, string] {
  const k = input?.stiffness ?? 170;
  const c = input?.damping ?? 26;
  const m = input?.mass ?? 1;
  if (!(k > 0 && c > 0 && m > 0)
    || !Number.isFinite(k) || !Number.isFinite(c) || !Number.isFinite(m)) {
    throw new RangeError('spring parameters must be finite and positive');
  }
  const w = Math.sqrt(k / m);
  // Кэшируем именно округлённое binary64 ω², а не k/m: после sqrt квадрат
  // может отличаться на ULP, а весь старый контракт повторно использовал w*w.
  const q = w * w;
  // Сначала нормализуем ОДУ по mass: `2*m` само переполняется при конечных
  // scale-equivalent m/k/c и не должно менять физику той же системы.
  const a = c / m / 2;
  const d = Math.sqrt(Math.abs(q - a * a));
  // Number.EPSILON = 2^-52 в binary64, поэтому его положительный корень
  // представим точно как 2^-26 и не требует отдельного Math.sqrt на вызов.
  const critical = d <= w * 2 ** -26;
  const under = a < w && !critical;
  const slow = under ? 0 : critical ? w : q / (a + d);
  const fast = under || critical ? 0 : -a - d;
  const sample = under
    ? (t: number) => 1 - Math.exp(-a * t)
      * (Math.cos(d * t) + a / d * Math.sin(d * t))
    : critical
      ? (t: number) => 1 - Math.exp(-w * t) * (1 + w * t)
      : (t: number) => 1
        - (fast * Math.exp(-slow * t) + slow * Math.exp(fast * t)) / (fast + slow);
  const velocity = under
    ? (t: number) => Math.exp(-a * t) * q / d * Math.sin(d * t)
    : critical
      ? (t: number) => Math.exp(-w * t) * q * t
      : (t: number) => q / (-fast - slow)
        * (Math.exp(-slow * t) - Math.exp(fast * t));

  // ε=1e-3 — тот же физический settle-допуск, что у runtime пакета. Для
  // осцилляций длительность выводится из строгих огибающих позиции и скорости;
  // монотонные режимы ищутся в безразмерном времени медленного полюса.
  const epsilon = 1e-3;
  let duration = under
    ? Math.log(Math.max(
        w / d / epsilon,
        q / d / (30 * epsilon),
      )) / a
    : 0;
  if (!under) {
    const step = 1 / (30 * slow);
    do duration += step;
    while (1 - sample(duration) > epsilon || velocity(duration) / 30 > epsilon);
  }
  if (!Number.isFinite(duration)) throw new RangeError('spring is not representable');

  // Для линейной интерполяции ошибка сегмента <= max|x''|*h^2/8. У пассивной
  // step-response max|x''|=ω², поэтому число узлов выводится из ε, не из Hz/cap.
  const count = Math.ceil(duration * w / Math.sqrt(8 * epsilon));
  // Тот же физический потолок, что у полного compositor-компилятора: выше
  // синхронной CSS-строки живой solver дешевле и не блокирует event loop.
  if (!(count <= BASE_GRID_MAX)) throw new RangeError('spring is not representable');
  const points: number[] = [];
  for (let index = 0; index <= count; index++) {
    points.push(Math.round(sample(duration * index / count) * 1e4) / 1e4);
  }
  points[count] = 1;
  return [duration * 1000, `linear(${points})`];
}
