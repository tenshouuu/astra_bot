#!/usr/bin/env node
/**
 * Audits agent bootstrap/context and repository Markdown against the layout.
 *
 * This is a read-only check. It verifies that discovered AGENTS.md and
 * AGENT_CONTEXT.md files point at existing repo paths. For AGENTS.md it also
 * verifies that the generated rule/skill indexes match the canonical ai/
 * sources. All tracked and non-ignored Markdown is checked for local links
 * and heading anchors. External URLs are not fetched.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const generatedRuleIndexStart = "<!-- BEGIN GENERATED RULE INDEX -->";
const generatedRuleIndexEnd = "<!-- END GENERATED RULE INDEX -->";
const generatedSkillIndexStart = "<!-- BEGIN GENERATED SKILL INDEX -->";
const generatedSkillIndexEnd = "<!-- END GENERATED SKILL INDEX -->";
const ignoredDirs = new Set([
  ".git",
  ".next",
  ".pnpm-store",
  ".turbo",
  "coverage",
  "dist",
  "node_modules",
  "out",
]);
const ignoredSubtrees = new Set([".claude/worktrees"]);

const requiredBootstrapPaths = [
  "ai/README.md",
  "ai/dev",
  "ai/roles",
  "AGENT_CONTEXT.md",
  "ai/rules",
  "ai/skills",
];
const rootLevelPathNames = new Set(["AGENT_CONTEXT.md", "AGENTS.md"]);
const historyHeadingPattern = /^##\s+(?:Update Log|Archive\b|Archive \/ long history)\b/i;
const packageAliasRoots = ["src", "src/modules", "src/config", "src/routes", "test"];
const optionalRuntimeAdapterPatterns = [
  /^\.cursor\/(?:\*|rules|skills)(?:\/.*)?$/,
  /^\.claude\/(?:\*|rules(?:\/.*)?|skills(?:\/.*)?)$/,
  /^\.agents\/skills(?:\/.*)?$/,
];

function toRepoPath(absolutePath) {
  return path.relative(root, absolutePath).split(path.sep).join("/");
}

function readText(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function walk(dir, visitor) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ignoredDirs.has(entry.name)) {
      continue;
    }

    const absolutePath = path.join(dir, entry.name);
    const repoPath = toRepoPath(absolutePath);
    if (ignoredSubtrees.has(repoPath)) {
      continue;
    }

    visitor(absolutePath, entry);

    if (entry.isDirectory()) {
      walk(absolutePath, visitor);
    }
  }
}

function listRepoEntries() {
  const entries = new Set(["."]);
  walk(root, (absolutePath, entry) => {
    if (entry.isFile() || entry.isDirectory() || entry.isSymbolicLink()) {
      entries.add(toRepoPath(absolutePath));
    }
  });
  return entries;
}

export function findMarkdownFiles(repositoryRoot = root) {
  const paths = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  return [...new Set(paths.split("\0"))]
    .filter((name) => /\.(?:md|mdc)$/.test(name))
    .map((name) => path.join(repositoryRoot, name))
    .filter((filePath) => fs.existsSync(filePath))
    .sort((a, b) => toRepoPath(a).localeCompare(toRepoPath(b), "en"));
}

function readFrontmatter(contents) {
  const match = contents.match(/^---\n([\s\S]*?)\n---\n?/);
  return match ? match[1] : "";
}

function readYamlScalar(frontmatter, key) {
  const match = frontmatter.match(new RegExp(`^${escapeRegExp(key)}:\\s*(.+)$`, "m"));
  if (!match) {
    return null;
  }
  return match[1].trim().replace(/^["']|["']$/g, "");
}

function readRuleFiles() {
  const rulesDir = path.join(root, "ai/rules");
  return fs
    .readdirSync(rulesDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".mdc"))
    .map((entry) => {
      const relativePath = `ai/rules/${entry.name}`;
      const contents = readText(path.join(rulesDir, entry.name));
      return {
        relativePath,
        alwaysApply: /\balwaysApply:\s*true\b/.test(readFrontmatter(contents)),
      };
    })
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath, "en"));
}

function readSkillFiles() {
  const skillsDir = path.join(root, "ai/skills");
  return fs
    .readdirSync(skillsDir, { withFileTypes: true })
    .filter(
      (entry) => entry.isDirectory() && fs.existsSync(path.join(skillsDir, entry.name, "SKILL.md")),
    )
    .map((entry) => {
      const relativePath = `ai/skills/${entry.name}/SKILL.md`;
      const contents = readText(path.join(skillsDir, entry.name, "SKILL.md"));
      const frontmatter = readFrontmatter(contents);
      return {
        relativePath,
        name: readYamlScalar(frontmatter, "name") ?? entry.name,
        description: readYamlScalar(frontmatter, "description") ?? "",
      };
    })
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath, "en"));
}

function extractGeneratedSection(contents, startMarker, endMarker) {
  const start = contents.indexOf(startMarker);
  const end = contents.indexOf(endMarker);
  if (start === -1 || end === -1 || end < start) {
    return null;
  }
  return contents.slice(start, end + endMarker.length);
}

function escapeMarkdownText(value) {
  return value.replace(/([_*])/g, "\\$1");
}

function renderRuleIndex(rules) {
  const coreRules = rules.filter((rule) => rule.alwaysApply);
  const scopedRules = rules.filter((rule) => !rule.alwaysApply);
  const coreLines = coreRules.map((rule) => `- \`${rule.relativePath}\``);
  const scopedLines = scopedRules.map((rule) => `- \`${rule.relativePath}\``);

  return [
    generatedRuleIndexStart,
    "",
    "Canonical rule files, generated by `pnpm sync:agents`:",
    "",
    "Core always-on rules (load by default):",
    "",
    ...(coreLines.length > 0 ? coreLines : ["- _(none)_"]),
    "",
    "Scoped rules (load only when the path/scope matches):",
    "",
    ...(scopedLines.length > 0 ? scopedLines : ["- _(none)_"]),
    "",
    generatedRuleIndexEnd,
  ].join("\n");
}

function renderSkillIndex(skills) {
  const skillLines = skills.map(
    (skill) =>
      `- \`${skill.relativePath}\` — ${escapeMarkdownText(skill.description || skill.name)}`,
  );

  return [
    generatedSkillIndexStart,
    "",
    "Canonical project skill files, generated by `pnpm sync:agents`:",
    "",
    ...(skillLines.length > 0 ? skillLines : ["- _(none)_"]),
    "",
    "When a task matches a skill, read that `SKILL.md` first, then follow its selected role routing.",
    "",
    generatedSkillIndexEnd,
  ].join("\n");
}

function extractPathReferences(contents) {
  const refs = [];

  for (const match of contents.matchAll(/`([^`\n]+)`/g)) {
    const line = offsetToLine(contents, match.index);
    addCandidate(refs, match[1], line, lineAt(contents, line), "inline-code");
  }

  for (const match of contents.matchAll(/\[[^\]\n]+\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const line = offsetToLine(contents, match.index);
    addCandidate(refs, match[1], line, lineAt(contents, line), "markdown-link");
  }

  return refs;
}

export function stripHistoricalSections(contents) {
  const lines = contents.split("\n");
  let historyLevel = null;
  return lines
    .map((line) => {
      const heading = line.match(/^(#{1,6})\s+/);
      if (historyLevel !== null && heading && heading[1].length <= historyLevel) {
        historyLevel = null;
      }
      if (historyHeadingPattern.test(line.trim())) {
        historyLevel = heading[1].length;
      }
      return historyLevel === null ? line : "";
    })
    .join("\n");
}

function maskCodeFences(contents) {
  let fence = null;
  return contents
    .split("\n")
    .map((line) => {
      const marker = line.match(/^\s{0,3}(`{3,}|~{3,})/);
      if (fence === null && marker) {
        fence = marker[1];
        return " ".repeat(line.length);
      }
      if (fence !== null) {
        if (
          marker &&
          marker[1][0] === fence[0] &&
          marker[1].length >= fence.length &&
          line.slice(marker[0].length).trim() === ""
        ) {
          fence = null;
        }
        return " ".repeat(line.length);
      }
      return line;
    })
    .join("\n");
}

export function markdownAnchors(contents) {
  const masked = maskCodeFences(contents);
  const anchors = new Set();
  for (const match of masked.matchAll(/\b(?:id|name)=["']([^"']+)["']/g)) {
    anchors.add(match[1]);
  }
  const addHeading = (heading) => {
    const base = heading
      .replace(/<[^>]*>/g, "")
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{M}\p{N}_\-\s]/gu, "")
      .replace(/ /g, "-");
    let slug = base;
    let suffix = 0;
    while (anchors.has(slug)) {
      slug = `${base}-${++suffix}`;
    }
    anchors.add(slug);
  };
  const lines = masked.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const heading = lines[index].match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
    if (heading) {
      addHeading(heading[1]);
    } else if (
      index > 0 &&
      /^\s{0,3}(?:=+|-+)\s*$/.test(lines[index]) &&
      lines[index - 1].trim() !== ""
    ) {
      addHeading(lines[index - 1]);
    }
  }
  return anchors;
}

export function auditMarkdownLinks(filePath, repositoryRoot = root) {
  const contents = maskCodeFences(readText(filePath)).replace(
    /(`+)(?!`)([\s\S]*?)\1(?!`)/g,
    (match) => match.replace(/[^\n]/g, " "),
  );
  const links = [
    ...contents.matchAll(/!?\[[^\]\n]*\]\((<[^>\n]+>|[^\s)]+)(?:\s+["'][^\n]*?["'])?\)/g),
    ...contents.matchAll(/^\s{0,3}\[[^\]\n]+\]:\s*(<[^>\n]+>|[^\s]+)(?:\s+.*)?$/gm),
  ];
  const findings = [];
  for (const match of links) {
    const destination = match[1].replace(/^<|>$/g, "");
    if (/^[a-z][a-z\d+.-]*:/i.test(destination) || destination.startsWith("//")) {
      continue;
    }
    const line = offsetToLine(contents, match.index);
    let target;
    let fragment;
    try {
      const hash = destination.indexOf("#");
      target = decodeURIComponent(hash === -1 ? destination : destination.slice(0, hash));
      fragment = hash === -1 ? "" : decodeURIComponent(destination.slice(hash + 1));
    } catch {
      findings.push({ severity: "error", line, message: `Malformed link: ${destination}` });
      continue;
    }
    const resolved =
      target === ""
        ? filePath
        : path.resolve(
            target.startsWith("/") ? repositoryRoot : path.dirname(filePath),
            target.replace(/^\//, ""),
          );
    const relative = path.relative(repositoryRoot, resolved);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      findings.push({ severity: "error", line, message: `Link leaves repository: ${destination}` });
    } else if (!fs.existsSync(resolved)) {
      findings.push({
        severity: "error",
        line,
        message: `Missing local link target: ${destination}`,
      });
    } else if (
      fragment &&
      /\.(?:md|mdc)$/.test(resolved) &&
      !markdownAnchors(readText(resolved)).has(fragment)
    ) {
      findings.push({ severity: "error", line, message: `Missing heading anchor: ${destination}` });
    }
  }
  return findings;
}

function addCandidate(refs, rawValue, line, lineText, source) {
  const value = normalizeCandidate(rawValue);
  if (value === null || !looksLikeRepoPath(value) || shouldIgnoreReference(value, lineText)) {
    return;
  }

  refs.push({ value, line, source });
}

function normalizeCandidate(value) {
  let normalized = value.trim();

  if (
    normalized === "" ||
    normalized.startsWith("http://") ||
    normalized.startsWith("https://") ||
    normalized.startsWith("mailto:") ||
    normalized.startsWith("#")
  ) {
    return null;
  }

  normalized = normalized.replace(/^@\.?\//, "");
  normalized = normalized.replace(/^\.\/+/, "");
  normalized = normalized.replace(/^<|>$/g, "");
  normalized = normalized.replace(/[.,;:]+$/g, "");
  normalized = normalized.replace(/^\//, "");

  if (normalized.includes(" ") || normalized.includes("\t") || normalized.includes("\n")) {
    return null;
  }

  return normalized;
}

function looksLikeRepoPath(value) {
  if (isNonFileToken(value)) {
    return false;
  }

  // A glob is only a path candidate when it also carries a path separator.
  // Bare wildcard tokens are prose about naming conventions, not locations —
  // e.g. CSS utility families (`text-*`) or env prefixes (`NEXT_PUBLIC_*`).
  if (value.includes("*")) {
    return value.includes("/");
  }

  if (
    value.startsWith(".") ||
    value.startsWith("ai/") ||
    value.startsWith("apps/") ||
    value.startsWith("docs/") ||
    value.startsWith("packages/") ||
    value.startsWith("scripts/") ||
    value.startsWith("src/")
  ) {
    return true;
  }

  return /\/.+\.[A-Za-z0-9]+$/.test(value) || rootLevelPathNames.has(value);
}

function isNonFileToken(value) {
  if (
    (/^\.env(?:\.|$)/.test(path.posix.basename(value)) &&
      ![".env.example", ".env.sample"].includes(path.posix.basename(value))) ||
    value === ".env" ||
    value.startsWith(".env") ||
    value.startsWith(".v") ||
    value.startsWith("*.") ||
    value.startsWith("api/") ||
    value.startsWith("v1/") ||
    value.startsWith("files/") ||
    value.startsWith("0x") ||
    value.includes(":") ||
    value.includes("@")
  ) {
    return true;
  }

  if (/^[A-Z0-9_*-]+$/.test(value)) {
    return true;
  }

  if (/^[a-z]+(?:\.[a-zA-Z0-9_*]+)+$/.test(value)) {
    return true;
  }

  if (/^[a-z]+\/v?\d+(?:\.\d+)+$/.test(value)) {
    return true;
  }

  if (value.includes("<") || value.includes(">")) {
    return true;
  }

  return false;
}

function offsetToLine(contents, offset) {
  return contents.slice(0, offset).split("\n").length;
}

function lineAt(contents, lineNumber) {
  return contents.split("\n")[lineNumber - 1] ?? "";
}

function shouldIgnoreReference(value, lineText) {
  if (value.includes("{") || value.includes("}")) {
    return true;
  }

  if (isOptionalRuntimeAdapterReference(value)) {
    return true;
  }

  if (
    lineText.includes("Older Update Log entries") ||
    value.includes("first-link-step-up-gate.ts") ||
    /\b(?:removed|deleted|formerly|was)\b/i.test(lineText)
  ) {
    return true;
  }

  if (value.startsWith(".pnpm/") || ignoredDirs.has(value.split("/")[0])) {
    return true;
  }

  return false;
}

function isOptionalRuntimeAdapterReference(value) {
  return optionalRuntimeAdapterPatterns.some((pattern) => pattern.test(value));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function globToRegExp(glob) {
  const segments = glob.split("/");
  const pattern = segments
    .map((segment, index) => {
      if (segment === "**") {
        return index === segments.length - 1 ? "(?:.*)?" : "(?:.*/)?";
      }

      const escaped = escapeRegExp(segment).replace(/\\\*/g, "[^/]*").replace(/\\\?/g, "[^/]");
      return index === segments.length - 1 ? escaped : `${escaped}/`;
    })
    .join("");

  return new RegExp(`^${pattern}$`);
}

