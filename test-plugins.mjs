import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { unzipSync, zipSync, isSymlinkEntry } from "./lib/zip.js";

const home = await mkdtemp(join(tmpdir(), "helloai-plugins-home-"));
const target = await mkdtemp(join(tmpdir(), "helloai-plugins-target-"));
const pluginRoot = await mkdtemp(join(tmpdir(), "helloai-plugins-src-"));
const installRoot = await mkdtemp(join(tmpdir(), "helloai-plugins-install-"));

async function writePlugin(root, packageJson) {
  await mkdir(join(root, "lib"), { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify(packageJson, null, 2));
  await writeFile(join(root, "cordis.patch.yml"), "- insert: []\n");
  await writeFile(join(root, "lib", "index.js"), "export default {};\n");
}
async function junction(targetPath, linkPath) {
  await mkdir(join(linkPath, ".."), { recursive: true });
  await symlink(targetPath, linkPath, "junction");
}

const declaredPlugin = join(pluginRoot, "plugin-a");
const linkedPlugin = join(pluginRoot, "plugin-b");
const declaredName = "@example/plugin-a";
const linkedName = "plugin-b";

try {
  await writePlugin(declaredPlugin, { name: declaredName, version: "1.0.0", main: "lib/index.js", dsh: { bundle: { patch: "./cordis.patch.yml" } }, dependencies: { "runtime-x": "1.0.0" } });
  await mkdir(join(declaredPlugin, "node_modules", "runtime-x", "lib"), { recursive: true });
  await writeFile(join(declaredPlugin, "node_modules", "runtime-x", "package.json"), JSON.stringify({ name: "runtime-x", version: "1.0.0", main: "lib/index.js" }));
  await writeFile(join(declaredPlugin, "node_modules", "runtime-x", "lib", "index.js"), "export const runtime = true;\n");
  await writePlugin(linkedPlugin, { name: linkedName, version: "2.0.0", main: "lib/index.js", dsh: { bundle: { patch: "./cordis.patch.yml" } } });

  const profile = join(home, "profiles", "desktop");
  await mkdir(join(profile, "node_modules"), { recursive: true });
  await writeFile(join(profile, "package.json"), JSON.stringify({ name: "dsh-profile-desktop", private: true, dependencies: { [declaredName]: `link:${declaredPlugin}` } }, null, 2));
  await writeFile(join(home, "settings.yaml"), "language: zh-CN\n");
  await junction(declaredPlugin, join(profile, "node_modules", "@example", "plugin-a"));
  // Hand-linked plugin that was never declared in package.json: the historical
  // backup silently dropped plugins like this one.
  await junction(linkedPlugin, join(profile, "node_modules", linkedName));
  // Dangling junction: must be reported, never crash the backup.
  await junction(join(tmpdir(), "helloai-plugins-vanished"), join(profile, "node_modules", "plugin-c"));
  // Link owned by the DeepSeek Harness installation: not a user plugin.
  await mkdir(join(installRoot, "node_modules", "some-dep"), { recursive: true });
  await writeFile(join(installRoot, "node_modules", "some-dep", "package.json"), JSON.stringify({ name: "some-dep", version: "9.9.9" }));
  await junction(join(installRoot, "node_modules", "some-dep"), join(profile, "node_modules", "some-dep"));
  // This plugin's own directory, linked like any other plugin: it must appear in
  // the list but never end up inside the archive.
  const selfRoot = resolve(".");
  // The plugin's own package name is scoped (`@hello-heyongping/dsh-helloai-bak`)
  // while the profile link keeps the short `dsh-helloai-bak`. Both matter: the link
  // name drives `bootstrap`, and the package name is what the inventory/report is
  // keyed by — so read it instead of hardcoding the one that is no longer accurate.
  const selfName = JSON.parse(await readFile(join(selfRoot, "package.json"), "utf8")).name;
  await junction(selfRoot, join(profile, "node_modules", "dsh-helloai-bak"));

  process.env.DSH_HOME = home;
  const { apply, discoverPlugins, makeBackup, prepareBackup, readBackupChunk, restoreBackup } = await import("./lib/index.js");

  const inventory = await discoverPlugins(home);
  const byName = new Map(inventory.map((plugin) => [plugin.packageName, plugin]));
  assert.ok(byName.has(declaredName), "declared plugin discovered");
  assert.ok(byName.has(linkedName), "undeclared junction plugin discovered");
  assert.equal(byName.get("plugin-c")?.status, "missing", "dangling junction reported as missing");
  assert.ok(!byName.has("some-dep"), "installation-owned link ignored");
  assert.equal(byName.get(linkedName)?.links[0]?.declared, false);
  assert.equal(byName.get(selfName)?.status, "self", "the backup plugin itself is not packable");
  assert.equal(byName.get(selfName)?.bootstrap, true);

  const made = await makeBackup();
  assert.equal(made.manifest.format, 4);
  const packedA = made.manifest.plugins.find((plugin) => plugin.packageName === declaredName);
  const packedB = made.manifest.plugins.find((plugin) => plugin.packageName === linkedName);
  assert.equal(packedA.status, "packed");
  assert.equal(packedB.status, "packed");
  assert.ok(packedA.fileCount >= 3 && packedA.bytes > 0, "plugin payload measured");
  assert.ok(packedA.runtimeDependencies.includes("node_modules/runtime-x"), "production dependency packed");
  const names = unzipSync(made.archive).map(({ entry }) => entry.name);
  assert.ok(names.includes(`${packedA.archive}/package.json`));
  assert.ok(names.includes(`${packedA.archive}/lib/index.js`));
  assert.ok(names.includes(`${packedA.archive}/node_modules/runtime-x/lib/index.js`));
  assert.ok(names.includes(`${packedB.archive}/package.json`));
  assert.equal(new Set([packedA.archive, packedB.archive]).size, 2, "each plugin gets its own archive prefix");
  assert.ok(!(made.manifest.externalRoots || []).some((item) => item.packageName === selfName), "self plugin is never an external root");
  assert.ok(!names.some((entry) => entry.startsWith("external/") && entry.includes("helloai-bak")), "self plugin has no payload in the archive");

  // The settings page downloads a staged archive in chunks, because the Desktop
  // app's custom-protocol bridge cannot deliver one multi-megabyte body.
  const staged = await prepareBackup();
  assert.equal(staged.ok, true);
  assert.ok(staged.size === made.archive.byteLength || staged.size > 0, "staged archive has bytes");
  assert.ok((await lstat(staged.path)).isFile(), "archive staged on disk");
  assert.ok(staged.path.startsWith(join(home, "backups")), `archive staged under DSH_HOME/backups, got ${staged.path}`);
  const chunks = [];
  for (let offset = 0; offset < staged.size; offset += staged.chunkSize) {
    const chunk = await readBackupChunk(staged.token, offset, staged.chunkSize);
    assert.ok(chunk.data.byteLength <= staged.chunkSize, "chunk respects the requested size");
    assert.equal(chunk.data.byteLength, Math.min(staged.chunkSize, staged.size - offset), "chunk is exactly the remaining range");
    chunks.push(chunk.data);
  }
  const reassembled = unzipSync(new Uint8Array(Buffer.concat(chunks)));
  const stagedManifest = reassembled.find((item) => item.entry.name === "manifest.json");
  assert.ok(stagedManifest, "staged chunks reassemble into a readable archive");
  assert.equal(JSON.parse(new TextDecoder().decode(stagedManifest.data)).plugin, "dsh-helloai-bak");
  assert.equal(reassembled.length, unzipSync(made.archive).length, "chunked copy has the same entry count as the direct build");
  await assert.rejects(() => readBackupChunk("00000000-0000-0000-0000-000000000000", 0, 1024), /过期|expired/i);
  // A backup must never swallow the previously staged archives.
  const second = await makeBackup();
  assert.ok(!unzipSync(second.archive).some(({ entry }) => entry.name.startsWith("dsh-home/backups")), "staged archives excluded from later backups");

  // Exercise the real HTTP surface, including query parsing for the chunk route.
  let handler;
  // The host mounts routes inside a fiber effect, so the stand-in provides one.
  apply({ webRuntime: { trustedHosts: [] }, webServer: { register(route) { handler = route.handler; return () => {}; } }, effect: (execute) => { execute(); } });
  assert.ok(handler, "webServer route registered");
  const call = async (method, url, body) => {
    const request = new Readable({ read() {} });
    request.method = method; request.url = url; request.headers = { host: "127.0.0.1:19387" };
    const chunks = [];
    const response = {
      statusCode: 0, headers: {},
      writeHead(code, headers) { this.statusCode = code; Object.assign(this.headers, headers || {}); return this; },
      end(data) { if (data) chunks.push(Buffer.from(data)); this.body = Buffer.concat(chunks); return this; },
      on() { return this; }, once() { return this; },
    };
    if (body !== undefined) request.push(body);
    request.push(null);
    await handler(request, response);
    return response;
  };
  const statusResponse = await call("GET", "/api/dsh-helloai-bak/status");
  assert.equal(statusResponse.statusCode, 200);
  assert.ok(JSON.parse(statusResponse.body.toString()).plugins.some((plugin) => plugin.selectable), "status advertises selectable plugins");
  const prepareResponse = await call("POST", "/api/dsh-helloai-bak/prepare", JSON.stringify({ include: [declaredPlugin] }));
  assert.equal(prepareResponse.statusCode, 200);
  const prepared = JSON.parse(prepareResponse.body.toString());
  assert.deepEqual(prepared.plugins, [declaredName], "prepare honours the selection");
  assert.equal(prepared.skipped.length, 1, "prepare reports the deselected plugin");
  const chunkResponse = await call("GET", `/api/dsh-helloai-bak/download?token=${encodeURIComponent(prepared.token)}&offset=0&length=64`);
  assert.equal(chunkResponse.statusCode, 200);
  assert.equal(chunkResponse.headers["content-length"], 64, "chunk route returns the requested range");
  assert.equal(chunkResponse.headers["x-dsh-helloai-total"], String(prepared.size));
  assert.equal(chunkResponse.body.byteLength, 64);
  const expired = await call("GET", "/api/dsh-helloai-bak/download?token=nope&offset=0&length=16");
  assert.equal(expired.statusCode, 410, "unknown token rejected");
  const badMethod = await call("GET", "/api/dsh-helloai-bak/backup");
  assert.equal(badMethod.statusCode, 405, "streaming backup stays POST-only");

  // Backup history: list, restore from a record, delete, and the delete guard.
  const history = await call("GET", "/api/dsh-helloai-bak/backups");
  assert.equal(history.statusCode, 200);
  const listed = JSON.parse(history.body.toString());
  const stagedRecord = listed.backups.find((record) => record.name === staged.filename);
  assert.ok(stagedRecord, "the staged archive appears in the history list");
  assert.equal(stagedRecord.restorable, true);
  assert.equal(stagedRecord.scope, "dsh-home");
  assert.deepEqual([...stagedRecord.plugins].sort(), [declaredName, linkedName].sort(), "history reports the packed plugins");
  assert.equal(stagedRecord.format, 4);

  const foreign = join(home, "dsh-helloai-backup-not-ours.zip");
  await writeFile(foreign, "not a zip");
  const refused = await call("POST", "/api/dsh-helloai-bak/backups/delete", JSON.stringify({ id: foreign }));
  assert.equal(refused.statusCode, 400, "deletion outside the backup roots is refused");
  assert.ok((await lstat(foreign)).isFile(), "the refused file was not touched");

  const junk = join(home, "backups", "readme.txt");
  await writeFile(junk, "keep\n");
  const junkRefused = await call("POST", "/api/dsh-helloai-bak/backups/delete", JSON.stringify({ id: junk }));
  assert.equal(junkRefused.statusCode, 400, "only backup archives may be deleted");
  assert.ok((await lstat(junk)).isFile());

  const fromRecord = await call("POST", "/api/dsh-helloai-bak/backups/restore", JSON.stringify({ id: stagedRecord.id }));
  assert.equal(fromRecord.statusCode, 200);
  const recordRestore = JSON.parse(fromRecord.body.toString());
  assert.ok(recordRestore.pluginsRestored.includes(linkedName), "restore from a record restores plugins");
  assert.equal(recordRestore.backupFormat, 4);

  const removed = await call("POST", "/api/dsh-helloai-bak/backups/delete", JSON.stringify({ id: stagedRecord.id }));
  assert.equal(removed.statusCode, 200);
  const afterDelete = JSON.parse(removed.body.toString());
  assert.equal(afterDelete.deleted, staged.filename);
  assert.ok(!afterDelete.backups.some((record) => record.name === staged.filename), "deleted archive is gone from the list");
  assert.equal(await lstat(staged.path).catch(() => undefined), undefined);

  process.env.DSH_HOME = target;
  const targetProfile = join(target, "profiles", "desktop");
  await mkdir(join(targetProfile, "node_modules"), { recursive: true });
  const restored = await restoreBackup(Buffer.from(made.archive).toString("base64"));
  assert.ok(restored.pluginsRestored.includes(declaredName));
  assert.ok(restored.pluginsRestored.includes(linkedName));
  assert.equal(restored.pluginsMissing.length, 1, "dangling plugin reported as missing");
  assert.ok(restored.addedPluginDependencies.includes(`desktop/${linkedName}`), "undeclared link re-declared");
  assert.equal(await readFile(join(target, "settings.yaml"), "utf8"), "language: zh-CN\n");

  const targetPackage = JSON.parse(await readFile(join(targetProfile, "package.json"), "utf8"));
  assert.ok(String(targetPackage.dependencies[linkedName]).startsWith("link:"), "link: spec written for plugin-b");
  assert.equal(await realpath(join(targetProfile, "node_modules", "@example", "plugin-a")), await realpath(declaredPlugin));
  assert.equal(await realpath(join(targetProfile, "node_modules", linkedName)), await realpath(linkedPlugin));
  assert.ok((await lstat(join(declaredPlugin, "node_modules", "runtime-x", "lib", "index.js"))).isFile(), "runtime dependency restored");
  const reportA = restored.restoreDiagnostics.find((item) => item.packageName === declaredName);
  assert.equal(reportA.status, "restored");
  assert.ok(reportA.links.every((link) => link.ok), "link topology verified");
  const reportSelf = restored.restoreDiagnostics.find((item) => item.packageName === selfName);
  assert.equal(reportSelf.status, "preserved", "self plugin preserved");
  assert.ok(reportSelf.links.every((link) => link.ok), "self link rebuilt");

  // User selection: unchecking a plugin keeps it out of the archive, and the
  // restore must report it as skipped rather than missing or failed.
  const partial = await makeBackup({ include: [linkedPlugin] });
  const skippedA = partial.manifest.plugins.find((plugin) => plugin.packageName === declaredName);
  assert.equal(skippedA.status, "skipped");
  assert.ok(skippedA.reason, "skip reason recorded");
  assert.equal(partial.manifest.plugins.find((plugin) => plugin.packageName === linkedName).status, "packed");
  const partialNames = unzipSync(partial.archive).map(({ entry }) => entry.name);
  assert.ok(!partialNames.some((entry) => entry.startsWith(packedA.archive)), "unchecked plugin payload omitted");
  assert.ok(partialNames.some((entry) => entry.startsWith(packedB.archive)), "checked plugin still packed");
  assert.equal((partial.manifest.externalRoots || []).length, 1);
  assert.equal((partial.manifest.plugins.find((plugin) => plugin.packageName === selfName) || {}).status, "self");
  const partialRestore = await restoreBackup(Buffer.from(partial.archive).toString("base64"));
  assert.equal(partialRestore.restoreDiagnostics.find((item) => item.packageName === declaredName)?.status, "skipped");
  assert.equal(partialRestore.restoreDiagnostics.find((item) => item.packageName === declaredName)?.files, 0);
  assert.ok(partialRestore.pluginsRestored.includes(linkedName));
  assert.ok(!partialRestore.installWarnings.some((warning) => warning.includes(declaredName)), "a skipped plugin is not a warning");

  // Migration case: the recorded plugin directory cannot exist on this machine.
  // The payload must land in a reachable fallback and the profile link must follow.
  const blocker = join(target, "blocker");
  await writeFile(blocker, "not a directory\n");
  const unreachable = join(blocker, "nested", linkedName);
  const rebuilt = unzipSync(made.archive).map(({ entry, data }) => ({
    name: entry.name,
    kind: entry.name.endsWith("/") ? "dir" : (isSymlinkEntry(entry) ? "symlink" : "file"),
    data,
    mode: (entry.externalAttributes >>> 16) & 0xffff,
  }));
  const manifestEntry = rebuilt.find((entry) => entry.name === "manifest.json");
  const migrated = JSON.parse(new TextDecoder().decode(manifestEntry.data));
  const migratedPlugin = migrated.plugins.find((plugin) => plugin.packageName === linkedName);
  migratedPlugin.source = unreachable;
  migratedPlugin.links = migratedPlugin.links.map((link) => ({ ...link, path: unreachable }));
  manifestEntry.data = new TextEncoder().encode(JSON.stringify(migrated, null, 2) + "\n");

  const migratedHome = await mkdtemp(join(tmpdir(), "helloai-plugins-migrated-"));
  try {
    const migratedProfile = join(migratedHome, "profiles", "desktop");
    await mkdir(join(migratedProfile, "node_modules"), { recursive: true });
    process.env.DSH_HOME = migratedHome;
    const relocation = await restoreBackup(Buffer.from(zipSync(rebuilt)).toString("base64"));
    const fallback = join(migratedHome, "plugins", linkedName);
    assert.ok(relocation.pluginsRelocated.some((item) => item.startsWith(linkedName)), "relocation reported");
    assert.equal(await realpath(join(migratedProfile, "node_modules", linkedName)), await realpath(fallback));
    const migratedPackage = JSON.parse(await readFile(join(migratedProfile, "package.json"), "utf8"));
    assert.ok(String(migratedPackage.dependencies[linkedName]).includes(fallback.replace(/\\/g, "/")), "profile points at the fallback path");
    assert.equal(relocation.restoreDiagnostics.find((item) => item.packageName === linkedName)?.status, "restored");
  } finally {
    await rm(migratedHome, { recursive: true, force: true });
    process.env.DSH_HOME = target;
  }
  console.log("plugin packaging/restore passed");
} finally {
  await rm(home, { recursive: true, force: true });
  await rm(target, { recursive: true, force: true });
  await rm(pluginRoot, { recursive: true, force: true });
  await rm(installRoot, { recursive: true, force: true });
}
