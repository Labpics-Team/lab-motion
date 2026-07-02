/**
 * internal/types.ts — общие доменные типы ядра.
 *
 * SpringParams живёт здесь, а не в spring.ts, чтобы разорвать модульный цикл
 * spring.ts ↔ internal/solver.ts (солверу нужен только тип, spring.ts —
 * публичная точка, реэкспортирующая его потребителям).
 */

/** Physics parameters for a spring. */
export interface SpringParams {
  /** Positive finite mass (kg). */
  readonly mass: number;
  /** Positive finite stiffness (N/m). */
  readonly stiffness: number;
  /** Non-negative finite damping coefficient (N·s/m). Zero = undamped. */
  readonly damping: number;
}
