from pathlib import Path
import re

p = Path('src/projection/dom.ts')
s = p.read_text()


def sub1(old: str, new: str, label: str) -> None:
    global s
    if s.count(old) != 1:
        raise AssertionError(f'{label}: expected 1, got {s.count(old)}')
    s = s.replace(old, new, 1)

# defaultGetScroll is always called through getScrollSafe(), which already owns
# try/catch + finite sanitation. Keep only the raw platform read here.
sub1(
"""function defaultGetScroll(): { x: number; y: number } {
  try {
    const g = globalThis as { scrollX?: unknown; scrollY?: unknown };
    const x = typeof g.scrollX === 'number' && Number.isFinite(g.scrollX) ? g.scrollX : 0;
    const y = typeof g.scrollY === 'number' && Number.isFinite(g.scrollY) ? g.scrollY : 0;
    return { x, y };
  } catch {
    return { x: 0, y: 0 };
  }
}
""",
"""function defaultGetScroll(): { x: number; y: number } {
  const g = globalThis as { scrollX?: number; scrollY?: number };
  return { x: g.scrollX as number, y: g.scrollY as number };
}
""",
'defaultGetScroll',
)

# raw is non-empty here, so split() always yields at least one token.
sub1("if (parts.length < 1 || parts.length > 2) return undefined;", "if (parts.length > 2) return undefined;", 'radius parts guard')
sub1("const y = parseRadiusToken(parts.length === 2 ? parts[1] : parts[0], height);", "const y = parseRadiusToken(parts[1] ?? parts[0], height);", 'radius y token')

# Three saved inline strings travel together through capture -> flight -> restore.
sub1(
"""interface CapturedEntry {
  readonly el: DomProjectionElement;
  readonly id: string;
  readonly first: FlipRect;
  readonly radiiFirst: BoxRadii | undefined;
  readonly savedTransform: string;
  readonly savedOrigin: string;
  readonly savedRadius: string;
}

interface FlightEntry {
  readonly el: DomProjectionElement;
  readonly savedTransform: string;
  readonly savedOrigin: string;
  readonly savedRadius: string;
  readonly radiiFirst: BoxRadii | undefined;
""",
"""type SavedInline = readonly [string, string, string];

interface CapturedEntry {
  readonly el: DomProjectionElement;
  readonly id: string;
  readonly first: FlipRect;
  readonly radiiFirst: BoxRadii | undefined;
  readonly saved: SavedInline;
}

interface FlightEntry {
  readonly el: DomProjectionElement;
  readonly saved: SavedInline;
  readonly radiiFirst: BoxRadii | undefined;
""",
'saved tuple types',
)

sub1(
"""  const restoreEntry = (entry: FlightEntry): void => {
    restoreProp(entry.el.style, 'transform', entry.savedTransform);
    restoreProp(entry.el.style, 'transform-origin', entry.savedOrigin);
    restoreProp(entry.el.style, 'border-radius', entry.savedRadius);
  };
""",
"""  const restoreEntry = (entry: FlightEntry): void => {
    const saved = entry.saved;
    restoreProp(entry.el.style, 'transform', saved[0]);
    restoreProp(entry.el.style, 'transform-origin', saved[1]);
    restoreProp(entry.el.style, 'border-radius', saved[2]);
  };
""",
'restore tuple',
)

sub1(
"""        let savedTransform: string;
        let savedOrigin: string;
        let savedRadius: string;
""",
"""        let saved: SavedInline;
""",
'capture saved locals',
)
sub1(
"""          savedTransform = flightEntry.savedTransform;
          savedOrigin = flightEntry.savedOrigin;
          savedRadius = flightEntry.savedRadius;
""",
"""          saved = flightEntry.saved;
""",
'capture saved from flight',
)
sub1(
"""          savedTransform = safeInline(el, 'transform');
          savedOrigin = safeInline(el, 'transform-origin');
          savedRadius = safeInline(el, 'border-radius');
""",
"""          saved = [
            safeInline(el, 'transform'),
            safeInline(el, 'transform-origin'),
            safeInline(el, 'border-radius'),
          ];
""",
'capture saved from DOM',
)
sub1(
"map.set(el, { el, id, first, radiiFirst, savedTransform, savedOrigin, savedRadius });",
"map.set(el, { el, id, first, radiiFirst, saved });",
'capture map tuple',
)

# Temporary measured records do not need stable property names in the shipped bundle.
sub1(
"""      interface Measured {
        readonly cap: CapturedEntry;
        readonly last: FlipRect;
        readonly radiiLast: BoxRadii | undefined;
      }
      const measured: Measured[] = [];
""",
"""      type Measured = readonly [CapturedEntry, FlipRect, BoxRadii | undefined];
      const measured: Measured[] = [];
""",
'measured tuple type',
)
sub1("measured.push({ cap, last, radiiLast });", "measured.push([cap, last, radiiLast]);", 'measured push')

sub1(
"""      const nodes: ProjectionPlayNode[] = measured.map((m) => ({
        id: m.cap.id,
        parent: findAncestorId(m.cap.el),
        // Узел ВСЁ ЕЩЁ активного полёта → first: undefined: visual pickup
        // V(p̂)/radii/opacity считает драйвер на момент play — C⁰ и при
        // отложенном play (пружина уехала после capture). Новый узел — снимок.
        first:
          controls.playing && flightEls !== null && flightEls.has(m.cap.id)
            ? undefined
            : m.cap.first,
        last: m.last,
        radii:
          m.cap.radiiFirst !== undefined && m.radiiLast !== undefined
            ? { first: m.cap.radiiFirst, last: m.radiiLast }
            : undefined,
      }));
""",
"""      const nodes: ProjectionPlayNode[] = measured.map(([cap, last, radiiLast]) => ({
        id: cap.id,
        parent: findAncestorId(cap.el),
        // Узел ВСЁ ЕЩЁ активного полёта → first: undefined: visual pickup
        // V(p̂)/radii/opacity считает драйвер на момент play — C⁰ и при
        // отложенном play (пружина уехала после capture). Новый узел — снимок.
        first: controls.playing && flightEls !== null && flightEls.has(cap.id) ? undefined : cap.first,
        last,
        radii:
          cap.radiiFirst !== undefined && radiiLast !== undefined
            ? { first: cap.radiiFirst, last: radiiLast }
            : undefined,
      }));
""",
'nodes measured tuple',
)

sub1(
"""      for (const m of measured) {
        newFlight.set(m.cap.id, {
          el: m.cap.el,
          savedTransform: m.cap.savedTransform,
          savedOrigin: m.cap.savedOrigin,
          savedRadius: m.cap.savedRadius,
          radiiFirst: m.cap.radiiFirst,
          radiiLast: m.radiiLast,
          degenerateRestored: false,
        });
      }
""",
"""      for (const [cap, , radiiLast] of measured) {
        newFlight.set(cap.id, {
          el: cap.el,
          saved: cap.saved,
          radiiFirst: cap.radiiFirst,
          radiiLast,
          degenerateRestored: false,
        });
      }
""",
'new flight tuple',
)
sub1(
"""        for (const m of measured) {
          m.cap.el.style.setProperty('transform-origin', '0 0');
        }
""",
"""        for (const [cap] of measured) cap.el.style.setProperty('transform-origin', '0 0');
""",
'origin tuple',
)

# No stale named fields may survive the refactor.
for needle in ('savedTransform', 'savedOrigin', 'savedRadius', 'm.cap', 'm.last', 'm.radiiLast'):
    if needle in s:
        raise AssertionError(f'stale token: {needle}')

p.write_text(s)
