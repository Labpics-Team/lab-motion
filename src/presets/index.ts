/**
 * presets/index.ts вЂ” generic-РїСЂРµСЃРµС‚С‹ Р°РЅРёРјР°С†РёР№: headless СЃР»РѕРІР°СЂСЊ РґРІРёР¶РµРЅРёР№.
 *
 * Р—Р°С‡РµРј: РїРѕС‚СЂРµР±РёС‚РµР»Рё СѓСЂРѕРІРЅСЏ РёРєРѕРЅРѕРє/РјРёРєСЂРѕ-UI (lab-icons Рё РґСЂ.) СЃРѕР±РёСЂР°СЋС‚
 * СЃРµРјР°РЅС‚РёС‡РµСЃРєРёРµ С…РѕСЂРµРѕРіСЂР°С„РёРё (В«Р·СЂР°С‡РѕРє РїСѓР»СЊСЃРёСЂСѓРµС‚В», В«РєСѓСЂСЃРѕСЂ РјРёРіР°РµС‚В», В«РёСЃРєСЂС‹
 * СЂР°Р·Р»РµС‚Р°СЋС‚СЃСЏ РєР°СЃРєР°РґРѕРјВ») РёР· РЅРµР±РѕР»СЊС€РѕРіРѕ СЃР»РѕРІР°СЂСЏ generic-РґРІРёР¶РµРЅРёР№. РџСЂРµСЃРµС‚ вЂ”
 * СЌС‚Рѕ Р§РРЎРўРђРЇ РїР°СЂР°РјРµС‚СЂРёР·РѕРІР°РЅРЅР°СЏ СЃРїРµС†РёС„РёРєР°С†РёСЏ РјСѓР»СЊС‚РёС‚СЂРµРєРѕРІС‹С… РєРµР№С„СЂРµР№РјРѕРІ
 * (PresetSpec), Р° РЅРµ РїСЂРёРІСЏР·РєР° Рє DOM: РѕРґРёРЅ РјРѕРјРµРЅС‚ РІСЂРµРјРµРЅРё t в†’ Р·РЅР°С‡РµРЅРёРµ РєР°Р¶РґРѕРіРѕ
 * С‚СЂРµРєР° (scale/rotate/x/y/opacity/progress). РљР°РЅР°Р» `progress` вЂ” generic 0в†’1
 * (РїРѕС‚СЂРµР±РёС‚РµР»СЊ РјР°РїРёС‚ РµРіРѕ РЅР° draw-on clip-reveal Рё С‚.Рї.).
 *
 * РРЅРІР°СЂРёР°РЅС‚С‹ (North, РЅР°СЃР»РµРґСѓСЋС‚ keyframes/stagger):
 *   1. Zero runtime deps вЂ” РЅРµС‚ РІРЅРµС€РЅРёС… npm-Р·Р°РІРёСЃРёРјРѕСЃС‚РµР№.
 *   2. CSS-safe вЂ” СЃСЌРјРїР»С‹ Р’РЎР•Р“Р”Рђ РєРѕРЅРµС‡РЅС‹ (NaN/Infinity Р·Р°РїСЂРµС‰РµРЅС‹), РІРєР»СЋС‡Р°СЏ
 *      overflow-РєСЂР°СЏ Рё С…РѕСЃС‚РёР»СЊРЅРѕРµ t (NaN/В±Infinity/1e308).
 *   3. Р”РµС‚РµСЂРјРёРЅРёР·Рј вЂ” samplePreset С‡РёСЃС‚; runPreset РёСЃРїРѕР»СЊР·СѓРµС‚ injectable clock
 *      (requestFrame seam); РѕРґРёРЅР°РєРѕРІС‹Рµ РІС…РѕРґС‹ в†’ Р±РёС‚-РёРґРµРЅС‚РёС‡РЅС‹Р№ РІС‹РІРѕРґ.
 *   4. Reduced-motion вЂ” CHARACTER-switch РІ runPreset: РєРѕРЅРµС‡РЅС‹Р№ repeat в†’
 *      РјРіРЅРѕРІРµРЅРЅС‹Р№ СЃРЅСЌРї Рє С„РёРЅР°Р»СЊРЅРѕР№ РїРѕР·Рµ; repeat=Infinity (ambient-Р»СѓРї) в†’
 *      РЅРµР№С‚СЂР°Р»СЊРЅР°СЏ РїРѕР·Р° t=0. РќР• hard-off: РїРѕР·Р° СЌРјРёС‚РёСЂСѓРµС‚СЃСЏ СЂРѕРІРЅРѕ РѕРґРёРЅ СЂР°Р·.
 *   5. Domain purity / SSR-safe вЂ” РЅРё DOM, РЅРё window/document РЅР° РІРµСЂС…РЅРµРј СѓСЂРѕРІРЅРµ.
 *   6. Р’Р°Р»РёРґР°С†РёСЏ РўРћР›Р¬РљРћ РІ compilePreset (MotionParamError, РїРѕ-СЂСѓСЃСЃРєРё,
 *      РїСЂРµС„РёРєСЃ "presets:"); samplePreset вЂ” РіРѕСЂСЏС‡РёР№ РїСѓС‚СЊ Р±РµР· РїСЂРѕРІРµСЂРѕРє.
 */

import { easeOut, sineInOut } from '../easing/index.js';
import { MotionParamError } from '../errors.js';
import {
  sampleKeyframes,
  type EasingFn,
  type MatchMediaResult,
} from '../keyframes/index.js';

export type { EasingFn, MatchMediaResult };

// в”Ђв”Ђв”Ђ РџСѓР±Р»РёС‡РЅС‹Рµ С‚РёРїС‹ в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ

/**
 * РђРЅРёРјРёСЂСѓРµРјРѕРµ СЃРІРѕР№СЃС‚РІРѕ С‚СЂРµРєР°. Р—Р°РєСЂС‹С‚С‹Р№ РїРµСЂРµС‡РµРЅСЊ:
 * С‚СЂР°РЅСЃС„РѕСЂРјС‹ (scale/scaleX/scaleY/rotate/x/y), opacity Рё generic-РєР°РЅР°Р»
 * progress (0в†’1, РїРѕС‚СЂРµР±РёС‚РµР»СЊ РёРЅС‚РµСЂРїСЂРµС‚РёСЂСѓРµС‚: draw-on, variable-color-РїРѕСЂРѕРівЂ¦).
 */
export type PresetProperty =
  | 'scale'
  | 'scaleX'
  | 'scaleY'
  | 'rotate'
  | 'x'
  | 'y'
  | 'opacity'
  | 'progress';

/** РџРѕР»РёС‚РёРєР° РїРѕРІС‚РѕСЂРѕРІ вЂ” СЃРµРјР°РЅС‚РёРєР° РёРґРµРЅС‚РёС‡РЅР° keyframes ('mirror' = Р°Р»РёР°СЃ 'reverse'). */
export type PresetRepeatType = 'loop' | 'reverse' | 'mirror';

/** РћРґРёРЅ С‚СЂРµРє РїСЂРµСЃРµС‚Р°: РѕРїРѕСЂРЅС‹Рµ Р·РЅР°С‡РµРЅРёСЏ РѕРґРЅРѕРіРѕ СЃРІРѕР№СЃС‚РІР° РІРѕ РІСЂРµРјРµРЅРё С†РёРєР»Р°. */
export interface PresetTrack {
  /** РЎРІРѕР№СЃС‚РІРѕ РёР· Р·Р°РєСЂС‹С‚РѕРіРѕ РїРµСЂРµС‡РЅСЏ PresetProperty. РЈРЅРёРєР°Р»СЊРЅРѕ РІ СЂР°РјРєР°С… СЃРїРµРєРё. */
  readonly property: PresetProperty;
  /** РћРїРѕСЂРЅС‹Рµ Р·РЅР°С‡РµРЅРёСЏ. Р”Р»РёРЅР° >= 2, РєР°Р¶РґРѕРµ РєРѕРЅРµС‡РЅРѕ. */
  readonly values: readonly number[];
  /**
   * Р”РѕР»Рё [0,1] РЅР° РєР°Р¶РґРѕРµ Р·РЅР°С‡РµРЅРёРµ (РєР°Рє РІ keyframes): РЅРµСѓР±С‹РІР°СЋС‰РёРµ,
   * times[0]=0, times[last]=1. РќРµ Р·Р°РґР°РЅРѕ в†’ СЂР°РІРЅРѕРјРµСЂРЅРѕРµ Р°РІС‚Рѕ-СЂР°СЃРїСЂРµРґРµР»РµРЅРёРµ.
   */
  readonly times?: readonly number[];
  /** Easing РЅР° СЃРµРіРјРµРЅС‚: РѕРґРёРЅ РѕР±С‰РёР№ РёР»Рё РјР°СЃСЃРёРІ РґР»РёРЅРѕР№ values.length-1. */
  readonly easing?: EasingFn | readonly EasingFn[];
}

