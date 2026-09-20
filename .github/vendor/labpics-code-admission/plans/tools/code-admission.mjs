#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, basename, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { hasInlineScannerControl, scannerConfigurationPath } from "./code-admission/controls.mjs";
import { materializeSnapshot } from "./code-admission/snapshot.mjs";
import { prepareQualifiedExecutable } from "./code-admission/identity.mjs";
import { blockingSecurityFindings, createTrivySession } from "./code-admission/trivy.mjs";

const MAX_OUTPUT = 64 * 1024 * 1024;
const MAX_TEXT_FILE = 64 * 1024 * 1024;
const SKIP_WALK_DIRS = new Set([".git", "node_modules", "target", ".venv", "vendor", "dist", "build", ".next"]);

const sha256 = (value) => createHash("sha256").update(String(value)).digest("hex");
const slash = (value) => String(value).split(sep).join("/");
const compactWhitespace = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

const canonicalRelative = (root, raw) => {
  if (typeof raw !== "string" || !raw || /[\x00-\x1f\x7f]/.test(raw)) throw new TypeError("Invalid analyzer source path");
  const candidate = isAbsolute(raw) ? resolve(raw) : resolve(root, raw);
  const result = relative(resolve(root), candidate);
  if (!result || isAbsolute(result) || result === ".." || result.startsWith(`..${sep}`)) throw new TypeError("Analyzer source path is outside snapshot");
  return slash(result);
};

export const multisetDifference = (baseFindings, candidateFindings) => {
  const remaining = new Map();
  for (const finding of baseFindings) {
    remaining.set(finding.fingerprint, (remaining.get(finding.fingerprint) ?? 0) + 1);
  }
  const added = [];
  for (const finding of candidateFindings) {
    const count = remaining.get(finding.fingerprint) ?? 0;
    if (count > 0) remaining.set(finding.fingerprint, count - 1);
    else added.push(finding);
  }
  return added;
};

export const normalizeAstMatches = (matches, root) => {
  if (!Array.isArray(matches)) throw new TypeError("ast-grep JSON must be an array");
  return matches.map((match) => {
    const path = canonicalRelative(root, match.file);
    const rule = String(match.ruleId ?? "ast-grep");
    const text = compactWhitespace(match.text);
    const start = match?.range?.start?.line;
    if (typeof match.text !== "string" || !Number.isSafeInteger(start) || start < 0) throw new TypeError("Invalid analyzer source witness");
    const line = start + 1;
    return {
      fingerprint: `ast:${rule}:${path}:${sha256(text)}`,
      source: "ast-grep",
      rule,
      path,
      line,
      message: String(match.message ?? `Structural rule ${rule} matched`),
    };
  });
};

export { normalizeTrivyReport } from "./code-admission/trivy.mjs";

const fallbackWalk = (root) => {
  const files = [];
  const visit = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      if (name === ".git") continue;
      const path = join(dir, name);
      const stat = statSync(path, { throwIfNoEntry: false });
      if (!stat) continue;
      if (stat.isDirectory()) visit(path);
      else if (stat.isFile()) files.push(path);
    }
  };
  visit(root);
  return files;
};

