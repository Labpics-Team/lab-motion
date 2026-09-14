from pathlib import Path
import os


def replace1(s: str, old: str, new: str, label: str) -> str:
    n = s.count(old)
    assert n == 1, f'{label}: {n}'
    return s.replace(old, new, 1)


def rebase_target() -> None:
    p = Path('src/projection/driver.ts')
    s = p.read_text()
    s = replace1(
        s,
        '''function rebaseNode(\n  id: string,\n  target: Omit<ProjectionPlayNode, 'id'>,\n  src: VectorProjectionNode,''',
        '''function rebaseNode(\n  target: ProjectionPlayNode,\n  src: VectorProjectionNode,''',
        'rebase signature',
    )
    s = replace1(s, '    id,\n    parent: target.parent,', '    id: target.id,\n    parent: target.parent,', 'rebase id owner')
    s = replace1(
        s,
        'return rebaseNode(n.id, n, old, pPrev, positionBasisPrev);',
        'return rebaseNode(n, old, pPrev, positionBasisPrev);',
        'play rebase call',
    )
    s = replace1(
        s,
        'rebased.push(rebaseNode(n.id, n, n, p0, springBasis._valueV0));',
        'rebased.push(rebaseNode(n, n, p0, springBasis._valueV0));',
        'release rebase call',
    )
    p.write_text(s)


def rebase_required() -> None:
    p = Path('src/projection/driver.ts')
    s = p.read_text()
    s = replace1(s, '  positionBasisValue = 0,\n): VectorProjectionNode {', '  positionBasisValue: number,\n): VectorProjectionNode {', 'required basis')
    p.write_text(s)


def axis_first(local_mode: bool = False) -> None:
    p = Path('src/projection/driver.ts')
    s = p.read_text()
    old = '''  if (src._qb === true) {\n    if (x !== 0) out.x = lerp1(src.first.x, src.last.x, clamp01(pHat + x * q));\n    if (y !== 0) out.y = lerp1(src.first.y, src.last.y, clamp01(pHat + y * q));\n  } else {\n    if (x !== 0) out.x = finite(box.x + x * q) + 0;\n    if (y !== 0) out.y = finite(box.y + y * q) + 0;\n  }'''
    if local_mode:
        new = '''  const normalized = src._qb === true;\n  if (x !== 0) out.x = normalized ? lerp1(src.first.x, src.last.x, clamp01(pHat + x * q)) : finite(box.x + x * q) + 0;\n  if (y !== 0) out.y = normalized ? lerp1(src.first.y, src.last.y, clamp01(pHat + y * q)) : finite(box.y + y * q) + 0;'''
    else:
        new = '''  if (x !== 0) out.x = src._qb === true ? lerp1(src.first.x, src.last.x, clamp01(pHat + x * q)) : finite(box.x + x * q) + 0;\n  if (y !== 0) out.y = src._qb === true ? lerp1(src.first.y, src.last.y, clamp01(pHat + y * q)) : finite(box.y + y * q) + 0;'''
    s = replace1(s, old, new, 'driver axis branch')
    p.write_text(s)

    p = Path('src/projection/geometry.ts')
    s = p.read_text()
    old = '''      if (vectorNode._qb === true) {\n        if (bx !== 0) v.x = lerp1(node.first.x, node.last.x, clamp01(t + bx * q));\n        if (by !== 0) v.y = lerp1(node.first.y, node.last.y, clamp01(t + by * q));\n      } else {\n        if (bx !== 0) v.x = finite(v.x + bx * q) + 0;\n        if (by !== 0) v.y = finite(v.y + by * q) + 0;\n      }'''
    if local_mode:
        new = '''      const normalized = vectorNode._qb === true;\n      if (bx !== 0) v.x = normalized ? lerp1(node.first.x, node.last.x, clamp01(t + bx * q)) : finite(v.x + bx * q) + 0;\n      if (by !== 0) v.y = normalized ? lerp1(node.first.y, node.last.y, clamp01(t + by * q)) : finite(v.y + by * q) + 0;'''
    else:
        new = '''      if (bx !== 0) v.x = vectorNode._qb === true ? lerp1(node.first.x, node.last.x, clamp01(t + bx * q)) : finite(v.x + bx * q) + 0;\n      if (by !== 0) v.y = vectorNode._qb === true ? lerp1(node.first.y, node.last.y, clamp01(t + by * q)) : finite(v.y + by * q) + 0;'''
    s = replace1(s, old, new, 'geometry axis branch')
    p.write_text(s)


def q_gate() -> None:
    p = Path('src/projection/geometry.ts')
    s = p.read_text()
    old = '''      const bx = q === 0 ? 0 : (vectorNode._qx ?? 0);\n      const by = q === 0 ? 0 : (vectorNode._qy ?? 0);'''
    new = '''      const bx = vectorNode._qx ?? 0;\n      const by = vectorNode._qy ?? 0;'''
    s = replace1(s, old, new, 'q coefficient gate')
    # Preserve the exact fast-path predicate: coefficients are semantically absent when q=0.
    s = replace1(
        s,
        '      if (vectorNode._qb === true) {',
        '      if (q !== 0 && vectorNode._qb === true) {',
        'bounded q gate',
    )
    old = '''      } else {\n        if (bx !== 0) v.x = finite(v.x + bx * q) + 0;\n        if (by !== 0) v.y = finite(v.y + by * q) + 0;\n      }\n\n      const a = liveAncestor[i];'''
    new = '''      } else if (q !== 0) {\n        if (bx !== 0) v.x = finite(v.x + bx * q) + 0;\n        if (by !== 0) v.y = finite(v.y + by * q) + 0;\n      }\n\n      const a = liveAncestor[i];'''
    s = replace1(s, old, new, 'unbounded q gate')
    s = replace1(
        s,
        '        if (anchorIsLast[i] && bx === 0 && by === 0) {',
        '        if (anchorIsLast[i] && (q === 0 || (bx === 0 && by === 0))) {',
        'root fast path q semantics',
    )
    p.write_text(s)


variant = os.environ['VARIANT']
if variant == 'base':
    pass
elif variant == 'rebase_target':
    rebase_target()
elif variant == 'rebase_required':
    rebase_required()
elif variant == 'rebase_both':
    rebase_target(); rebase_required()
elif variant == 'axis_first':
    axis_first(False)
elif variant == 'axis_local':
    axis_first(True)
elif variant == 'q_gate':
    q_gate()
elif variant == 'rebase_axis':
    rebase_target(); rebase_required(); axis_first(False)
else:
    raise AssertionError(variant)
