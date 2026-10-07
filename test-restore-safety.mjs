import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { unzipSync } from "./lib/zip.js";

/**
 * Restore must never roll newer work back to older content, every restore must
 * be undoable, and restoring the same archive twice must not lock itself out.
 * All three are checked here against throwaway DSH_HOMEs.
 */

const selfRoot = resolve(".");
const PRE_RESTORE_PREFIX = "dsh-helloai-backup-prerestore-";
const PLUGIN_NAME = "example-local-plugin";
const SETTINGS = "language: zh-CN\n";
const EDITED = "language: en-US\n";

const home = await mkdtemp(join(tmpdir(), "dsh-helloai-safety-home-"));
const external = await mkdtemp(join(tmpdir(), "dsh-helloai-safety-plugin-"));
const repeatHome = await mkdtemp(join(tmpdir(), "dsh-helloai-safety-repeat-"));
const repeatPlugin = await mkdtemp(join(tmpdir(), "dsh-helloai-safety-repeat-plugin-"));
const bare = await mkdtemp(join(tmpdir(), "dsh-helloai-safety-bare-"));

async function seedPlugin(directory) {
  await writeFile(join(directory, "package.json"), JSON.stringify({ name: PLUGIN_NAME, version: "1.0.0", main: "lib/index.js" }));
  await writeFile(join(directory, "cordis.patch.yml"), "[]\n");
  await mkdir(join(directory, "lib"), { recursive: true });
  await writeFile(join(directory, "lib", "index.js"), "export default {};\n");
}

/**
 * The same hermetic fixture as test-portable: no `dsh.profile` marker, so the
 * restore never shells out to a real package manager.
 */
async function seedHome(root, pluginDirectory = external) {
  const profile = join(root, "profiles", "desktop");
  await mkdir(join(profile, "node_modules"), { recursive: true });
  await writeFile(join(profile, "package.json"), JSON.stringify({ name: "dsh-profile-desktop", private: true, dependencies: { [PLUGIN_NAME]: `link:${pluginDirectory}`, "dsh-helloai-bak": `link:${selfRoot}` } }, null, 2));
  await mkdir(join(root, "skills"), { recursive: true });
  await writeFile(join(root, "skills", "old.md"), "old skill\n");
  await writeFile(join(root, "settings.yaml"), SETTINGS);
}

/** Push a file's mtime past the archive so the guard has an unambiguous case. */
async function makeNewer(path, since) {
  const stamp = new Date(since + 60_000);
  await utimes(path, stamp, stamp);
}

