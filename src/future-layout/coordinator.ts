/**
 * src/future-layout/coordinator.ts — document-scoped coordinator поверхностей.
 *
 * Спека «DOCUMENT-SCOPED COORDINATOR»: один document — одна active
 * Future Layout generation. Законы запечатаны RED-тестами:
 *  - новый transition supersede-ит визуальное представление старого
 *    (onSupersede-handler вытесняемой generation вызывается в begin());
 *  - stale commit НЕ публикует состояние после supersede;
 *  - stale finish НЕ очищает новую generation;
 *  - cleanup ровно один раз; skip освобождает owner.
 *
 * Имена view-transition — монотонная последовательность модуля (не статичные
 * глобальные имена: коллизия невозможна в пределах realm), CSS отключает
 * UA-анимации group/image-pair/old/new (спека «VIEW TRANSITION HOST»).
 */

export interface SurfaceGenerationInput {
  readonly target: unknown;
  readonly fromWidth: number;
  readonly toWidth: number;
}

export interface SurfaceGeneration {
  readonly generation: number;
  readonly viewTransitionName: string;
  readonly generatedCss: string;
  /** Публикует состояние; stale после supersede — молча игнорируется. */
  commit(): void;
  /** Терминализирует generation ровно один раз; stale — игнорируется. */
  finish(): void;
  /** skip UA/host: терминализирует без публикации (owner освобождается). */
  skip(): void;
  readonly published: boolean;
  readonly released: boolean;
  /** true с момента, когда эта generation вытеснена новой (до finish/skip). */
  readonly superseded: boolean;
  /** Остановка старого визуального представления при supersede: begin()
   * новой generation вызывает handler ровно один раз (если зарегистрирован
   * и generation ещё не released). */
  onSupersede(handler: () => void): void;
}

export interface SurfaceCoordinator {
  begin(input: SurfaceGenerationInput): SurfaceGeneration;
  readonly activeGeneration: number;
}

interface GenerationRecord {
  readonly number: number;
  readonly name: string;
  readonly css: string;
  published: boolean;
  released: boolean;
  superseded: boolean;
  supersedeHandler?: (() => void) | undefined;
}

// Монотонный счётчик имён realm: уникальные bounded view-transition-name
// без глобальных статичных имён и без реестра владельцев.
let NAME_SEQ = 0;

function hostCss(name: string): string {
  // UA default-анимации width/height/transform/opacity полностью отключены:
  // браузер не исполняет собственный layout transition поверх Lab Motion.
  return ['group', 'image-pair', 'old', 'new']
    .map((p) => `::view-transition-${p}(${name}) { animation: none; }`)
    .join('\n');
}

export function createSurfaceCoordinator(): SurfaceCoordinator {
  let generationSeq = 0;
  let active: GenerationRecord | undefined;

  const coordinator: SurfaceCoordinator = {
    begin(input: SurfaceGenerationInput): SurfaceGeneration {
      void input;
      const previous = active;
      const name = `lm-surface-${++NAME_SEQ}`;
      const record: GenerationRecord = {
        number: ++generationSeq,
        name,
        css: hostCss(name),
        published: false,
        released: false,
        superseded: false,
      };
      active = record;
      // Supersede: новое начало вытесняет визуальное представление старого —
      // handler транзакции останавливает её effects/observer ПОСЛЕ того, как
      // новая generation установлена active: её finish/skip внутри остановки
      // обязан быть stale no-op (старая запись уже не владеет coordinator'ом).
      if (previous !== undefined && !previous.released) {
        previous.superseded = true;
        const handler = previous.supersedeHandler;
        previous.supersedeHandler = undefined;
        if (handler !== undefined) {
          try { handler(); } catch { /* остановка старой — best effort */ }
        }
      }
      return {
        generation: record.number,
        viewTransitionName: record.name,
        generatedCss: record.css,
        commit(): void {
          // Stale commit после supersede не публикует состояние.
          if (active !== record || record.released) return;
          record.published = true;
        },
        finish(): void {
          // Stale finish не очищает новую generation; cleanup ровно один раз.
          if (active !== record || record.released) return;
          record.released = true;
          active = undefined;
        },
        skip(): void {
          if (active !== record || record.released) return;
          record.released = true;
          active = undefined;
        },
        get published(): boolean {
          return record.published;
        },
        get released(): boolean {
          return record.released;
        },
        get superseded(): boolean {
          return record.superseded;
        },
        onSupersede(handler: () => void): void {
          // Регистрация после supersede бессмысленна: handler не вызывается.
          if (record.superseded || record.released) return;
          record.supersedeHandler = handler;
        },
      };
    },
    get activeGeneration(): number {
      return active?.number ?? 0;
    },
  };
  return coordinator;
}
