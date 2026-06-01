import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const strict = process.argv.includes("--strict");
const configPath = path.join(root, "scripts", "maintainability.config.json");
const config = fs.existsSync(configPath)
  ? JSON.parse(fs.readFileSync(configPath, "utf8"))
  : {};
const configuredIgnores = Array.isArray(config.ignoredSegments)
  ? config.ignoredSegments
  : [];
const ignoredPathIncludes = (config.ignoredPathIncludes ?? []).map((item) =>
  item.replaceAll("\\", "/"),
);
const ignoredSegments = new Set([
  "node_modules",
  ".git",
  "dist",
  "dist-bundle",
  "build",
  "out",
  "coverage",
  ".wrangler",
  "target",
  "release",
  ...configuredIgnores,
]);
const sourceExtensions = new Set(
  config.sourceExtensions ?? [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
);
const styleExtensions = new Set([".css", ".scss", ".sass", ".less"]);
const generatedPatterns = (
  config.generatedPatterns ?? [
    "dist/",
    "dist-bundle/",
    "/dist/",
    "/build/",
    "/out/",
    "/target/",
    "/gen/",
    "worker-configuration.d.ts",
    "vite-env.d.ts",
    "next-env.d.ts",
    "*.tsbuildinfo",
  ]
).map((pattern) => pattern.replaceAll("\\", "/"));
const allowedGenerated = new Set(
  (config.allowedGenerated ?? []).map((item) => item.replaceAll("\\", "/")),
);
const maxImpl = Number(config.maxImplementationFileLines ?? 700);
const maxStyle = Number(config.maxStyleFileLines ?? 400);
const maxAppShell = Number(config.maxAppShellLines ?? 180);
const maxDesktopMain = Number(config.maxDesktopMainLines ?? 450);
const maxDomainBarrel = Number(config.maxDomainBarrelLines ?? 250);
const nearMargin = Number(config.nearBudgetMarginLines ?? 0);
const specificFileBudgets = config.specificFileBudgets ?? {};

function relative(file) {
  return path.relative(root, file).replaceAll("\\", "/");
}

function shouldSkipPath(relativePath) {
  return ignoredPathIncludes.some(
    (item) => relativePath === item || relativePath.startsWith(`${item}/`),
  );
}

function walk(directory, files = []) {
  if (!fs.existsSync(directory)) return files;
  const relativeDirectory = relative(directory);
  if (shouldSkipPath(relativeDirectory)) return files;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredSegments.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    const relativePath = relative(absolute);
    if (shouldSkipPath(relativePath)) continue;
    if (entry.isDirectory()) {
      walk(absolute, files);
      continue;
    }
    if (sourceExtensions.has(path.extname(entry.name))) files.push(absolute);
  }
  return files;
}

function lineCount(file) {
  return fs.readFileSync(file, "utf8").split(/\r?\n/).length;
}

function matchesPattern(file, pattern) {
  if (pattern.startsWith("*.")) return file.endsWith(pattern.slice(1));
  return file === pattern || file.includes(pattern);
}

function implementationBudget(record) {
  if (specificFileBudgets[record.file]) return specificFileBudgets[record.file];
  const isAppShell = /(^|\/)App\.(tsx|jsx|ts|js)$/.test(record.file);
  const isDesktopMain =
    /(^|\/)(main|lib)\.(cjs|mjs|js|ts|rs)$/.test(record.file) &&
    /desktop|tauri|src-tauri/.test(record.file);
  const isDomainBarrel =
    /(^|\/)packages\/[^/]+\/src\/index\.ts$/.test(record.file) ||
    /(^|\/)packages\/shared-types\/src\/index\.ts$/.test(record.file);
  if (isAppShell) return maxAppShell;
  if (isDesktopMain) return maxDesktopMain;
  if (isDomainBarrel) return maxDomainBarrel;
  return maxImpl;
}

function routeContractViolations() {
  const routeConfig = config.routeContract;
  if (!routeConfig) return [];
  const routerPath = path.join(root, routeConfig.routerFile);
  const snapshotPath = path.join(root, routeConfig.snapshotFile);
  if (!fs.existsSync(routerPath) || !fs.existsSync(snapshotPath)) {
    return ["Relay route contract files are missing."];
  }
  const source = fs.readFileSync(routerPath, "utf8");
  const actual = [
    ...source.matchAll(/method:\s*"([^"]+)"[\s\S]*?path:\s*"([^"]+)"/g),
  ].map((match) => `${match[1]} ${match[2]}`);
  const expected = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
  const missing = expected.filter((route) => !actual.includes(route));
  const added = actual.filter((route) => !expected.includes(route));
  const duplicates = actual.filter(
    (route, index) => actual.indexOf(route) !== index,
  );
  const messages = [];
  if (missing.length > 0) {
    messages.push(`missing Relay routes: ${missing.join(", ")}`);
  }
  if (added.length > 0) {
    messages.push(`unsnapshotted Relay routes: ${added.join(", ")}`);
  }
  if (duplicates.length > 0) {
    messages.push(
      `duplicate Relay route definitions: ${duplicates.join(", ")}`,
    );
  }
  return messages;
}