/** РЎРїРµС†РёС„РёРєР°С†РёСЏ РїСЂРµСЃРµС‚Р°: РјСѓР»СЊС‚РёС‚СЂРµРєРѕРІС‹Рµ РєРµР№С„СЂРµР№РјС‹ РѕРґРЅРѕРіРѕ С†РёРєР»Р° + РїРѕРІС‚РѕСЂС‹. */
export interface PresetSpec {
  /** Р”Р»РёС‚РµР»СЊРЅРѕСЃС‚СЊ РћР”РќРћР“Рћ С†РёРєР»Р° (СЃРµРєСѓРЅРґС‹). > 0, РєРѕРЅРµС‡РЅР°. */
  readonly duration: number;
  /** РўСЂРµРєРё. РњРёРЅРёРјСѓРј РѕРґРёРЅ; property СѓРЅРёРєР°Р»СЊРЅС‹. */
  readonly tracks: readonly PresetTrack[];
  /**
   * Р—Р°РґРµСЂР¶РєР° СЃС‚Р°СЂС‚Р° (СЃРµРєСѓРЅРґС‹, >= 0). Р”Рѕ РёСЃС‚РµС‡РµРЅРёСЏ delay СЃСЌРјРїР»РµСЂ РґРµСЂР¶РёС‚
   * РїРѕР·Сѓ t=0 (РїРµСЂРІС‹Рµ Р·РЅР°С‡РµРЅРёСЏ С‚СЂРµРєРѕРІ) вЂ” СЃР»РѕР№ РІРёРґРёРј Рё СЃС‚Р°С‚РёС‡РµРЅ, РЅРµ В«РїСѓСЃС‚В».
   */
  readonly delay?: number;
  /** Р§РёСЃР»Рѕ Р”РћРџРћР›РќРРўР•Р›Р¬РќР«РҐ С†РёРєР»РѕРІ: С†РµР»РѕРµ >= 0 РёР»Рё Infinity. РџРѕ СѓРјРѕР»С‡Р°РЅРёСЋ 0. */
  readonly repeat?: number;
  /** РџРѕР»РёС‚РёРєР° РЅР°РїСЂР°РІР»РµРЅРёСЏ РїРѕРІС‚РѕСЂРѕРІ. РџРѕ СѓРјРѕР»С‡Р°РЅРёСЋ 'loop'. */
  readonly repeatType?: PresetRepeatType;
  /** РџР°СѓР·Р° РјРµР¶РґСѓ С†РёРєР»Р°РјРё (СЃРµРєСѓРЅРґС‹, >= 0), РґРµСЂР¶РёС‚ РєРѕРЅРµС† С†РёРєР»Р°. РџРѕ СѓРјРѕР»С‡Р°РЅРёСЋ 0. */
  readonly repeatDelay?: number;
}

/** РЎСЌРјРїР» РїСЂРµСЃРµС‚Р°: Р·РЅР°С‡РµРЅРёСЏ РўРћР›Р¬РљРћ С‚РµС… СЃРІРѕР№СЃС‚РІ, С‡С‚Рѕ РµСЃС‚СЊ РІ С‚СЂРµРєР°С… СЃРїРµРєРё. */
export type PresetValues = Partial<Record<PresetProperty, number>>;

/**
 * РЎРєРѕРјРїРёР»РёСЂРѕРІР°РЅРЅС‹Р№ РїСЂРµСЃРµС‚ вЂ” РЅРѕСЂРјР°Р»РёР·РѕРІР°РЅРЅР°СЏ РІР°Р»РёРґРЅР°СЏ С„РѕСЂРјР° РґР»СЏ РіРѕСЂСЏС‡РµРіРѕ
 * СЃСЌРјРїР»РёСЂРѕРІР°РЅРёСЏ. РџРѕР»СѓС‡Р°РµС‚СЃСЏ РўРћР›Р¬РљРћ С‡РµСЂРµР· compilePreset(); РїРѕР»СЏ readonly,
 * СЃС‚СЂСѓРєС‚СѓСЂР° РЅРµРїСЂРѕР·СЂР°С‡РЅР° РґР»СЏ РїРѕС‚СЂРµР±РёС‚РµР»СЏ (Р±СЂРµРЅРґРёСЂРѕРІР°РЅР°).
 */
export interface CompiledPreset {
  /** Р‘СЂРµРЅРґРёСЂСѓСЋС‰РёР№ РјР°СЂРєРµСЂ вЂ” Р·Р°С‰РёС‚Р° РѕС‚ РїРѕРґСЃРѕРІС‹РІР°РЅРёСЏ СЃС‹СЂРѕР№ PresetSpec. */
  readonly __compiledPreset: true;
  readonly duration: number;
  readonly delay: number;
  readonly repeat: number;
  readonly repeatType: 'loop' | 'reverse';
  readonly repeatDelay: number;
  readonly tracks: readonly CompiledTrack[];
}

interface CompiledTrack {
  readonly property: PresetProperty;
  readonly values: readonly number[];
  readonly times: readonly number[];
  readonly easings: readonly EasingFn[];
}

// в”Ђв”Ђв”Ђ Р’РЅСѓС‚СЂРµРЅРЅРёРµ РєРѕРЅСЃС‚Р°РЅС‚С‹/С…РµР»РїРµСЂС‹ в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ

const PRESET_PROPERTIES: readonly PresetProperty[] = [
  'scale',
  'scaleX',
  'scaleY',
  'rotate',
  'x',
  'y',
  'opacity',
  'progress',
];

/** Finiteness guard вЂ” РґРёСЃС†РёРїР»РёРЅР° keyframes/timeline clampFinite. */
function clampFinite(x: number): number {
  if (Number.isFinite(x)) return x;
  if (Number.isNaN(x)) return 0;
  return x > 0 ? Number.MAX_VALUE : -Number.MAX_VALUE;
}

function linearEasing(t: number): number {
  return t;
}

// в”Ђв”Ђв”Ђ compilePreset: РІР°Р»РёРґР°С†РёСЏ Рё РЅРѕСЂРјР°Р»РёР·Р°С†РёСЏ в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ

/**
 * Р’Р°Р»РёРґРёСЂСѓРµС‚ Рё РЅРѕСЂРјР°Р»РёР·СѓРµС‚ PresetSpec. Р•РґРёРЅСЃС‚РІРµРЅРЅР°СЏ С‚РѕС‡РєР° РІР°Р»РёРґР°С†РёРё subpath:
 * РІСЃС‘ СЃС‚СЂСѓРєС‚СѓСЂРЅРѕ РЅРµРІР°Р»РёРґРЅРѕРµ РїР°РґР°РµС‚ Р·РґРµСЃСЊ MotionParamError (РїРѕ-СЂСѓСЃСЃРєРё),
 * Р° РЅРµ РїСЂРµРІСЂР°С‰Р°РµС‚СЃСЏ С‚РёС…Рѕ РІ NaN РЅР° РєР°РґСЂРµ.
 *
 * @throws MotionParamError РїСЂРё РЅРµРІР°Р»РёРґРЅРѕР№ СЃРїРµРєРµ.
 */
