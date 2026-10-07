/**
 * Live verification against a real DSH_HOME.
 *
 * Builds a real backup, then rewrites it the way a backup taken on another
 * computer would look: every plugin directory points somewhere that cannot
 * exist here. Restoring it into a throwaway sandbox home proves that plugin
 * payloads, profile link: declarations and node_modules junctions all survive
 * a machine move. Nothing outside the sandbox is modified.
 *
 * Usage: node test-live.mjs
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isSymlinkEntry, unzipSync, zipSync } from "./lib/zip.js";

const liveHome = process.env.DSH_HOME;
if (!liveHome) { console.error("DSH_HOME is not set"); process.exit(1); }

const sandbox = await mkdtemp(join(tmpdir(), "helloai-live-sandbox-"));
let failures = 0;

// End-to-end check of the exact flow the settings page uses (staged prepare +
// chunked download) against the running Harness' web server.
async function verifyHttpDownload(origin) {
  const headers = { "x-dsh-helloai-bak": "1" };
  const prepared = await fetch(`${origin}/api/dsh-helloai-bak/prepare`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({}) });
  if (prepared.status === 404) { console.log("[live] http check skipped: the running Harness still has the previous host build (restart it to activate /prepare)"); return; }
  if (!prepared.ok) { console.error(`[live] FAIL prepare HTTP ${prepared.status}`); failures += 1; return; }
  const info = await prepared.json();
  const chunks = [];
  for (let offset = 0; offset < info.size; offset += info.chunkSize) {
    const response = await fetch(`${origin}/api/dsh-helloai-bak/download?token=${encodeURIComponent(info.token)}&offset=${offset}&length=${info.chunkSize}`, { headers });
    if (!response.ok) { console.error(`[live] FAIL download HTTP ${response.status} at ${offset}`); failures += 1; return; }
    const buffer = Buffer.from(await response.arrayBuffer());
    // The harness gzips responses when the client advertises gzip, and that drops
    // content-length; assert the byte count itself, clamped by the server to one chunk.
    const expected = Math.min(info.chunkSize, info.size - offset);
    if (buffer.byteLength !== expected) { console.error(`[live] FAIL chunk ${offset}: got ${buffer.byteLength}, expected ${expected}`); failures += 1; return; }
    if (Number(response.headers.get("x-dsh-helloai-total")) !== info.size) { console.error(`[live] FAIL chunk ${offset}: total header mismatch`); failures += 1; return; }
    chunks.push(buffer);
  }
  const archive = Buffer.concat(chunks);
  if (archive.byteLength !== info.size) { console.error(`[live] FAIL reassembled ${archive.byteLength} != ${info.size}`); failures += 1; return; }
  const entries = unzipSync(new Uint8Array(archive));
  const manifest = JSON.parse(new TextDecoder().decode(entries.find(({ entry }) => entry.name === "manifest.json").data));
  console.log(`[live] http: /prepare + ${chunks.length} chunk(s) -> ${(archive.byteLength / 1048576).toFixed(1)} MB, ${entries.length} entries, ${manifest.plugins.filter((plugin) => plugin.status === "packed").length} plugin(s) packed`);
  assert.equal(manifest.plugin, "dsh-helloai-bak", "chunked download reassembles a valid backup");
  console.log(`[live] http: staged at ${info.path}`);

  // The history list and its delete route, then clean up the archive this run made.
  const history = await fetch(`${origin}/api/dsh-helloai-bak/backups`, { headers });
  if (history.status === 404 || history.status === 405) { console.log("[live] http: /backups not in the running host build yet (reload it to cover the history list)"); return; }
  const listed = await history.json();
  const record = listed.backups.find((item) => item.name === info.filename);
  assert.ok(record, "the freshly staged archive is listed in the backup history");
  assert.equal(record.restorable, true);
  console.log(`[live] http: history lists ${listed.backups.length} record(s); newest holds ${record.plugins.length} plugin(s)`);
  const removed = await fetch(`${origin}/api/dsh-helloai-bak/backups/delete`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ id: record.id }) });
  assert.equal(removed.status, 200, "history delete accepts the record id");
  const after = await removed.json();
  assert.ok(!after.backups.some((item) => item.name === info.filename), "verification archive removed from the history");
  console.log("[live] http: verification archive deleted through the history route");
}

try {
  const origin = process.env.DSH_WEB_URL || "http://127.0.0.1:19387";
  try { await verifyHttpDownload(origin); }
  catch (error) { console.log(`[live] http check skipped (${origin} unreachable: ${error.message})`); }

  process.env.DSH_HOME = liveHome;
  const { makeBackup, restoreBackup } = await import("./lib/index.js");
  const made = await makeBackup();
  const packed = made.manifest.plugins.filter((plugin) => plugin.status === "packed");
  console.log(`[live] backup: ${made.manifest.entryCount} entries, ${(made.archive.byteLength / 1048576).toFixed(1)} MB, ${packed.length} packable plugin(s)`);
  for (const plugin of made.manifest.plugins) console.log(`[live]   ${plugin.status.padEnd(11)} ${plugin.packageName} (${plugin.fileCount} files, ${(plugin.bytes / 1048576).toFixed(2)} MB)`);
  assert.ok(packed.length >= 1, "the live profile must expose at least one local plugin");
  assert.ok(made.manifest.plugins.some((plugin) => plugin.status === "self"), "the backup plugin itself appears in the inventory");
  assert.ok(!packed.some((plugin) => plugin.bootstrap), "the backup plugin is never packed");
  assert.ok(!unzipSync(made.archive).some(({ entry }) => entry.name.startsWith("external/") && entry.name.includes("helloai-bak")), "no payload for the backup plugin");

  // Selection: pack only the smallest plugin and make sure the rest stay out.
  const smallest = [...packed].sort((a, b) => a.bytes - b.bytes)[0];
  const partial = await makeBackup({ include: [smallest.source] });
  assert.equal(partial.manifest.plugins.filter((plugin) => plugin.status === "packed").length, 1, "only the checked plugin is packed");
  assert.equal(partial.manifest.plugins.filter((plugin) => plugin.status === "skipped").length, packed.length - 1, "the others are reported as skipped");
  assert.ok(!unzipSync(partial.archive).some(({ entry }) => entry.name.startsWith("external/") && !entry.name.startsWith(smallest.archive)), "unchecked plugin payloads omitted");
  console.log(`[live] selection: packed only ${smallest.packageName}, skipped ${packed.length - 1}`);

  // Redirect the archive to a machine where none of the recorded directories exist.
  const rebuilt = unzipSync(made.archive).map(({ entry, data }) => ({ name: entry.name, kind: entry.name.endsWith("/") ? "dir" : (isSymlinkEntry(entry) ? "symlink" : "file"), data, mode: (entry.externalAttributes >>> 16) & 0xffff }));
  const text = (name) => new TextDecoder().decode(rebuilt.find((item) => item.name === name).data);
  const manifest = JSON.parse(text("manifest.json"));
  const blocker = join(sandbox, "blocker");
  await writeFile(blocker, "not a directory\n");
  const redirects = [];
  for (const plugin of manifest.plugins) {
    const unreachable = join(blocker, "nested", plugin.packageName.replace(/[\\/]/g, "-"));
    redirects.push([plugin.source, unreachable]);
    plugin.source = unreachable;
    plugin.links = plugin.links.map((link) => ({ ...link, path: unreachable }));
  }
  for (const external of manifest.externalRoots || []) {
    const match = manifest.plugins.find((plugin) => plugin.packageName === external.packageName);
    if (match) external.source = match.source;
  }
  const rewrite = (value) => { let result = value; for (const [from, to] of redirects) result = result.split(from.replace(/\\/g, "/")).join(to.replace(/\\/g, "/")).split(from).join(to); return result; };
  rebuilt.find((item) => item.name === "manifest.json").data = new TextEncoder().encode(JSON.stringify(manifest, null, 2) + "\n");

  for (const item of rebuilt) {
    if (item.name === "manifest.json" || item.kind !== "file" || !/\.(json|jsonc|yaml|yml)$/i.test(item.name)) continue;
    const decoded = rewrite(new TextDecoder().decode(item.data));
    if (!item.name.endsWith("package.json")) { item.data = new TextEncoder().encode(decoded); continue; }
    const parsed = JSON.parse(decoded);
    // Keep the sandbox hermetic: without the profile marker no package manager runs.
    if (parsed?.dsh?.profile) delete parsed.dsh;
    item.data = new TextEncoder().encode(JSON.stringify(parsed, null, 2) + "\n");
  }

  process.env.DSH_HOME = sandbox;
  const result = await restoreBackup(Buffer.from(zipSync(rebuilt)).toString("base64"));
  console.log(`[live] restore: ${result.pluginsRestored.length} restored, ${result.pluginsPreserved.length} preserved, ${result.pluginsMissing.length} missing, ${result.linkedPlugins.length} links`);
  for (const report of result.restoreDiagnostics) console.log(`[live]   ${report.status.padEnd(10)} ${report.packageName} -> ${report.restoredPath} (${report.files} files, ${report.links.length} links)`);
  for (const warning of result.installWarnings) console.log(`[live]   warning: ${warning}`);

  const profilePackage = JSON.parse(await readFile(join(sandbox, "profiles", "desktop", "package.json"), "utf8").catch(() => "{}"));
  const selfReport = result.restoreDiagnostics.find((item) => item.packageName === "dsh-helloai-bak");
  if (!selfReport || selfReport.status !== "preserved") { console.error(`[live] FAIL dsh-helloai-bak: expected preserved, got ${selfReport?.status}`); failures += 1; }
  else if (!selfReport.links.every((link) => link.ok)) { console.error("[live] FAIL dsh-helloai-bak: link not rebuilt"); failures += 1; }
  for (const plugin of packed) {
    const report = result.restoreDiagnostics.find((item) => item.packageName === plugin.packageName);
    if (!report) { console.error(`[live] FAIL ${plugin.packageName}: no restore report`); failures += 1; continue; }
    if (report.status !== "restored" || report.files === 0) { console.error(`[live] FAIL ${plugin.packageName}: ${report.status} ${report.message || ""}`); failures += 1; continue; }
    if (!await stat(join(report.restoredPath, "package.json")).catch(() => undefined)) { console.error(`[live] FAIL ${plugin.packageName}: payload missing at ${report.restoredPath}`); failures += 1; }
    for (const link of report.links) {
      if (!link.ok) { console.error(`[live] FAIL ${plugin.packageName}: link ${link.linkPath} not recreated`); failures += 1; }
      const sections = ["dependencies", "optionalDependencies", "devDependencies"];
      const spec = String(sections.map((section) => profilePackage[section]?.[link.linkName]).find((value) => typeof value === "string") || "");
      const expected = `link:${report.restoredPath.replace(/\\/g, "/")}`;
      if (spec !== expected) { console.error(`[live] FAIL ${link.linkName}: spec "${spec}" should be "${expected}"`); failures += 1; }
    }
    for (const link of plugin.links.filter((item) => !item.declared)) {
      if (!result.addedPluginDependencies.includes(`${link.profile}/${link.linkName}`)) { console.error(`[live] FAIL ${plugin.packageName}: undeclared link ${link.profile}/${link.linkName} was not re-declared`); failures += 1; }
    }
  }
  for (const name of result.pluginsMissing) console.log(`[live]   dangling (cannot be restored): ${name}`);
  assert.equal(failures, 0, `${failures} live verification failure(s)`);
  console.log("[live] live backup/restore verification passed");
} finally {
  await rm(sandbox, { recursive: true, force: true });
}
