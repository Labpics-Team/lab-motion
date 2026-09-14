from pathlib import Path

# 1) One internal type-owner for the driver→geometry vector state. Type-only export is
# intentionally NOT re-exported from projection/index.ts, so public API stays unchanged.
g = Path('src/projection/geometry.ts')
s = g.read_text()
old = """interface DriverProjectionNodeInit extends ProjectionNodeInit {
  _qx?: number;
  _qy?: number;
}
"""
new = """export interface DriverProjectionNodeInit extends ProjectionNodeInit {
  _qx?: number;
  _qy?: number;
}
"""
assert s.count(old) == 1
s = s.replace(old, new, 1)
g.write_text(s)

# 2) Driver consumes that one internal contract instead of redeclaring the same shape.
d = Path('src/projection/driver.ts')
s = d.read_text()
old_import = """  type BoxRadii,
  type CornerRadius,
  type ProjectionFrame,
  type ProjectionNodeInit,
  type Projector,
"""
new_import = """  type BoxRadii,
  type CornerRadius,
  type DriverProjectionNodeInit,
  type ProjectionFrame,
  type ProjectionNodeInit,
  type Projector,
"""
assert s.count(old_import) == 1
s = s.replace(old_import, new_import, 1)
old_type = """interface VectorProjectionNode extends ProjectionNodeInit {
  _qx?: number;
  _qy?: number;
}

"""
assert s.count(old_type) == 1
s = s.replace(old_type, '', 1)
assert s.count('VectorProjectionNode') > 0
s = s.replace('VectorProjectionNode', 'DriverProjectionNodeInit')
# Narrow public lifecycle prose to the contract's supported C1 domain.
s = s.replace(
"""  /** Старт/перехват. Mid-flight: C⁰ по построению (first' = V(p̂) аналитически, ноль DOM),
   *  C¹ по формуле §2.3.2. Generation-инвалидация кадров старого полёта. */
""",
"""  /** Старт/перехват. Mid-flight: C⁰ по построению (first' = V(p̂) аналитически, ноль DOM).
   *  C¹ — в поддерживаемом vector-domain (`clamp:false`); bounded-режим сохраняет legacy scalar semantics.
   *  Generation-инвалидация кадров старого полёта. */
""",
1,
)
d.write_text(s)

# 3) Reference docs say exactly where vector C1 is promised.
p = Path('docs/projection.md')
s = p.read_text()
old = """- **Velocity continuity при перехвате**: повторный `play()`/`capture()` в полёте
  берёт текущие боксы аналитически, без чтений DOM под transform. При неизменных
  целях прежняя теорема `v0' = v̂/(1−p̂)` остаётся точным C¹ всех каналов. При
  изменении 2D-цели `x/y` сохраняют собственную физическую boundary velocity:
  общий scalar-path дополняется только однородным членом `u·Q(t)`, где `Q(0)=0`
  и `Q′(0)=1`. Поэтому новая ось получает ускорение к новой цели, но не чужой
  мгновенный импульс; тот же скорректированный page-space box проходит через
  обычный parent-space projector. Размеры, radii и opacity по-прежнему используют
  общий scalar progress и существующий bounded dominant-channel `v0`. Жест ведёт
  через `seek(p)`, отпускание — `release(v)`.
"""
new = """- **Velocity continuity при перехвате**: повторный `play()`/`capture()` в полёте
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
"""
assert s.count(old) == 1
p.write_text(s.replace(old, new, 1))

# 4) Module-level reference must not re-introduce a broader claim than the docs.
i = Path('src/projection/index.ts')
s = i.read_text()
s = s.replace(
""" * always остаются на этом общем scalar-path и флорятся ≥ 0. После changed-target
 * retarget page-space x/y могут иметь дополнительный однородный член u·Q(t),
""",
""" * always остаются на этом общем scalar-path и флорятся ≥ 0. В поддерживаемом
 * changed-target domain с clamp:false page-space x/y могут иметь дополнительный однородный член u·Q(t),
""",
1,
)
s = s.replace(
""" *   P5. C⁰ всегда и C¹ по формулам driver.ts при прерывании; transform-origin
 *       потребителя — '0 0' (формулы выведены для верхнего-левого origin).
""",
""" *   P5. C⁰ всегда; C¹ по формулам driver.ts только в поддерживаемом vector-domain
 *       (clamp:false). Bounded clamp:true сохраняет legacy scalar semantics.
 *       Transform-origin потребителя — '0 0' (формулы выведены для верхнего-левого origin).
""",
1,
)
i.write_text(s)

# Fail closed on duplicated local contract or accidental public re-export.
assert 'interface VectorProjectionNode' not in d.read_text()
assert 'type DriverProjectionNodeInit' in d.read_text()
assert 'type DriverProjectionNodeInit' not in i.read_text()