export function compilePreset(spec: PresetSpec): CompiledPreset {
  if (!spec || typeof spec !== 'object') {
    throw new MotionParamError('presets: spec РґРѕР»Р¶РµРЅ Р±С‹С‚СЊ РѕР±СЉРµРєС‚РѕРј PresetSpec');
  }

  const duration = spec.duration;
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new MotionParamError(
      `presets: duration РґРѕР»Р¶РµРЅ Р±С‹С‚СЊ РїРѕР»РѕР¶РёС‚РµР»СЊРЅС‹Рј РєРѕРЅРµС‡РЅС‹Рј С‡РёСЃР»РѕРј, РїРѕР»СѓС‡РµРЅРѕ ${duration}`,
    );
  }

  const rawTracks = spec.tracks;
  if (!rawTracks || rawTracks.length < 1) {
    throw new MotionParamError(
      `presets: tracks РґРѕР»Р¶РµРЅ СЃРѕРґРµСЂР¶Р°С‚СЊ РјРёРЅРёРјСѓРј 1 С‚СЂРµРє, РїРѕР»СѓС‡РµРЅРѕ ${rawTracks?.length ?? 0}`,
    );
  }

  const seen = new Set<PresetProperty>();
  const tracks: CompiledTrack[] = [];
  for (let ti = 0; ti < rawTracks.length; ti++) {
    const track = rawTracks[ti]!;
    const property = track.property;
    if (!PRESET_PROPERTIES.includes(property)) {
      throw new MotionParamError(
        `presets: tracks[${ti}].property "${String(property)}" РІРЅРµ РїРµСЂРµС‡РЅСЏ ${PRESET_PROPERTIES.join('|')}`,
      );
    }
    if (seen.has(property)) {
      throw new MotionParamError(
        `presets: СЃРІРѕР№СЃС‚РІРѕ "${property}" РІСЃС‚СЂРµС‡Р°РµС‚СЃСЏ РІ tracks Р±РѕР»РµРµ РѕРґРЅРѕРіРѕ СЂР°Р·Р°`,
      );
    }
    seen.add(property);

    const values = track.values;
    if (!values || values.length < 2) {
      throw new MotionParamError(
        `presets: tracks[${ti}].values РґРѕР»Р¶РµРЅ СЃРѕРґРµСЂР¶Р°С‚СЊ РјРёРЅРёРјСѓРј 2 СЌР»РµРјРµРЅС‚Р°, РїРѕР»СѓС‡РµРЅРѕ ${values?.length ?? 0}`,
      );
    }
    for (let i = 0; i < values.length; i++) {
      if (!Number.isFinite(values[i])) {
        throw new MotionParamError(
          `presets: tracks[${ti}].values[${i}] РґРѕР»Р¶РµРЅ Р±С‹С‚СЊ РєРѕРЅРµС‡РЅС‹Рј С‡РёСЃР»РѕРј, РїРѕР»СѓС‡РµРЅРѕ ${values[i]}`,
        );
      }
    }

    const n = values.length;
    let times: readonly number[];
    if (track.times !== undefined) {
      if (track.times.length !== n) {
        throw new MotionParamError(
          `presets: tracks[${ti}].times.length (${track.times.length}) РґРѕР»Р¶РµРЅ СЃРѕРІРїР°РґР°С‚СЊ СЃ values.length (${n})`,
        );
      }
      for (let i = 0; i < n; i++) {
        const t = track.times[i]!;
        if (!Number.isFinite(t)) {
          throw new MotionParamError(
            `presets: tracks[${ti}].times[${i}] РґРѕР»Р¶РµРЅ Р±С‹С‚СЊ РєРѕРЅРµС‡РЅС‹Рј С‡РёСЃР»РѕРј, РїРѕР»СѓС‡РµРЅРѕ ${t}`,
          );
        }
        if (i > 0 && t < track.times[i - 1]!) {
          throw new MotionParamError(`presets: tracks[${ti}].times РґРѕР»Р¶РЅС‹ Р±С‹С‚СЊ РЅРµСѓР±С‹РІР°СЋС‰РёРјРё`);
        }
      }
      if (track.times[0] !== 0) {
        throw new MotionParamError(
          `presets: tracks[${ti}].times[0] РґРѕР»Р¶РµРЅ Р±С‹С‚СЊ 0, РїРѕР»СѓС‡РµРЅРѕ ${track.times[0]}`,
        );
      }
      if (track.times[n - 1] !== 1) {
        throw new MotionParamError(
          `presets: tracks[${ti}].times[last] РґРѕР»Р¶РµРЅ Р±С‹С‚СЊ 1, РїРѕР»СѓС‡РµРЅРѕ ${track.times[n - 1]}`,
        );
      }
      times = track.times;
    } else {
      const auto = new Array<number>(n);
      for (let i = 0; i < n; i++) auto[i] = i / (n - 1);
      times = auto;
    }

    const segCount = n - 1;
    let easings: readonly EasingFn[];
    if (Array.isArray(track.easing)) {
      if (track.easing.length !== segCount) {
        throw new MotionParamError(
          `presets: tracks[${ti}].easing[].length (${track.easing.length}) РґРѕР»Р¶РµРЅ СЃРѕРІРїР°РґР°С‚СЊ СЃ С‡РёСЃР»РѕРј СЃРµРіРјРµРЅС‚РѕРІ (${segCount})`,
        );
      }
      easings = track.easing;
    } else if (typeof track.easing === 'function') {
      easings = new Array<EasingFn>(segCount).fill(track.easing);
    } else {
      easings = new Array<EasingFn>(segCount).fill(linearEasing);
    }

    tracks.push({ property, values, times, easings });
  }

  const delay = spec.delay ?? 0;
  if (!Number.isFinite(delay) || delay < 0) {
    throw new MotionParamError(
      `presets: delay РґРѕР»Р¶РµРЅ Р±С‹С‚СЊ >= 0 Рё РєРѕРЅРµС‡РЅС‹Рј, РїРѕР»СѓС‡РµРЅРѕ ${delay}`,
    );
  }

  const repeatRaw = spec.repeat ?? 0;
  if (
    repeatRaw !== Infinity &&
    (!Number.isFinite(repeatRaw) || repeatRaw < 0 || Math.floor(repeatRaw) !== repeatRaw)
  ) {
    throw new MotionParamError(
      `presets: repeat РґРѕР»Р¶РµРЅ Р±С‹С‚СЊ РЅРµРѕС‚СЂРёС†Р°С‚РµР»СЊРЅС‹Рј С†РµР»С‹Рј С‡РёСЃР»РѕРј РёР»Рё Infinity, РїРѕР»СѓС‡РµРЅРѕ ${repeatRaw}`,
    );
  }

  const repeatTypeRaw = spec.repeatType ?? 'loop';
  if (repeatTypeRaw !== 'loop' && repeatTypeRaw !== 'reverse' && repeatTypeRaw !== 'mirror') {
    throw new MotionParamError(
      `presets: repeatType РґРѕР»Р¶РµРЅ Р±С‹С‚СЊ 'loop'|'reverse'|'mirror', РїРѕР»СѓС‡РµРЅРѕ ${String(repeatTypeRaw)}`,
    );
  }
  const repeatType: 'loop' | 'reverse' = repeatTypeRaw === 'mirror' ? 'reverse' : repeatTypeRaw;

  const repeatDelay = spec.repeatDelay ?? 0;
  if (!Number.isFinite(repeatDelay) || repeatDelay < 0) {
    throw new MotionParamError(
      `presets: repeatDelay РґРѕР»Р¶РµРЅ Р±С‹С‚СЊ >= 0 Рё РєРѕРЅРµС‡РЅС‹Рј, РїРѕР»СѓС‡РµРЅРѕ ${repeatDelay}`,
    );
  }

  return {
    __compiledPreset: true,
    duration,
    delay,
    repeat: repeatRaw,
    repeatType,
    repeatDelay,
    tracks,
  };
}

// в”Ђв”Ђв”Ђ Р”Р»РёС‚РµР»СЊРЅРѕСЃС‚СЊ в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ

/**
 * РЎСѓРјРјР°СЂРЅР°СЏ РґР»РёС‚РµР»СЊРЅРѕСЃС‚СЊ РїСЂРµСЃРµС‚Р° СЃ СѓС‡С‘С‚РѕРј delay/repeat/repeatDelay (СЃРµРєСѓРЅРґС‹).
 * Infinity РїСЂРё repeat=Infinity вЂ” РјРµС‚Р°РґР°РЅРЅС‹Рµ, РЅРµ СЌРјРёС‚РёСЂСѓРµРјРѕРµ Р·РЅР°С‡РµРЅРёРµ.
 */
export function presetTotalDuration(compiled: CompiledPreset): number {
  const cycles = compiled.repeat === Infinity ? Infinity : compiled.repeat + 1;
  if (cycles === Infinity) return Infinity;
  return compiled.delay + compiled.duration * cycles + compiled.repeatDelay * compiled.repeat;
}

// в”Ђв”Ђв”Ђ samplePreset: С‡РёСЃС‚С‹Р№ РіРѕСЂСЏС‡РёР№ СЃСЌРјРїР»РµСЂ в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ

/**
 * Р—РЅР°С‡РµРЅРёСЏ РІСЃРµС… С‚СЂРµРєРѕРІ РїСЂРµСЃРµС‚Р° РІ РјРѕРјРµРЅС‚ tSeconds (РѕС‚ РЅСѓР»СЏ РѕР±С‰РµР№ С€РєР°Р»С‹,
 * delay РІС…РѕРґРёС‚ РІ С€РєР°Р»Сѓ). Р§РёСЃС‚Р°СЏ С„СѓРЅРєС†РёСЏ Р±РµР· СЃРѕСЃС‚РѕСЏРЅРёСЏ Рё РІР°Р»РёРґР°С†РёРё
 * (РєРѕРЅС‚СЂР°РєС‚: compiled РїРѕР»СѓС‡РµРЅ РёР· compilePreset).
 *
 * РҐРѕСЃС‚РёР»СЊРЅРѕРµ t: NaN в†’ РїРѕР·Р° t=0; -Infinity/РѕС‚СЂРёС†Р°С‚РµР»СЊРЅРѕРµ в†’ РїРѕР·Р° t=0;
 * +Infinity/Р·Р° totalDuration в†’ РєРѕРЅРµС† РїРѕСЃР»РµРґРЅРµРіРѕ С†РёРєР»Р° (yoyo-aware).
 * Р’С‹С…РѕРґ Р’РЎР•Р“Р”Рђ РєРѕРЅРµС‡РµРЅ (invariant 2).
 */
