import { clampFinite } from '../value/units.js';

/** Координаты и порядок композиции принадлежат CSS-поверхности. */
export const TRANSFORM_AXES = {
  x: 0, y: 0, rotate: 0, skewX: 0, skewY: 0, scaleX: 1, scaleY: 1,
} as const;

/** 0: translate/scale/rotate/skew; 1: translate/rotate/skew/scale. */
export type TransformOrder = 0 | 1;

/** Набор axes удерживает топологию нативных кадров, включая полные обороты. */
export function composeTransform(state: Readonly<Partial<Record<keyof typeof TRANSFORM_AXES | 'scale', number>>>, order: TransformOrder = 0, axes = 0, sanitize = false): string {
  const x = finite(state.x ?? 0, sanitize), y = finite(state.y ?? 0, sanitize);
  let sx: number, sy: number;
  if (state.scale !== undefined) sx = sy = finite(state.scale, sanitize);
  else { sx = finite(state.scaleX ?? 1, sanitize); sy = finite(state.scaleY ?? 1, sanitize); }
  const rotate = finite(state.rotate ?? 0, sanitize), skewX = finite(state.skewX ?? 0, sanitize), skewY = finite(state.skewY ?? 0, sanitize);
  let translate = '', scale = '', rotation = '', skew = '';
  if (axes & 1) translate = ` translate(${x}px,${y}px)`;
  else if (x !== 0 || y !== 0) translate = x === 0 ? ` translateY(${y}px)`
    : y === 0 ? ` translateX(${x}px)` : ` translate(${x}px, ${y}px)`;
  if (axes & 2) scale = ` scale(${sx},${sy})`;
  else if (sx !== 1 || sy !== 1) scale = sx === sy ? ` scale(${sx})`
    : ` scaleX(${sx})` + (sy === 1 ? '' : ` scaleY(${sy})`);
  if (axes & 4 || rotate !== 0) rotation = ` rotate(${rotate}deg)`;
  if (axes & 8) skew = ` skew(${skewX}deg,${skewY}deg)`;
  else if (skewX !== 0 || skewY !== 0) skew = skewX === 0 ? ` skewY(${skewY}deg)`
    : skewY === 0 ? ` skewX(${skewX}deg)` : ` skew(${skewX}deg, ${skewY}deg)`;
  const result = translate + (order === 0 ? scale + rotation + skew : rotation + skew + scale);
  return result ? result.slice(1) : 'none';
}

function finite(value: number, sanitize: boolean): number { return sanitize ? clampFinite(value) : value; }
