/**
 * test/color-mutation-harden.test.ts — S41: закалка mutation-покрытия value/color.ts.
 *
 * Baseline Stryker: color.ts = 73.77% (78 выживших — макс из core-модулей).
 * color — чистый parse/interpolate (hex/rgb/hsl, HSL↔RGB, смешение) → оракулы
 * ПРЯМЫЕ: known-value (канонические цвета W3C) + EXACT-STRING на выводе интерполяции
 * (точная строка убивает unary-`+`/toFixed/channel-арифметику одним сравнением).
 * Все ожидаемые значения ЗАЗЕМЛЕНЫ прогоном здорового кода (probe).
 *
 * Закрываемые КЛАССЫ:
 *   C1-4 hex-парсинг (#rgb/#rgba/#rrggbb/#rrggbbaa: doubling, parseInt base16, /255, trim)
 *   C5-7 rgb/hsl-парсинг + clamp255/clamp01/parseHue/parsePct
 *   C8-10 interpolate progress (t<=0/>=1/NaN/∞) + hsl-vs-rgb путь
 *   C11-13 interpolate каналов (exact-string) + alpha + hue-wraparound
 *   C14 hslToRgb канонические цвета (hueToRgb ветки, q/p, s===0)
 *   C15 rgbToHsl канонические (hue-ветки max===rn/gn/bn, s-формула l>0.5, gray max===min)
 *   C16 mixColor (t<0.5?from:to, невалид-фоллбек)
 *
 * Остаток (regex-мутации, границы `<`↔`<=`) — в блоке эквивалентов внизу.
 */

import { describe, expect, it } from 'vitest';
import {
  parseColor,
  interpolateColor,
  mixColor,
  hslToRgb,
  rgbToHsl,
  type ParsedColor,
} from '../src/value/color.js';

/** Парсит и утверждает, что не null. */
function pc(s: string): ParsedColor {
  const c = parseColor(s);
  expect(c).not.toBeNull();
  return c as ParsedColor;
}

// ─── C1-C4 — hex-парсинг (строки 76-113, 80-91 arith, 46-49 regex) ──────────────

describe('C1-4 hex-парсинг: doubling, parseInt base16, alpha/255, trim', () => {
  it('#abc → shorthand doubling: r=0xaa=170, g=0xbb=187, b=0xcc=204, a=1', () => {
    const c = pc('#abc');
    expect(c.format).toBe('hex');
    expect(c.r).toBe(170); // 0xaa — doubling h[1]+h[1]
    expect(c.g).toBe(187); // 0xbb
    expect(c.b).toBe(204); // 0xcc
    expect(c.a).toBe(1);
  });
  it('#abcd → все каналы doubling + alpha: {170,187,204} a=0xdd/255', () => {
    const c = pc('#abcd');
    expect([c.r, c.g, c.b]).toEqual([170, 187, 204]); // все три канала (не только r)
    expect(c.a).toBeCloseTo(221 / 255, 10); // 0xdd=221, /255
  });
  it('#aabbcc → полный hex: 170,187,204', () => {
    const c = pc('#aabbcc');
    expect([c.r, c.g, c.b, c.a]).toEqual([170, 187, 204, 1]);
  });
  it('#aabbccdd → полный hex + alpha 0.8667', () => {
    const c = pc('#aabbccdd');
    expect([c.r, c.g, c.b]).toEqual([170, 187, 204]);
    expect(c.a).toBeCloseTo(221 / 255, 10);
  });
  it('trim: "  #fff  " распознаётся (без trim → null)', () => {
    const c = pc('  #fff  ');
    expect([c.r, c.g, c.b]).toEqual([255, 255, 255]);
  });
  it('нераспознанный формат → null', () => {
    expect(parseColor('notacolor')).toBeNull();
    expect(parseColor('#gggggg')).toBeNull();
  });
  it('case-insensitivity: UPPERCASE hex/rgb/hsl распознаются (флаг `i` регексов)', () => {
    // CSS-цвета регистронезависимы. Мутант, снявший флаг `i` у HEX/RGB/HSL_RE,
    // не распознал бы uppercase → null. Нота QA-ревью: тесты покрывали лишь HEX6.
    expect(parseColor('#FFF')).toEqual(parseColor('#fff'));
    expect(parseColor('#FFFF')).toEqual(parseColor('#ffff'));
    expect(parseColor('#AABBCC')).toEqual(parseColor('#aabbcc'));
    expect(parseColor('#FF000080')).toEqual(parseColor('#ff000080'));
    expect(parseColor('RGB(10, 20, 30)')).not.toBeNull(); // uppercase RGB → флаг i
    expect(parseColor('HSL(120, 50%, 50%)')).not.toBeNull(); // uppercase HSL → флаг i
  });
});