export function samplePreset(compiled: CompiledPreset, tSeconds: number): PresetValues {
  // РҐРѕСЃС‚РёР»СЊРЅРѕРµ РІСЂРµРјСЏ в†’ РґРµС‚РµСЂРјРёРЅРёСЂРѕРІР°РЅРЅС‹Рµ РєСЂР°СЏ (mirror keyframes computeAt).
  let t: number;
  if (Number.isNaN(tSeconds)) {
    t = 0;
  } else if (tSeconds === Infinity) {
    t = Number.MAX_VALUE;
  } else if (tSeconds === -Infinity || tSeconds < 0) {
    t = 0;
  } else {
    t = tSeconds;
  }

  // Delay-РѕРєРЅРѕ: РґРµСЂР¶РёРј РїРѕР·Сѓ t=0 (РїРµСЂРІС‹Рµ Р·РЅР°С‡РµРЅРёСЏ С‚СЂРµРєРѕРІ).
  let vt = t - compiled.delay;
  if (vt < 0) vt = 0;

  const { duration, repeat, repeatType, repeatDelay, tracks } = compiled;
  const totalCycles = repeat === Infinity ? Infinity : repeat + 1;
  const cycleLen = duration + repeatDelay;
  const activeTotal =
    totalCycles === Infinity ? Infinity : duration * totalCycles + repeatDelay * repeat;

  // Р—Р° РїСЂРµРґРµР»Р°РјРё Р°РєС‚РёРІРЅРѕР№ РґР»РёС‚РµР»СЊРЅРѕСЃС‚Рё в†’ РєРѕРЅРµС† РџРћРЎР›Р•Р”РќР•Р“Рћ С†РёРєР»Р° (yoyo-aware).
  let cycleIndex: number;
  let phaseP: number;
  if (activeTotal !== Infinity && vt >= activeTotal) {
    cycleIndex = totalCycles - 1;
    phaseP = 1;
  } else {
    cycleIndex = Math.floor(vt / cycleLen);
    if (cycleIndex < 0) cycleIndex = 0;
    if (totalCycles !== Infinity && cycleIndex >= totalCycles) cycleIndex = totalCycles - 1;
    const local = vt - cycleIndex * cycleLen;
    // РћРєРЅРѕ repeatDelay (local > duration) РґРµСЂР¶РёС‚ РєРѕРЅРµС† С†РёРєР»Р°: p=1.
    phaseP = local <= duration ? clampFinite(local / duration) : 1;
    if (phaseP < 0) phaseP = 0;
    else if (phaseP > 1) phaseP = 1;
  }

  const forward = repeatType === 'loop' || cycleIndex % 2 === 0;
  const effectiveP = forward ? phaseP : 1 - phaseP;

  const out: PresetValues = {};
  for (let i = 0; i < tracks.length; i++) {
    const track = tracks[i]!;
    // РљРѕРЅРµС‡РЅРѕСЃС‚СЊ РіР°СЂР°РЅС‚РёСЂСѓРµС‚ sampleKeyframes: values РІР°Р»РёРґРёСЂРѕРІР°РЅС‹ compilePreset,
    // РІРЅСѓС‚СЂРµРЅРЅРёРµ guards (eased/overflow) СЂРµР¶СѓС‚ NaN/в€ћ РґРѕ РІРѕР·РІСЂР°С‚Р°. Р’РЅРµС€РЅРёР№ clamp
    // Р·РґРµСЃСЊ Р±С‹Р» Р±С‹ РјС‘СЂС‚РІС‹Рј РєРѕРґРѕРј (СѓСЂРѕРє РІРµСЂРёС„РёРєР°С†РёРё s07 вЂ” РЅРµ РґРµРєР»Р°СЂРёРѕРІР°С‚СЊ
    // Р·Р°С‰РёС‚Сѓ С‚Р°Рј, РіРґРµ РѕРЅР° РЅРµ СЃСЂР°Р±Р°С‚С‹РІР°РµС‚).
    out[track.property] = sampleKeyframes(track.values, track.times, track.easings, effectiveP);
  }
  return out;
}

// в”Ђв”Ђв”Ђ Р¤Р°Р±СЂРёРєРё РїСЂРµСЃРµС‚РѕРІ в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
//
// Р”РµС„РѕР»С‚С‹ РєР°Р»РёР±СЂРѕРІР°РЅС‹ РїРѕ РІРєСѓСЃРѕРІРѕРјСѓ СЌС‚Р°Р»РѕРЅСѓ РІР»Р°РґРµР»СЊС†Р° (4 Lottie СЃ lab.pics,
// СЂР°Р·Р±РѕСЂ: .agents/research/animated-icons-domain/lab-pics-lottie/REFS-LABPICS.md):
// РјСЏРіРєРёРµ Р°РјРїР»РёС‚СѓРґС‹ (scale-РїСѓР»СЊСЃ ~0.12, wiggle ~8В°), 3-7 РѕРїРѕСЂРЅС‹С… С‚РѕС‡РµРє,
// identity-РєСЂР°РµРІС‹Рµ РїРѕР·С‹ (РїРѕСЃР»Рµ Р°РЅРёРјР°С†РёРё РёРєРѕРЅРєР° РІС‹РіР»СЏРґРёС‚ РєР°Рє СЃС‚Р°С‚РёС‡РµСЃРєР°СЏ),
// С‚Р°Р№РјРёРЅРіРё: ~0.5-1СЃ Р°РєС†РµРЅС‚ / 2-3СЃ СЃСЋР¶РµС‚ / ~5СЃ ambient-Р»СѓРї.
//
// Р¤Р°Р±СЂРёРєР° РІРѕР·РІСЂР°С‰Р°РµС‚ РќР•РєРѕРјРїРёР»РёСЂРѕРІР°РЅРЅСѓСЋ PresetSpec вЂ” РїРѕС‚СЂРµР±РёС‚РµР»СЊ РјРѕР¶РµС‚
// СЂР°СЃС€РёСЂРёС‚СЊ СЃРїСЂРµРґРѕРј ({...pulse(), repeat: 2}) Рё РєРѕРјРїРёР»РёСЂСѓРµС‚ РїСЂРё РёСЃРїРѕР»СЊР·РѕРІР°РЅРёРё.

function assertFinite(name: string, value: number): void {
  if (!Number.isFinite(value)) {
    throw new MotionParamError(`presets: ${name} РґРѕР»Р¶РµРЅ Р±С‹С‚СЊ РєРѕРЅРµС‡РЅС‹Рј С‡РёСЃР»РѕРј, РїРѕР»СѓС‡РµРЅРѕ ${value}`);
  }
}

function assertDuration(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new MotionParamError(
      `presets: ${name}.duration РґРѕР»Р¶РµРЅ Р±С‹С‚СЊ РїРѕР»РѕР¶РёС‚РµР»СЊРЅС‹Рј РєРѕРЅРµС‡РЅС‹Рј С‡РёСЃР»РѕРј, РїРѕР»СѓС‡РµРЅРѕ ${value}`,
    );
  }
}

export interface PulseOptions {
  /** РђРјРїР»РёС‚СѓРґР° РїСЂРёСЂРѕСЃС‚Р° РјР°СЃС€С‚Р°Р±Р° РІ РїРёРєРµ. РџРѕ СѓРјРѕР»С‡Р°РЅРёСЋ 0.12 (РјСЏРіРєРёР№ РїСѓР»СЊСЃ). */
  readonly amount?: number;
  /** Р”Р»РёС‚РµР»СЊРЅРѕСЃС‚СЊ С†РёРєР»Р°, СЃ. РџРѕ СѓРјРѕР»С‡Р°РЅРёСЋ 0.9. */
  readonly duration?: number;
}

/** РџСѓР»СЊСЃ РјР°СЃС€С‚Р°Р±Р°: 1 в†’ 1+amount в†’ 1 (Р·СЂР°С‡РѕРє РёР· СЌС‚Р°Р»РѕРЅР° ref-1). */
export function pulse(opts: PulseOptions = {}): PresetSpec {
  const amount = opts.amount ?? 0.12;
  const duration = opts.duration ?? 0.9;
  assertFinite('pulse.amount', amount);
  assertDuration('pulse', duration);
  if (amount <= -1) {
    throw new MotionParamError(
      `presets: pulse.amount РґРѕР»Р¶РµРЅ Р±С‹С‚СЊ > -1 (РјР°СЃС€С‚Р°Р± РІ РїРёРєРµ 1+amount > 0), РїРѕР»СѓС‡РµРЅРѕ ${amount}`,
    );
  }
  return {
    duration,
    tracks: [{ property: 'scale', values: [1, 1 + amount, 1], easing: sineInOut }],
  };
}

export interface BlinkOptions {
  /** РњРёРЅРёРјР°Р»СЊРЅР°СЏ РЅРµРїСЂРѕР·СЂР°С‡РЅРѕСЃС‚СЊ РІ РїСЂРѕРІР°Р»Рµ, [0,1]. РџРѕ СѓРјРѕР»С‡Р°РЅРёСЋ 0. */
  readonly min?: number;
  /** Р”Р»РёС‚РµР»СЊРЅРѕСЃС‚СЊ С†РёРєР»Р°, СЃ. РџРѕ СѓРјРѕР»С‡Р°РЅРёСЋ 1 (РєСѓСЂСЃРѕСЂ РёР· СЌС‚Р°Р»РѕРЅР° ref-2). */
  readonly duration?: number;
}

/** РњРёРіР°РЅРёРµ РЅРµРїСЂРѕР·СЂР°С‡РЅРѕСЃС‚Рё: 1 в†’ min в†’ 1, Р±РµСЃРєРѕРЅРµС‡РЅС‹Р№ Р»СѓРї (РєСѓСЂСЃРѕСЂ С‚РµСЂРјРёРЅР°Р»Р°). */
export function blink(opts: BlinkOptions = {}): PresetSpec {
  const min = opts.min ?? 0;
  const duration = opts.duration ?? 1;
  assertFinite('blink.min', min);
  assertDuration('blink', duration);
  if (min < 0 || min > 1) {
    throw new MotionParamError(`presets: blink.min РґРѕР»Р¶РµРЅ Р±С‹С‚СЊ РІ [0,1], РїРѕР»СѓС‡РµРЅРѕ ${min}`);
  }
  return {
    duration,
    repeat: Infinity,
    tracks: [{ property: 'opacity', values: [1, min, 1], easing: sineInOut }],
  };
}

