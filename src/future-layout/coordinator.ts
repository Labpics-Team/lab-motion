/**
 * src/future-layout/coordinator.ts — document-scoped coordinator поверхностей.
 *
 * Спека «DOCUMENT-SCOPED COORDINATOR»: один document — одна active
 * Future Layout generation. Законы запечатаны RED-тестами:
 *  - новый transition supersede-ит визуальное представление старого;
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
}

// Монотонный счётчик имён realm: уникальные bounded view-transition-name
// без глобальных статичных имён и без реестра владельцев.
let NAME_SEQ = 0;

function hostCss(name: string): string {
  // UA default-анимации width/height/transform/opacity полностью отключены:
  // браузер не исполняет собственный layout transition поверх Lab Motion.
  return (
    `::view-transition-group(${name}) { animation: none; }\n`
    + `::view-transition-image-pair(${name}) { animation: none; }\n`
    + `::view-transition-old(${name}) { animation: none; }\n`
    + `::view-transition-new(${name}) { animation: none; }`
  );
}

export function createSurfaceCoordinator(): SurfaceCoordinator {
  let generationSeq = 0;
  let active: GenerationRecord | undefined;

  const coordinator: SurfaceCoordinator = {
    begin(input: SurfaceGenerationInput): SurfaceGeneration {
      void input;
      const name = `lm-surface-${++NAME_SEQ}`;
      const record: GenerationRecord = {
        number: ++generationSeq,
        name,
        css: hostCss(name),
        published: false,
        released: false,
      };
      active = record;
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
      };
    },
    get activeGeneration(): number {
      return active?.number ?? 0;
    },
  };
  return coordinator;
}
