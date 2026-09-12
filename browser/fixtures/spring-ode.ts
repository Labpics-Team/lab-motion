type SpringCoefficients = {
  readonly mass: number;
  readonly stiffness: number;
  readonly damping: number;
};

/**
 * Численный тестовый оракул исходного ОДУ, без runtime-солвера и его ветвлений.
 * x(0)=0, x′(0)=v0; время в секундах, скорость нормализована по амплитуде.
 * Конечный диапазон ограничивает жёсткость задачи и число шагов RK4.
 */
export function integrateSpringPositions(
  spring: SpringCoefficients,
  v0: number,
  times: readonly number[],
  maxStep = 1 / 4096,
): number[] {
  const { mass, stiffness, damping } = spring;
  const inRange = (value: number, min: number, max: number) =>
    Number.isFinite(value) && value >= min && value <= max;
  if (
    !inRange(mass, 0.25, 4) || !inRange(stiffness, 1, 256) ||
    !inRange(damping, 0, 32) || !inRange(v0, -12, 12) ||
    !inRange(maxStep, 1 / 16384, 1 / 1024) ||
    times.length === 0 || times.length > 16_385
  ) throw new Error('spring ODE oracle: вход вне конечного диапазона');
  for (let index = 0; index < times.length; index++) {
    if (!inRange(times[index]!, 0, 16) || times[index]! < (times[index - 1] ?? 0)) {
      throw new Error('spring ODE oracle: времена должны возрастать в [0, 16]');
    }
  }

  const acceleration = (position: number, velocity: number) =>
    (stiffness * (1 - position) - damping * velocity) / mass;
  const positions: number[] = [];
  let position = 0;
  let velocity = v0;
  let previousTime = 0;
  for (const time of times) {
    const duration = time - previousTime;
    const steps = Math.ceil(duration / maxStep);
    const step = steps === 0 ? 0 : duration / steps;
    for (let index = 0; index < steps; index++) {
      const dx1 = velocity;
      const dv1 = acceleration(position, velocity);
      const dx2 = velocity + dv1 * step / 2;
      const dv2 = acceleration(position + dx1 * step / 2, dx2);
      const dx3 = velocity + dv2 * step / 2;
      const dv3 = acceleration(position + dx2 * step / 2, dx3);
      const dx4 = velocity + dv3 * step;
      const dv4 = acceleration(position + dx3 * step, dx4);
      position += step * (dx1 + 2 * dx2 + 2 * dx3 + dx4) / 6;
      velocity += step * (dv1 + 2 * dv2 + 2 * dv3 + dv4) / 6;
    }
    positions.push(position);
    previousTime = time;
  }
  return positions;
}
