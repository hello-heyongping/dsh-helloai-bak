/**
 * Regression: a `file:` dependency pointing at a packed tarball OUTSIDE DSH_HOME
 * must travel through the archive as a FILE, and must come back installed.
 *
 * Backup half: declaredLinks() used to record every declared link:/file: spec
 * with the literal kind "directory". A .tgz carries no package.json, so
 * discoverPlugins() classified the plugin as a directory and
 * packagePluginPayload() read the tarball through collectDirectoryWithStats():
 * the file's relative name came out empty and was prefixed into
 * "external/NNN-<slug>/" — a trailing-slash (directory) entry holding the tarball
 * bytes. Every ZIP reader treats that entry as a directory and discards the data,
 * so restore recreated an empty directory and the tarball was silently lost.
 *
 * Restore half: the profile links were then recreated from the tarball itself, so
 * node_modules/<name> became a symlink to the .tgz and Node parsed gzip as
 * JavaScript ("Invalid or unexpected token") while the restore still reported
 * success. A tarball is a package archive the package manager installs, not a
 * directory to link to.
 *
 * Usage: node test-file-plugin.mjs
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
// Node refuses to spawn a .cmd shim directly on Windows (EINVAL) — the same trap
// runPackageManager() documents inside the plugin.
const runShim = (command, args, options) => process.platform === "win32"
  ? execFileAsync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", command, ...args], options)
  : execFileAsync(command, args, options);

const pluginName = "@fixture/tarball-plugin";
const sandbox = await mkdtemp(join(tmpdir(), "helloai-file-plugin-"));
const packageSource = await mkdtemp(join(tmpdir(), "helloai-file-source-"));
const outside = await mkdtemp(join(tmpdir(), "helloai-file-payload-"));

let tarball;
let installable = false;
try {
  await writeFile(join(packageSource, "package.json"), JSON.stringify({ name: pluginName, version: "1.0.0", main: "index.js" }, null, 2) + "\n");
  await writeFile(join(packageSource, "index.js"), "module.exports = { ok: true };\n");
  await runShim("npm", ["pack", "--pack-destination", outside], { cwd: packageSource });
  tarball = join(outside, (await readdir(outside)).find((file) => file.endsWith(".tgz")));
  installable = true;
} catch {
  // No npm available: the archive half only moves bytes, so a stand-in file still
  // covers it and the install/loadability assertions are skipped below.
  tarball = join(outside, "fixture-plugin-1.0.0.tgz");
  await writeFile(tarball, Buffer.concat([Buffer.from([0x1f, 0x8b, 0x08, 0x00]), Buffer.alloc(4096, 0x42)]));
}
const payload = await readFile(tarball);

try {
  await mkdir(join(sandbox, "profiles", "desktop"), { recursive: true });
  await writeFile(join(sandbox, "profiles", "desktop", "package.json"), JSON.stringify({
    name: "dsh-profile-desktop",
    private: true,
    dependencies: { [pluginName]: `file:${tarball.replace(/\\/g, "/")}` },
    dsh: { profile: { bundles: [] } },
  }, null, 2) + "\n");

  process.env.DSH_HOME = sandbox;
  const { makeBackup, restoreBackup } = await import("./lib/index.js");
  const made = await makeBackup();

  const filePlugins = made.manifest.plugins.filter((plugin) => plugin.kind === "file");
  assert.equal(filePlugins.length, 1, `expected exactly one file-kind plugin, got ${filePlugins.length}`);
  const plugin = filePlugins[0];
  assert.ok(plugin.source.endsWith(".tgz"), `source should be the tarball, got ${plugin.source}`);
  assert.equal(plugin.status, "packed", `expected packed, got ${plugin.status}: ${plugin.reason || ""}`);
  assert.equal(plugin.fileCount, 1, "a tarball is one file");
  assert.equal(plugin.bytes, payload.byteLength);
  assert.equal(plugin.runtimeDependencies.length, 0, "a tarball has no node_modules to vendor");

  const external = made.manifest.externalRoots.find((item) => item.source === plugin.source);
  assert.equal(external?.kind, "file", "externalRoots must record the tarball as a file");
  assert.equal(made.manifest.plugins.filter((item) => item.status === "packed").length, 1, "only the tarball is packed");

  const { unzipSync } = await import("./lib/zip.js");
  const entries = unzipSync(made.archive);
  const inside = entries.filter(({ entry }) => entry.name.startsWith(`${plugin.archive}/`));
  const files = inside.filter(({ entry }) => !entry.name.endsWith("/"));
  assert.equal(files.length, 1, `expected one payload entry under ${plugin.archive}/, got ${files.length}`);
  assert.equal(files[0].entry.name, `${plugin.archive}/payload.tgz`);
  assert.equal(files[0].data.byteLength, payload.byteLength, "the whole tarball must be in the archive");
  assert.ok(Buffer.from(files[0].data).equals(payload), "payload bytes must be the tarball itself");
  for (const { entry, data } of inside.filter(({ entry }) => entry.name.endsWith("/"))) {
    assert.equal(data.byteLength, 0, `${entry.name} is a directory entry and must not carry the tarball bytes`);
  }

  // ---- restore half: the tarball is gone, so the archive is the only source ----
  await rm(sandbox, { recursive: true, force: true });
  await rm(tarball, { force: true });
  await mkdir(sandbox, { recursive: true });
  const result = await restoreBackup(Buffer.from(made.archive).toString("base64"), true);
  assert.deepEqual(result.pluginsFailed, [], `restore failed: ${result.pluginsFailed.join("; ")}`);
  assert.ok(result.pluginsRestored.includes(pluginName), "the tarball plugin must be reported restored");
  const report = result.restoreDiagnostics.find((item) => item.packageName === pluginName);
  assert.equal(report?.status, "restored", `restore diagnostics: ${JSON.stringify(report)}`);
  assert.equal((await stat(tarball)).size, payload.byteLength, "the tarball must come back byte-for-byte");

  // The profile must never point at the raw tarball: if it links anything it has to
  // be a package directory, because Node would otherwise parse gzip as JavaScript.
  const profileRoot = join(sandbox, "profiles", "desktop");
  const installed = join(profileRoot, "node_modules", ...pluginName.split("/"));
  const entry = await lstat(installed).catch(() => undefined);
  if (entry) {
    const resolved = await realpath(installed);
    assert.ok((await stat(resolved)).isDirectory(), `${installed} resolves to ${resolved}, which is not a directory`);
    assert.ok(await stat(join(resolved, "package.json")).catch(() => undefined), `${resolved} has no package.json`);
  }
  if (installable && result.reinstalledProfiles.includes("desktop")) {
    const { stdout } = await execFileAsync(process.execPath, ["-e", `console.log(JSON.stringify(require(${JSON.stringify(pluginName)})))`], { cwd: profileRoot });
    assert.equal(stdout.trim(), '{"ok":true}', `the restored plugin must load, got: ${stdout.trim()}`);
    console.log(`restore half passed: profile reinstalled, require('${pluginName}') -> ${stdout.trim()}`);
  } else {
    console.log("restore half: package manager unavailable, install/loadability assertion skipped");
  }

  console.log(`file-plugin regression passed: ${plugin.archive}/payload.tgz (${payload.byteLength} bytes, kind=${plugin.kind})`);
} finally {
  await rm(sandbox, { recursive: true, force: true });
  await rm(packageSource, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
}
