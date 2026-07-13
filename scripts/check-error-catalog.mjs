/**
 * Fail-closed сверка runtime-кодов MotionParamError с русским каталогом.
 * Описания остаются в документации и не попадают в исполняемый пакет.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const CODE_RE = /^LM\d{3}$/;
const TABLE_ROW_RE = /^\|\s*`?(LM\d{3})`?\s*\|/;

function cleanCell(value) {
  return value.trim().replace(/^`|`$/g, '');
}

export function parseErrorCatalog(markdown) {
  const entries = new Map();
  const errors = [];
  for (const [index, line] of markdown.split(/\r?\n/).entries()) {
    if (!TABLE_ROW_RE.test(line)) continue;
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
    if (cells.length !== 5) {
      errors.push(`docs/errors.md:${index + 1}: строка должна содержать 5 колонок`);
      continue;
    }
    const code = cleanCell(cells[0]);
    const status = cleanCell(cells[4]);
    if (entries.has(code)) {
      errors.push(`docs/errors.md:${index + 1}: код ${code} описан повторно`);
      continue;
    }
    if (status !== 'active' && status !== 'retired' && status !== 'reserved') {
      errors.push(`docs/errors.md:${index + 1}: неизвестный статус ${status}`);
    }
    entries.set(code, {
      code,
      line: index + 1,
      status,
    });
  }
  if (!entries.has('LM000') || entries.get('LM000').status !== 'reserved') {
    errors.push('docs/errors.md: отсутствует зарезервированный legacy-код LM000');
  }
  return { entries, errors };
}

function staticCode(argument) {
  return argument !== undefined && ts.isStringLiteral(argument)
    ? argument.text
    : undefined;
}

function sourcePosition(sourceFile, node, file) {
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return { file, line: position.line + 1 };
}

function hasFactoryTag(node) {
  return ts.getJSDocTags(node)
    .some((tag) => tag.tagName.text === 'motionErrorFactory');
}

function verifyFactory(node, sourceFile, file) {
  const at = sourcePosition(sourceFile, node, file);
  const fail = (reason) => ({
    error: `${at.file}:${at.line}: @motionErrorFactory ${reason}`,
  });
  if (
    !ts.isFunctionDeclaration(node) ||
    node.parent !== sourceFile ||
    node.name === undefined ||
    node.modifiers?.length ||
    node.asteriskToken !== undefined ||
    node.typeParameters !== undefined ||
    node.parameters.length !== 1
  ) {
    return fail('обязан быть локальной обычной функцией с одним параметром');
  }
  const [code] = node.parameters;
  if (
    !ts.isIdentifier(code.name) ||
    code.name.text !== 'code' ||
    code.initializer !== undefined ||
    code.questionToken !== undefined ||
    code.dotDotDotToken !== undefined ||
    code.type === undefined ||
    !ts.isTypeReferenceNode(code.type) ||
    !ts.isIdentifier(code.type.typeName) ||
    code.type.typeName.text !== 'MotionParamErrorCode'
  ) {
    return fail('первым параметром обязан быть code: MotionParamErrorCode');
  }
  if (node.type === undefined || node.type.kind !== ts.SyntaxKind.NeverKeyword) {
    return fail('обязан явно возвращать never');
  }
  const statements = node.body?.statements;
  const statement = statements?.length === 1 ? statements[0] : undefined;
  const expression = statement !== undefined && ts.isThrowStatement(statement)
    ? statement.expression
    : undefined;
  if (
    expression === undefined ||
    !ts.isNewExpression(expression) ||
    !ts.isIdentifier(expression.expression) ||
    expression.expression.text !== 'MotionParamError' ||
    expression.arguments?.length !== 1 ||
    !ts.isIdentifier(expression.arguments[0]) ||
    expression.arguments[0].text !== 'code'
  ) {
    return fail('тело обязано быть единственным throw new MotionParamError(code)');
  }
  return {
    name: node.name.text,
    declarationName: node.name,
    innerConstruction: expression,
  };
}

function constructorBindings(sourceFile) {
  const bindings = new Set(['MotionParamError']);
  const namespaces = new Set();
  const escapes = [];
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause;
      const imports = clause?.namedBindings;
      if (clause?.isTypeOnly || imports === undefined) continue;
      if (ts.isNamespaceImport(imports)) {
        // Любой runtime namespace допускает computed-доступ к реэкспорту
        // конструктора; named imports остаются проверяемыми по символу.
        namespaces.add(imports.name.text);
        continue;
      }
      for (const element of imports.elements) {
        if ((element.propertyName ?? element.name).text !== 'MotionParamError') continue;
        if (element.isTypeOnly) continue;
        bindings.add(element.name.text);
        if (element.name.text !== 'MotionParamError') escapes.push(element.name);
      }
      continue;
    }
    if (ts.isExportDeclaration(statement) && !statement.isTypeOnly) {
      const exported = statement.exportClause;
      if (exported === undefined) continue;
      if (ts.isNamespaceExport(exported)) {
        const moduleName = ts.isStringLiteral(statement.moduleSpecifier)
          ? statement.moduleSpecifier.text
          : '';
        if (/(?:^|\/)errors(?:\.js)?$/.test(moduleName)) escapes.push(exported.name);
        continue;
      }
      if (!ts.isNamedExports(exported)) continue;
      for (const element of exported.elements) {
        if (element.isTypeOnly) continue;
        const original = (element.propertyName ?? element.name).text;
        if (original === 'MotionParamError' && element.name.text !== 'MotionParamError') {
          escapes.push(element.name);
        }
      }
    }
  }
  return { bindings, namespaces, escapes };
}

function isImportExportReference(node) {
  let current = node;
  while (current.parent !== undefined) {
    current = current.parent;
    if (
      ts.isImportDeclaration(current) ||
      ts.isImportEqualsDeclaration(current) ||
      ts.isExportDeclaration(current)
    ) return true;
    if (ts.isStatement(current) || ts.isSourceFile(current)) return false;
  }
  return false;
}

function isClassExtendsReference(node) {
  let current = node;
  while (current.parent !== undefined) {
    current = current.parent;
    if (ts.isHeritageClause(current)) {
      return current.token === ts.SyntaxKind.ExtendsKeyword && ts.isClassLike(current.parent);
    }
    if (ts.isStatement(current) || ts.isSourceFile(current)) return false;
  }
  return false;
}

function isTypeReference(node) {
  if (isClassExtendsReference(node)) return false;
  let current = node;
  while (current.parent !== undefined) {
    current = current.parent;
    if (ts.isTypeNode(current) || ts.isInterfaceDeclaration(current)) return true;
    if (ts.isStatement(current) || ts.isSourceFile(current)) return false;
  }
  return false;
}

function isInstanceofRhs(node) {
  let current = node;
  while (
    current.parent !== undefined &&
    (
      ts.isParenthesizedExpression(current.parent) ||
      ts.isAsExpression(current.parent) ||
      ts.isNonNullExpression(current.parent)
    ) &&
    current.parent.expression === current
  ) current = current.parent;
  const parent = current.parent;
  return parent !== undefined &&
    ts.isBinaryExpression(parent) &&
    parent.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword &&
    parent.right === current;
}

function isConstructorProperty(node) {
  if (ts.isPropertyAccessExpression(node)) return node.name.text === 'MotionParamError';
  if (!ts.isElementAccessExpression(node)) return false;
  const argument = node.argumentExpression;
  return argument !== undefined &&
    (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) &&
    argument.text === 'MotionParamError';
}

function isDynamicErrorsImport(node) {
  if (!ts.isCallExpression(node) || node.expression.kind !== ts.SyntaxKind.ImportKeyword) {
    return false;
  }
  const specifier = node.arguments[0];
  return specifier !== undefined &&
    (ts.isStringLiteral(specifier) || ts.isNoSubstitutionTemplateLiteral(specifier)) &&
    /(?:^|\/)errors(?:\.js)?$/.test(specifier.text);
}

function inspectMotionParamErrorSource(source, file = 'source.ts') {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const calls = [];
  const errors = [];
  const factories = new Map();
  const constructorScope = constructorBindings(sourceFile);

  const findFactories = (node) => {
    if (hasFactoryTag(node)) {
      const result = verifyFactory(node, sourceFile, file);
      if (result.error !== undefined) errors.push(result.error);
      else if (factories.has(result.name)) {
        const at = sourcePosition(sourceFile, node, file);
        errors.push(`${at.file}:${at.line}: @motionErrorFactory ${result.name} объявлен повторно`);
      } else {
        factories.set(result.name, result);
      }
    }
    ts.forEachChild(node, findFactories);
  };
  findFactories(sourceFile);

  const recordCall = (node, args) => {
    const at = sourcePosition(sourceFile, node, file);
    calls.push({
      code: staticCode(args[0]),
      argumentCount: args.length,
      file: at.file,
      line: at.line,
    });
  };

  const innerConstructions = new Set(
    [...factories.values()].map((factory) => factory.innerConstruction),
  );
  const escape = (node) => {
    const at = sourcePosition(sourceFile, node, file);
    errors.push(`${at.file}:${at.line}: запрещён runtime-escape конструктора MotionParamError`);
  };
  for (const node of constructorScope.escapes) escape(node);
  const visit = (node) => {
    if (innerConstructions.has(node)) return;
    if (isDynamicErrorsImport(node)) {
      escape(node);
      return;
    }
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'MotionParamError'
    ) {
      recordCall(node, node.arguments ?? []);
      for (const argument of node.arguments ?? []) visit(argument);
      return;
    }
    if (isConstructorProperty(node)) {
      if (!isImportExportReference(node) && !isTypeReference(node) && !isInstanceofRhs(node)) {
        escape(node);
      }
      return;
    }
    if (ts.isIdentifier(node) && constructorScope.namespaces.has(node.text)) {
      if (!isImportExportReference(node) && !isTypeReference(node)) escape(node);
      return;
    }
    if (ts.isIdentifier(node) && constructorScope.bindings.has(node.text)) {
      const classDeclaration = ts.isClassDeclaration(node.parent) && node.parent.name === node
        ? node.parent
        : undefined;
      const declaration = classDeclaration !== undefined &&
        !classDeclaration.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword);
      if (
        !declaration &&
        !isImportExportReference(node) &&
        !isTypeReference(node) &&
        !isInstanceofRhs(node)
      ) escape(node);
      return;
    }
    if (ts.isIdentifier(node) && factories.has(node.text)) {
      const factory = factories.get(node.text);
      if (node === factory.declarationName) return;
      const parent = node.parent;
      if (
        ts.isCallExpression(parent) &&
        parent.expression === node &&
        parent.questionDotToken === undefined
      ) {
        recordCall(parent, parent.arguments);
        // Аргументы всё ещё обходятся ниже: вложенный MotionParamError не скрывается.
      } else {
        const at = sourcePosition(sourceFile, node, file);
        errors.push(
          `${at.file}:${at.line}: @motionErrorFactory ${factory.name} нельзя передавать, сохранять или переименовывать`,
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { calls, errors };
}

export function inspectMotionParamErrors(source, file = 'source.ts') {
  return inspectMotionParamErrorSource(source, file).calls;
}

export function validateErrorCatalog({ catalogText, sources }) {
  const catalog = parseErrorCatalog(catalogText);
  const errors = [...catalog.errors];
  const uses = new Set();

  for (const [file, source] of sources) {
    const inspected = inspectMotionParamErrorSource(source, file);
    errors.push(...inspected.errors);
    for (const call of inspected.calls) {
      const at = `${call.file}:${call.line}`;
      if (call.code === undefined || !CODE_RE.test(call.code)) {
        errors.push(`${at}: MotionParamError обязан использовать статический код LMddd`);
        continue;
      }
      if (call.argumentCount !== 1) {
        errors.push(`${at}: MotionParamError обязан принимать ровно один статический аргумент`);
      }
      const entry = catalog.entries.get(call.code);
      if (entry === undefined) {
        errors.push(`${at}: код ${call.code} отсутствует в docs/errors.md`);
        continue;
      }
      if (entry.status !== 'active') {
        errors.push(`${at}: код ${call.code} имеет статус ${entry.status}, а не active`);
      }
      uses.add(call.code);
    }
  }

  for (const entry of catalog.entries.values()) {
    const used = uses.has(entry.code);
    if (entry.status === 'active' && !used) {
      errors.push(`docs/errors.md:${entry.line}: active-код ${entry.code} не используется`);
    }
    if ((entry.status === 'retired' || entry.status === 'reserved') && used) {
      errors.push(`docs/errors.md:${entry.line}: ${entry.status}-код ${entry.code} используется`);
    }
  }
  return errors;
}

function sourceFiles(root) {
  const files = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (extname(path) === '.ts' || extname(path) === '.tsx') files.push(path);
    }
  }
  return files.sort();
}

export function checkWorkspace(root = resolve('.')) {
  const catalogPath = resolve(root, 'docs/errors.md');
  if (!existsSync(catalogPath)) return ['docs/errors.md: файл каталога отсутствует'];
  const sources = sourceFiles(resolve(root, 'src')).map((path) => [
    path.slice(root.length + 1),
    readFileSync(path, 'utf8'),
  ]);
  return validateErrorCatalog({
    catalogText: readFileSync(catalogPath, 'utf8'),
    sources,
  });
}

const invokedPath = process.argv[1] === undefined
  ? undefined
  : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  const errors = checkWorkspace();
  if (errors.length > 0) {
    console.error(`error-catalog: найдено нарушений: ${errors.length}`);
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
  } else {
    console.log('error-catalog: OK');
  }
}
