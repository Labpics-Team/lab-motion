import { basename, extname } from 'node:path';

// Pinned Trivy 0.74.0 pkg/iac/ignore/parse.go is the authority for directive
// tokenization. This is admission of scanner controls, not a CVE detector.
const SPACE = '[\\u0009-\\u000d\\u0020\\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]';
const trimSpace = value => value.replace(new RegExp(`^${SPACE}+|${SPACE}+$`, 'g'), '');
const CONFIG_EXTENSIONS = new Set(['.tf', '.tfvars', '.hcl', '.json', '.jsonc', '.yaml', '.yml', '.template', '.tpl', '.tftpl']);
export function scannerConfigurationPath(path) {
  const name = basename(path).toLowerCase();
  return /^(dockerfile|containerfile)([.-]|$)/.test(name) || /\.(dockerfile|containerfile)$/.test(name) || CONFIG_EXTENSIONS.has(extname(name));
}
export function hasInlineScannerControl(line) {
  for (let token of trimSpace(line).split(' ')) {
    token = trimSpace(token).replace(/^[#/*]+/, '');
    const prefix = token.startsWith('trivy:') ? 6 : token.startsWith('tfsec:') ? 6 : 0;
    if (!prefix) continue;
    const sections = token.slice(prefix).split(':');
    for (let i = 0; i + 1 < sections.length; i += 2) {
      if (sections[i] === 'ignore' && sections[i + 1].split('[')[0]) return true;
    }
  }
  return false;
}