export interface WiggleOptions {
  /** РњР°РєСЃРёРјР°Р»СЊРЅС‹Р№ СѓРіРѕР» РѕС‚РєР»РѕРЅРµРЅРёСЏ, РіСЂР°РґСѓСЃС‹. РџРѕ СѓРјРѕР»С‡Р°РЅРёСЋ 8 (РјСЏРіРєРѕРµ РїРѕРєР°С‡РёРІР°РЅРёРµ). */
  readonly degrees?: number;
  /** Р§РёСЃР»Рѕ СЃРІРёРЅРіРѕРІ (СЃРјРµРЅ РЅР°РїСЂР°РІР»РµРЅРёСЏ). Р¦РµР»РѕРµ >= 1. РџРѕ СѓРјРѕР»С‡Р°РЅРёСЋ 3. */
  readonly cycles?: number;
  /** Р”Р»РёС‚РµР»СЊРЅРѕСЃС‚СЊ, СЃ. РџРѕ СѓРјРѕР»С‡Р°РЅРёСЋ 0.8. */
  readonly duration?: number;
}

/**
 * РџРѕРєР°С‡РёРІР°РЅРёРµ РІРѕРєСЂСѓРі СЏРєРѕСЂСЏ СЃ Р·Р°С‚СѓС…Р°СЋС‰РµР№ Р°РјРїР»РёС‚СѓРґРѕР№: 0 в†’ +d в†’ в€’dВ·k в†’ вЂ¦ в†’ 0
 * (РєРѕР»РѕРєРѕР»СЊС‡РёРє СѓРІРµРґРѕРјР»РµРЅРёР№). Р—Р°С‚СѓС…Р°РЅРёРµ Р»РёРЅРµР№РЅРѕРµ вЂ” РґРІРёР¶РµРЅРёРµ С‡РёС‚Р°РµРјРѕРµ, РЅРµ РґС‘СЂРіР°РЅРѕРµ.
 */
export function wiggle(opts: WiggleOptions = {}): PresetSpec {
  const degrees = opts.degrees ?? 8;
  const cycles = opts.cycles ?? 3;
  const duration = opts.duration ?? 0.8;
  assertFinite('wiggle.degrees', degrees);
  assertDuration('wiggle', duration);
  if (!Number.isFinite(cycles) || cycles < 1 || Math.floor(cycles) !== cycles) {
    throw new MotionParamError(
      `presets: wiggle.cycles РґРѕР»Р¶РµРЅ Р±С‹С‚СЊ С†РµР»С‹Рј С‡РёСЃР»РѕРј >= 1, РїРѕР»СѓС‡РµРЅРѕ ${cycles}`,
    );
  }
  const values: number[] = [0];
  for (let k = 1; k <= cycles; k++) {
    const amp = (degrees * (cycles - k + 1)) / cycles;
    values.push(k % 2 === 1 ? amp : -amp);
  }
  values.push(0);
  return {
    duration,
    tracks: [{ property: 'rotate', values, easing: sineInOut }],
  };
}

export interface SpinOptions {
  /** Р§РёСЃР»Рѕ РѕР±РѕСЂРѕС‚РѕРІ (РѕС‚СЂРёС†Р°С‚РµР»СЊРЅРѕРµ вЂ” РїСЂРѕС‚РёРІ С‡Р°СЃРѕРІРѕР№). РџРѕ СѓРјРѕР»С‡Р°РЅРёСЋ 1. */
  readonly turns?: number;
  /** Р”Р»РёС‚РµР»СЊРЅРѕСЃС‚СЊ, СЃ. РџРѕ СѓРјРѕР»С‡Р°РЅРёСЋ 1. */
  readonly duration?: number;
}

/** РћР±РѕСЂРѕС‚: rotate 0 в†’ 360Г—turns (РѕР±РЅРѕРІР»РµРЅРёРµ/Р·Р°РіСЂСѓР·РєР°). */
export function spin(opts: SpinOptions = {}): PresetSpec {
  const turns = opts.turns ?? 1;
  const duration = opts.duration ?? 1;
  assertFinite('spin.turns', turns);
  assertDuration('spin', duration);
  return {
    duration,
    tracks: [{ property: 'rotate', values: [0, 360 * turns], easing: sineInOut }],
  };
}

export interface BreatheOptions {
  /** РђРјРїР»РёС‚СѓРґР° РїСЂРёСЂРѕСЃС‚Р° РјР°СЃС€С‚Р°Р±Р°. РџРѕ СѓРјРѕР»С‡Р°РЅРёСЋ 0.05 (Р·Р°РјРµС‚РЅРѕ РјСЏРіС‡Рµ pulse). */
  readonly amount?: number;
  /** Р”Р»РёС‚РµР»СЊРЅРѕСЃС‚СЊ С†РёРєР»Р°, СЃ. РџРѕ СѓРјРѕР»С‡Р°РЅРёСЋ 2.6 (ambient). */
  readonly duration?: number;
}

/** Р”С‹С…Р°РЅРёРµ: РјРµРґР»РµРЅРЅС‹Р№ РјСЏРіРєРёР№ РїСѓР»СЊСЃ РјР°СЃС€С‚Р°Р±Р°, Р±РµСЃРєРѕРЅРµС‡РЅС‹Р№ ambient-Р»СѓРї. */
export function breathe(opts: BreatheOptions = {}): PresetSpec {
  const amount = opts.amount ?? 0.05;
  const duration = opts.duration ?? 2.6;
  assertFinite('breathe.amount', amount);
  assertDuration('breathe', duration);
  if (amount <= -1) {
    throw new MotionParamError(
      `presets: breathe.amount РґРѕР»Р¶РµРЅ Р±С‹С‚СЊ > -1, РїРѕР»СѓС‡РµРЅРѕ ${amount}`,
    );
  }
  return {
    duration,
    repeat: Infinity,
    tracks: [{ property: 'scale', values: [1, 1 + amount, 1], easing: sineInOut }],
  };
}

export interface PopOptions {
  /** РџРёРє РїРµСЂРµР»С‘С‚Р° РјР°СЃС€С‚Р°Р±Р° РїРµСЂРµРґ РѕСЃРµРґР°РЅРёРµРј РІ 1. РџРѕ СѓРјРѕР»С‡Р°РЅРёСЋ 1.18. */
  readonly overshoot?: number;
  /** Р”Р»РёС‚РµР»СЊРЅРѕСЃС‚СЊ, СЃ. РџРѕ СѓРјРѕР»С‡Р°РЅРёСЋ 0.5. */
  readonly duration?: number;
}

/** РџРѕСЏРІР»РµРЅРёРµ СЃ РїРµСЂРµР»С‘С‚РѕРј: scale 0 в†’ overshoot в†’ 1 (Appear-РєР»Р°СЃСЃ). */
export function pop(opts: PopOptions = {}): PresetSpec {
  const overshoot = opts.overshoot ?? 1.18;
  const duration = opts.duration ?? 0.5;
  assertFinite('pop.overshoot', overshoot);
  assertDuration('pop', duration);
  if (overshoot <= 0) {
    throw new MotionParamError(
      `presets: pop.overshoot РґРѕР»Р¶РµРЅ Р±С‹С‚СЊ > 0, РїРѕР»СѓС‡РµРЅРѕ ${overshoot}`,
    );
  }
  return {
    duration,
    tracks: [
      {
        property: 'scale',
        values: [0, overshoot, 1],
        times: [0, 0.7, 1],
        easing: [easeOut, sineInOut],
      },
    ],
  };
}

export interface BounceYOptions {
  /** Р’С‹СЃРѕС‚Р° РїРѕРґСЃРєРѕРєР°, РµРґРёРЅРёС†С‹ РєРѕРѕСЂРґРёРЅР°С‚ (РґР»СЏ 24px-РёРєРѕРЅРєРё ~2-4). РџРѕ СѓРјРѕР»С‡Р°РЅРёСЋ 2.5. */
  readonly height?: number;
  /** Р”Р»РёС‚РµР»СЊРЅРѕСЃС‚СЊ, СЃ. РџРѕ СѓРјРѕР»С‡Р°РЅРёСЋ 0.6. */
  readonly duration?: number;
}

/** РџРѕРґСЃРєРѕРє: y 0 в†’ в€’height в†’ 0 в†’ в€’heightВ·0.35 в†’ 0 (РІС‚РѕСЂРѕР№ РѕС‚СЃРєРѕРє РЅРёР¶Рµ). */
export function bounceY(opts: BounceYOptions = {}): PresetSpec {
  const height = opts.height ?? 2.5;
  const duration = opts.duration ?? 0.6;
  assertFinite('bounceY.height', height);
  assertDuration('bounceY', duration);
  return {
    duration,
    tracks: [
      {
        property: 'y',
        values: [0, -height, 0, -height * 0.35, 0],
        times: [0, 0.3, 0.6, 0.8, 1],
        easing: sineInOut,
      },
    ],
  };
}

