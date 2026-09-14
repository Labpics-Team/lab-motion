from pathlib import Path


def replace1(text: str, old: str, new: str, label: str) -> str:
    assert text.count(old) == 1, f'{label}: {text.count(old)}'
    return text.replace(old, new, 1)


g = Path('src/projection/geometry.ts')
s = g.read_text()
s = replace1(
    s,
    '''interface DriverProjectionNodeInit extends ProjectionNodeInit {\n  _qx?: number;\n  _qy?: number;\n  _qb?: true;\n}\n\nexport function createProjector(nodes: readonly ProjectionNodeInit[]): Projector {''',
    '''interface DriverProjectionNodeInit extends ProjectionNodeInit {\n  _qx?: number;\n  _qy?: number;\n}\n\n// Public declaration stays one-argument; the implementation's second argument is\n// an internal driver seam and is erased from the emitted declaration surface.\nexport function createProjector(nodes: readonly ProjectionNodeInit[]): Projector;\nexport function createProjector(nodes: readonly ProjectionNodeInit[], bounded = false): Projector {''',
    'geometry flight bound signature',
)
s = replace1(
    s,
    '''      if (vectorNode._qb === true) {\n        if (bx !== 0) v.x = lerp1(node.first.x, node.last.x, clamp01(t + bx * q));\n        if (by !== 0) v.y = lerp1(node.first.y, node.last.y, clamp01(t + by * q));\n      } else {''',
    '''      if (bounded) {\n        if (bx !== 0) v.x = lerp1(node.first.x, node.last.x, clamp01(t + bx * q));\n        if (by !== 0) v.y = lerp1(node.first.y, node.last.y, clamp01(t + by * q));\n      } else {''',
    'geometry bounded owner',
)
assert '_qb' not in s
g.write_text(s)


d = Path('src/projection/driver.ts')
s = d.read_text()
s = replace1(
    s,
    '''interface VectorProjectionNode extends ProjectionNodeInit {\n  _qx?: number;\n  _qy?: number;\n  _qb?: true;\n}''',
    '''interface VectorProjectionNode extends ProjectionNodeInit {\n  _qx?: number;\n  _qy?: number;\n}''',
    'driver remove per-node bounded marker',
)
s = replace1(
    s,
    '''function boxWithPositionBasis(src: VectorProjectionNode, pHat: number, q: number): FlipRect {''',
    '''function boxWithPositionBasis(src: VectorProjectionNode, pHat: number, q: number, bounded: boolean): FlipRect {''',
    'box bounded parameter',
)
s = replace1(s, '  if (src._qb === true) {', '  if (bounded) {', 'box bounded branch')
s = replace1(
    s,
    '''  positionBasisValue = 0,\n): VectorProjectionNode {''',
    '''  positionBasisValue = 0,\n  bounded = false,\n): VectorProjectionNode {''',
    'rebase bounded parameter',
)
s = replace1(
    s,
    '''    first: boxWithPositionBasis(src, pHat, positionBasisValue),''',
    '''    first: boxWithPositionBasis(src, pHat, positionBasisValue, bounded),''',
    'rebase bounded box call',
)
s = replace1(
    s,
    '''          return rebaseNode(n.id, n, old, pPrev, positionBasisPrev);''',
    '''          return rebaseNode(n.id, n, old, pPrev, positionBasisPrev, bounded);''',
    'play bounded rebase call',
)
s = replace1(
    s,
    '''        rebased.push(rebaseNode(n.id, n, n, p0, springBasis._valueV0));''',
    '''        rebased.push(rebaseNode(n.id, n, n, p0, springBasis._valueV0, bounded));''',
    'release bounded rebase call',
)
s = replace1(
    s,
    '''          const oldVx = old._qb === true\n            ? finite(oldRx * visibleVelocity(pPrev + oldX * positionBasisPrev, vPrev + oldX * positionBasisVelocityPrev))\n            : finite(oldRx * vPrev + oldX * positionBasisVelocityPrev);\n          const oldVy = old._qb === true\n            ? finite(oldRy * visibleVelocity(pPrev + oldY * positionBasisPrev, vPrev + oldY * positionBasisVelocityPrev))\n            : finite(oldRy * vPrev + oldY * positionBasisVelocityPrev);''',
    '''          const oldVx = finite(oldRx * visibleVelocity(\n            pPrev + oldX * positionBasisPrev,\n            vPrev + oldX * positionBasisVelocityPrev,\n          ));\n          const oldVy = finite(oldRy * visibleVelocity(\n            pPrev + oldY * positionBasisPrev,\n            vPrev + oldY * positionBasisVelocityPrev,\n          ));''',
    'unify visible boundary velocity',
)
s = replace1(s, '            if (bounded) node._qb = true;\n', '', 'remove bounded marker write')
projector_call = '''(createProjector as unknown as (\n        nodes: readonly ProjectionNodeInit[],\n        bounded: boolean,\n      ) => Projector)'''
s = replace1(
    s,
    '''      const projector = createProjector(resolved);''',
    f'''      const projector = {projector_call}(resolved, bounded);''',
    'pass play flight bounded to projector',
)
s = replace1(
    s,
    '''      const projector = createProjector(rebased);''',
    f'''      const projector = {projector_call}(rebased, bounded);''',
    'pass release flight bounded to projector',
)
s = replace1(
    s,
    ''': boxWithPositionBasis(node, pHat, springBasis._valueV0);''',
    ''': boxWithPositionBasis(node, pHat, springBasis._valueV0, bounded);''',
    'boxAt bounded call',
)
assert '_qb' not in s
d.write_text(s)
