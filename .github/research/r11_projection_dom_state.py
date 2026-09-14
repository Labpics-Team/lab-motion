from pathlib import Path
import re


def sub1(pattern: str, repl: str, text: str, label: str) -> str:
    out, n = re.subn(pattern, repl, text, count=1, flags=re.S)
    assert n == 1, f'{label}: {n}'
    return out


p = Path('src/projection/dom.ts')
s = p.read_text()

s = sub1(
    r'''function defaultGetScroll\(\): \{ x: number; y: number \} \{.*?\n\}\n\n''',
    '',
    s,
    'remove duplicate default scroll sanitizer',
)
s = s.replace(
    '  const getScroll = options?.getScroll ?? defaultGetScroll;',
    '''  const getScroll =
    options?.getScroll ??
    (() => ({
      x: (globalThis as { scrollX?: number }).scrollX as number,
      y: (globalThis as { scrollY?: number }).scrollY as number,
    }));''',
)

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
s = s.replace('let captured: Map<DomProjectionElement, CapturedEntry> | null = null;', 'let captured: Map<DomProjectionElement, DomEntry> | null = null;')
s = s.replace('let flightEls: Map<string, FlightEntry> | null = null;', 'let flightEls: Map<string, DomEntry> | null = null;')
s = s.replace('const restoreEntry = (entry: FlightEntry): void => {', 'const restoreEntry = (entry: DomEntry): void => {')
s = s.replace('const map = new Map<DomProjectionElement, CapturedEntry>();', 'const map = new Map<DomProjectionElement, DomEntry>();')
s = s.replace(
    '''          radiiFirst =
            flightEntry.radiiFirst !== undefined && flightEntry.radiiLast !== undefined
              ? flightEntry.radiiFirst
              : undefined;''',
    '          radiiFirst = flightEntry.radiiLast === undefined ? undefined : flightEntry.radiiFirst;',
)

s = s.replace(
    '''      interface Measured {
        readonly cap: CapturedEntry;
        readonly last: FlipRect;
        readonly radiiLast: BoxRadii | undefined;
      }
      const measured: Measured[] = [];
      const measuredIds = new Set<string>();
      for (const cap of captured.values()) {''',
    '''      interface Measured {
        readonly cap: DomEntry;
        readonly last: FlipRect;
        readonly radiiLast: BoxRadii | undefined;
      }
      const measured: Measured[] = [];
      const byEl = captured;
      for (const cap of byEl.values()) {''',
)
s = s.replace(
    '''        } catch {
          continue; // узел исчез между capture и play — тихая деградация
        }''',
    '''        } catch {
          byEl.delete(cap.el);
          continue; // узел исчез между capture и play — тихая деградация
        }''',
    1,
)
s = s.replace('        measuredIds.add(cap.id);\n', '')
s = s.replace('      const byEl = captured;\n      const ancestorMemo', '      const ancestorMemo')
s = s.replace(
    'terminal = entry !== undefined && measuredIds.has(entry.id) ? entry.id : memo;',
    'terminal = entry === undefined ? memo : entry.id;',
)
s = s.replace(
    'if (entry !== undefined && measuredIds.has(entry.id)) answer = entry.id;',
    'if (entry !== undefined) answer = entry.id;',
)

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
assert 'measuredIds' not in s
assert 'defaultGetScroll' not in s
p.write_text(s)