// ─── C5-C7 — rgb/hsl-парсинг + clamp (118-135, 287-311) ─────────────────────────

describe('C5-7 rgb/hsl-парсинг + clamp255/clamp01/parseHue/parsePct', () => {
  it('rgb(10,20,30) → {10,20,30,1} format=rgb', () => {
    const c = pc('rgb(10, 20, 30)');
    expect([c.r, c.g, c.b, c.a]).toEqual([10, 20, 30, 1]);
    expect(c.format).toBe('rgb');
  });
  it('rgba(10,20,30,0.5) → a=0.5', () => {
    expect(pc('rgba(10, 20, 30, 0.5)').a).toBe(0.5);
  });
  it('rgb(300,20,30) → r клампится в 255 (clamp255 верхняя граница)', () => {
    expect(pc('rgb(300, 20, 30)').r).toBe(255);
  });
  it('hsl(120,50%,50%) → hsl{h120,s0.5,l0.5}, r/g/b из hslToRgb', () => {
    const c = pc('hsl(120, 50%, 50%)');
    expect(c.format).toBe('hsl');
    expect(c.hsl).toEqual({ h: 120, s: 0.5, l: 0.5 }); // parseHue, parsePct
    expect(c.r).toBeCloseTo(63.75, 4);
    expect(c.g).toBeCloseTo(191.25, 4);
    expect(c.b).toBeCloseTo(63.75, 4);
  });
});

// ─── C8-C10 — interpolate progress + hsl-vs-rgb путь (154-164) ──────────────────

