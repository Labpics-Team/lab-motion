from pathlib import Path


def replace_one(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected one match, got {count}')
    return text.replace(old, new, 1)


geometry_path = Path('src/projection/geometry.ts')
geometry = geometry_path.read_text()
geometry = replace_one(
    geometry,
    """function createProjectorCore(
  nodes: readonly ProjectionNodeInit[],
  positionBasisById?: ReadonlyMap<string, PositionBasisCorrection>,
): ProjectionDriverProjector {""",
    """function createProjectorCore(
  nodes: readonly ProjectionNodeInit[],
  positionBasisById?: ReadonlyMap<string, PositionBasisCorrection>,
  boundPositionBasis = false,
): ProjectionDriverProjector {""",
    'core bounded flag',
)
geometry = replace_one(
    geometry,
    """      if (q !== 0) {
        const bx = positionBasisX?.[i] ?? 0;
        const by = positionBasisY?.[i] ?? 0;
        if (bx !== 0) v.x = finite(v.x + bx * q) + 0;
        if (by !== 0) v.y = finite(v.y + by * q) + 0;
      }

      const a = liveAncestor[i];""",
    """      if (q !== 0) {
        const bx = positionBasisX?.[i] ?? 0;
        const by = positionBasisY?.[i] ?? 0;
        if (bx !== 0) v.x = finite(v.x + bx * q) + 0;
        if (by !== 0) v.y = finite(v.y + by * q) + 0;
        if (boundPositionBasis) {
          v.x = Math.max(Math.min(v.x, Math.max(node.first.x, node.last.x)), Math.min(node.first.x, node.last.x));
          v.y = Math.max(Math.min(v.y, Math.max(node.first.y, node.last.y)), Math.min(node.first.y, node.last.y));
        }
      }

      const a = liveAncestor[i];""",
    'bounded corrected box',
)
geometry = replace_one(
    geometry,
    """export function createDriverProjector(
  nodes: readonly ProjectionNodeInit[],
  positionBasisById: ReadonlyMap<string, PositionBasisCorrection>,
): ProjectionDriverProjector {
  return createProjectorCore(nodes, positionBasisById);
}""",
    """export function createDriverProjector(
  nodes: readonly ProjectionNodeInit[],
  positionBasisById: ReadonlyMap<string, PositionBasisCorrection>,
  bounded = false,
): ProjectionDriverProjector {
  return createProjectorCore(nodes, positionBasisById, bounded);
}""",
    'driver projector bounded seam',
)
geometry_path.write_text(geometry)


driver_path = Path('src/projection/driver.ts')
driver = driver_path.read_text()
driver = replace_one(
    driver,
    "const projector = createDriverProjector(resolved, positionCorrectionById);",
    "const projector = createDriverProjector(resolved, positionCorrectionById, bounded);",
    'play bounded projector',
)
driver = replace_one(
    driver,
    "const projector = createDriverProjector(rebased, positionCorrectionById);",
    "const projector = createDriverProjector(rebased, positionCorrectionById, bounded);",
    'release bounded projector',
)
driver_path.write_text(driver)
