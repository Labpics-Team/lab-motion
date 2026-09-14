from pathlib import Path


def replace1(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    assert count == 1, f'{label}: expected 1, got {count}'
    return text.replace(old, new, 1)

# 1) One internal type-owner for the driver→geometry vector state. Type-only export is
# intentionally NOT re-exported from projection/index.ts, so public API stays unchanged.
g = Path('src/projection/geometry.ts')
s = g.read_text()
s = replace1(
    s,
    """interface DriverProjectionNodeInit extends ProjectionNodeInit {
  _qx?: number;
  _qy?: number;
}
""",
    """export interface DriverProjectionNodeInit extends ProjectionNodeInit {
  _qx?: number;
  _qy?: number;
}
""",
    'geometry internal type owner',
)
g.write_text(s)

# 2) Driver consumes that one internal contract instead of redeclaring the same shape.
d = Path('src/projection/driver.ts')
s = d.read_text()
s = replace1(
    s,
    """  type BoxRadii,
  type CornerRadius,
  type ProjectionFrame,
  type ProjectionNodeInit,
  type Projector,
""",
    """  type BoxRadii,
  type CornerRadius,
  type DriverProjectionNodeInit,
  type ProjectionFrame,
  type ProjectionNodeInit,
  type Projector,
""",
    'driver internal type import',
)
s = replace1(
    s,
    """interface VectorProjectionNode extends ProjectionNodeInit {
  _qx?: number;
  _qy?: number;
}

""",
    '',
    'duplicate driver type',
)
assert s.count('VectorProjectionNode') > 0
s = s.replace('VectorProjectionNode', 'DriverProjectionNodeInit')
s = replace1(
    s,
    """  /** Старт/перехват. Mid-flight: C⁰ по построению (first' = V(p̂) аналитически, ноль DOM),
   *  C¹ по формуле §2.3.2. Generation-инвалидация кадров старого полёта. */
""",
    """  /** Старт/перехват. Mid-flight: C⁰ по построению (first' = V(p̂) аналитически, ноль DOM).
   *  C¹ — в поддерживаемом vector-domain (`clamp:false`); bounded-режим сохраняет legacy scalar semantics.
   *  Generation-инвалидация кадров старого полёта. */
""",
    'driver public lifecycle prose',
)
d.write_text(s)

# 3) Reference docs say exactly where vector C1 is promised.
p = Path('docs/projection.md')
s = p.read_text()
s = replace1(
    s,
    """- **Velocity continuity при перехвате**: повторный `play()`/`capture()` в полёте
  берёт текущие боксы аналитически, без чтений DOM под transform. При неизменных
  целях прежняя теорема `v0' = v̂/(1−p̂)` остаётся точным C¹ всех каналов. При
  изменении 2D-цели `x/y` сохраняют собственную физическую boundary velocity:
  общий scalar-path дополняется только однородным членом `u·Q(t)`, где `Q(0)=0`
  и `Q′(0)=1`. Поэтому новая ось получает ускорение к новой цели, но не чужой
  мгновенный импульс; тот же скорректированный page-space box проходит через
  обычный parent-space projector. Размеры, radii и opacity по-прежнему используют
  общий scalar progress и существующий bounded dominant-channel `v0`. Жест ведёт
  через `seek(p)`, отпускание — `release(v)`.
""",
    """- **Velocity continuity при перехвате**: повторный `play()`/`capture()` в полёте
  берёт текущие боксы аналитически, без чтений DOM под transform. При неизменных
  целях прежняя теорема `v0' = v̂/(1−p̂)` остаётся точным C¹ всех каналов. В
  поддерживаемом 2D-domain с `clamp:false` при изменении цели `x/y` сохраняют
  собственную физическую boundary velocity: общий scalar-path дополняется только
  однородным членом `u·Q(t)`, где `Q(0)=0` и `Q′(0)=1`. Поэтому новая ось получает
  ускорение к новой цели, но не чужой мгновенный импульс; тот же скорректированный
  page-space box проходит через обычный parent-space projector. `clamp:true`
  сохраняет прежний bounded scalar-path и не обещает vector C¹. Размеры, radii и
  opacity по-прежнему используют общий scalar progress. Жест ведёт через
  `seek(p)`, отпускание — `release(v)`.
""",
    'projection reference vector scope',
)
p.write_text(s)

# 4) Module-level reference must not re-introduce a broader claim than the docs.
i = Path('src/projection/index.ts')
s = i.read_text()
s = replace1(
    s,
    """ * Базовый visual box использует mix(F,L,P(t)); размеры
 * всегда остаются на этом общем scalar-path и флорятся ≥ 0. После changed-target
 * retarget page-space x/y могут иметь дополнительный однородный член u·Q(t),
""",
    """ * Базовый visual box использует mix(F,L,P(t)); размеры
 * всегда остаются на этом общем scalar-path и флорятся ≥ 0. В поддерживаемом
 * changed-target domain с clamp:false page-space x/y могут иметь дополнительный
 * однородный член u·Q(t),
""",
    'module vector scope',
)
s = replace1(
    s,
    """ *   P5. C⁰ всегда и C¹ по формулам driver.ts при прерывании; transform-origin
 *       потребителя — '0 0' (формулы выведены для верхнего-левого origin).
""",
    """ *   P5. C⁰ всегда; C¹ по формулам driver.ts только в поддерживаемом vector-domain
 *       (clamp:false). Bounded clamp:true сохраняет legacy scalar semantics.
 *       Transform-origin потребителя — '0 0' (формулы выведены для верхнего-левого origin).
""",
    'module P5 scope',
)
i.write_text(s)

# Fail closed on duplicated local contract or accidental public re-export.
assert 'interface VectorProjectionNode' not in d.read_text()
assert d.read_text().count('DriverProjectionNodeInit') > 1
assert 'export interface DriverProjectionNodeInit' in g.read_text()
assert 'DriverProjectionNodeInit' not in i.read_text()