const trackedFiles = (root) => {
  const top = spawnSync("git", ["-C", root, "rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  if (top.status !== 0 || resolve(top.stdout.trim()) !== resolve(root)) return fallbackWalk(root);
  const git = spawnSync("git", ["-C", root, "ls-files", "-z"], {
    encoding: "buffer",
    maxBuffer: MAX_OUTPUT,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (git.status === 0) {
    return git.stdout
      .toString("utf8")
      .split("\0")
      .filter(Boolean)
      .map((path) => join(root, path));
  }
  return fallbackWalk(root);
};

const readSmallText = (path) => {
  const stat = statSync(path, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.size > MAX_TEXT_FILE) return null;
  const bytes = readFileSync(path);
  if (bytes.includes(0)) return null;
  return bytes.toString("utf8");
};

const SUPPRESSION_PATTERNS = Object.freeze([
  { rule: "lab-bypass-ast-grep-ignore", regex: /ast-grep-ignore\s*:/g, message: "ast-grep suppression is owned by trusted policy, not candidate code" },
]);

export const collectBypassFindings = (root, configTargets = []) => {
  const detectedConfigs = new Set(configTargets);
  const findings = [];
  for (const absolute of trackedFiles(root)) {
    const path = canonicalRelative(root, absolute);
    const name = basename(path);
    const text = readSmallText(absolute);
    if (text === null) continue;

    if (name === ".trivyignore" || name.startsWith(".trivyignore.")) {
      findings.push({
        fingerprint: `bypass:trivy-ignore:${path}:${sha256(text)}`,
        source: "policy",
        rule: "lab-bypass-trivy-ignore",
        path,
        line: 1,
        message: "Trivy suppressions must be changed in trusted policy, not candidate code",
      });
    }

    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
      const lineText = lines[index];
      if ((scannerConfigurationPath(path) || detectedConfigs.has(path)) && hasInlineScannerControl(lineText)) {
        findings.push({
          fingerprint: `bypass:trivy-inline:${path}:${sha256(compactWhitespace(lineText))}`,
          source: "policy", kind: "scanner-control", severity: "UNKNOWN",
          rule: "lab-bypass-trivy-inline", path, line: index + 1,
          message: "Candidate-owned inline scanner suppression requires external policy review; hidden findings are not a clean scan",
        });
      }
      for (const pattern of SUPPRESSION_PATTERNS) {
        pattern.regex.lastIndex = 0;
        if (!pattern.regex.test(lineText)) continue;
        findings.push({
          fingerprint: `bypass:${pattern.rule}:${path}:${sha256(compactWhitespace(lineText))}`,
          source: "policy",
          rule: pattern.rule,
          path,
          line: index + 1,
          message: pattern.message,
        });
      }
    }
  }
  return findings;
};

const commandJson = (runtime, args, { allowedStatuses = [0], cwd, home = process.env.HOME } = {}) => {
  const result = runtime.run(args, {
    cwd,
    encoding: "utf8",
    maxBuffer: MAX_OUTPUT,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120000,
    env: { PATH: process.env.PATH, HOME: home, NO_COLOR: "1" },
  });
  if (result.error) throw new Error(`${command} failed to start: ${result.error.message}`);
  if (!allowedStatuses.includes(result.status)) {
    throw new Error(`Structural analyzer exited ${result.status}; diagnosticDigest=${sha256(result.stderr ?? "")}`);
  }
  try {
    if (!result.stdout?.trim()) throw new Error("empty output");
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error("Structural analyzer returned invalid or empty JSON");
  }
};

const AST_EXTENSIONS = Object.freeze({
  rust: new Set([".rs"]),
  go: new Set([".go"]),
  typescript: new Set([".ts", ".tsx", ".mts", ".cts"]),
  javascript: new Set([".js", ".jsx", ".mjs", ".cjs"]),
});

const extension = (path) => {
  const name = basename(path);
  const index = name.lastIndexOf(".");
  return index === -1 ? "" : name.slice(index).toLowerCase();
};

export const validateStructuralRules = (value) => {
  if (!Array.isArray(value) || value.length === 0) throw new Error("trusted structural rule set must be a non-empty array");
  const ids = new Set();
  return value.map((rule, index) => {
    if (!rule || typeof rule !== "object") throw new Error(`structural rule ${index} must be an object`);
    const id = String(rule.id ?? "");
    const language = String(rule.language ?? "").toLowerCase();
    const pattern = String(rule.pattern ?? "");
    const message = String(rule.message ?? "");
    if (!/^lab-[a-z0-9-]+$/.test(id)) throw new Error(`invalid structural rule id: ${id}`);
    if (ids.has(id)) throw new Error(`duplicate structural rule id: ${id}`);
    if (!AST_EXTENSIONS[language]) throw new Error(`unsupported structural rule language: ${language}`);
    if (!pattern || !message) throw new Error(`structural rule ${id} requires pattern and message`);
    ids.add(id);
    return Object.freeze({ id, language, pattern, message });
  });
};

const astFindings = ({ root, runtime, rules, policyDirectory }) => {
  const config = join(policyDirectory, "ast-grep-policy.yml");
  writeFileSync(config, "ruleDirs: []\n", { mode: 0o600 });
  const files = trackedFiles(root);
  const findings = [];
  for (const rule of rules) {
    const extensions = AST_EXTENSIONS[rule.language];
    const inputs = files.filter((path) => extensions.has(extension(path)));
    for (let offset = 0; offset < inputs.length; offset += 128) {
      const chunk = inputs.slice(offset, offset + 128);
      if (chunk.length === 0) continue;
      const report = commandJson(runtime, [
        "run", "--config", config, "--threads", "2",
        ...["hidden", "dot", "exclude", "global", "parent", "vcs"].flatMap(kind => ["--no-ignore", kind]),
        "--pattern", rule.pattern,
        "--lang", rule.language,
        "--json=compact",
        "--color", "never",
        ...chunk,
      ], { allowedStatuses: [0, 1], cwd: policyDirectory, home: policyDirectory });
      findings.push(...normalizeAstMatches(report.map((match) => ({
        ...match,
        ruleId: rule.id,
        message: rule.message,
      })), root));
    }
  }
  return findings;
};


export const formatFinding = (finding) =>
  `${finding.rule} ${finding.path}:${finding.line} ${finding.message}`;

export const parseArgs = (argv) => {
  const allowed = new Set(["base", "base-ref", "candidate", "candidate-ref", "trusted", "ast-grep", "ast-grep-digest", "ast-rules-digest", "trivy", "trivy-digest", "trivy-cache", "out"]);
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error(`invalid argument near ${key ?? "<end>"}`);
    if (!allowed.has(key.slice(2)) || values.has(key.slice(2))) throw new Error("unknown or duplicate admission argument");
    values.set(key.slice(2), value);
  }
  return Object.fromEntries(values);
};

const inspectSnapshots = ({ base, candidate, trusted, astGrep, astDigest, astRulesDigest, trivy, trivyDigest, cacheDir }) => {
  const rulesPath = join(trusted, "plans/tools/code-admission/rules.json");
  const rulesRaw = readFileSync(rulesPath, "utf8");
  if (sha256(rulesRaw) !== astRulesDigest) throw new Error("ast-grep rules do not match their qualified digest");
  const rules = validateStructuralRules(JSON.parse(rulesRaw));

  const policyDirectory = join(cacheDir, "ast-policy");
  mkdirSync(policyDirectory, { recursive: true, mode: 0o700 });
  const astRuntime = prepareQualifiedExecutable(astGrep, astDigest, cacheDir, "ast-grep binary");
  let baseAst, candidateAst;
  try {
    baseAst = astFindings({ root: base, runtime: astRuntime, rules, policyDirectory });
    candidateAst = astFindings({ root: candidate, runtime: astRuntime, rules, policyDirectory });
  } finally { astRuntime.close(); }
  const session = createTrivySession(trivy, cacheDir, trivyDigest);
  let candidateScan;
  try { candidateScan = session.scan(candidate); }
  finally { session.close(); }
  // Security has no grandfathering. A second baseline scan cannot change the
  // decision and needlessly doubles source work and database exposure.
  const baseBypass = collectBypassFindings(base);
  const candidateBypass = collectBypassFindings(candidate, candidateScan.evidence.configTargets);
  const candidateTrivy = candidateScan.findings;
  const sourceControls = candidateBypass.filter(finding => finding.kind === "scanner-control");
  const blocking = [...blockingSecurityFindings(candidateTrivy), ...sourceControls];
  const baseFindings = [...baseAst, ...baseBypass];
  const candidateFindings = [...candidateAst, ...candidateBypass];
  const added = multisetDifference(baseFindings, candidateFindings)
    .sort((left, right) => formatFinding(left).localeCompare(formatFinding(right)));

  return {
    valid: added.length === 0 && blocking.length === 0,
    structural: { tool: { name: "ast-grep", binaryDigest: astDigest }, rulesDigest: astRulesDigest },
    security: { mode: "strict-candidate", findings: candidateTrivy, sourceControls, blocking, evidence: candidateScan.evidence, baselineEvidence: null, baselineReason: "not-scanned-no-security-grandfathering" },
    sbom: candidateScan.sbom,
    baseCount: baseFindings.length,
    candidateCount: candidateFindings.length,
    added,
    counts: {
      ast: { base: baseAst.length, candidate: candidateAst.length },
      bypass: { base: baseBypass.length, candidate: candidateBypass.length },
      trivy: { base: null, candidate: candidateTrivy.length },
    },
  };
};

export const runAdmission = ({ base, candidate, trusted, astGrep, astDigest, astRulesDigest, trivy, trivyDigest, cacheDir, baseRef = "HEAD", candidateRef = "HEAD" }) => {
  if (!/^[a-f0-9]{64}$/.test(astDigest ?? "")) throw new TypeError("A qualified ast-grep binary digest is required");
  if (!/^[a-f0-9]{64}$/.test(astRulesDigest ?? "")) throw new TypeError("A qualified ast-grep rules digest is required");
  if (!/^[a-f0-9]{64}$/.test(trivyDigest ?? "")) throw new TypeError("A qualified Trivy binary digest is required");
  mkdirSync(cacheDir, { recursive: true });
  const work = mkdtempSync(join(cacheDir, "source-snapshots-"));
  try {
    const basePath = join(work, "base"), candidatePath = join(work, "candidate");
    const subjects = {
      base: materializeSnapshot(base, baseRef, basePath),
      candidate: materializeSnapshot(candidate, candidateRef, candidatePath),
    };
    const result = inspectSnapshots({ base: basePath, candidate: candidatePath, trusted, astGrep, astDigest, astRulesDigest, trivy, trivyDigest, cacheDir: work });
    return { schema: "labpics.code-admission/v2", outcome: result.valid ? "passed" : "rejected", subjects, ...result };
  } finally { rmSync(work, { recursive: true, force: true }); }
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    for (const name of ["base", "candidate", "trusted", "ast-grep", "trivy"]) {
      if (!args[name]) throw new Error(`missing --${name}`);
    }
    const cacheDir = args["trivy-cache"] ?? mkdtempSync(join(tmpdir(), "labpics-trivy-"));
    const result = runAdmission({
      base: resolve(args.base),
      candidate: resolve(args.candidate),
      trusted: resolve(args.trusted),
      astGrep: resolve(args["ast-grep"]),
      astDigest: args["ast-grep-digest"],
      astRulesDigest: args["ast-rules-digest"],
      trivy: resolve(args.trivy),
      trivyDigest: args["trivy-digest"],
      cacheDir: resolve(cacheDir),
      baseRef: args["base-ref"] ?? "HEAD",
      candidateRef: args["candidate-ref"] ?? "HEAD",
    });
    if (args.out) {
      mkdirSync(resolve(args.out), { recursive: true });
      const { sbom, ...evidence } = result;
      writeFileSync(join(resolve(args.out), "admission.json"), JSON.stringify(evidence, null, 2) + "\n");
      writeFileSync(join(resolve(args.out), "sbom.cdx.json"), JSON.stringify(sbom, null, 2) + "\n");
    }
    console.log(`code admission: base=${result.baseCount} candidate=${result.candidateCount}`);
    console.log(`  ast-grep: ${result.counts.ast.base} -> ${result.counts.ast.candidate}`);
    console.log(`  policy bypass: ${result.counts.bypass.base} -> ${result.counts.bypass.candidate}`);
    console.log(`  trivy: ${result.counts.trivy.candidate} findings on exact candidate; no baseline exemption`);
    if (!result.valid) {
      console.error(`code admission rejected: ${result.added.length} new findings and ${result.security.blocking.length} blocking security findings:`);
      for (const finding of [...new Map([...result.added, ...result.security.blocking].map(f => [f.fingerprint, f])).values()]) {
        console.error(`- ${formatFinding(finding)}`);
        const safeMessage = `${finding.rule}: ${finding.message}`.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
        console.error(`::error file=${encodeURIComponent(finding.path)},line=${finding.line},title=${encodeURIComponent(finding.rule)}::${safeMessage}`);
      }
      process.exit(1);
    }
    console.log("code admission accepted: no new structural debt and no blocking security findings");
  } catch (error) {
    console.error(`code admission infrastructure failure: ${error.message}`);
    process.exit(2);
  }
}