function startupImportViolations() {
  const rules = config.startupImportRules ?? [];
  const messages = [];
  for (const rule of rules) {
    const absolute = path.join(root, rule.file);
    if (!fs.existsSync(absolute)) continue;
    const source = fs.readFileSync(absolute, "utf8");
    const imports = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map(
      (match) => match[1],
    );
    for (const banned of rule.banned ?? []) {
      const hit = imports.find((item) => item.includes(banned));
      if (hit) {
        messages.push(`${rule.file} imports banned startup dependency ${hit}.`);
      }
    }
  }
  return messages;
}

const sourceRoots = (
  config.sourceRoots ?? ["src", "test", "scripts", "app", "apps", "packages"]
).filter((dir) => fs.existsSync(path.join(root, dir)));
const files = sourceRoots
  .flatMap((directory) => walk(path.join(root, directory)))
  .filter((file, index, all) => all.indexOf(file) === index);
const records = files.map((file) => ({
  file: relative(file),
  ext: path.extname(file),
  lines: lineCount(file),
}));
const implementationRecords = records.filter(
  (record) => !styleExtensions.has(record.ext),
);
const styleRecords = records.filter((record) =>
  styleExtensions.has(record.ext),
);
const generatedRecords = records.filter(
  (record) =>
    generatedPatterns.some((pattern) => matchesPattern(record.file, pattern)) &&
    !allowedGenerated.has(record.file),
);

const violations = [];
const warnings = [];
for (const record of implementationRecords) {
  const budget = implementationBudget(record);
  if (record.lines > budget) {
    violations.push(
      `${record.file} has ${record.lines} lines; budget is ${budget}.`,
    );
  } else if (nearMargin > 0 && budget - record.lines <= nearMargin) {
    warnings.push(
      `${record.file} is within ${budget - record.lines} lines of budget ${budget}.`,
    );
  }
}
for (const record of styleRecords) {
  if (record.lines > maxStyle) {
    violations.push(
      `${record.file} has ${record.lines} style lines; budget is ${maxStyle}.`,
    );
  } else if (nearMargin > 0 && maxStyle - record.lines <= nearMargin) {
    warnings.push(
      `${record.file} is within ${maxStyle - record.lines} style lines of budget ${maxStyle}.`,
    );
  }
}
if (generatedRecords.length > 0 && config.allowGeneratedArtifacts !== true) {
  violations.push(
    "generated/runtime artifacts in source scan: " +
      generatedRecords
        .slice(0, 12)
        .map((record) => record.file)
        .join(", ") +
      (generatedRecords.length > 12
        ? ` and ${generatedRecords.length - 12} more`
        : ""),
  );
}
violations.push(...routeContractViolations());
violations.push(...startupImportViolations());

console.log(`${config.label ?? path.basename(root)} maintainability audit`);
console.log("");
console.log("Largest implementation files:");
for (const record of implementationRecords
  .sort((a, b) => b.lines - a.lines)
  .slice(0, 12)) {
  console.log(`- ${record.file}: ${record.lines} lines`);
}
console.log("");
console.log("Largest style files:");
for (const record of styleRecords
  .sort((a, b) => b.lines - a.lines)
  .slice(0, 8)) {
  console.log(`- ${record.file}: ${record.lines} lines`);
}
console.log("");
console.log(`Generated/runtime findings: ${generatedRecords.length}`);
for (const record of generatedRecords.slice(0, 8))
  console.log(`- ${record.file}`);

if (warnings.length > 0) {
  console.log("");
  console.log("Maintainability near-budget warnings:");
  for (const warning of warnings) console.log(`- ${warning}`);
  if (strict) process.exitCode = 1;
}

if (violations.length > 0) {
  console.log("");
  console.log("Maintainability budget violations:");
  for (const violation of violations) console.log(`- ${violation}`);
  if (strict) process.exitCode = 1;
}
