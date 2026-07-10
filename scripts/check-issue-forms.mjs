import { readdirSync, readFileSync } from 'node:fs';

const directory = new URL('../.github/ISSUE_TEMPLATE/', import.meta.url);
const files = readdirSync(directory)
  .filter((name) => /\.ya?ml$/u.test(name) && name !== 'config.yml')
  .sort();

const errors = [];
const allowedTypes = new Set(['checkboxes', 'dropdown', 'input', 'markdown', 'textarea', 'upload']);

for (const file of files) {
  const source = readFileSync(new URL(file, directory), 'utf8');

  // `about` допустим в legacy Markdown frontmatter и contact_links config,
  // но GitHub YAML issue form требует top-level `description`.
  if (/^about\s*:/mu.test(source)) {
    errors.push(`${file}: top-level about недопустим; используйте description`);
  }
  if (!/^name\s*:\s*\S+/mu.test(source)) errors.push(`${file}: отсутствует name`);
  if (!/^description\s*:\s*\S+/mu.test(source)) {
    errors.push(`${file}: отсутствует description`);
  }
  if (!/^body\s*:/mu.test(source)) errors.push(`${file}: отсутствует body`);

  const ids = [...source.matchAll(/^\s+id\s*:\s*([^\s#]+)\s*$/gmu)].map((match) => match[1]);
  const seen = new Set();
  for (const id of ids) {
    if (!/^[A-Za-z0-9_-]+$/u.test(id)) errors.push(`${file}: некорректный id ${id}`);
    if (seen.has(id)) errors.push(`${file}: повторный id ${id}`);
    seen.add(id);
  }

  const types = [...source.matchAll(/^\s+- type\s*:\s*([^\s#]+)\s*$/gmu)].map(
    (match) => match[1],
  );
  if (types.length === 0) errors.push(`${file}: body не содержит элементов form schema`);
  for (const type of types) {
    if (!allowedTypes.has(type)) errors.push(`${file}: неизвестный type ${type}`);
  }
}

if (files.length === 0) errors.push('issue forms не найдены');

if (errors.length > 0) {
  console.error(`issue-forms: FAIL\n${errors.map((error) => `- ${error}`).join('\n')}`);
  process.exit(1);
}

console.log(`issue-forms: PASS — ${files.length} forms`);
