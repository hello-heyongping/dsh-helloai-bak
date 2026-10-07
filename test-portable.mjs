import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const home = await mkdtemp(join(tmpdir(), "dsh-helloai-portable-home-"));
const external = await mkdtemp(join(tmpdir(), "dsh-helloai-portable-plugin-"));
const targetHome = await mkdtemp(join(tmpdir(), "dsh-helloai-portable-target-"));
const selfRoot = resolve(".");
try {
  await writeFile(join(external, "package.json"), JSON.stringify({ name: "example-local-plugin", version: "1.0.0", main: "lib/index.js", dependencies: { "example-runtime": "1.0.0" } }));
  await writeFile(join(external, "cordis.patch.yml"), "[]\n");
  await mkdir(join(external, "lib"), { recursive: true });
  await writeFile(join(external, "lib", "index.js"), "export default {};\n");
  await mkdir(join(external, "node_modules", "example-runtime", "lib"), { recursive: true });
  await writeFile(join(external, "node_modules", "example-runtime", "package.json"), JSON.stringify({ name: "example-runtime", version: "1.0.0", main: "lib/index.js" }));
  await writeFile(join(external, "node_modules", "example-runtime", "lib", "index.js"), "export const runtime = true;\n");
  const profile = join(home, "profiles", "desktop");
  await mkdir(profile, { recursive: true });
  // Deliberately no `dsh.profile` marker: the fixture must stay hermetic so the
  // restore never shells out to a real package manager.
  await writeFile(join(profile, "package.json"), JSON.stringify({ name: "dsh-profile-desktop", private: true, dependencies: { "example-local-plugin": `link:${external}`, "dsh-helloai-bak": `link:${selfRoot}` } }, null, 2));
  await writeFile(join(profile, "pnpm-lock.yaml"), `lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      example-local-plugin:\n        specifier: link:${external.replaceAll("\\", "/")}\n        version: link:${external.replaceAll("\\", "/")}\n      dsh-helloai-bak:\n        specifier: link:${selfRoot.replaceAll("\\", "/")}\n        version: link:${selfRoot.replaceAll("\\", "/")}\n`);
  await mkdir(join(profile, "node_modules"), { recursive: true });
  await writeFile(join(profile, "node_modules", "dsh-helloai-bak-preserved.txt"), "fresh bootstrap plugin\n");
  await writeFile(join(home, "settings.yaml"), "language: zh-CN\n");

  process.env.DSH_HOME = home;
  const { makeBackup, restoreBackup } = await import("./lib/index.js");
  const made = await makeBackup();
  const encoded = Buffer.from(made.archive).toString("base64");
  assert.equal(made.manifest.format, 4);
  const externalManifest = made.manifest.externalRoots?.find((item) => item.packageName === "example-local-plugin");
  assert.ok(externalManifest);
  assert.ok(externalManifest.runtimeDependencies?.includes("node_modules/example-runtime"));
  const localPlugin = made.manifest.plugins?.find((item) => item.packageName === "example-local-plugin");
  assert.ok(localPlugin, "format 4 records the plugin inventory");
  assert.equal(localPlugin.status, "packed");
  assert.ok(localPlugin.links.some((link) => link.declared && link.profile === "desktop"));

  process.env.DSH_HOME = targetHome;
  const targetProfile = join(targetHome, "profiles", "desktop");
  await mkdir(join(targetProfile, "node_modules"), { recursive: true });
  await writeFile(join(targetProfile, "node_modules", "dsh-helloai-bak-preserved.txt"), "fresh bootstrap plugin\n");
  const restored = await restoreBackup(encoded);
  assert.ok(restored.restored > 0);
  assert.equal(await readFile(join(targetHome, "settings.yaml"), "utf8"), "language: zh-CN\n");
  assert.equal(await readFile(join(targetProfile, "node_modules", "dsh-helloai-bak-preserved.txt"), "utf8"), "fresh bootstrap plugin\n");
  const rewritten = await readFile(join(targetProfile, "package.json"), "utf8");
  assert.ok(rewritten.includes("dsh-helloai-bak"));
  assert.ok(await readFile(join(external, "package.json"), "utf8"));
  assert.ok(await readFile(join(external, "node_modules", "example-runtime", "lib", "index.js"), "utf8"));
  assert.equal(await realpath(join(targetProfile, "node_modules", "example-local-plugin")), await realpath(external));
  console.log("portable backup/restore passed");
} finally {
  await rm(home, { recursive: true, force: true });
  await rm(targetHome, { recursive: true, force: true });
  await rm(external, { recursive: true, force: true });
}

