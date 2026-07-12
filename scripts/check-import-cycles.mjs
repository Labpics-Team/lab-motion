import { readdir, readFile } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const sourceRoot = join(repositoryRoot, 'src');
const sourceExtensions = new Set(['.ts', '.tsx', '.mts', '.cts']);

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function collectSourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => compareText(left.name, right.name));

  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectSourceFiles(path));
    } else if (entry.isFile() && sourceExtensions.has(extname(entry.name))) {
      files.push(path);
    }
  }
  return files;
}

function isRelativeSpecifier(specifier) {
  return specifier === '.' || specifier === '..' || specifier.startsWith('./') || specifier.startsWith('../');
}

function importHasRuntimeEffect(node) {
  const clause = node.importClause;
  if (clause === undefined) return true;
  if (clause.isTypeOnly) return false;
  if (clause.name !== undefined) return true;

  const bindings = clause.namedBindings;
  if (bindings === undefined || ts.isNamespaceImport(bindings)) return true;
  return bindings.elements.length === 0 || bindings.elements.some((element) => !element.isTypeOnly);
}

function exportHasRuntimeEffect(node) {
  if (node.isTypeOnly) return false;
  if (node.exportClause === undefined || ts.isNamespaceExport(node.exportClause)) return true;
  return node.exportClause.elements.length === 0
    || node.exportClause.elements.some((element) => !element.isTypeOnly);
}

function runtimeSpecifiers(sourceFile) {
  const specifiers = new Set();

  function addModuleSpecifier(node) {
    const specifier = node.moduleSpecifier;
    if (specifier !== undefined && ts.isStringLiteralLike(specifier) && isRelativeSpecifier(specifier.text)) {
      specifiers.add(specifier.text);
    }
  }

  function visit(node) {
    if (ts.isImportDeclaration(node) && importHasRuntimeEffect(node)) {
      addModuleSpecifier(node);
    } else if (ts.isExportDeclaration(node) && exportHasRuntimeEffect(node)) {
      addModuleSpecifier(node);
    } else if (
      ts.isImportEqualsDeclaration(node)
      && !node.isTypeOnly
      && ts.isExternalModuleReference(node.moduleReference)
    ) {
      const expression = node.moduleReference.expression;
      if (expression !== undefined && ts.isStringLiteralLike(expression) && isRelativeSpecifier(expression.text)) {
        specifiers.add(expression.text);
      }
    } else if (
      ts.isCallExpression(node)
      && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments.length === 1
      && ts.isStringLiteralLike(node.arguments[0])
      && isRelativeSpecifier(node.arguments[0].text)
    ) {
      specifiers.add(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return [...specifiers].sort(compareText);
}

function resolutionCandidates(importer, specifier) {
  const target = resolve(dirname(importer), specifier);
  const extension = extname(target);

  if (extension === '.js') return [`${target.slice(0, -3)}.ts`, `${target.slice(0, -3)}.tsx`];
  if (extension === '.mjs') return [`${target.slice(0, -4)}.mts`];
  if (extension === '.cjs') return [`${target.slice(0, -4)}.cts`];
  if (sourceExtensions.has(extension)) return [target];
  if (extension !== '') return [];

  return [
    `${target}.ts`,
    `${target}.tsx`,
    `${target}.mts`,
    `${target}.cts`,
    join(target, 'index.ts'),
    join(target, 'index.tsx'),
    join(target, 'index.mts'),
    join(target, 'index.cts'),
  ];
}

function resolveSourceImport(importer, specifier, sourceFiles) {
  return resolutionCandidates(importer, specifier).find((candidate) => sourceFiles.has(candidate));
}

function stronglyConnectedComponents(graph) {
  let nextIndex = 0;
  const indexes = new Map();
  const lowLinks = new Map();
  const stack = [];
  const onStack = new Set();
  const components = [];

  function connect(node) {
    indexes.set(node, nextIndex);
    lowLinks.set(node, nextIndex);
    nextIndex += 1;
    stack.push(node);
    onStack.add(node);

    for (const dependency of graph.get(node)) {
      if (!indexes.has(dependency)) {
        connect(dependency);
        lowLinks.set(node, Math.min(lowLinks.get(node), lowLinks.get(dependency)));
      } else if (onStack.has(dependency)) {
        lowLinks.set(node, Math.min(lowLinks.get(node), indexes.get(dependency)));
      }
    }

    if (lowLinks.get(node) !== indexes.get(node)) return;

    const component = [];
    let current;
    do {
      current = stack.pop();
      onStack.delete(current);
      component.push(current);
    } while (current !== node);
    component.sort(compareText);
    components.push(component);
  }

  for (const node of [...graph.keys()].sort(compareText)) {
    if (!indexes.has(node)) connect(node);
  }
  return components;
}

function representativeCycle(graph, component) {
  const members = new Set(component);
  const start = component[0];

  function search(node, path, visited) {
    for (const dependency of graph.get(node)) {
      if (!members.has(dependency)) continue;
      if (dependency === start) return [...path, start];
      if (visited.has(dependency)) continue;

      visited.add(dependency);
      const cycle = search(dependency, [...path, dependency], visited);
      if (cycle !== undefined) return cycle;
      visited.delete(dependency);
    }
    return undefined;
  }

  return search(start, [start], new Set([start]));
}

function displayPath(path) {
  return relative(repositoryRoot, path).split(sep).join('/');
}

const files = await collectSourceFiles(sourceRoot);
const sourceFiles = new Set(files);
const graph = new Map(files.map((file) => [file, []]));
let edgeCount = 0;

for (const file of files) {
  const source = await readFile(file, 'utf8');
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, false);
  const dependencies = new Set();
  for (const specifier of runtimeSpecifiers(sourceFile)) {
    const dependency = resolveSourceImport(file, specifier, sourceFiles);
    if (dependency !== undefined) dependencies.add(dependency);
  }
  graph.set(file, [...dependencies].sort(compareText));
  edgeCount += dependencies.size;
}

const cyclicComponents = stronglyConnectedComponents(graph)
  .filter((component) => component.length > 1 || graph.get(component[0]).includes(component[0]))
  .sort((left, right) => compareText(left[0], right[0]));

if (cyclicComponents.length > 0) {
  console.error('Обнаружены циклы относительных runtime-импортов в src:');
  for (const component of cyclicComponents) {
    const cycle = representativeCycle(graph, component);
    console.error(`- ${cycle.map(displayPath).join(' -> ')}`);
  }
  process.exitCode = 1;
} else {
  console.log(
    `Циклы относительных runtime-импортов не обнаружены: ${files.length} файлов, ${edgeCount} связей.`,
  );
}
