from pathlib import Path

p = Path('src/projection/geometry.ts')
s = p.read_text()

old = '''  if (t === 0) return x + 0;\n  if (t === 1) return y + 0;'''
new = '''  if (t === 1) return y + 0;'''
assert s.count(old) == 1, f'lerp endpoint guards={s.count(old)}'
s = s.replace(old, new, 1)

old = '''          let rx = finite(finite(rf.x) + (finite(rl.x) - finite(rf.x)) * tc);\n          let ry = finite(finite(rf.y) + (finite(rl.y) - finite(rf.y)) * tc);'''
new = '''          let rx = lerp1(rf.x, rl.x, tc);\n          let ry = lerp1(rf.y, rl.y, tc);'''
assert s.count(old) == 1, f'projector radii affine={s.count(old)}'
s = s.replace(old, new, 1)

p.write_text(s)
