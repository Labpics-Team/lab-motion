from pathlib import Path

p = Path('src/projection/driver.ts')
s = p.read_text()
old = ''' * Velocity continuity при перехвате (спека §2.3.2): скорость канала c ∈ {x,y,w,h}
 * узла аналитична каждый кадр: V̇_c = R_c · ṗ, R_c = L_c − F_c. Пер-боксовые px/s
 * НЕ хранятся — восстанавливаются замкнутой формой (принцип
 * readCompositorSpring: «состояние никогда не читается из DOM»).
 *   C⁰: first' = mixBox(first, last, p̂) — аналитический visual box, ноль DOM.
 *       Каналы radii/opacity ребейзятся той же формой: radii.first' =
 *       lerp(prev first, prev last, clamp01(p̂)) пер-угла/пер-оси, opacity.from' =
 *       lerp(prev from, prev to, clamp01(p̂)) — визуальный радиус/прозрачность
 *       СЕЙЧАС; переданные цели (.last/.to) не трогаются. Prev без radii/opacity →
 *       переданные берутся как есть.
 *   C¹: v0'·R'_c = v̂·R_c ⇒ доминантный канал c* = argmax |R'_c| по ВСЕМ
 *       продолжающимся узлам × каналам; v0' = v̂·R_{c*}/R'_{c*} (|R'| ≤ ε → 0),
 *       потолок V0_CAP (при p̂→1 знаменатель (1−p̂) мал — без капа нефизичный рывок).
 *   Теорема: при неизменных целях R'_c = (1−p̂)·R_c для ВСЕХ каналов сразу ⇒
 *   v0' = v̂/(1−p̂) точен для каждого канала каждого узла — точный C¹ всюду,
 *   отдельной ветки в коде нет. При изменённых целях — точный C¹ доминантного,
 *   C⁰ + пропорциональная скорость у остальных (честность WAAPI-групп).
'''
new = ''' * Velocity continuity при перехвате (спека §2.3.2) остаётся аналитической и
 * без чтений DOM. Scalar channels (w/h/radii/opacity) сохраняют прежний общий
 * progress P(t): доминантный диапазон задаёт bounded v0', а при неизменных целях
 * теорема R'_c=(1−p̂)R_c даёт точный C¹ каждого такого канала.
 *
 * Page-space x/y используют тот же ОДИН solve, но ещё его линейный базис Q(t)
 * по начальной скорости: V_c(t)=first'_c+R'_c·P(t)+u_c·Q(t), Q(0)=0, Q'(0)=1.
 * u_c = v_boundary,c − R'_c·v0' восстанавливается из старых аналитических
 * R·P'(t)+u·Q'(t). Поэтому при смене 2D-цели каждая ось сохраняет собственную
 * физическую boundary velocity; неизменная цель даёт u=0 и остаётся на старом
 * бит-пути. Тот же скорректированный page-space box поступает в parent-space
 * projector, так что отдельного geometry owner/solver/clock не появляется.
 *
 * C⁰: first' — текущий аналитический visual box; radii/opacity ребейзятся тем
 * же scalar P. V0_CAP по-прежнему ограничивает scalar v0' при малом диапазоне.
'''
if s.count(old) != 1:
    raise SystemExit(f'expected one stale velocity-contract block, got {s.count(old)}')
p.write_text(s.replace(old, new, 1))
