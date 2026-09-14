from pathlib import Path


def replace_one(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected one match, got {count}')
    return text.replace(old, new, 1)


driver_path = Path('src/projection/driver.ts')
driver = driver_path.read_text()

driver = replace_one(
    driver,
    """interface PositionCorrection {
  readonly x: number;
  readonly y: number;
}

function boxWithPositionBasis(""",
    """interface PositionCorrection {
  readonly x: number;
  readonly y: number;
}

const EMPTY_POSITION_CORRECTIONS: ReadonlyMap<string, PositionCorrection> = new Map();

function boxWithPositionBasis(""",
    'shared empty correction map',
)

driver = replace_one(
    driver,
    """      generation++;
      phase = 'canceled';
      vHat = 0;
      throw error;""",
    """      generation++;
      phase = 'canceled';
      vHat = 0;
      positionBasisVelocityHat = 0;
      throw error;""",
    'requestFrame error resets vector velocity',
)

driver = replace_one(
    driver,
    """      generation++;
      phase = 'canceled';
      vHat = 0;
      clearPendingTick();
      throw error;""",
    """      generation++;
      phase = 'canceled';
      vHat = 0;
      positionBasisVelocityHat = 0;
      clearPendingTick();
      throw error;""",
    'onFrame error resets vector velocity',
)

driver = replace_one(
    driver,
    """      const positionCorrectionById = new Map<string, PositionCorrection>();
      if (prevById !== undefined) {""",
    """      let mutablePositionCorrections: Map<string, PositionCorrection> | undefined;
      if (prevById !== undefined) {""",
    'lazy correction map declaration',
)

driver = replace_one(
    driver,
    """          if (correction.x !== 0 || correction.y !== 0) {
            positionCorrectionById.set(node.id, correction);
          }
        }
      }

      // Валидация дерева — рано, до любых эффектов, даже под reduce.
      const projector = createDriverProjector(resolved, positionCorrectionById);""",
    """          if (correction.x !== 0 || correction.y !== 0) {
            (mutablePositionCorrections ??= new Map()).set(node.id, correction);
          }
        }
      }
      const positionCorrectionById =
        mutablePositionCorrections ?? EMPTY_POSITION_CORRECTIONS;

      // Валидация дерева — рано, до любых эффектов, даже под reduce.
      const projector = createDriverProjector(resolved, positionCorrectionById);""",
    'lazy correction map use',
)

driver_path.write_text(driver)


geometry_path = Path('src/projection/geometry.ts')
geometry = geometry_path.read_text()
geometry = replace_one(
    geometry,
    """  const positionBasisX = new Float64Array(count);
  const positionBasisY = new Float64Array(count);
  let hasPositionBasis = false;
  if (positionBasisById !== undefined) {
    for (let i = 0; i < count; i++) {
      const correction = positionBasisById.get(nodes[i].id);
      if (correction === undefined) continue;
      const x = finite(correction.x);
      const y = finite(correction.y);
      positionBasisX[i] = x;
      positionBasisY[i] = y;
      if (x !== 0 || y !== 0) hasPositionBasis = true;
    }
  }""",
    """  let positionBasisX: Float64Array | undefined;
  let positionBasisY: Float64Array | undefined;
  let hasPositionBasis = false;
  if (positionBasisById !== undefined && positionBasisById.size !== 0) {
    positionBasisX = new Float64Array(count);
    positionBasisY = new Float64Array(count);
    for (let i = 0; i < count; i++) {
      const correction = positionBasisById.get(nodes[i].id);
      if (correction === undefined) continue;
      const x = finite(correction.x);
      const y = finite(correction.y);
      positionBasisX[i] = x;
      positionBasisY[i] = y;
      if (x !== 0 || y !== 0) hasPositionBasis = true;
    }
  }""",
    'lazy basis arrays',
)
geometry = replace_one(
    geometry,
    """      if (q !== 0) {
        const bx = positionBasisX[i];
        const by = positionBasisY[i];
        if (bx !== 0) v.x = finite(v.x + bx * q) + 0;
        if (by !== 0) v.y = finite(v.y + by * q) + 0;
      }""",
    """      if (q !== 0) {
        const bx = positionBasisX?.[i] ?? 0;
        const by = positionBasisY?.[i] ?? 0;
        if (bx !== 0) v.x = finite(v.x + bx * q) + 0;
        if (by !== 0) v.y = finite(v.y + by * q) + 0;
      }""",
    'optional basis array read',
)
geometry = replace_one(
    geometry,
    """          anchorIsLast[i] &&
          (q === 0 || (positionBasisX[i] === 0 && positionBasisY[i] === 0))""",
    """          anchorIsLast[i] &&
          (q === 0 || ((positionBasisX?.[i] ?? 0) === 0 && (positionBasisY?.[i] ?? 0) === 0))""",
    'optional basis root fast path',
)
geometry_path.write_text(geometry)


index_path = Path('src/projection/index.ts')
index = index_path.read_text()
index = replace_one(
    index,
    """ * Математика (вывод — индукция по глубине, geometry.ts): узел несёт first F,
 * last L и anchor B (где ФАКТИЧЕСКИ стоит в layout; default B = L, у
 * кроссфейд-ghost'а B = F). Целевой инвариант: V_i(p) = mix(F_i, L_i, p)
 * покомпонентно, размеры флорятся ≥ 0. Кумулятивная карта «layout над узлом →
 * page» равна box-map ближайшего проецирующего предка A:""",
    """ * Математика (вывод — индукция по глубине, geometry.ts): узел несёт first F,
 * last L и anchor B (где ФАКТИЧЕСКИ стоит в layout; default B = L, у
 * кроссфейд-ghost'а B = F). Базовый visual box использует mix(F,L,P(t)); размеры
 * всегда остаются на этом общем scalar-path и флорятся ≥ 0. После changed-target
 * retarget page-space x/y могут иметь дополнительный однородный член u·Q(t),
 * Q(0)=0, Q'(0)=1, чтобы сохранить собственную boundary velocity без второго
 * clock/solver. Уже скорректированный V затем проходит ту же единственную
 * parent-space карту. Кумулятивная карта «layout над узлом → page» равна box-map
 * ближайшего проецирующего предка A:""",
    'index geometry invariant',
)
index_path.write_text(index)
