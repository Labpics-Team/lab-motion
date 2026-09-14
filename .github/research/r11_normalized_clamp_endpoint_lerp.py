from pathlib import Path

p = Path('src/projection/geometry.ts')
s = p.read_text()
old = '''export function lerp1(a: number, b: number, t: number): number {\n  return finite(finite(a) + (finite(b) - finite(a)) * t) + 0;\n}\n'''
new = '''export function lerp1(a: number, b: number, t: number): number {\n  if (t === 0) return finite(a) + 0;\n  if (t === 1) return finite(b) + 0;\n  return finite(finite(a) + (finite(b) - finite(a)) * t) + 0;\n}\n'''
assert s.count(old) == 1, f'lerp1 anchor count={s.count(old)}'
p.write_text(s.replace(old, new, 1))