function pathExistsFrom(ref, baseDir, repoEntries) {
  const bases = candidateBaseDirs(baseDir);
  const refs = expandReference(ref);

  if (ref.includes("*")) {
    const patterns = new Set();
    for (const currentRef of refs) {
      patterns.add(currentRef);
      for (const base of bases) {
        patterns.add(toRepoPath(path.resolve(base, currentRef)));
      }
    }
    return [...patterns].some((pattern) => {
      const regexp = globToRegExp(pattern);
      return [...repoEntries].some((entry) => regexp.test(entry));
    });
  }

  return refs.some((currentRef) =>
    bases.some((base) => fs.existsSync(path.resolve(base, currentRef))),
  );
}

function candidateBaseDirs(baseDir) {
  const bases = new Set([root, baseDir]);
  const packageRoot = findNearestPackageRoot(baseDir);

  if (packageRoot !== null) {
    bases.add(packageRoot);
    for (const aliasRoot of packageAliasRoots) {
      const absoluteAliasRoot = path.join(packageRoot, aliasRoot);
      if (fs.existsSync(absoluteAliasRoot)) {
        bases.add(absoluteAliasRoot);
      }
    }
  }

  return [...bases];
}

function findNearestPackageRoot(startDir) {
  let current = startDir;
  while (current.startsWith(root)) {
    if (fs.existsSync(path.join(current, "package.json"))) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }

  return null;
}

