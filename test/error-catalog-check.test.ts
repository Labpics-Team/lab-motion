import { describe, expect, it } from 'vitest';
import {
  parseErrorCatalog,
  validateErrorCatalog,
} from '../scripts/check-error-catalog.mjs';

const catalog = (rows: string[]): string => `
| Код | Граница | Причина | Исправление | Статус |
|---|---|---|---|---|
| \`LM000\` | Внешний конструктор | Legacy-сообщение | Использовать код каталога | reserved |
${rows.join('\n')}
`;

const row = (
  code: string,
  status = 'active',
): string => `| \`${code}\` | api | причина | исправить вход | ${status} |`;

describe('error catalog checker', () => {
  it('принимает полное соответствие code-only вызова каталогу', () => {
    const errors = validateErrorCatalog({
      catalogText: catalog([row('LM001')]),
      sources: [[
        'src/a.ts',
        "throw new MotionParamError('LM001');",
      ]],
    });
    expect(errors).toEqual([]);
  });

  it('fail-closed отвергает prose, неизвестный код и дополнительные аргументы', () => {
    const errors = validateErrorCatalog({
      catalogText: catalog([row('LM001')]),
      sources: [
        ['src/prose.ts', "throw new MotionParamError('старый текст');"],
        ['src/short.ts', "throw new MotionParamError('LM12');"],
        ['src/missing.ts', "throw new MotionParamError('LM999');"],
        ['src/detail.ts', "throw new MotionParamError('LM001', value);"],
        ['src/extra.ts', "throw new MotionParamError('LM001', `:${value}`, third);"],
      ],
    });
    expect(errors.join('\n')).toMatch(/статический код LMddd/);
    expect(errors.join('\n')).toMatch(/LM999 отсутствует/);
    expect(errors.join('\n')).toMatch(/ровно один статический аргумент/);
  });

  it('не допускает duplicate, retired-use и неиспользуемый active-код', () => {
    const text = catalog([
      row('LM001'),
      row('LM001'),
      row('LM002', 'retired'),
      row('LM003'),
    ]);
    const parsed = parseErrorCatalog(text);
    expect(parsed.errors.join('\n')).toMatch(/LM001 описан повторно/);

    const errors = validateErrorCatalog({
      catalogText: text,
      sources: [['src/a.ts', "throw new MotionParamError('LM002');"]],
    });
    expect(errors.join('\n')).toMatch(/LM002 имеет статус retired/);
    expect(errors.join('\n')).toMatch(/active-код LM003 не используется/);
  });

  it('fail-closed требует LM000 и известный статус', () => {
    const withoutReserved = `
| Код | Граница | Причина | Исправление | Статус |
|---|---|---|---|---|
${row('LM001', 'unknown')}
`;
    const parsed = parseErrorCatalog(withoutReserved);
    expect(parsed.errors.join('\n')).toMatch(/неизвестный статус unknown/);
    expect(parsed.errors.join('\n')).toMatch(/legacy-код LM000/);
  });

  it('не допускает detail ни у одного использования смыслового кода', () => {
    const errors = validateErrorCatalog({
      catalogText: catalog([row('LM010')]),
      sources: [[
        'src/a.ts',
        [
          "throw new MotionParamError('LM010');",
          "throw new MotionParamError('LM010', `:${index}`);",
        ].join('\n'),
      ]],
    });
    expect(errors.join('\n')).toMatch(/ровно один статический аргумент/);
  });

  it('принимает проверенную локальную фабрику и валидирует её прямые вызовы', () => {
    const errors = validateErrorCatalog({
      catalogText: catalog([row('LM010')]),
      sources: [[
        'src/native.ts',
        [
          '/** @motionErrorFactory */',
          'function failNative(code: MotionParamErrorCode): never {',
          '  throw new MotionParamError(code);',
          '}',
          "failNative('LM010');",
        ].join('\n'),
      ]],
    });
    expect(errors).toEqual([]);
  });

  it('отклоняет динамический вызов и escape проверенной фабрики', () => {
    const errors = validateErrorCatalog({
      catalogText: catalog([row('LM010')]),
      sources: [[
        'src/native.ts',
        [
          '/** @motionErrorFactory */',
          'function failNative(code: MotionParamErrorCode): never {',
          '  throw new MotionParamError(code);',
          '}',
          'failNative(runtimeCode);',
          'const alias = failNative;',
        ].join('\n'),
      ]],
    });
    expect(errors.join('\n')).toMatch(/статический код LMddd/);
    expect(errors.join('\n')).toMatch(/нельзя передавать, сохранять или переименовывать/);
  });

  it('fail-closed отклоняет неверную сигнатуру или тело tagged-фабрики', () => {
    const errors = validateErrorCatalog({
      catalogText: catalog([row('LM010')]),
      sources: [[
        'src/native.ts',
        [
          '/** @motionErrorFactory */',
          'function failNative(code: string): never {',
          '  const error = new MotionParamError(code);',
          '  throw error;',
          '}',
          "failNative('LM010');",
        ].join('\n'),
      ]],
    });
    expect(errors.join('\n')).toMatch(/code: MotionParamErrorCode|единственным throw/);
    expect(errors.join('\n')).toMatch(/статический код LMddd/);
  });

  it('не освобождает untagged динамический конструктор', () => {
    const errors = validateErrorCatalog({
      catalogText: catalog([row('LM010')]),
      sources: [['src/a.ts', 'throw new MotionParamError(runtimeCode);']],
    });
    expect(errors.join('\n')).toMatch(/статический код LMddd/);
  });

  it('не позволяет переименовать конструктор и обойти статический код', () => {
    const errors = validateErrorCatalog({
      catalogText: catalog([]),
      sources: [[
        'src/alias.ts',
        [
          'const E = MotionParamError;',
          'throw new E(runtimeCode);',
        ].join('\n'),
      ]],
    });
    expect(errors.join('\n')).toMatch(/runtime-escape конструктора/);
  });

  it('не позволяет получить конструктор через namespace или property access', () => {
    const errors = validateErrorCatalog({
      catalogText: catalog([]),
      sources: [[
        'src/property.ts',
        [
          "import * as errors from './errors.js';",
          'const Dot = errors.MotionParamError;',
          "const Bracket = errors['MotionParamError'];",
          'void Dot; void Bracket;',
        ].join('\n'),
      ]],
    });
    expect(errors.join('\n')).toMatch(/runtime-escape конструктора/);
  });

  it('не позволяет computed access к namespace ошибок', () => {
    const errors = validateErrorCatalog({
      catalogText: catalog([]),
      sources: [[
        'src/computed.ts',
        [
          "import * as errors from './errors.js';",
          'declare const key: string;',
          'const Template = errors[`MotionParamError`];',
          'const Dynamic = errors[key];',
          'void Template; void Dynamic;',
        ].join('\n'),
      ]],
    });
    expect(errors.join('\n')).toMatch(/runtime-escape конструктора/);
  });

  it('не позволяет межфайловый alias через re-export', () => {
    const errors = validateErrorCatalog({
      catalogText: catalog([]),
      sources: [
        ['src/barrel.ts', "export { MotionParamError as E } from './errors.js';"],
        ['src/use.ts', "import { E } from './barrel.js'; new E(runtimeCode);"],
      ],
    });
    expect(errors.join('\n')).toMatch(/runtime-escape конструктора/);
  });

  it('не позволяет default re-export конструктора', () => {
    const errors = validateErrorCatalog({
      catalogText: catalog([]),
      sources: [
        [
          'src/barrel.ts',
          "import { MotionParamError } from './errors.js'; export default MotionParamError;",
        ],
        ['src/use.ts', "import E from './barrel.js'; new E(runtimeCode);"],
      ],
    });
    expect(errors.join('\n')).toMatch(/runtime-escape конструктора/);
  });

  it('не позволяет computed access после dynamic import errors boundary', () => {
    const errors = validateErrorCatalog({
      catalogText: catalog([]),
      sources: [[
        'src/dynamic.ts',
        "const errors = await import('./errors.js'); new errors[key](runtimeCode);",
      ]],
    });
    expect(errors.join('\n')).toMatch(/runtime-escape конструктора/);
  });

  it('не позволяет Reflect, передачу или наследование конструктора', () => {
    const errors = validateErrorCatalog({
      catalogText: catalog([]),
      sources: [[
        'src/escape.ts',
        [
          'Reflect.construct(MotionParamError, [runtimeCode]);',
          'consume(MotionParamError);',
          'class Derived extends MotionParamError {}',
        ].join('\n'),
      ]],
    });
    expect(errors.join('\n')).toMatch(/runtime-escape конструктора/);
  });

  it('разрешает только import/export/type и RHS instanceof', () => {
    const errors = validateErrorCatalog({
      catalogText: catalog([]),
      sources: [[
        'src/allowed.ts',
        [
          "import { MotionParamError } from './errors.js';",
          'export { MotionParamError };',
          'type ErrorType = MotionParamError;',
          'declare const error: unknown;',
          'void (error instanceof MotionParamError);',
        ].join('\n'),
      ]],
    });
    expect(errors).toEqual([]);
  });

  it('запрещает detail даже при статическом коде', () => {
    const errors = validateErrorCatalog({
      catalogText: catalog([row('LM010')]),
      sources: [['src/detail.ts', "throw new MotionParamError('LM010', `:${value}`);"]],
    });
    expect(errors.join('\n')).toMatch(/ровно один статический аргумент/);
  });

  it('принимает code-only tagged factory с одним параметром', () => {
    const errors = validateErrorCatalog({
      catalogText: catalog([row('LM010')]),
      sources: [[
        'src/native.ts',
        [
          '/** @motionErrorFactory */',
          'function failNative(code: MotionParamErrorCode): never {',
          '  throw new MotionParamError(code);',
          '}',
          "failNative('LM010');",
        ].join('\n'),
      ]],
    });
    expect(errors).toEqual([]);
  });
});
