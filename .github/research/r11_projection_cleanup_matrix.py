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
    s = s.replace('  readonly vector: boolean;\n', '')
    s = sub1(r'''  /\*\* Публичный прогресс — всегда \[0,1\]\. \*/\n  let progress = 1;\n''', '', s, 'progress state')
    for line in [
        '    progress = 1;\n',
        '    progress = 0;\n',
        '      progress = clamp01(p);\n',
        '      progress = clamp01(pp);\n',
    ]:
        s = s.replace(line, '')
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


def radius_marker() -> None:
    p = Path('src/projection/dom.ts')
    s = p.read_text()
    s = s.replace('  readonly radiiFirst: BoxRadii | undefined;\n', '  radiiFirst: BoxRadii | undefined;\n')
    s = s.replace('  radiiLast?: BoxRadii | undefined;\n', '')
    s = s.replace(
        '          radiiFirst = flightEntry.radiiLast === undefined ? undefined : flightEntry.radiiFirst;',
        '          radiiFirst = flightEntry.radiiFirst;',
    )
    s = sub1(
        r'''        m\.cap\.radiiLast = m\.radiiLast;\n        m\.cap\.degenerateRestored = false;''',
        '''        if (m.radiiLast === undefined) m.cap.radiiFirst = undefined;
        m.cap.degenerateRestored = false;''',
        s,
        'radius marker promotion',
    )
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
    s = s.replace('if (parts.length < 1 || parts.length > 2) return undefined;', 'if (parts.length > 2) return undefined;')
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
if variant == 'baseline':
    pass
elif variant == 'driver_ssot':
    driver_ssot()
elif variant == 'radius_marker':
    radius_marker()
elif variant == 'radius_parse':
    radius_parse()
elif variant == 'radius_format':
    radius_format()
elif variant == 'combined':
    driver_ssot(); radius_marker(); radius_parse(); radius_format()
else:
    raise AssertionError(variant)