export interface DriftOptions {
  /** Р”СЂРµР№С„ РїРѕ x (РµРґРёРЅРёС†С‹ РєРѕРѕСЂРґРёРЅР°С‚). РџРѕ СѓРјРѕР»С‡Р°РЅРёСЋ 0 вЂ” С‚СЂРµРє РЅРµ СЃРѕР·РґР°С‘С‚СЃСЏ. */
  readonly dx?: number;
  /** Р”СЂРµР№С„ РїРѕ y. РџРѕ СѓРјРѕР»С‡Р°РЅРёСЋ в€’1.5 (Р»С‘РіРєРёР№ РїРѕРґСЉС‘Рј, Р·РІС‘Р·РґС‹ РёР· СЌС‚Р°Р»РѕРЅР° ref-3). */
  readonly dy?: number;
  /** Р”Р»РёС‚РµР»СЊРЅРѕСЃС‚СЊ С†РёРєР»Р°, СЃ. РџРѕ СѓРјРѕР»С‡Р°РЅРёСЋ 5 (ambient). */
  readonly duration?: number;
}

/** Ambient-РґСЂРµР№С„: РїР»Р°РІРЅС‹Р№ СѓС…РѕРґ Рє (dx,dy) Рё РІРѕР·РІСЂР°С‚, Р±РµСЃРєРѕРЅРµС‡РЅС‹Р№ Р»СѓРї. */
export function drift(opts: DriftOptions = {}): PresetSpec {
  const dx = opts.dx ?? 0;
  const dy = opts.dy ?? -1.5;
  const duration = opts.duration ?? 5;
  assertFinite('drift.dx', dx);
  assertFinite('drift.dy', dy);
  assertDuration('drift', duration);
  if (dx === 0 && dy === 0) {
    throw new MotionParamError('presets: drift вЂ” dx Рё dy РѕРґРЅРѕРІСЂРµРјРµРЅРЅРѕ РЅСѓР»РµРІС‹Рµ, РґСЂРµР№С„Р° РЅРµС‚');
  }
  const tracks: PresetTrack[] = [];
  if (dx !== 0) tracks.push({ property: 'x', values: [0, dx, 0], easing: sineInOut });
  if (dy !== 0) tracks.push({ property: 'y', values: [0, dy, 0], easing: sineInOut });
  return { duration, repeat: Infinity, tracks };
}

export interface FadeSlideOptions {
  /** РќР°С‡Р°Р»СЊРЅРѕРµ СЃРјРµС‰РµРЅРёРµ РїРѕ x (РґРІРёР¶РµРЅРёРµ Рє 0). РџРѕ СѓРјРѕР»С‡Р°РЅРёСЋ 0 вЂ” С‚СЂРµРє РЅРµ СЃРѕР·РґР°С‘С‚СЃСЏ. */
  readonly dx?: number;
  /** РќР°С‡Р°Р»СЊРЅРѕРµ СЃРјРµС‰РµРЅРёРµ РїРѕ y. РџРѕ СѓРјРѕР»С‡Р°РЅРёСЋ 4. */
  readonly dy?: number;
  /** Р”Р»РёС‚РµР»СЊРЅРѕСЃС‚СЊ, СЃ. РџРѕ СѓРјРѕР»С‡Р°РЅРёСЋ 0.35. */
  readonly duration?: number;
}

/** РџРѕСЏРІР»РµРЅРёРµ СЃРѕ СЃРґРІРёРіРѕРј: opacity 0в†’1, СЃРјРµС‰РµРЅРёРµ (dx,dy)в†’0 (Appear-РєР»Р°СЃСЃ). */
export function fadeSlide(opts: FadeSlideOptions = {}): PresetSpec {
  const dx = opts.dx ?? 0;
  const dy = opts.dy ?? 4;
  const duration = opts.duration ?? 0.35;
  assertFinite('fadeSlide.dx', dx);
  assertFinite('fadeSlide.dy', dy);
  assertDuration('fadeSlide', duration);
  const tracks: PresetTrack[] = [
    { property: 'opacity', values: [0, 1], easing: easeOut },
  ];
  if (dx !== 0) tracks.push({ property: 'x', values: [dx, 0], easing: easeOut });
  if (dy !== 0) tracks.push({ property: 'y', values: [dy, 0], easing: easeOut });
  return { duration, tracks };
}

export interface DrawOnOptions {
  /** Р”Р»РёС‚РµР»СЊРЅРѕСЃС‚СЊ СЂРёСЃРѕРІР°РЅРёСЏ, СЃ. РџРѕ СѓРјРѕР»С‡Р°РЅРёСЋ 1.2. */
  readonly duration?: number;
}

/**
 * РљР°РЅР°Р» РїСЂРѕРіСЂРµСЃСЃР° СЂРёСЃРѕРІР°РЅРёСЏ: progress 0в†’1 РјРѕРЅРѕС‚РѕРЅРЅРѕ (BL-002 В«РєРёСЃС‚РѕС‡РєР° СЂРёСЃСѓРµС‚В»).
 * РџРѕС‚СЂРµР±РёС‚РµР»СЊ РјР°РїРёС‚ progress РЅР° С‚РµС…РЅРёРєСѓ СЂР°СЃРєСЂС‹С‚РёСЏ (clip-path РІРґРѕР»СЊ guide-РїСѓС‚Рё,
 * variable-draw РїРѕСЂРѕРі Рё С‚.Рї.) вЂ” СЃР°Рј РїСЂРµСЃРµС‚ РѕСЃС‚Р°С‘С‚СЃСЏ headless-С‡РёСЃР»РѕРј.
 */
export function drawOn(opts: DrawOnOptions = {}): PresetSpec {
  const duration = opts.duration ?? 1.2;
  assertDuration('drawOn', duration);
  return {
    duration,
    tracks: [{ property: 'progress', values: [0, 1], easing: sineInOut }],
  };
}

// в”Ђв”Ђв”Ђ runPreset: СѓРїСЂР°РІР»СЏРµРјС‹Р№ frame-loop в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ

const FIXED_DT_S = 1 / 60;
/** Safety-cap РєР°РґСЂРѕРІ вЂ” РёРґРµРЅС‚РёС‡РµРЅ keyframes/timeline MAX_FRAMES. */
const MAX_FRAMES = 100_000;

/** РћРїС†РёРё runPreset вЂ” injectable seams РІ РґРёСЃС†РёРїР»РёРЅРµ keyframes(). */
export interface RunPresetOptions {
  /** РљРѕР»Р±СЌРє РЅР° РєР°Р¶РґС‹Р№ С€Р°Рі: Р·РЅР°С‡РµРЅРёСЏ Р’РЎР•РҐ С‚СЂРµРєРѕРІ РІ С‚РµРєСѓС‰РёР№ РјРѕРјРµРЅС‚. */
  readonly onUpdate?: (values: PresetValues) => void;
  /** Injectable requestAnimationFrame-Р·Р°РјРµРЅРёС‚РµР»СЊ. Р’РѕР·РІСЂР°С‚ 0 = timeout-fallback. */
  readonly requestFrame?: ((cb: (ts?: number) => void) => number) | undefined;
  /** Injectable matchMedia. undefined = SSR / РЅРµС‚ РїСЂРµРґРїРѕС‡С‚РµРЅРёР№ (reduce=false). */
  readonly matchMedia?: ((query: string) => MatchMediaResult) | undefined;
}

/** РЈРїСЂР°РІР»СЏРµРјС‹Р№ С…РµРЅРґР» РїСЂРµСЃРµС‚Р°. Thenable вЂ” `await runPreset(...)`. */
export interface PresetControls {
  /** РЎСѓРјРјР°СЂРЅР°СЏ РґР»РёС‚РµР»СЊРЅРѕСЃС‚СЊ c delay/repeat (СЃРµРєСѓРЅРґС‹); Infinity РїСЂРё repeat=в€ћ. */
  readonly totalDuration: number;
  /** РўРµРєСѓС‰РµРµ РІРёСЂС‚СѓР°Р»СЊРЅРѕРµ РІСЂРµРјСЏ (СЃРµРєСѓРЅРґС‹) РѕС‚ СЃС‚Р°СЂС‚Р° (delay РІС…РѕРґРёС‚ РІ С€РєР°Р»Сѓ). */
  readonly time: number;
  /** РџСЂРѕРіСЂРµСЃСЃ РўР•РљРЈР©Р•Р“Рћ С†РёРєР»Р° [0,1]. */
  readonly progress: number;
  /** Р’РѕР·РѕР±РЅРѕРІРёС‚СЊ (no-op РµСЃР»Рё РёРіСЂР°РµС‚ РёР»Рё Р·Р°РІРµСЂС€С‘РЅ). */
  play(): void;
  /** РџР°СѓР·Р° (Р·Р°РјРѕСЂР°Р¶РёРІР°РµС‚ РІРёСЂС‚СѓР°Р»СЊРЅРѕРµ РІСЂРµРјСЏ). */
  pause(): void;
  /** РџРµСЂРµРјРѕС‚РєР° Рє t СЃРµРєСѓРЅРґ. NaN в†’ no-op, +Infinity в†’ complete(). */
  seek(t: number): void;
  /** РЎРЅСЌРї Рє С„РёРЅР°Р»СЊРЅРѕР№ РїРѕР·Рµ (repeat=в€ћ в†’ РЅРµР№С‚СЂР°Р»СЊРЅР°СЏ РїРѕР·Р° t=0) Рё СЂРµР·РѕР»РІ. */
  complete(): void;
  /** РћСЃС‚Р°РЅРѕРІРёС‚СЊСЃСЏ РІ С‚РµРєСѓС‰РµР№ РїРѕР·РёС†РёРё Рё СЂРµР·РѕР»РІРёС‚СЊ. */
  cancel(): void;
  then<TResult1 = void, TResult2 = never>(
    onfulfilled?: ((value: void) => TResult1 | PromiseLike<TResult1>) | null | undefined,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null | undefined,
  ): Promise<TResult1 | TResult2>;
}

