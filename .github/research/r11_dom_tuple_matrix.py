from pathlib import Path
import os
import re


def sub1(pattern: str, repl: str, text: str, label: str) -> str:
    out, n = re.subn(pattern, repl, text, count=1, flags=re.S)
    assert n == 1, f'{label}: {n}'
    return out


def saved_tuple() -> None:
    p = Path('src/projection/dom.ts')
    s = p.read_text()
    # This transform runs after the safe DomEntry ownership pass. It changes only
    # representation of the three inseparable inline snapshots.
    old = '''  readonly savedTransform: string;
  readonly savedOrigin: string;
  readonly savedRadius: string;
'''
    new = '''  readonly saved: readonly [string, string, string];
'''
    assert s.count(old) == 1, f'saved fields={s.count(old)}'
    s = s.replace(old, new, 1)

    old = '''  const restoreEntry = (entry: DomEntry): void => {
    restoreProp(entry.el.style, 'transform', entry.savedTransform);
    restoreProp(entry.el.style, 'transform-origin', entry.savedOrigin);
    restoreProp(entry.el.style, 'border-radius', entry.savedRadius);
  };'''
    new = '''  const restoreEntry = (entry: DomEntry): void => {
    const saved = entry.saved;
    restoreProp(entry.el.style, 'transform', saved[0]);
    restoreProp(entry.el.style, 'transform-origin', saved[1]);
    restoreProp(entry.el.style, 'border-radius', saved[2]);
  };'''
    assert s.count(old) == 1, 'restore saved tuple'
    s = s.replace(old, new, 1)

    old = '''        let savedTransform: string;
        let savedOrigin: string;
        let savedRadius: string;
'''
    new = '''        let saved: readonly [string, string, string];
'''
    assert s.count(old) == 1, 'capture saved locals'
    s = s.replace(old, new, 1)

    old = '''          savedTransform = flightEntry.savedTransform;
          savedOrigin = flightEntry.savedOrigin;
          savedRadius = flightEntry.savedRadius;
'''
    new = '''          saved = flightEntry.saved;
'''
    assert s.count(old) == 1, 'reuse saved tuple'
    s = s.replace(old, new, 1)

    old = '''          savedTransform = safeInline(el, 'transform');
          savedOrigin = safeInline(el, 'transform-origin');
          savedRadius = safeInline(el, 'border-radius');
'''
    new = '''          saved = [
            safeInline(el, 'transform'),
            safeInline(el, 'transform-origin'),
            safeInline(el, 'border-radius'),
          ];
'''
    assert s.count(old) == 1, 'capture saved tuple'
    s = s.replace(old, new, 1)

    old = 'map.set(el, { el, id, first, radiiFirst, savedTransform, savedOrigin, savedRadius });'
    new = 'map.set(el, { el, id, first, radiiFirst, saved });'
    assert s.count(old) == 1, 'capture map saved tuple'
    s = s.replace(old, new, 1)

    # Degenerate frame restore is the only consumer outside restoreEntry.
    old = "restoreProp(style, 'transform', entry.savedTransform);"
    new = "restoreProp(style, 'transform', entry.saved[0]);"
    assert s.count(old) == 1, 'degenerate transform restore'
    s = s.replace(old, new, 1)

    for needle in ('savedTransform', 'savedOrigin', 'savedRadius'):
        assert needle not in s, needle
    p.write_text(s)


def measured_tuple() -> None:
    p = Path('src/projection/dom.ts')
    s = p.read_text()
    old = '''      interface Measured {
        readonly cap: DomEntry;
        readonly last: FlipRect;
        readonly radiiLast: BoxRadii | undefined;
      }
      const measured: Measured[] = [];
'''
    new = '''      type Measured = readonly [DomEntry, FlipRect, BoxRadii | undefined];
      const measured: Measured[] = [];
'''
    assert s.count(old) == 1, f'Measured interface={s.count(old)}'
    s = s.replace(old, new, 1)
    assert s.count('        measured.push({ cap, last, radiiLast });\n') == 1
    s = s.replace('        measured.push({ cap, last, radiiLast });\n', '        measured.push([cap, last, radiiLast]);\n', 1)

    old = '''      const nodes: ProjectionPlayNode[] = measured.map((m) => ({
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
'''
    new = '''      const nodes: ProjectionPlayNode[] = measured.map(([cap, last, radiiLast]) => ({
        id: cap.id,
        parent: findAncestorId(cap.el),
        first: controls.playing && flightEls !== null && flightEls.has(cap.id) ? undefined : cap.first,
        last,
        radii:
          cap.radiiFirst !== undefined && radiiLast !== undefined
            ? { first: cap.radiiFirst, last: radiiLast }
            : undefined,
      }));
'''
    assert s.count(old) == 1, 'nodes measured tuple'
    s = s.replace(old, new, 1)

    old = '''      for (const m of measured) {
        if (m.radiiLast === undefined) m.cap.radiiFirst = undefined;
        m.cap.degenerateRestored = false;
        newFlight.set(m.cap.id, m.cap);
      }
'''
    new = '''      for (const [cap, , radiiLast] of measured) {
        if (radiiLast === undefined) cap.radiiFirst = undefined;
        cap.degenerateRestored = false;
        newFlight.set(cap.id, cap);
      }
'''
    assert s.count(old) == 1, 'promote measured tuple'
    s = s.replace(old, new, 1)

    old = '''        for (const m of measured) {
          m.cap.el.style.setProperty('transform-origin', '0 0');
        }
'''
    new = '''        for (const [cap] of measured) cap.el.style.setProperty('transform-origin', '0 0');
'''
    assert s.count(old) == 1, 'origin measured tuple'
    s = s.replace(old, new, 1)

    for needle in ('m.cap', 'm.last', 'm.radiiLast'):
        assert needle not in s, needle
    p.write_text(s)


variant = os.environ['VARIANT']
if variant == 'base':
    pass
elif variant == 'saved':
    saved_tuple()
elif variant == 'measured':
    measured_tuple()
elif variant == 'both':
    saved_tuple(); measured_tuple()
else:
    raise AssertionError(variant)

# Representation work is not allowed to weaken the hostile-DOM read boundary.
s = Path('src/projection/dom.ts').read_text()
assert "typeof g.scrollX === 'number' && Number.isFinite(g.scrollX)" in s
assert "typeof g.scrollY === 'number' && Number.isFinite(g.scrollY)" in s
assert 'getScrollSafe(getScroll)' in s
