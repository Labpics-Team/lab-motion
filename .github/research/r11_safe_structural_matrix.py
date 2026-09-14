from pathlib import Path
import os
import re


def sub1(pattern: str, repl: str, text: str, label: str) -> str:
    out, n = re.subn(pattern, repl, text, count=1, flags=re.S)
    assert n == 1, f'{label}: {n}'
    return out


def driver_ssot() -> None:
    p = Path('src/projection/driver.ts')
    s = p.read_text()
    assert s.count('  readonly vector: boolean;\n') == 1
    s = s.replace('  readonly vector: boolean;\n', '')
    s = sub1(r'''  /\*\* Публичный прогресс — всегда \[0,1\]\. \*/\n  let progress = 1;\n''', '', s, 'progress state')
    for line in [
        '    progress = 1;\n',
        '    progress = 0;\n',
        '      progress = clamp01(p);\n',
        '      progress = clamp01(pp);\n',
    ]:
        assert line in s, line
        s = s.replace(line, '')
    assert s.count('flight = { byId, projector, reduced, vector };') == 1
    assert s.count('flight = { byId, projector, reduced, vector: false };') == 1
    s = s.replace('flight = { byId, projector, reduced, vector };', 'flight = { byId, projector, reduced };')
    s = s.replace('flight = { byId, projector, reduced, vector: false };', 'flight = { byId, projector, reduced };')
    s = sub1(
        r'''    get progress\(\): number \{\n      return progress;\n    \},''',
        '''    get progress(): number {
      return clamp01(pHat);
    },''',
        s,
        'progress getter',
    )
    assert 'readonly vector:' not in s
    assert 'let progress =' not in s
    p.write_text(s)


def dom_reuse() -> None:
    p = Path('src/projection/dom.ts')
    s = p.read_text()
    # Deliberately keep defaultGetScroll/getScrollSafe byte-for-byte: this slice
    # changes only state ownership, never the hostile-DOM safety boundary.
    scroll_guard = s[s.index('function defaultGetScroll'):s.index('// ─── Адаптер')]
    s = sub1(
        r'''interface CapturedEntry \{.*?\n\}\n\ninterface FlightEntry \{.*?\n\}\n''',
        '''interface DomEntry {
  readonly el: DomProjectionElement;
  readonly id: string;
  readonly first: FlipRect;
  readonly radiiFirst: BoxRadii | undefined;
  readonly savedTransform: string;
  readonly savedOrigin: string;
  readonly savedRadius: string;
  radiiLast?: BoxRadii | undefined;
  degenerateRestored?: boolean;
}
''',
        s,
        'unify DOM entry ownership',
    )
    replacements = {
        'let captured: Map<DomProjectionElement, CapturedEntry> | null = null;': 'let captured: Map<DomProjectionElement, DomEntry> | null = null;',
        'let flightEls: Map<string, FlightEntry> | null = null;': 'let flightEls: Map<string, DomEntry> | null = null;',
        "const restoreEntry = (entry: FlightEntry): void => {": "const restoreEntry = (entry: DomEntry): void => {",
        'const map = new Map<DomProjectionElement, CapturedEntry>();': 'const map = new Map<DomProjectionElement, DomEntry>();',
        'readonly cap: CapturedEntry;': 'readonly cap: DomEntry;',
    }
    for old, new in replacements.items():
        assert s.count(old) == 1, old
        s = s.replace(old, new, 1)
    s = sub1(
        r'''      const newFlight = new Map<string, FlightEntry>\(\);\n      for \(const m of measured\) \{\n        newFlight\.set\(m\.cap\.id, \{\n          el: m\.cap\.el,\n          savedTransform: m\.cap\.savedTransform,\n          savedOrigin: m\.cap\.savedOrigin,\n          savedRadius: m\.cap\.savedRadius,\n          radiiFirst: m\.cap\.radiiFirst,\n          radiiLast: m\.radiiLast,\n          degenerateRestored: false,\n        \}\);\n      \}''',
        '''      const newFlight = new Map<string, DomEntry>();
      for (const m of measured) {
        m.cap.radiiLast = m.radiiLast;
        m.cap.degenerateRestored = false;
        newFlight.set(m.cap.id, m.cap);
      }''',
        s,
        'promote captured entries in place',
    )
    assert 'CapturedEntry' not in s
    assert 'FlightEntry' not in s
    assert s[s.index('function defaultGetScroll'):s.index('// ─── Адаптер')] == scroll_guard
    p.write_text(s)