function expandReference(ref) {
  const match = ref.match(/^(.*)\{([^{}]+)\}(.*)$/);
  if (!match) {
    return [ref];
  }

  const [, before, variants, after] = match;
  return variants.split(",").flatMap((variant) => expandReference(`${before}${variant}${after}`));
}

function auditPathReferences(filePath, repoEntries, explicitOnly = false) {
  const relativePath = toRepoPath(filePath);
  const baseDir = path.dirname(filePath);
  const contents = stripHistoricalSections(readText(filePath));
  const findings = [];
  const refs = extractPathReferences(contents);
  const seenRefs = new Set();

  for (const ref of refs) {
    // Ordinary docs use package-relative examples as well as repository paths.
    // Audit unambiguous repository pointers; Markdown links have a strict,
    // separate resolver that checks their file-relative target and anchor.
    if (
      ref.source !== "inline-code" ||
      (explicitOnly &&
        !/^(?:ai|apps|packages|docs|scripts)\//.test(ref.value) &&
        !rootLevelPathNames.has(ref.value))
    ) {
      continue;
    }
    const key = `${ref.value}:${ref.line}`;
    if (seenRefs.has(key)) {
      continue;
    }
    seenRefs.add(key);

    if (!pathExistsFrom(ref.value, baseDir, repoEntries)) {
      findings.push({
        severity: "error",
        line: ref.line,
        message: `Path reference does not resolve from repo root or ${path.dirname(relativePath)}: ${ref.value}`,
      });
    }
  }

  return findings;
}

