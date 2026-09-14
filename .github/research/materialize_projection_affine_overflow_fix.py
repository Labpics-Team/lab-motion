from pathlib import Path

p = Path('src/projection/geometry.ts')
s = p.read_text()

old = '''export function lerp1(a: number, b: number, t: number): number {\n  return finite(finite(a) + (finite(b) - finite(a)) * t) + 0;\n}\n'''
new = '''export function lerp1(a: number, b: number, t: number): number {\n  const x = finite(a);\n  const y = finite(b);\n  if (t === 0) return x + 0;\n  if (t === 1) return y + 0;\n  const d = y - x;\n  return finite(Number.isFinite(d) ? x + d * t : x * (1 - t) + y * t) + 0;\n}\n'''
assert s.count(old) == 1
s = s.replace(old, new, 1)

old = '''function mixInto(first: FlipRect, last: FlipRect, t: number, out: MutableRect): MutableRect {\n  out.x = finite(finite(first.x) + (finite(last.x) - finite(first.x)) * t) + 0;\n  out.y = finite(finite(first.y) + (finite(last.y) - finite(first.y)) * t) + 0;\n  const w = finite(finite(first.width) + (finite(last.width) - finite(first.width)) * t) + 0;\n  const h = finite(finite(first.height) + (finite(last.height) - finite(first.height)) * t) + 0;\n'''
new = '''function mixInto(first: FlipRect, last: FlipRect, t: number, out: MutableRect): MutableRect {\n  out.x = lerp1(first.x, last.x, t);\n  out.y = lerp1(first.y, last.y, t);\n  const w = lerp1(first.width, last.width, t);\n  const h = lerp1(first.height, last.height, t);\n'''
assert s.count(old) == 1
s = s.replace(old, new, 1)

old = '''  let rx = finite(finite(first.x) + (finite(last.x) - finite(first.x)) * t);\n  let ry = finite(finite(first.y) + (finite(last.y) - finite(first.y)) * t);\n'''
new = '''  let rx = lerp1(first.x, last.x, t);\n  let ry = lerp1(first.y, last.y, t);\n'''
assert s.count(old) == 1
s = s.replace(old, new, 1)

old = '''          let rx = finite(finite(rf.x) + (finite(rl.x) - finite(rf.x)) * tc);\n          let ry = finite(finite(rf.y) + (finite(rl.y) - finite(rf.y)) * tc);\n'''
new = '''          let rx = lerp1(rf.x, rl.x, tc);\n          let ry = lerp1(rf.y, rl.y, tc);\n'''
assert s.count(old) == 1
s = s.replace(old, new, 1)

p.write_text(s)