describe('C8-10 interpolate: progress-клампинг + путь hsl/rgb (156,158,160)', () => {
  const black = pc('#000');
  const white = pc('#fff');
  it('progress: t=0→from, t=1→to, t=0.5→середина (156)', () => {
    expect(interpolateColor(black, white, 0)).toBe('rgb(0, 0, 0)');
    expect(interpolateColor(black, white, 1)).toBe('rgb(255, 255, 255)');
    expect(interpolateColor(black, white, 0.5)).toBe('rgb(128, 128, 128)');
  });
  it('нефинитный t: NaN→0 (from), +∞→1 (to) (158)', () => {
    expect(interpolateColor(black, white, NaN)).toBe('rgb(0, 0, 0)');
    expect(interpolateColor(black, white, Infinity)).toBe('rgb(255, 255, 255)');
    expect(interpolateColor(black, white, -Infinity)).toBe('rgb(0, 0, 0)');
  });
  it('путь hsl только если ОБА hsl (160): hsl+hsl→hsl(...), hsl+rgb→rgb(...)', () => {
    const h1 = pc('hsl(0, 100%, 50%)');
    const h2 = pc('hsl(120, 100%, 50%)');
    expect(interpolateColor(h1, h2, 0.5)).toMatch(/^hsl\(/); // оба hsl → hsl-путь
    expect(interpolateColor(h1, white, 0.5)).toMatch(/^rgb\(/); // один не hsl → rgb-путь
  });
});

// ─── C11-C13 — interpolate каналов (exact-string) + alpha + wraparound ──────────

describe('C11-13 interpolate: каналы/alpha/hue-wraparound (179-213)', () => {
  it('alpha-интерполяция: rgba(0,0,0,0)→rgba(255,255,255,1)@.5 = rgba(128, 128, 128, 0.5)', () => {
    // EXACT-string кусает: channel-арифметику, Math.round, a>=1 (212), +a.toFixed (188).
    const c0 = pc('rgba(0, 0, 0, 0)');
    const c1 = pc('rgba(255, 255, 255, 1)');
    expect(interpolateColor(c0, c1, 0.5)).toBe('rgba(128, 128, 128, 0.5)');
  });
  it('hsl-интерполяция каналов: hsl(0)→hsl(120)@.5 = hsl(60, 100%, 50%)', () => {
    // EXACT-string кусает: hue-арифметику, s/l-каналы, unary-+ на toFixed (209/210).
    const c0 = pc('hsl(0, 100%, 50%)');
    const c1 = pc('hsl(120, 100%, 50%)');
    expect(interpolateColor(c0, c1, 0.5)).toBe('hsl(60, 100%, 50%)');
  });
  it('hue-wraparound кратчайший путь: hsl(350)→hsl(10)@.5 = hsl(0,...) (200-201)', () => {
    // dh = 10-350 = -340 → +360 = 20 → 350+20·0.5 = 360 → normalize → 0.
    // Мутант (убрать `dh<-180 += 360`): dh=-340 → 350-170 = 180 → hsl(180) ≠ hsl(0).
    const c0 = pc('hsl(350, 100%, 50%)');
    const c1 = pc('hsl(10, 100%, 50%)');
    expect(interpolateColor(c0, c1, 0.5)).toBe('hsl(0, 100%, 50%)');
  });
  it('hue-wraparound другая сторона: hsl(10)→hsl(350)@.5 = hsl(0,...) (200)', () => {
    // dh = 350-10 = 340 → -360 = -20 → 10 + (-20)·0.5 = 0 → hsl(0).
    // Мутант (убрать `dh>180 -= 360`): dh=340 → 10+170 = 180 → hsl(180) ≠ hsl(0).
    const c0 = pc('hsl(10, 100%, 50%)');
    const c1 = pc('hsl(350, 100%, 50%)');
    expect(interpolateColor(c0, c1, 0.5)).toBe('hsl(0, 100%, 50%)');
  });
});

// ─── C14 — hslToRgb канонические цвета (226-250) ────────────────────────────────

describe('C14 hslToRgb канонические (hueToRgb ветки, q/p, s===0)', () => {
  it('чистые тона: 0→красный, 120→зелёный, 240→синий, 60→жёлтый', () => {
    expect(hslToRgb(0, 1, 0.5)).toEqual({ r: 255, g: 0, b: 0 });
    expect(hslToRgb(120, 1, 0.5)).toEqual({ r: 0, g: 255, b: 0 });
    expect(hslToRgb(240, 1, 0.5)).toEqual({ r: 0, g: 0, b: 255 });
    const yellow = hslToRgb(60, 1, 0.5);
    expect(yellow.r).toBeCloseTo(255, 5);
    expect(yellow.g).toBeCloseTo(255, 5);
    expect(yellow.b).toBe(0);
  });
  it('s=0 → серый по l (short-circuit строка 227): l=0.5 → 127.5', () => {
    expect(hslToRgb(0, 0, 0.5)).toEqual({ r: 127.5, g: 127.5, b: 127.5 });
    expect(hslToRgb(200, 0, 0.5)).toEqual({ r: 127.5, g: 127.5, b: 127.5 }); // hue игнор при s=0
  });
});

// ─── C15 — rgbToHsl канонические (259-283) ──────────────────────────────────────

describe('C15 rgbToHsl канонические (hue-ветки, s-формула, gray)', () => {
  it('чистые тона → hue: красный→0, зелёный→120, синий→240, жёлтый→60', () => {
    expect(rgbToHsl(255, 0, 0)).toEqual({ h: 0, s: 1, l: 0.5 }); // max===rn ветка
    expect(rgbToHsl(0, 255, 0)).toEqual({ h: 120, s: 1, l: 0.5 }); // max===gn
    expect(rgbToHsl(0, 0, 255)).toEqual({ h: 240, s: 1, l: 0.5 }); // max===bn
    expect(rgbToHsl(255, 255, 0)).toEqual({ h: 60, s: 1, l: 0.5 });
  });
  it('серый max===min → h=0, s=0 (short-circuit строка 267)', () => {
    const g = rgbToHsl(128, 128, 128);
    expect(g.h).toBe(0);
    expect(g.s).toBe(0);
    expect(g.l).toBeCloseTo(0.502, 3);
  });
  it('gn<bn → hue +6 оборот (строка 275): красный с b>g даёт hue около 360', () => {
    // max===rn, gn<bn → (gn-bn)/d + 6. rgb(255,0,50): g=0<b=50 → hue в верхней части круга.
    const c = rgbToHsl(255, 0, 50);
    expect(c.h).toBeGreaterThan(300); // без «+6» дало бы отрицательный→нормализация иначе
    expect(c.h).toBeLessThan(360);
  });
});

// ─── C16 — mixColor фоллбек (170-175) ───────────────────────────────────────────

describe('C16 mixColor: невалид-фоллбек t<0.5?from:to (строка 173)', () => {
  it('невалидный from: t<0.5 → from-строка, t>=0.5 → to-строка', () => {
    expect(mixColor('notacolor', 'rgb(0, 0, 0)', 0.3)).toBe('notacolor');
    expect(mixColor('notacolor', 'rgb(0, 0, 0)', 0.7)).toBe('rgb(0, 0, 0)');
  });
  it('оба валидны: смешивает (не фоллбек)', () => {
    expect(mixColor('rgb(0, 0, 0)', 'rgb(255, 255, 255)', 0.5)).toBe('rgb(128, 128, 128)');
  });
});

// ─── C17 — hsl-интерполяция с РАЗНЫМИ s/l/a (204,205,206 channel-арифметика) ─────

describe('C17 hsl-интерполяция каналов s/l/a (строки 204,205,206)', () => {
  it('разные s/l: hsl(0,20%,30%)→hsl(120,80%,70%)@.5 = hsl(60, 50%, 50%)', () => {
    // Прошлый тест имел равные s/l (delta=0) → арифметика не тестировалась. Здесь
    // s: 0.2→0.8@.5=0.5; l: 0.3→0.7@.5=0.5. Мутант `fh.s - (th.s-fh.s)*t` = -0.1→0%.
    const c0 = pc('hsl(0, 20%, 30%)');
    const c1 = pc('hsl(120, 80%, 70%)');
    expect(interpolateColor(c0, c1, 0.5)).toBe('hsl(60, 50%, 50%)');
  });
  it('разный alpha: hsla(0,20%,30%,0.2)→hsla(120,80%,70%,0.9)@.5 = hsla(..., 0.55)', () => {
    const c0 = pc('hsla(0, 20%, 30%, 0.2)');
    const c1 = pc('hsla(120, 80%, 70%, 0.9)');
    expect(interpolateColor(c0, c1, 0.5)).toBe('hsla(60, 50%, 50%, 0.55)'); // a: 0.2→0.9@.5
  });
});

// ─── C18 — hue-wraparound на t≠0.5 (200,201 без 360-маскировки) ──────────────────

describe('C18 hue-wraparound на t=0.25/0.75 (строки 200,201)', () => {
  it('hsl(30)→hsl(350)@.25 = hsl(20): dh=320>180 → −360 (кусает 200)', () => {
    // dh=350-30=320 >180 → dh-=360 = -40 → h=30-10=20. Мутант `dh+=360`=680 → h=30+170=200.
    // t=0.25 (не 0.5): ±360·0.25=90, нормализация НЕ маскирует (в отличие от 0.5→180→wrap).
    const c0 = pc('hsl(30, 100%, 50%)');
    const c1 = pc('hsl(350, 100%, 50%)');
    expect(interpolateColor(c0, c1, 0.25)).toBe('hsl(20, 100%, 50%)');
  });
  it('hsl(350)→hsl(30)@.75 = hsl(20): dh=-320<-180 → +360 (кусает 201)', () => {
    // dh=30-350=-320 <-180 → dh+=360=40 → h=350+30=380→norm 20. Мутант `dh-=360`=-680 → h=350-510=-160→norm 200.
    const c0 = pc('hsl(350, 100%, 50%)');
    const c1 = pc('hsl(30, 100%, 50%)');
    expect(interpolateColor(c0, c1, 0.75)).toBe('hsl(20, 100%, 50%)');
  });
});

// ─── C19 — путь rgb/hsl в обе стороны (160 format-конъюнкты) ─────────────────────

describe('C19 interpolate путь: rgb+hsl и hsl+rgb → rgb-путь (строка 160)', () => {
  it('rgb+hsl → rgb-путь: #ff0000→hsl(120,100%,50%)@.5 = rgb(128, 128, 0)', () => {
    // Один не-hsl → sRGB-путь. Мутант, берущий hsl-путь при from.format≠hsl, дошёл бы
    // до interpolateHsl(rgb-from) → from.hsl undefined → бросок. Оракул rgb(...) кусает.
    expect(interpolateColor(pc('#ff0000'), pc('hsl(120, 100%, 50%)'), 0.5)).toBe('rgb(128, 128, 0)');
  });
  it('hsl+rgb → rgb-путь: hsl(120,100%,50%)→#ff0000@.5 = rgb(128, 128, 0)', () => {
    expect(interpolateColor(pc('hsl(120, 100%, 50%)'), pc('#ff0000'), 0.5)).toBe('rgb(128, 128, 0)');
  });
});

// ─── C20 — rgbToHsl hue-ветки max===gn/bn (строки 277, 279) ─────────────────────

describe('C20 rgbToHsl hue-ветки max===gn/bn (строки 275-279)', () => {
  it('max===gn с d≠1: rgbToHsl(50,200,100) → h=140 (кусает 277 (bn-rn)/d, не *d)', () => {
    // d = 0.588 ≠ 1: `/d` даёт h=140, мутант `*d` даёт h≈126.9. Прошлый тест имел d=1
    // (pure-цвет) → `*d`≡`/d` маскировало мутанта.
    expect(rgbToHsl(50, 200, 100).h).toBeCloseTo(140, 4);
  });
  it('max===bn с d≠1: rgbToHsl(100,50,200) → h=260 (ветка (rn-gn)/d+4)', () => {
    expect(rgbToHsl(100, 50, 200).h).toBeCloseTo(260, 4);
  });
});

// ─── C21 — parsePct без процента (строка 311 includes('%')) ─────────────────────

describe('C21 parsePct: "50" (без %) ≠ "50%" (строка 311)', () => {
  it('hsl(120,50,50) без % → s=1,l=1 (clamp01(50)); мутант includes("") дал бы 0.5', () => {
    // parsePct: `s.includes('%') ? v/100 : v`. Без % → v=50 → clamp01(50)=1.
    // Мутант 311 `includes('')` всегда true → v/100=0.5. Различает точным s/l.
    const noPct = pc('hsl(120, 50, 50)');
    expect(noPct.hsl).toEqual({ h: 120, s: 1, l: 1 });
    const withPct = pc('hsl(120, 50%, 50%)');
    expect(withPct.hsl).toEqual({ h: 120, s: 0.5, l: 0.5 });
  });
});

// ─── Документированные ЭКВИВАЛЕНТНЫЕ / НЕДОСТИЖИМЫЕ мутанты ──────────────────────
//
// Не гоняются (Goodhart). Остаток — regex-мутации, границы `<`↔`<=` (мера-0) и
// избыточные конъюнкты (аналог decay `!==undefined`):
//   • 46-49 Regex (HEX3/4/6/8), 60/61 StringLiteral (RGB_RE/HSL_RE): мутации regex
//     (квантификаторы/классы), не меняющие валидность для распознаваемых входов —
//     мутант всё ещё матчит те же строки. Differential на конкретных цветах их не
//     различает (парсинг результата идентичен); полноценно закрываются только
//     генеративным fuzz по алфавиту, что уже несёт value-parse fuzz-сьют.
//   • 156:7/158:7/201:7 EqualityOperator `<`↔`<=`, 244-248 hueToRgb-границы,
//     289/294 clamp-границы, 227/231/272 (`===`/`<`) — различие лишь в точке строгого
//     равенства (t=0/1 ровно; tc=1/6 ровно; f=0/255 ровно), мера-0 в непрерывном
//     диапазоне, недостижимо детерминированной точкой без спец-конструкции.
//   • 160 конъюнкты `from.hsl`/`to.hsl` (ConditionalExpression `true &&`): ИЗБЫТОЧНЫ с
//     `format==='hsl'` — parseColor гарантирует `format==='hsl' ⟺ hsl определён`
//     (аналог decay `!==undefined` избыточен с isFinite). Мутанты дают тот же путь.
//   • 173:28 (mixColor `t<0.5`→`<=`): граница ровно t=0.5, мера-0.
//   • 88/98/108 StringLiteral (`kind:'color'`→'', `format:'hex'`→''): kind НИКОГДА не
//     читается (чистый дискриминант-тег, никто не ветвится по нему); format читается
//     лишь как `===('hsl')` — 'hex' и '' ОБА не 'hsl' → тот же sRGB-путь. Эквивалент.
//   • 227 BlockStatement (`if(s===0){return gray}` → пустой блок): без short-circuit
//     s=0 идёт в общую формулу → q=l·(1+0)=l, p=2l−l=l, hueToRgb(l,l,·)=l (q===p) → все
//     каналы = l·255 = тот же серый. Эквивалент (if(true)-вариант 227 УБИТ C14 s=1).
describe('документированные эквиваленты color (обоснование, не театр)', () => {
  it('parseColor инвариант: format==="hsl" ⟺ hsl определён (обоснование 160-конъюнктов)', () => {
    // Характеризация редундантности from.hsl/to.hsl с format-проверкой.
    expect(pc('hsl(120, 50%, 50%)').hsl).toBeDefined();
    expect(pc('#abc').hsl).toBeUndefined();
    expect(pc('rgb(1, 2, 3)').hsl).toBeUndefined();
  });
});