def measured_owner() -> None:
    p = Path('src/projection/dom.ts')
    s = p.read_text()
    cap_type = 'DomEntry' if 'interface DomEntry {' in s else 'CapturedEntry'
    old = f'''      const measured: Measured[] = [];
      const measuredIds = new Set<string>();
      for (const cap of captured.values()) {{'''
    new = '''      const measured: Measured[] = [];
      const byEl = captured;
      for (const cap of byEl.values()) {'''
    assert s.count(old) == 1
    s = s.replace(old, new, 1)
    old_catch = '''        } catch {
          continue; // узел исчез между capture и play — тихая деградация
        }'''
    new_catch = '''        } catch {
          byEl.delete(cap.el);
          continue; // узел исчез между capture и play — тихая деградация
        }'''
    assert s.count(old_catch) == 1
    s = s.replace(old_catch, new_catch, 1)
    assert s.count('        measuredIds.add(cap.id);\n') == 1
    s = s.replace('        measuredIds.add(cap.id);\n', '', 1)
    assert s.count('      const byEl = captured;\n      const ancestorMemo') == 1
    s = s.replace('      const byEl = captured;\n      const ancestorMemo', '      const ancestorMemo', 1)
    assert s.count('terminal = entry !== undefined && measuredIds.has(entry.id) ? entry.id : memo;') == 1
    s = s.replace(
        'terminal = entry !== undefined && measuredIds.has(entry.id) ? entry.id : memo;',
        'terminal = entry === undefined ? memo : entry.id;',
        1,
    )
    assert s.count('if (entry !== undefined && measuredIds.has(entry.id)) answer = entry.id;') == 1
    s = s.replace(
        'if (entry !== undefined && measuredIds.has(entry.id)) answer = entry.id;',
        'if (entry !== undefined) answer = entry.id;',
        1,
    )
    assert 'measuredIds' not in s
    assert f'readonly cap: {cap_type};' in s
    p.write_text(s)


def radius_marker() -> None:
    p = Path('src/projection/dom.ts')
    s = p.read_text()
    assert 'interface DomEntry {' in s, 'radius marker requires unified entry owner'
    assert s.count('  readonly radiiFirst: BoxRadii | undefined;\n') == 1
    s = s.replace('  readonly radiiFirst: BoxRadii | undefined;\n', '  radiiFirst: BoxRadii | undefined;\n', 1)
    assert s.count('  radiiLast?: BoxRadii | undefined;\n') == 1
    s = s.replace('  radiiLast?: BoxRadii | undefined;\n', '', 1)
    old = '''          radiiFirst =
            flightEntry.radiiFirst !== undefined && flightEntry.radiiLast !== undefined
              ? flightEntry.radiiFirst
              : undefined;'''
    assert s.count(old) == 1
    s = s.replace(old, '          radiiFirst = flightEntry.radiiFirst;', 1)
    old = '''        m.cap.radiiLast = m.radiiLast;
        m.cap.degenerateRestored = false;'''
    new = '''        if (m.radiiLast === undefined) m.cap.radiiFirst = undefined;
        m.cap.degenerateRestored = false;'''
    assert s.count(old) == 1
    s = s.replace(old, new, 1)
    assert 'radiiLast?:' not in s
    assert 'flightEntry.radiiLast' not in s
    assert 'm.cap.radiiLast' not in s
    p.write_text(s)


def radius_parse() -> None:
    p = Path('src/projection/dom.ts')
    s = p.read_text()
    s = sub1(
        r'''function parseRadiusToken\(token: string, base: number\): number \| null \{.*?\n\}''',
        '''function parseRadiusToken(token: string, base: number): number | null {
  const percent = token.endsWith('%');
  if (!percent && !token.endsWith('px')) return null;
  const n = Number(token.slice(0, percent ? -1 : -2));
  return Number.isFinite(n) ? (percent ? (n * base) / 100 : n) : null;
}''',
        s,
        'radius parser',
    )
    assert s.count('if (parts.length < 1 || parts.length > 2) return undefined;') == 1
    s = s.replace('if (parts.length < 1 || parts.length > 2) return undefined;', 'if (parts.length > 2) return undefined;', 1)
    p.write_text(s)


def radius_format() -> None:
    p = Path('src/projection/dom.ts')
    s = p.read_text()
    s = sub1(
        r'''          `\$\{radii\[0\]\.x\}px \$\{radii\[1\]\.x\}px \$\{radii\[2\]\.x\}px \$\{radii\[3\]\.x\}px / ` \+\n            `\$\{radii\[0\]\.y\}px \$\{radii\[1\]\.y\}px \$\{radii\[2\]\.y\}px \$\{radii\[3\]\.y\}px`,''',
        '''          `${radii[0].x}px ${radii[1].x}px ${radii[2].x}px ${radii[3].x}px / ${radii[0].y}px ${radii[1].y}px ${radii[2].y}px ${radii[3].y}px`,''',
        s,
        'radius formatter',
    )
    p.write_text(s)


variant = os.environ['VARIANT']
if variant == 'baseline' or variant == 'shared':
    pass
elif variant == 'driver':
    driver_ssot()
elif variant == 'dom_reuse':
    dom_reuse()
elif variant == 'measured_owner':
    measured_owner()
elif variant == 'dom_safe':
    dom_reuse(); measured_owner()
elif variant == 'all_safe':
    driver_ssot(); dom_reuse(); measured_owner(); radius_marker(); radius_parse(); radius_format()
else:
    raise AssertionError(variant)

# All variants must retain the hostile-global scroll boundary. The matrix is not
# allowed to earn bytes by deleting correctness checks.
dom = Path('src/projection/dom.ts').read_text()
assert 'function defaultGetScroll()' in dom
assert "typeof g.scrollX === 'number' && Number.isFinite(g.scrollX)" in dom
assert "typeof g.scrollY === 'number' && Number.isFinite(g.scrollY)" in dom
assert 'getScrollSafe(getScroll)' in dom
