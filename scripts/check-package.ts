import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const cwd = fileURLToPath(new URL("../", import.meta.url));
const tracked = execFileSync("git", ["ls-files", "-z"], { cwd, encoding: "utf8" }).split("\0");
const privateSpecs = tracked.filter(path =>
  path !== "openapi.metadata.json" && /(?:^|\/)(?:openapi|swagger)(?:[.-].*)?\.(?:json|ya?ml)$/i.test(path));
assert.equal(privateSpecs.length, 0, `Private API specifications must not be tracked: ${privateSpecs.join(", ")}`);

// Inspect npm's file list, including ignored local files, without running hooks recursively.
const packed = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
  cwd,
  encoding: "utf8",
})) as Array<{ files: Array<{ path: string }> }> | Record<string, { files: Array<{ path: string }> }>;
// npm 11 returns an array; npm 12 keys the result by package name.
const packages = Object.values(packed);
assert.equal(packages.length, 1, "Expected exactly one npm package");
const files = packages[0]!.files.map(file => file.path);
const allowedFiles = new Set(["package.json", "README.md", "LICENSE", "examples/workflow.ts"]);
const unexpected = files.filter(path => !allowedFiles.has(path) && !/^dist\/(?:[\w-]+\/)*[\w-]+\.(?:js|d\.ts)$/.test(path));
assert.equal(unexpected.length, 0, `Unexpected files in npm package: ${unexpected.join(", ")}`);
for (const required of [...allowedFiles, "dist/index.js", "dist/index.d.ts"]) {
  assert.ok(files.includes(required), `Missing required package file: ${required}`);
}
console.log(`Verified ${files.length} npm package files; no private OpenAPI specification included.`);
