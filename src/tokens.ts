export interface RGBA {
  r: number;
  g: number;
  b: number;
  a: number;
}

export function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  h /= 360;
  s /= 100;
  l /= 100;
  let r, g, b;
  if (s === 0) {
    r = g = b = l;
  } else {
    const hue2rgb = (p: number, q: number, t: number) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1 / 3);
  }
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

export function parseColor(color: string): RGBA | null {
  const trimmed = color.trim().toLowerCase();

  if (trimmed.startsWith('#')) {
    const hex = trimmed.substring(1);
    if (hex.length === 3 || hex.length === 4) {
      const r = parseInt(hex[0] + hex[0], 16);
      const g = parseInt(hex[1] + hex[1], 16);
      const b = parseInt(hex[2] + hex[2], 16);
      const a = hex.length === 4 ? parseInt(hex[3] + hex[3], 16) / 255 : 1;
      return { r, g, b, a };
    }
    if (hex.length === 6 || hex.length === 8) {
      const r = parseInt(hex.substring(0, 2), 16);
      const g = parseInt(hex.substring(2, 4), 16);
      const b = parseInt(hex.substring(4, 6), 16);
      const a = hex.length === 8 ? parseInt(hex.substring(6, 8), 16) / 255 : 1;
      return { r, g, b, a };
    }
    return null;
  }

  const rgbMatch = trimmed.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/);
  if (rgbMatch) {
    return {
      r: parseInt(rgbMatch[1], 10),
      g: parseInt(rgbMatch[2], 10),
      b: parseInt(rgbMatch[3], 10),
      a: rgbMatch[4] !== undefined ? parseFloat(rgbMatch[4]) : 1,
    };
  }

  const hslMatch = trimmed.match(/^hsla?\(\s*(\d+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*(?:,\s*([\d.]+)\s*)?\)$/);
  if (hslMatch) {
    const h = parseInt(hslMatch[1], 10);
    const s = parseFloat(hslMatch[2]);
    const l = parseFloat(hslMatch[3]);
    const a = hslMatch[4] !== undefined ? parseFloat(hslMatch[4]) : 1;
    const [r, g, b] = hslToRgb(h, s, l);
    return { r, g, b, a };
  }

  const presetColors: Record<string, string> = {
    transparent: 'rgba(0,0,0,0)',
    black: '#000000',
    white: '#ffffff',
    red: '#ff0000',
    green: '#00ff00',
    blue: '#0000ff',
  };
  if (trimmed in presetColors) {
    return parseColor(presetColors[trimmed]);
  }

  return null;
}

export function interpolateColor(fromColor: RGBA, toColor: RGBA, t: number): string {
  const r = Math.round(fromColor.r + (toColor.r - fromColor.r) * t);
  const g = Math.round(fromColor.g + (toColor.g - fromColor.g) * t);
  const b = Math.round(fromColor.b + (toColor.b - fromColor.b) * t);
  const a = fromColor.a + (toColor.a - fromColor.a) * t;
  const clampedR = Math.max(0, Math.min(255, r));
  const clampedG = Math.max(0, Math.min(255, g));
  const clampedB = Math.max(0, Math.min(255, b));
  const clampedA = Math.max(0, Math.min(1, a));
  return `rgba(${clampedR}, ${clampedG}, ${clampedB}, ${clampedA.toFixed(3)})`;
}

export function resolveToken(
  token: string | number,
  target?: Element,
  customTokens?: Record<string, string | number>,
): string | number {
  if (typeof token !== 'string') return token;

  const trimmed = token.trim();

  if (customTokens && trimmed in customTokens) {
    return customTokens[trimmed];
  }

  if (trimmed.startsWith('var(') && trimmed.endsWith(')')) {
    const varName = trimmed.substring(4, trimmed.length - 1).trim();
    if (typeof window !== 'undefined' && target) {
      const val = window.getComputedStyle(target).getPropertyValue(varName).trim();
      if (val) return val;
    }
  }

  return token;
}