function auditAgentsFile(filePath, repoEntries, rules, skills) {
  const contents = readText(filePath);
  const findings = [];

  for (const requiredPath of requiredBootstrapPaths) {
    if (!fs.existsSync(path.join(root, requiredPath))) {
      findings.push({
        severity: "error",
        message: `Required bootstrap path does not exist: ${requiredPath}`,
      });
    }
  }

  const ruleSection = extractGeneratedSection(
    contents,
    generatedRuleIndexStart,
    generatedRuleIndexEnd,
  );
  const skillSection = extractGeneratedSection(
    contents,
    generatedSkillIndexStart,
    generatedSkillIndexEnd,
  );

  if (ruleSection === null) {
    findings.push({ severity: "error", message: "Missing generated rule index section." });
  } else if (ruleSection !== renderRuleIndex(rules)) {
    findings.push({
      severity: "error",
      message: "Generated rule index is stale; run `pnpm sync:agents`.",
    });
  }

  if (skillSection === null) {
    findings.push({ severity: "error", message: "Missing generated skill index section." });
  } else if (skillSection !== renderSkillIndex(skills)) {
    findings.push({
      severity: "error",
      message: "Generated skill index is stale; run `pnpm sync:agents`.",
    });
  }

  findings.push(...auditPathReferences(filePath, repoEntries));

  return { relativePath: toRepoPath(filePath), findings };
}

