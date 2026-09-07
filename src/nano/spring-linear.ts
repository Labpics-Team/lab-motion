/**
 * nano/spring-linear.ts — SSOT дефолт-пружины nano: замкнутая форма →
 * длительность и CSS linear()-строка. Общий шов для runtime ./nano и
 * build-time compiler-lowering (#208): компилятор потребляет ровно тот же
 * канонический артефакт, что уходит браузеру, поэтому обе стороны совпадают
 * бит-в-бит по построению. Тело функции — канонический nano-код: любое
 * изменение здесь меняет и runtime, и compiled поведение сразу.
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
  // Сначала нормализуем ОДУ по mass: `2*m` само переполняется при конечных
  // scale-equivalent m/k/c и не должно менять физику той же системы.
  const a = c / m / 2;
  const d = Math.sqrt(Math.abs(w * w - a * a));
  const critical = d <= w * Math.sqrt(Number.EPSILON);
  const under = a < w && !critical;
  const slow = under ? 0 : critical ? w : w * w / (a + d);
  const fast = under || critical ? 0 : -a - d;
  const sample = under
    ? (t: number) => 1 - Math.exp(-a * t)
      * (Math.cos(d * t) + a / d * Math.sin(d * t))
    : critical
      ? (t: number) => 1 - Math.exp(-w * t) * (1 + w * t)
      : (t: number) => 1
        - (fast * Math.exp(-slow * t) + slow * Math.exp(fast * t)) / (fast + slow);

  // ε=1e-3 — тот же физический settle-допуск, что у runtime пакета. Для
  // осцилляций длительность выводится из строгих огибающих позиции и скорости;
  // монотонные режимы ищутся в безразмерном времени медленного полюса.
  const epsilon = 1e-3;
  let duration = under
    ? Math.max(
        Math.log(w / d / epsilon) / a,
        Math.log(w * w / d / (30 * epsilon)) / a,
      )
    : 0;
  if (!under) {
    const step = 1 / (30 * slow);
    let gap = 0;
    let speed = 0;
    do {
      duration += step;
      if (critical) {
        const e = Math.exp(-w * duration);
        // Порядок операций у position-gap совпадает с прежним 1-sample(t).
        gap = 1 - (1 - e * (1 + w * duration));
        speed = e * w * w * duration;
      } else {
        const es = Math.exp(-slow * duration);
        const ef = Math.exp(fast * duration);
        gap = 1 - (1 - (fast * es + slow * ef) / (fast + slow));
        speed = w * w / (-fast - slow) * (es - ef);
      }
    } while (gap > epsilon || speed / 30 > epsilon);
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