try {
  /* ---------------- fixture ---------------- */
  await seedPlugin(external);
  await seedPlugin(repeatPlugin);
  await seedHome(home);

  process.env.DSH_HOME = home;
  const { makeBackup, restoreBackup, restoreBackupRecord } = await import("./lib/index.js");

  const made = await makeBackup();
  const encoded = Buffer.from(made.archive).toString("base64");
  const backupTime = Date.parse(made.manifest.createdAt);
  assert.ok(Number.isFinite(backupTime), "manifest carries a usable createdAt");

  /* ---------------- work that postdates the backup ---------------- */
  await writeFile(join(home, "settings.yaml"), EDITED);
  await makeNewer(join(home, "settings.yaml"), backupTime);
  await writeFile(join(external, "lib", "added-later.js"), "export const later = true;\n");
  await makeNewer(join(external, "lib", "added-later.js"), backupTime);
  // A file the backup carries that is simply gone must still come back.
  await rm(join(home, "skills", "old.md"));

  /* ---------------- guarded restore ---------------- */
  const restored = await restoreBackup(encoded);

  assert.ok(restored.preRestoreSnapshot?.name?.startsWith(PRE_RESTORE_PREFIX), `snapshot recorded: ${JSON.stringify(restored.preRestoreSnapshot)}`);
  const snapshotInfo = await stat(restored.preRestoreSnapshot.path);
  assert.ok(snapshotInfo.isFile() && snapshotInfo.size > 0, "the pre-restore snapshot exists on disk");
  assert.equal(restored.overwriteGuard, "guard");

  assert.equal(await readFile(join(home, "settings.yaml"), "utf8"), EDITED, "a newer settings.yaml was NOT rolled back");
  assert.ok(restored.skippedNewer.includes("settings.yaml"), `settings.yaml reported as skipped: ${JSON.stringify(restored.skippedNewer)}`);
  assert.ok(restored.skippedNewerCount >= 1);

  assert.ok(await readFile(join(external, "lib", "added-later.js"), "utf8"), "a newer plugin file survived");
  assert.ok(restored.pluginsSkippedNewer.includes(PLUGIN_NAME), `plugin reported as skipped: ${JSON.stringify(restored.pluginsSkippedNewer)}`);

  assert.equal(await readFile(join(home, "skills", "old.md"), "utf8"), "old skill\n", "a deleted, older file was restored");

  /* ---------------- the snapshot is itself a restorable backup ---------------- */
  const snapshotEntries = unzipSync(new Uint8Array(await readFile(restored.preRestoreSnapshot.path))).map(({ entry }) => entry.name);
  assert.ok(!snapshotEntries.some((name) => name.startsWith("dsh-home/backups/")), "the snapshot does not pack previous backups into itself");
  assert.ok(snapshotEntries.includes("manifest.json"), "the snapshot is a real backup archive");

  /* ---------------- force overrides the guard ---------------- */
  const forced = await restoreBackup(encoded, true);
  assert.equal(forced.overwriteGuard, "forced");
  assert.equal(await readFile(join(home, "settings.yaml"), "utf8"), SETTINGS, "force rolled the file back on purpose");

  /* ---------------- and the forced restore is reversible ---------------- */
  const undone = await restoreBackupRecord(forced.preRestoreSnapshot.path, true);
  assert.ok(undone.restored > 0);
  assert.equal(await readFile(join(home, "settings.yaml"), "utf8"), EDITED, "the pre-restore snapshot brought the newer content back");

  /* ---------------- a repeated restore is idempotent, not self-blocking ---------------- */
  await seedHome(repeatHome, repeatPlugin);
  process.env.DSH_HOME = repeatHome;
  const repeatEncoded = Buffer.from((await makeBackup()).archive).toString("base64");

  const first = await restoreBackup(repeatEncoded);
  assert.ok(first.pluginsRestored.includes(PLUGIN_NAME), `first pass restored the plugin: ${JSON.stringify(first.pluginsRestored)}`);
  assert.equal(first.skippedNewerCount, 0, `first pass skipped nothing: ${JSON.stringify(first.skippedNewer)}`);

  // Every file now postdates the archive, but it holds exactly the archived
  // bytes, so the second pass must write again rather than refuse. The profile
  // package.json is the one exception: the first pass rewrote its link paths for
  // this machine, so it legitimately differs — and leaving it alone is exactly
  // what keeps plugins installed after the backup from being dropped.
  const second = await restoreBackup(repeatEncoded);
  const unexpected = second.skippedNewer.filter((name) => !name.startsWith("profiles/"));
  assert.deepEqual(unexpected, [], `second pass skipped nothing unexpected: ${JSON.stringify(second.skippedNewer)}`);
  assert.ok(second.pluginsRestored.includes(PLUGIN_NAME), `second pass restored the plugin: ${JSON.stringify(second.pluginsRestored)}`);
  assert.equal(await readFile(join(repeatHome, "settings.yaml"), "utf8"), SETTINGS);

  /* ---------------- fail closed when no snapshot can be written ---------------- */
  await seedHome(bare, repeatPlugin);
  await writeFile(join(bare, "backups"), "this file blocks the backup directory\n");
  process.env.DSH_HOME = bare;
  const bareEncoded = Buffer.from((await makeBackup()).archive).toString("base64");
  await writeFile(join(bare, "settings.yaml"), EDITED);
  let refused;
  try {
    await restoreBackup(bareEncoded);
  } catch (error) {
    refused = error;
  }
  assert.ok(refused, "restore refused when the pre-restore snapshot could not be written");
  assert.equal(refused.code, "error.backup.preRestoreSnapshotFailed", `unexpected code: ${refused.code}`);
  assert.equal(await readFile(join(bare, "settings.yaml"), "utf8"), EDITED, "nothing was overwritten before the refusal");

  console.log("restore safety passed");
} finally {
  for (const directory of [home, external, repeatHome, repeatPlugin, bare]) await rm(directory, { recursive: true, force: true });
}