function auditAgentContextFile(filePath, repoEntries) {
  const contents = readText(filePath);
  const findings = auditPathReferences(filePath, repoEntries);
  for (const match of contents.matchAll(/^#{1,6}\s+Update Log\b.*$/gm)) {
    findings.push({
      severity: "error",
      line: offsetToLine(contents, match.index),
      message: "Context must describe current state; keep completed-work history in Git.",
    });
  }
  return {
    relativePath: toRepoPath(filePath),
    findings,
  };
}

function printReports(label, reports) {
  console.log(`${label}: ${reports.length}`);
  for (const report of reports) {
    console.log(`- ${report.relativePath}`);
    if (report.findings.length === 0) {
      console.log("  ok");
      continue;
    }

    for (const finding of report.findings) {
      const line = finding.line === undefined ? "" : `:${finding.line}`;
      console.log(`  [${finding.severity}] ${report.relativePath}${line} ${finding.message}`);
    }
  }
}

function main() {
  const repoEntries = listRepoEntries();
  const markdownFiles = findMarkdownFiles();
  const agentsFiles = [
    ...new Set([
      path.join(root, "AGENTS.md"),
      ...markdownFiles.filter((filePath) => path.basename(filePath) === "AGENTS.md"),
    ]),
  ];
  const agentContextFiles = markdownFiles.filter(
    (filePath) => path.basename(filePath) === "AGENT_CONTEXT.md",
  );
  const rules = readRuleFiles();
  const skills = readSkillFiles();
  const agentReports = agentsFiles.map((filePath) =>
    auditAgentsFile(filePath, repoEntries, rules, skills),
  );
  const contextReports = agentContextFiles.map((filePath) =>
    auditAgentContextFile(filePath, repoEntries),
  );
  const markdownReports = markdownFiles.map((filePath) => ({
    relativePath: toRepoPath(filePath),
    findings: [
      ...auditMarkdownLinks(filePath),
      ...(toRepoPath(filePath).startsWith("ai/dev/") ||
      path.basename(filePath) === "AGENTS.md" ||
      path.basename(filePath) === "AGENT_CONTEXT.md"
        ? []
        : auditPathReferences(filePath, repoEntries, true)),
    ],
  }));
  const reports = [...agentReports, ...contextReports, ...markdownReports];
  const errorCount = reports.reduce(
    (count, report) =>
      count + report.findings.filter((finding) => finding.severity === "error").length,
    0,
  );

  printReports("Bootstrap files", agentReports);
  printReports("AGENT_CONTEXT.md files", contextReports);
  console.log(
    `Markdown files checked: ${markdownFiles.length} (local links, anchors, current repo pointers)`,
  );
  for (const report of markdownReports.filter((report) => report.findings.length > 0)) {
    printReports("Markdown link errors", [report]);
  }

  console.log(`Rules indexed: ${rules.length}`);
  console.log(`Skills indexed: ${skills.length}`);

  if (errorCount > 0) {
    console.error(`AGENTS audit failed: ${errorCount} error(s).`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