function prefersReducedMotion(
  matchMedia: ((query: string) => MatchMediaResult) | undefined,
): boolean {
  if (typeof matchMedia !== 'function') return false;
  try {
    return matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

function isCompiled(spec: PresetSpec | CompiledPreset): spec is CompiledPreset {
  return (spec as CompiledPreset).__compiledPreset === true;
}

/**
 * РџСЂРѕРёРіСЂС‹РІР°РµС‚ РїСЂРµСЃРµС‚ РћР”РќРРњ frame-loop'РѕРј РЅР° РІСЃРµ С‚СЂРµРєРё (РґРµС‚РµСЂРјРёРЅРёР·Рј: РѕРґРёРЅ clock,
 * РѕРґРёРЅ СЃСЌРјРїР» РЅР° РєР°РґСЂ). РќР°С‡РёРЅР°РµС‚ РЅРµРјРµРґР»РµРЅРЅРѕ (РµСЃР»Рё РЅРµ reduced-motion).
 *
 * Reduced-motion CHARACTER-switch (РёРЅРІР°СЂРёР°РЅС‚ 4): РєРѕРЅРµС‡РЅС‹Р№ repeat в†’ СЃРёРЅС…СЂРѕРЅРЅС‹Р№
 * СЃРЅСЌРї Рє С„РёРЅР°Р»СЊРЅРѕР№ РїРѕР·Рµ; repeat=Infinity (ambient-Р»СѓРї Р±РµР· С„РёРЅР°Р»Р°) в†’ РЅРµР№С‚СЂР°Р»СЊРЅР°СЏ
 * РїРѕР·Р° t=0. РџРѕР·Р° СЌРјРёС‚РёСЂСѓРµС‚СЃСЏ СЂРѕРІРЅРѕ РѕРґРёРЅ СЂР°Р· вЂ” РїРѕС‚СЂРµР±РёС‚РµР»СЊ РџРћР›РЈР§РђР•Рў СЃС‚Р°С‚РёС‡РЅСѓСЋ
 * РІР°Р»РёРґРЅСѓСЋ РїРѕР·Сѓ, Р° РЅРµ В«РЅРёС‡РµРіРѕВ» (РќР• hard-off).
 *
 * @throws MotionParamError РїСЂРё РЅРµРІР°Р»РёРґРЅРѕР№ СЃРїРµРєРµ (С‡РµСЂРµР· compilePreset).
 */
export function runPreset(
  spec: PresetSpec | CompiledPreset,
  opts: RunPresetOptions = {},
): PresetControls {
  const compiled = isCompiled(spec) ? spec : compilePreset(spec);
  const totalDuration = presetTotalDuration(compiled);
  const onUpdate = opts.onUpdate;

  const reduce = prefersReducedMotion(opts.matchMedia);

  const scheduleFrame: (cb: (ts?: number) => void) => number =
    opts.requestFrame ??
    ((cb) =>
      typeof requestAnimationFrame !== 'undefined'
        ? requestAnimationFrame(cb)
        : (setTimeout(cb, FIXED_DT_S * 1000) as unknown as number));

  // в”Ђв”Ђ РР·РјРµРЅСЏРµРјРѕРµ СЃРѕСЃС‚РѕСЏРЅРёРµ в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
  let _vt = 0;
  let _lastRealTs: number | undefined;
  let _paused = false;
  let _settled = false;
  let _loopRunning = false;
  let _tickActive = false;
  let _useTimeoutFallback = false;
  let _frameCount = 0;

  let _resolve!: () => void;
  const _promise = new Promise<void>((res) => {
    _resolve = res;
  });

  function emit(values: PresetValues): void {
    if (!onUpdate) return;
    try {
      onUpdate(values);
    } catch {
      // РР·РѕР»СЏС†РёСЏ РѕС€РёР±РѕРє РїРѕР»СЊР·РѕРІР°С‚РµР»СЊСЃРєРѕРіРѕ РєРѕР»Р±СЌРєР° вЂ” Р»СѓРї/РїСЂРѕРјРёСЃ Р¶РёРІСѓС‚ РґР°Р»СЊС€Рµ.
    }
  }

  function settle(finalValues: PresetValues): void {
    if (_settled) return;
    _settled = true;
    _loopRunning = false;
    try {
      emit(finalValues);
    } finally {
      _resolve();
    }
  }

  function tick(ts?: number): void {
    if (_settled) {
      _loopRunning = false;
      return;
    }
    if (_tickActive) return;

    if (_paused) {
      _loopRunning = false;
      _lastRealTs = undefined;
      return;
    }

    _tickActive = true;
    try {
      _frameCount++;
      if (_frameCount >= MAX_FRAMES) {
        // Safety cap вЂ” РІС‹С…РѕРґРёРј РІ РўР•РљРЈР©Р•Р™ РїРѕР·РёС†РёРё (РЅРµ В«РµСЃС‚РµСЃС‚РІРµРЅРЅС‹Р№В» С„РёРЅР°Р»).
        settle(samplePreset(compiled, _vt));
        return;
      }

      let dt: number;
      if (ts !== undefined) {
        dt = _lastRealTs !== undefined ? (ts - _lastRealTs) / 1000 : FIXED_DT_S;
        _lastRealTs = ts;
      } else {
        dt = FIXED_DT_S;
      }
      if (dt <= 0) dt = FIXED_DT_S;

      _vt += dt;

      if (totalDuration !== Infinity && _vt >= totalDuration) {
        _vt = totalDuration;
        settle(samplePreset(compiled, totalDuration));
        return;
      }

      emit(samplePreset(compiled, _vt));
    } finally {
      _tickActive = false;
    }

    if (_useTimeoutFallback) {
      setTimeout(tick, 0);
    } else {
      const h = scheduleFrame(tick);
      if (h === 0) {
        _useTimeoutFallback = true;
        setTimeout(tick, 0);
      }
    }
  }

  function ensureLoop(): void {
    if (_loopRunning || _settled || _paused) return;
    _loopRunning = true;
    const h = scheduleFrame(tick);
    if (h === 0) {
      _useTimeoutFallback = true;
      setTimeout(tick, 0);
    }
  }

  // в”Ђв”Ђ Reduced-motion CHARACTER-switch вЂ” СЃРёРЅС…СЂРѕРЅРЅРѕ, РґРѕ СЃС‚Р°СЂС‚Р° Р»СѓРїР° в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
  if (reduce) {
    if (compiled.repeat === Infinity) {
      settle(samplePreset(compiled, 0)); // РЅРµР№С‚СЂР°Р»СЊРЅР°СЏ РїРѕР·Р° ambient-Р»СѓРїР°
    } else {
      _vt = totalDuration;
      settle(samplePreset(compiled, totalDuration)); // С„РёРЅР°Р»СЊРЅР°СЏ РїРѕР·Р°
    }
  } else {
    ensureLoop();
  }

  const controls: PresetControls = {
    get totalDuration(): number {
      return totalDuration;
    },
    get time(): number {
      return _vt;
    },
    get progress(): number {
      if (_settled) return 1;
      const active = Math.max(0, _vt - compiled.delay);
      const cycleLen = compiled.duration + compiled.repeatDelay;
      const totalCycles = compiled.repeat === Infinity ? Infinity : compiled.repeat + 1;
      let cycleIndex = Math.floor(active / cycleLen);
      if (totalCycles !== Infinity && cycleIndex >= totalCycles) cycleIndex = totalCycles - 1;
      const local = active - Math.max(0, cycleIndex) * cycleLen;
      const p = local <= compiled.duration ? local / compiled.duration : 1;
      return Math.min(1, Math.max(0, p));
    },

    play(): void {
      if (_settled) return;
      if (!_paused) return;
      _paused = false;
      _lastRealTs = undefined;
      ensureLoop();
    },

    pause(): void {
      _paused = true;
    },

    seek(t: number): void {
      if (_settled) return;
      if (Number.isNaN(t)) return;
      if (t === Infinity) {
        controls.complete();
        return;
      }
      const upper = totalDuration === Infinity ? Number.MAX_VALUE : totalDuration;
      _vt = Math.max(0, Math.min(upper, t));
      _lastRealTs = undefined;
      emit(samplePreset(compiled, _vt));
    },

    complete(): void {
      if (_settled) return;
      if (compiled.repeat === Infinity) {
        settle(samplePreset(compiled, 0)); // РЅРµР№С‚СЂР°Р»СЊРЅР°СЏ РїРѕР·Р° вЂ” Сѓ Р»СѓРїР° РЅРµС‚ С„РёРЅР°Р»Р°
        return;
      }
      _vt = totalDuration;
      settle(samplePreset(compiled, totalDuration));
    },

    cancel(): void {
      if (_settled) return;
      settle(samplePreset(compiled, _vt));
    },

    then<TResult1 = void, TResult2 = never>(
      onfulfilled?: ((value: void) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ): Promise<TResult1 | TResult2> {
      return _promise.then(onfulfilled, onrejected);
    },
  };

  return controls;
}

// в”Ђв”Ђв”Ђ presetToWaapi: С‡РёСЃС‚С‹Р№ РєРѕРЅРІРµСЂС‚РµСЂ РІ РґР°РЅРЅС‹Рµ element.animate() в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ

/** РћРґРёРЅ WAAPI-РєРµР№С„СЂРµР№Рј: offset + СЃРѕР±СЂР°РЅРЅС‹Рµ CSS-СЃРІРѕР№СЃС‚РІР°. */
export interface WaapiKeyframe {
  readonly offset: number;
  readonly transform?: string;
  readonly opacity?: number;
}

/** РўР°Р№РјРёРЅРі РґР»СЏ element.animate(): РґР»РёС‚РµР»СЊРЅРѕСЃС‚Рё РІ РњРР›Р›РРЎР•РљРЈРќР”РђРҐ. */
export interface WaapiTiming {
  readonly duration: number;
  readonly delay: number;
  readonly iterations: number;
  readonly direction: 'normal' | 'alternate';
  readonly fill: 'both';
  readonly easing: 'linear';
}

/** РљР°РЅР°Р» progress: РЅРµ РІС‹СЂР°Р¶Р°РµС‚СЃСЏ CSS-СЃРІРѕР№СЃС‚РІРѕРј, РїРѕС‚СЂРµР±РёС‚РµР»СЊ РІРµРґС‘С‚ РµРіРѕ СЃР°Рј. */
export interface WaapiProgressTrack {
  readonly offsets: readonly number[];
  readonly values: readonly number[];
}

export interface WaapiConversion {
  readonly keyframes: readonly WaapiKeyframe[];
  readonly timing: WaapiTiming;
  readonly progressTrack?: WaapiProgressTrack;
}

/** РџР»РѕС‚РЅРѕСЃС‚СЊ СЂР°РІРЅРѕРјРµСЂРЅРѕР№ СЃРµС‚РєРё offset'РѕРІ (РёРЅС‚РµСЂРІР°Р»РѕРІ) РїРѕРІРµСЂС… С‚РѕС‡РµРє times. */
const WAAPI_GRID_INTERVALS = 24;

/**
 * РљРѕРЅРІРµСЂС‚РёСЂСѓРµС‚ РїСЂРµСЃРµС‚ РІ РґР°РЅРЅС‹Рµ РґР»СЏ element.animate() вЂ” headless: РїСЂРѕРёР·РІРѕРґРёС‚
 * РўРћР›Р¬РљРћ РґР°РЅРЅС‹Рµ (keyframes + timing), DOM-РІС‹Р·РѕРІ РґРµР»Р°РµС‚ РїРѕС‚СЂРµР±РёС‚РµР»СЊ.
 *
 * РЎРµРјР°РЅС‚РёРєР° easing СЃРѕС…СЂР°РЅСЏРµС‚СЃСЏ РїР»РѕС‚РЅРѕР№ СЃРµС‚РєРѕР№ offset'РѕРІ: РІ РєР°Р¶РґРѕР№ С‚РѕС‡РєРµ
 * Р·РЅР°С‡РµРЅРёРµ РІС‹С‡РёСЃР»РµРЅРѕ С‚РѕС‡РЅРѕ (sampleKeyframes), РјРµР¶РґСѓ С‚РѕС‡РєР°РјРё WAAPI
 * РёРЅС‚РµСЂРїРѕР»РёСЂСѓРµС‚ Р»РёРЅРµР№РЅРѕ (timing.easing='linear').
 *
 * transform СЃРѕР±РёСЂР°РµС‚СЃСЏ РІ С„РёРєСЃ-РїРѕСЂСЏРґРєРµ translate в†’ rotate в†’ scale;
 * РѕСЃРё РјР°СЃС€С‚Р°Р±Р° РїРµСЂРµРјРЅРѕР¶Р°СЋС‚СЃСЏ: sx = scaleВ·scaleX, sy = scaleВ·scaleY.
 *
 * @throws MotionParamError РїСЂРё РЅРµРІР°Р»РёРґРЅРѕР№ СЃРїРµРєРµ Рё РїСЂРё repeatDelay > 0
 *   (РІ WAAPI РЅРµС‚ РЅР°С‚РёРІРЅРѕРіРѕ repeatDelay; С‡РµСЃС‚РЅС‹Р№ РѕС‚РєР°Р· РІРјРµСЃС‚Рѕ С‚РёС…Рѕ-РЅРµРІРµСЂРЅРѕР№
 *   СЃРµРјР°РЅС‚РёРєРё вЂ” РґР»СЏ repeatDelay РёСЃРїРѕР»СЊР·СѓР№С‚Рµ runPreset).
 */
export function presetToWaapi(spec: PresetSpec | CompiledPreset): WaapiConversion {
  const compiled = isCompiled(spec) ? spec : compilePreset(spec);
  if (compiled.repeatDelay > 0) {
    throw new MotionParamError(
      'presets: presetToWaapi РЅРµ РїРѕРґРґРµСЂР¶РёРІР°РµС‚ repeatDelay > 0 (РІ WAAPI РЅРµС‚ РїР°СѓР·С‹ РјРµР¶РґСѓ РёС‚РµСЂР°С†РёСЏРјРё) вЂ” РёСЃРїРѕР»СЊР·СѓР№С‚Рµ runPreset',
    );
  }

  // Offsets: С‚РѕС‡РєРё times РІСЃРµС… С‚СЂРµРєРѕРІ в€Є СЂР°РІРЅРѕРјРµСЂРЅР°СЏ СЃРµС‚РєР° (РґРµРґСѓРї С‡РµСЂРµР· Set).
  const offsetSet = new Set<number>();
  for (let i = 0; i <= WAAPI_GRID_INTERVALS; i++) offsetSet.add(i / WAAPI_GRID_INTERVALS);
  for (const track of compiled.tracks) {
    for (const t of track.times) offsetSet.add(t);
  }
  const offsets = [...offsetSet].sort((a, b) => a - b);

  const has = (p: PresetProperty): boolean =>
    compiled.tracks.some((track) => track.property === p);
  const hasTranslate = has('x') || has('y');
  const hasRotate = has('rotate');
  const hasScale = has('scale') || has('scaleX') || has('scaleY');
  const hasOpacity = has('opacity');
  const hasProgress = has('progress');
  const hasCss = hasTranslate || hasRotate || hasScale || hasOpacity;

  const sampleTrackAt = (p: PresetProperty, offset: number): number | undefined => {
    const track = compiled.tracks.find((t) => t.property === p);
    if (!track) return undefined;
    return clampFinite(sampleKeyframes(track.values, track.times, track.easings, offset));
  };

  const keyframes: WaapiKeyframe[] = [];
  const progressOffsets: number[] = [];
  const progressValues: number[] = [];

  for (const offset of offsets) {
    if (hasCss) {
      const parts: string[] = [];
      if (hasTranslate) {
        const x = sampleTrackAt('x', offset) ?? 0;
        const y = sampleTrackAt('y', offset) ?? 0;
        parts.push(`translate(${x}px, ${y}px)`);
      }
      if (hasRotate) {
        parts.push(`rotate(${sampleTrackAt('rotate', offset)!}deg)`);
      }
      if (hasScale) {
        const s = sampleTrackAt('scale', offset) ?? 1;
        const sx = s * (sampleTrackAt('scaleX', offset) ?? 1);
        const sy = s * (sampleTrackAt('scaleY', offset) ?? 1);
        parts.push(`scale(${sx}, ${sy})`);
      }
      const kf: { offset: number; transform?: string; opacity?: number } = { offset };
      if (parts.length > 0) kf.transform = parts.join(' ');
      if (hasOpacity) kf.opacity = sampleTrackAt('opacity', offset)!;
      keyframes.push(kf);
    }
    if (hasProgress) {
      progressOffsets.push(offset);
      progressValues.push(sampleTrackAt('progress', offset)!);
    }
  }

  const conversion: {
    keyframes: readonly WaapiKeyframe[];
    timing: WaapiTiming;
    progressTrack?: WaapiProgressTrack;
  } = {
    keyframes,
    timing: {
      duration: compiled.duration * 1000,
      delay: compiled.delay * 1000,
      iterations: compiled.repeat === Infinity ? Infinity : compiled.repeat + 1,
      direction: compiled.repeatType === 'reverse' ? 'alternate' : 'normal',
      fill: 'both',
      easing: 'linear',
    },
  };
  if (hasProgress) {
    conversion.progressTrack = { offsets: progressOffsets, values: progressValues };
  }
  return conversion;
}
