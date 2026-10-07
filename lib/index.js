import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { promisify } from "node:util";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { access, lstat, mkdir, open, readdir, readFile, readlink, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { collectDirectoryWithStats, readZipEntry, restoreEntries, unzipSync, zipSync } from "./zip.js";
const name = "helloai-backup";
const inject = ["webServer", "webRuntime"];
const PREFIX = "/api/dsh-helloai-bak";
const MAX_BODY = 768 * 1024 * 1024;
const SELF_PACKAGE = "dsh-helloai-bak";
const FORMAT = 4;
const DEPENDENCY_SECTIONS = ["dependencies", "optionalDependencies", "devDependencies"];
const EXCLUDED_ROOTS = /* @__PURE__ */ new Set(["dsh-runtimes", "sessions", "attachments", "logs", "speech-to-text", "backups"]);
const EXCLUDED_NAMES = /* @__PURE__ */ new Set([".DS_Store", "Thumbs.db"]);
const GENERATED_SEGMENTS = /* @__PURE__ */ new Set(["node_modules", ".pnpm", ".bin"]);
const BACKUP_DIRECTORY = "backups";
const DOWNLOAD_CHUNK = 4 * 1024 * 1024;
const MAX_STAGED_ARCHIVES = 8;
const stagedArchives = /* @__PURE__ */ new Map();
const execFileAsync = promisify(execFile);
function dshHome() {
  return resolve(process.env.DSH_HOME || join(homedir(), ".dsh"));
}
function localDate() {
  const now = /* @__PURE__ */ new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
function json(res, status, payload) {
  const data = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": data.length, "cache-control": "no-store" });
  res.end(data);
}
function fail(message, statusCode = 400, code = "error.backup.request") {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}
function readBody(req, limit = MAX_BODY) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const rejectOnce = (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    };
    req.on("data", (chunk) => {
      if (settled) return;
      size += chunk.byteLength;
      if (size > limit) {
        rejectOnce(fail("\u6062\u590D\u6587\u4EF6\u592A\u5927\uFF0C\u8D85\u8FC7 768 MB \u9650\u5236", 413, "error.backup.bodyTooLarge"));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on("error", rejectOnce);
    req.on("end", () => {
      if (settled) return;
      const text = Buffer.concat(chunks).toString("utf8").trim();
      try {
        settled = true;
        resolveBody(text ? JSON.parse(text) : {});
      } catch (error) {
        rejectOnce(fail(`\u8BF7\u6C42\u4E0D\u662F\u6709\u6548 JSON\uFF1A${String(error)}`, 400, "error.backup.invalidJson"));
      }
    });
  });
}
function isLoopbackHost(hostname) {
  return hostname === "localhost" || hostname === "::1" || /^127(?:\.\d{1,3}){3}$/.test(hostname);
}
function requestAllowed(req, trustedHosts) {
  const host = String(req.headers.host || "").toLowerCase();
  let parsedHost;
  try {
    parsedHost = new URL(`http://${host}`);
  } catch {
    return false;
  }
  if (isLoopbackHost(parsedHost.hostname)) return true;
  const configured = trustedHosts.map((item) => item.toLowerCase().split(":")[0]);
  if (configured.includes(parsedHost.hostname)) return true;
  const origin = req.headers.origin;
  if (!origin || origin === "null") return true;
  try {
    const originUrl = new URL(origin);
    return originUrl.host.toLowerCase() === host;
  } catch {
    return false;
  }
}
function safeRel(value) {
  return value.replace(/[\\/]+/g, "/").replace(/^\.\//, "");
}
function normalizedPath(value) {
  return resolve(value).replace(/[\\/]+/g, "/").replace(/\/$/, "").toLowerCase();
}
function forwardPath(value) {
  return resolve(value).replace(/\\/g, "/");
}
function isInside(root, candidate) {
  const base = normalizedPath(root);
  const value = normalizedPath(candidate);
  return value === base || value.startsWith(`${base}/`);
}
function isGeneratedPath(relativeName) {
  return safeRel(relativeName).split("/").some((part) => GENERATED_SEGMENTS.has(part));
}
function isRuntimePath(relativeName, runtimePaths) {
  const normalized = safeRel(relativeName);
  return runtimePaths.some((item) => normalized === item || normalized.startsWith(`${item}/`));
}
function isRuntimePathOrParent(relativeName, runtimePaths) {
  const normalized = safeRel(relativeName);
  return runtimePaths.some((item) => item === normalized || item.startsWith(`${normalized}/`) || normalized.startsWith(`${item}/`));
}
function isTextConfig(path) {
  return [".json", ".yaml", ".yml", ".jsonc"].includes(extname(path).toLowerCase()) || basename(path) === "package.json";
}
async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
async function readJsonFile(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return void 0;
  }
}
function pathFromLocalSpec(profileRoot, spec) {
  if (typeof spec !== "string") return void 0;
  let value = spec.trim();
  if (value.startsWith("link:")) value = value.slice(5);
  else if (value.startsWith("file:")) value = value.slice(5);
  else return void 0;
  if (!value) return void 0;
  if (value.startsWith("~")) value = join(homedir(), value.slice(1));
  return resolve(profileRoot, value.replace(/\\/g, sep));
}
function isInstallOwnedPath(path) {
  const segments = normalizedPath(path).split("/").filter(Boolean);
  return segments.some((segment) => segment === "node_modules" || segment === "resources" || segment.endsWith(".asar") || segment.endsWith(".asar.unpacked"));
}
async function isDshPluginPackage(path) {
  const packageJson = await readJsonFile(join(path, "package.json"));
  if (packageJson && (packageJson.dsh || packageJson.cordis)) return true;
  return exists(join(path, "cordis.patch.yml"));
}
function dependencyNames(packageJson) {
  const names = /* @__PURE__ */ new Set();
  for (const section of ["dependencies", "optionalDependencies"]) {
    const deps = packageJson?.[section];
    if (!deps || typeof deps !== "object") continue;
    for (const dep of Object.keys(deps)) names.add(dep);
  }
  return [...names];
}
function resolveLinkTarget(linkPath, rawTarget) {
  return isAbsolute(rawTarget) ? resolve(rawTarget) : resolve(dirname(linkPath), rawTarget);
}
function pluginSlug(value) {
  return (value || "plugin").replace(/^@/, "").replace(/[\\/]/g, "-").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "plugin";
}
function archiveSlug(plugin, index) {
  return `external/${String(index + 1).padStart(3, "0")}-${pluginSlug(plugin.packageName || basename(plugin.source))}`;
}
async function listProfiles(root) {
  const profilesRoot = join(root, "profiles");
  const entries = await readdir(profilesRoot, { withFileTypes: true }).catch(() => []);
  const profiles = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const profileRoot = join(profilesRoot, entry.name);
    const packageJson = await readJsonFile(join(profileRoot, "package.json"));
    if (!packageJson) continue;
    profiles.push({ name: entry.name, root: profileRoot, packageJson });
  }
  return profiles.sort((a, b) => a.name.localeCompare(b.name));
}
function declaredLinks(profile) {
  const links = [];
  for (const section of DEPENDENCY_SECTIONS) {
    const deps = profile.packageJson?.[section];
    if (!deps || typeof deps !== "object") continue;
    for (const [linkName, spec] of Object.entries(deps)) {
      const path = pathFromLocalSpec(profile.root, spec);
      if (!path) continue;
      links.push({ profile: profile.name, linkName, path, target: String(spec), kind: "directory", origin: "declared", declared: true, section, spec: String(spec), exists: true });
    }
  }
  return links;
}
async function linkedPlugins(profile) {
  const nodeModules = join(profile.root, "node_modules");
  const links = [];
  const candidates = [];
  const entries = await readdir(nodeModules, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (entry.name.startsWith("@")) {
      const scoped = await readdir(join(nodeModules, entry.name), { withFileTypes: true }).catch(() => []);
      for (const child of scoped) candidates.push({ linkName: `${entry.name}/${child.name}`, linkPath: join(nodeModules, entry.name, child.name) });
      continue;
    }
    candidates.push({ linkName: entry.name, linkPath: join(nodeModules, entry.name) });
  }
  for (const candidate of candidates) {
    const info = await lstat(candidate.linkPath).catch(() => void 0);
    if (!info?.isSymbolicLink()) continue;
    const rawTarget = await readlink(candidate.linkPath).catch(() => "");
    const path = resolveLinkTarget(candidate.linkPath, rawTarget);
    if (isInstallOwnedPath(path)) continue;
    const targetInfo = await stat(path).catch(() => void 0);
    const kind = targetInfo && !targetInfo.isDirectory() ? "file" : "directory";
    if (!targetInfo) {
      links.push({ profile: profile.name, linkName: candidate.linkName, path, target: rawTarget, kind, origin: "linked", declared: false, exists: false });
      continue;
    }
    if (kind === "directory" && !await isDshPluginPackage(path)) continue;
    links.push({ profile: profile.name, linkName: candidate.linkName, path, target: rawTarget, kind, origin: "linked", declared: false, exists: true });
  }
  return links;
}
async function bundleLinks(profile) {
  const bundles = profile.packageJson?.dsh?.profile?.bundles;
  if (!Array.isArray(bundles)) return [];
  const nodeModules = join(profile.root, "node_modules");
  const links = [];
  for (const bundleName of bundles) {
    if (typeof bundleName !== "string") continue;
    const linkPath = join(nodeModules, ...bundleName.split("/"));
    const info = await lstat(linkPath).catch(() => void 0);
    if (!info?.isSymbolicLink()) continue;
    const rawTarget = await readlink(linkPath).catch(() => "");
    const path = resolveLinkTarget(linkPath, rawTarget);
    if (isInstallOwnedPath(path)) continue;
    const targetInfo = await stat(path).catch(() => void 0);
    const kind = targetInfo && !targetInfo.isDirectory() ? "file" : "directory";
    links.push({ profile: profile.name, linkName: bundleName, path, target: rawTarget, kind, origin: "bundle", declared: false, exists: Boolean(targetInfo) });
  }
  return links;
}
async function discoverPlugins(root) {
  const profiles = await listProfiles(root);
  const all = [];
  for (const profile of profiles) all.push(...declaredLinks(profile), ...await linkedPlugins(profile), ...await bundleLinks(profile));
  const grouped = /* @__PURE__ */ new Map();
  const insideHome = /* @__PURE__ */ new Map();
  for (const link of all) {
    const bucket = isInside(root, link.path) ? insideHome : grouped;
    const key = normalizedPath(link.path);
    const item = bucket.get(key) || { source: link.path, links: [] };
    if (!item.links.some((existing) => existing.profile === link.profile && existing.linkName === link.linkName)) item.links.push(link);
    else {
      const index = item.links.findIndex((existing) => existing.profile === link.profile && existing.linkName === link.linkName);
      if (index >= 0 && link.declared) item.links[index] = { ...item.links[index], declared: true, section: link.section, spec: link.spec, origin: "declared" };
    }
    bucket.set(key, item);
  }
  const build = async (source, links, statusHint) => {
    const packageJson = await readJsonFile(join(source, "package.json"));
    const kind = packageJson ? "directory" : links.some((link) => link.kind === "file") ? "file" : "directory";
    const linkExists = links.some((link) => link.exists);
    const bootstrap = links.some((link) => link.linkName === SELF_PACKAGE) || packageJson?.name === SELF_PACKAGE;
    let status = statusHint;
    let reason;
    if (!linkExists) {
      status = "missing";
      reason = "\u94FE\u63A5\u6307\u5411\u7684\u63D2\u4EF6\u76EE\u5F55\u5DF2\u4E0D\u5B58\u5728\uFF0C\u65E0\u6CD5\u6253\u5305";
    } else if (bootstrap) {
      status = "self";
      reason = "\u8FD9\u662F\u5907\u4EFD\u63D2\u4EF6\u81EA\u8EAB\uFF1B\u6062\u590D\u65F6\u59CB\u7EC8\u4FDD\u7559\u672C\u673A\u6B63\u5728\u8FD0\u884C\u7684\u7248\u672C\uFF0C\u56E0\u6B64\u65E0\u9700\u6253\u5305";
    } else if (statusHint === "inside-home") reason = "\u63D2\u4EF6\u4F4D\u4E8E DSH_HOME \u5185\uFF0C\u5DF2\u968F dsh-home \u5907\u4EFD";
    const entry = typeof packageJson?.main === "string" ? packageJson.main : typeof packageJson?.exports?.["."] === "string" ? packageJson.exports["."] : void 0;
    const entryPresent = linkExists && kind === "directory" ? entry ? await exists(join(source, entry)) : true : void 0;
    return {
      packageName: String(packageJson?.name || links[0]?.linkName || basename(source)),
      source,
      archive: "",
      kind,
      version: typeof packageJson?.version === "string" ? packageJson.version : void 0,
      pluginId: typeof packageJson?.dsh?.id === "string" ? packageJson.dsh.id : void 0,
      entry,
      entryPresent,
      bytes: 0,
      fileCount: 0,
      runtimeDependencies: [],
      bootstrap,
      status,
      reason,
      links: links.sort((a, b) => a.profile.localeCompare(b.profile) || a.linkName.localeCompare(b.linkName))
    };
  };
  const plugins = [];
  const sorted = [...grouped.values()].sort((a, b) => a.source.localeCompare(b.source));
  for (let index = 0; index < sorted.length; index += 1) {
    const item = sorted[index];
    const plugin = await build(item.source, item.links, "packed");
    plugin.archive = archiveSlug(plugin, index);
    plugins.push(plugin);
  }
  for (const item of [...insideHome.values()].sort((a, b) => a.source.localeCompare(b.source))) plugins.push(await build(item.source, item.links, "inside-home"));
  return plugins;
}
function currentPluginRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}
async function collectRuntimeDependencies(root) {
  const packageJson = await readJsonFile(join(root, "package.json"));
  if (!packageJson) return { paths: [], names: [] };
  const paths = /* @__PURE__ */ new Set();
  const names = /* @__PURE__ */ new Set();
  const queue = dependencyNames(packageJson).map((dependency) => ({ name: dependency, base: root }));
  const visited = /* @__PURE__ */ new Set();
  while (queue.length) {
    const item = queue.shift();
    const packagePath = join(item.base, "node_modules", ...item.name.split("/"));
    const packageJsonPath = join(packagePath, "package.json");
    const packageInfo = await readJsonFile(packageJsonPath);
    if (!packageInfo) continue;
    const relativePath = safeRel(relative(root, packagePath));
    if (!relativePath || !relativePath.startsWith("node_modules/")) continue;
    const key = normalizedPath(packagePath);
    if (visited.has(key)) continue;
    visited.add(key);
    paths.add(relativePath);
    names.add(item.name);
    for (const dependency of dependencyNames(packageInfo)) {
      const nested = join(packagePath, "node_modules", ...dependency.split("/"));
      const hoisted = join(root, "node_modules", ...dependency.split("/"));
      if (await exists(join(nested, "package.json"))) queue.push({ name: dependency, base: packagePath });
      else if (await exists(join(hoisted, "package.json"))) queue.push({ name: dependency, base: root });
    }
  }
  return { paths: [...paths].sort(), names: [...names].sort() };
}
function externalSkip(relativeName, kind, runtimePaths = []) {
  const normalized = safeRel(relativeName);
  const first = normalized.split("/")[0];
  if (first === "node_modules") {
    if (normalized === "node_modules" || normalized === "node_modules/") return runtimePaths.length === 0;
    if (!isRuntimePathOrParent(normalized, runtimePaths)) return true;
    if (normalized.split("/").includes(".pnpm") || normalized.split("/").includes(".bin")) return true;
  } else if (isGeneratedPath(normalized)) return true;
  if (first === ".git" || EXCLUDED_NAMES.has(basename(normalized)) || normalized.endsWith(".log") || normalized.endsWith(".zip") || normalized.endsWith(".tgz")) return true;
  if (kind === "symlink" && normalized.includes("..")) return true;
  return false;
}
async function packagePluginPayload(plugin) {
  const runtime = plugin.kind === "directory" ? await collectRuntimeDependencies(plugin.source) : { paths: [], names: [] };
  plugin.runtimeDependencies = runtime.paths;
  if (plugin.kind === "directory") {
    const collected = await collectDirectoryWithStats(plugin.source, (relativeName, kind) => externalSkip(relativeName, kind, runtime.paths));
    plugin.fileCount = collected.stats.fileCount;
    plugin.bytes = collected.stats.bytes;
    return collected.entries.map((entry) => ({ ...entry, name: `${plugin.archive}/${entry.name}` }));
  }
  const data = new Uint8Array(await readFile(plugin.source));
  plugin.fileCount = 1;
  plugin.bytes = data.byteLength;
  return [{ name: `${plugin.archive}/payload${extname(plugin.source)}`, kind: "file", mode: 384, data }];
}
function applySelection(plugins, include) {
  if (!include) return plugins;
  const chosen = new Set(include.map((item) => normalizedPath(item)));
  for (const plugin of plugins) {
    if (plugin.status !== "packed") continue;
    if (chosen.has(normalizedPath(plugin.source))) continue;
    plugin.status = "skipped";
    plugin.reason = "\u672A\u52FE\u9009\uFF0C\u672C\u6B21\u5907\u4EFD\u5DF2\u8DF3\u8FC7\uFF08\u672C\u673A\u76EE\u5F55\u4FDD\u6301\u4E0D\u53D8\uFF09";
  }
  return plugins;
}
async function makeBackup(options = {}) {
  const root = dshHome();
  const rootInfo = await stat(root).catch(() => void 0);
  if (!rootInfo?.isDirectory()) throw fail(`\u627E\u4E0D\u5230 DSH_HOME\uFF1A${root}`, 404, "error.backup.homeMissing");
  const excluded = [];
  const homeSkip = (relativeName, kind) => {
    const normalized = safeRel(relativeName);
    const first = normalized.split("/")[0];
    if (EXCLUDED_ROOTS.has(first) || isGeneratedPath(normalized) || EXCLUDED_NAMES.has(basename(normalized)) || normalized.endsWith(".log")) {
      if (normalized) excluded.push(normalized);
      return true;
    }
    if (kind === "symlink" && normalized.includes("..")) return true;
    return false;
  };
  const home = await collectDirectoryWithStats(root, homeSkip);
  const plugins = applySelection(await discoverPlugins(root), options.include);
  const externalEntries = [];
  const packed = [];
  const installWarnings = [];
  for (const plugin of plugins) {
    if (plugin.status !== "packed") {
      if (plugin.reason && (plugin.status === "missing" || plugin.status === "failed")) installWarnings.push(`${plugin.packageName}\uFF1A${plugin.reason}\uFF08${plugin.source}\uFF09`);
      continue;
    }
    const payload = await packagePluginPayload(plugin);
    if (!payload.length) {
      plugin.status = "missing";
      plugin.reason = "\u63D2\u4EF6\u76EE\u5F55\u4E2D\u6CA1\u6709\u53EF\u6253\u5305\u7684\u6587\u4EF6";
      installWarnings.push(`${plugin.packageName}\uFF1A${plugin.reason}`);
      continue;
    }
    externalEntries.push({ name: `${plugin.archive}/`, kind: "dir", mode: 448, data: new Uint8Array() }, ...payload);
    packed.push(plugin);
  }
  const included = [.../* @__PURE__ */ new Set(["dsh-home", ...home.entries.map((entry) => entry.name.split("/")[0]).filter(Boolean), ...packed.map((plugin) => plugin.archive.split("/")[0])])].sort();
  const externalRoots = packed.map((plugin) => ({ source: plugin.source, archive: plugin.archive, kind: plugin.kind, packageName: plugin.packageName, bootstrap: plugin.bootstrap, runtimeDependencies: plugin.runtimeDependencies, entry: plugin.entry }));
  const manifest = {
    format: FORMAT,
    plugin: SELF_PACKAGE,
    createdAt: (/* @__PURE__ */ new Date()).toISOString(),
    dshHomeName: basename(root),
    included,
    excluded: [...new Set(excluded)].sort(),
    entryCount: 0,
    includesSecrets: true,
    plugins,
    externalRoots,
    installWarnings: installWarnings.length ? installWarnings : void 0
  };
  const archiveEntries = [{ name: "manifest.json", kind: "file", mode: 384, data: new Uint8Array() }, { name: "dsh-home/", kind: "dir", mode: 448, data: new Uint8Array() }, ...home.entries.map((entry) => ({ ...entry, name: `dsh-home/${entry.name}` })), ...externalEntries];
  manifest.entryCount = archiveEntries.length;
  archiveEntries[0] = { name: "manifest.json", kind: "file", mode: 384, data: new TextEncoder().encode(JSON.stringify(manifest, null, 2) + "\n") };
  return { archive: zipSync(archiveEntries), filename: `dsh-helloai-backup-${localDate()}.zip`, manifest };
}
function backupDirectory() {
  return join(dshHome(), BACKUP_DIRECTORY);
}
function localStamp(date = /* @__PURE__ */ new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}
const PRE_RESTORE_PREFIX = "dsh-helloai-backup-prerestore-";
async function writePreRestoreSnapshot() {
  try {
    const made = await makeBackup();
    const directory = backupDirectory();
    await mkdir(directory, { recursive: true });
    const name2 = await freeBackupName(directory, PRE_RESTORE_PREFIX);
    const target = join(directory, name2);
    const temp = `${target}.tmp-${randomUUID()}`;
    try {
      await writeFile(temp, Buffer.from(made.archive));
      await rename(temp, target);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
    return { name: name2, path: forwardPath(target), bytes: made.archive.byteLength };
  } catch (error) {
    throw fail(`\u6062\u590D\u524D\u7684\u81EA\u52A8\u5FEB\u7167\u5931\u8D25\uFF0C\u5DF2\u4E2D\u6B62\u6062\u590D\u4EE5\u514D\u65E7\u6570\u636E\u8986\u76D6\u65B0\u6570\u636E\uFF1A${error instanceof Error ? error.message : String(error)}`, 500, "error.backup.preRestoreSnapshotFailed");
  }
}
async function freeBackupName(directory, prefix) {
  for (let step = 0; step < 120; step += 1) {
    const name2 = `${prefix}${localStamp(new Date(Date.now() + step * 1e3))}.zip`;
    if (!await exists(join(directory, name2))) return name2;
  }
  return `${prefix}${localStamp()}-${randomUUID().slice(0, 8)}.zip`;
}
async function firstConflictingEntry(root, cutoff, archived, prefix) {
  const queue = [""];
  let visited = 0;
  while (queue.length) {
    const relative2 = queue.shift();
    const items = await readdir(relative2 ? join(root, relative2) : root, { withFileTypes: true }).catch(() => []);
    for (const item of items) {
      if ((visited += 1) > 2e5) return void 0;
      const child = relative2 ? `${relative2}/${item.name}` : item.name;
      if (isGeneratedPath(child)) continue;
      if (item.isDirectory()) {
        queue.push(child);
        continue;
      }
      const target = join(root, child);
      const info = await lstat(target).catch(() => void 0);
      if (!info || info.mtimeMs <= cutoff) continue;
      const original = archived.get(`${prefix}/${child}`);
      if (!original) return child;
      const bytes = await readFile(target).catch(() => void 0);
      if (!bytes || !bytes.equals(Buffer.from(original))) return child;
    }
  }
  return void 0;
}
async function pruneStagedArchives() {
  for (const [token, item] of [...stagedArchives.entries()].sort((a, b) => b[1].createdAt - a[1].createdAt)) {
    if (stagedArchives.size <= MAX_STAGED_ARCHIVES) break;
    stagedArchives.delete(token);
  }
}
async function prepareBackup(options = {}) {
  const result = await makeBackup(options);
  const directory = backupDirectory();
  await mkdir(directory, { recursive: true });
  const stamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-").slice(0, 19);
  let filename = `dsh-helloai-backup-${stamp}.zip`;
  let path = join(directory, filename);
  for (let index = 2; await exists(path); index += 1) {
    filename = `dsh-helloai-backup-${stamp}-${index}.zip`;
    path = join(directory, filename);
  }
  const archive = Buffer.from(result.archive);
  await writeFile(path, archive);
  const token = randomUUID();
  const manifestPlugins = result.manifest.plugins || [];
  const plugins = manifestPlugins.filter((plugin) => plugin.status === "packed").map((plugin) => plugin.packageName);
  const skipped = manifestPlugins.filter((plugin) => plugin.status === "skipped").map((plugin) => plugin.packageName);
  stagedArchives.set(token, { path, filename, size: archive.byteLength, plugins, skipped, createdAt: Date.now() });
  await pruneStagedArchives();
  return { ok: true, token, filename, path, directory, size: archive.byteLength, chunkSize: DOWNLOAD_CHUNK, entryCount: result.manifest.entryCount, plugins, skipped, missing: manifestPlugins.filter((plugin) => plugin.status === "missing").map((plugin) => plugin.packageName) };
}
async function readBackupChunk(token, offset, length) {
  const staged = stagedArchives.get(token);
  if (!staged) throw fail("\u5907\u4EFD\u6587\u4EF6\u5DF2\u8FC7\u671F\uFF0C\u8BF7\u91CD\u65B0\u751F\u6210", 410, "error.backup.tokenExpired");
  const start = Math.max(0, Math.min(Number.isFinite(offset) ? offset : 0, staged.size));
  const size = Math.max(0, Math.min(Number.isFinite(length) ? length : DOWNLOAD_CHUNK, DOWNLOAD_CHUNK, staged.size - start));
  const handle = await open(staged.path, "r");
  try {
    const buffer = Buffer.alloc(size);
    const { bytesRead } = await handle.read(buffer, 0, size, start);
    return { data: buffer.subarray(0, bytesRead), offset: start, total: staged.size, filename: staged.filename };
  } finally {
    await handle.close();
  }
}
const BACKUP_FILE_PATTERN = /^dsh-helloai-backup-.+\.zip$/i;
async function backupRecordRoots() {
  const roots = [
    { root: join(dshHome(), BACKUP_DIRECTORY), scope: "dsh-home" },
    { root: currentPluginRoot(), scope: "plugin-directory" }
  ];
  const seen = /* @__PURE__ */ new Set();
  const unique = [];
  for (const entry of roots) {
    const key = normalizedPath(entry.root);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(entry);
  }
  return unique;
}
async function listBackupRecords() {
  const records = [];
  for (const { root, scope } of await backupRecordRoots()) {
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isFile() || !BACKUP_FILE_PATTERN.test(entry.name)) continue;
      const path = join(root, entry.name);
      const info = await stat(path).catch(() => void 0);
      if (!info) continue;
      const record = { id: forwardPath(path), name: entry.name, path: forwardPath(path), scope, size: info.size, modifiedAt: info.mtime.toISOString(), plugins: [], missing: 0, restorable: false };
      try {
        const manifestBytes = await readZipEntry(path, "manifest.json");
        const manifest = manifestBytes ? JSON.parse(new TextDecoder().decode(manifestBytes)) : void 0;
        if (manifest?.plugin !== SELF_PACKAGE) {
          record.note = "\u4E0D\u662F\u672C\u63D2\u4EF6\u751F\u6210\u7684\u5907\u4EFD";
          records.push(record);
          continue;
        }
        record.createdAt = manifest.createdAt;
        record.format = manifest.format;
        record.plugins = (manifest.plugins || []).filter((plugin) => plugin.status === "packed").map((plugin) => plugin.packageName);
        if (!record.plugins.length && Array.isArray(manifest.externalRoots)) record.plugins = manifest.externalRoots.map((external) => external.packageName || basename(external.source));
        record.missing = (manifest.plugins || []).filter((plugin) => plugin.status === "missing").length;
        record.restorable = true;
      } catch {
        record.note = "\u5907\u4EFD\u5185\u5BB9\u65E0\u6CD5\u8BFB\u53D6";
      }
      records.push(record);
    }
  }
  return records.sort((a, b) => (b.createdAt || b.modifiedAt).localeCompare(a.createdAt || a.modifiedAt));
}
async function resolveBackupRecord(id) {
  const target = resolve(id);
  const name2 = basename(target);
  if (!BACKUP_FILE_PATTERN.test(name2)) throw fail("\u53EA\u80FD\u64CD\u4F5C\u5907\u4EFD\u8BB0\u5F55\u4E2D\u7684\u6587\u4EF6", 400, "error.backup.recordRefused");
  const roots = await backupRecordRoots();
  if (!roots.some((entry) => normalizedPath(dirname(target)) === normalizedPath(entry.root))) throw fail("\u53EA\u80FD\u64CD\u4F5C\u5907\u4EFD\u76EE\u5F55\u4E2D\u7684\u6587\u4EF6", 400, "error.backup.recordRefused");
  if (!await exists(target)) throw fail(`\u5907\u4EFD\u6587\u4EF6\u4E0D\u5B58\u5728\uFF1A${name2}`, 404, "error.backup.recordMissing");
  return { target, name: name2 };
}
async function deleteBackupRecord(id) {
  const { target, name: name2 } = await resolveBackupRecord(id);
  await rm(target, { force: true });
  for (const [token, staged] of stagedArchives) if (normalizedPath(staged.path) === normalizedPath(target)) stagedArchives.delete(token);
  return { deleted: name2, backups: await listBackupRecords() };
}
async function restoreBackupRecord(id, force = false) {
  const { target } = await resolveBackupRecord(id);
  return restoreArchive(new Uint8Array(await readFile(target)), force);
}
function responseForRestore(result) {
  const failed = result.pluginsFailed || [];
  if (!failed.length) return { ok: true, ...result };
  return {
    ok: false,
    partial: true,
    code: "error.backup.partial",
    error: `\u6709 ${failed.length} \u4E2A\u63D2\u4EF6\u6062\u590D\u5931\u8D25\uFF1A${failed.join("\uFF1B")}`,
    ...result
  };
}
function pluginsFromManifest(manifest) {
  if (Array.isArray(manifest.plugins) && manifest.plugins.length) return manifest.plugins;
  return (manifest.externalRoots || []).map((external, index) => ({
    packageName: external.packageName || basename(external.source),
    source: external.source,
    archive: external.archive || `external/${String(index + 1).padStart(3, "0")}-${pluginSlug(external.packageName || basename(external.source))}`,
    kind: external.kind,
    entry: external.entry,
    bytes: 0,
    fileCount: 0,
    runtimeDependencies: external.runtimeDependencies || [],
    bootstrap: external.bootstrap || external.packageName === SELF_PACKAGE,
    status: "packed",
    links: []
  }));
}
async function pathIsReachable(path) {
  try {
    await mkdir(dirname(path), { recursive: true });
    return true;
  } catch {
    return false;
  }
}
async function chooseTarget(plugin, root, used) {
  if (plugin.bootstrap) return { target: currentPluginRoot(), relocated: false, preserved: true };
  if (await pathIsReachable(plugin.source)) return { target: plugin.source, relocated: false, preserved: false };
  const base = join(root, "plugins", pluginSlug(plugin.packageName || basename(plugin.source)));
  let candidate = base;
  let suffix = 1;
  while (used.has(normalizedPath(candidate)) || await exists(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  if (!await pathIsReachable(candidate)) throw fail(`\u65E0\u6CD5\u5728 ${candidate} \u5EFA\u7ACB\u63D2\u4EF6\u76EE\u5F55\uFF1A\u539F\u8DEF\u5F84 ${plugin.source} \u4E0D\u53EF\u7528`, 500, "error.backup.externalPathUnavailable");
  return { target: candidate, relocated: true, preserved: false };
}
async function restorePluginPayload(entries, plugin, target, options = {}) {
  if (plugin.kind === "file") {
    const temp2 = join(dirname(target), `.dsh-helloai-restore-${randomUUID()}`);
    await mkdir(temp2, { recursive: true });
    try {
      const count = await restoreEntries(entries, temp2, plugin.archive);
      const payload = (await readdir(temp2, { withFileTypes: true })).flatMap((item) => item.isDirectory() ? [] : [join(temp2, item.name)]).find((item) => basename(item).startsWith("payload"));
      if (!payload) throw new Error(`\u5907\u4EFD\u7F3A\u5C11\u672C\u5730\u63D2\u4EF6\u5305\uFF1A${plugin.source}`);
      await rm(target, { recursive: true, force: true });
      await mkdir(dirname(target), { recursive: true });
      await rename(payload, target);
      return count;
    } finally {
      await rm(temp2, { recursive: true, force: true });
    }
  }
  const temp = join(dirname(target), `.dsh-helloai-restore-${randomUUID()}`);
  const old = join(dirname(target), `.dsh-helloai-old-${randomUUID()}`);
  await mkdir(temp, { recursive: true });
  let replaced = false;
  const filter = (relativeName, entry) => externalSkip(relativeName, entry.name.endsWith("/") ? "dir" : "file", plugin.runtimeDependencies);
  try {
    const count = await restoreEntries(entries, temp, plugin.archive, filter);
    if (count === 0) throw new Error(`\u5907\u4EFD\u4E2D\u6CA1\u6709\u53EF\u6062\u590D\u7684\u63D2\u4EF6\u6587\u4EF6\uFF1A${plugin.source}`);
    const packageJson = await readJsonFile(join(temp, "package.json"));
    if (packageJson?.name && plugin.packageName && plugin.packageName.includes("/") && packageJson.name !== plugin.packageName) {
      throw new Error(`\u63D2\u4EF6 package.json \u540D\u79F0\u4E0D\u5339\u914D\uFF1A\u671F\u671B ${plugin.packageName}\uFF0C\u5B9E\u9645 ${packageJson.name}`);
    }
    if (await exists(target)) {
      try {
        await rename(target, old);
      } catch {
        return await restoreEntries(entries, target, plugin.archive, filter, options);
      }
    }
    await rename(temp, target);
    replaced = true;
    await rm(old, { recursive: true, force: true });
    return count;
  } catch (error) {
    if (!replaced && await exists(old) && !await exists(target)) {
      try {
        await rename(old, target);
      } catch {
      }
    }
    throw error;
  } finally {
    await rm(temp, { recursive: true, force: true });
    if (replaced) await rm(old, { recursive: true, force: true });
  }
}
function replacePath(text, source, target) {
  const sourceForward = source.replace(/\\/g, "/");
  const targetForward = target.replace(/\\/g, "/");
  const escapedSource = source.replace(/\\/g, "\\\\");
  const escapedTarget = target.replace(/\\/g, "\\\\");
  return text.split(sourceForward).join(targetForward).split(escapedSource).join(escapedTarget).split(source).join(target);
}
async function captureBootstrapSpecs(root) {
  const result = [];
  for (const profile of await listProfiles(root)) {
    for (const section of DEPENDENCY_SECTIONS) {
      const spec = profile.packageJson?.[section]?.[SELF_PACKAGE];
      if (typeof spec === "string") result.push({ profile: profile.name, section, spec });
    }
  }
  return result;
}
async function restoreBootstrapSpecs(root, specs) {
  for (const saved of specs) {
    const path = join(root, "profiles", saved.profile, "package.json");
    const packageJson = await readJsonFile(path);
    if (!packageJson) continue;
    packageJson[saved.section] ||= {};
    packageJson[saved.section][SELF_PACKAGE] = saved.spec;
    await writeFile(path, JSON.stringify(packageJson, null, 2) + "\n");
  }
}
async function rewriteProfilePaths(root, mappings) {
  if (!mappings.length) return;
  const profilesRoot = join(root, "profiles");
  const profiles = await readdir(profilesRoot, { withFileTypes: true }).catch(() => []);
  for (const profile of profiles) {
    if (!profile.isDirectory()) continue;
    const profileRoot = join(profilesRoot, profile.name);
    for (const file of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"]) {
      const path = join(profileRoot, file);
      if (!isTextConfig(path) || !await exists(path)) continue;
      let text = await readFile(path, "utf8");
      for (const mapping of mappings) text = replacePath(text, mapping.source, mapping.target);
      await writeFile(path, text);
    }
  }
}
async function ensurePluginDependencies(root, plugins, mappings) {
  const added = [];
  const warnings = [];
  const targetOf = (source) => mappings.find((item) => normalizedPath(item.source) === normalizedPath(source))?.target || source;
  for (const plugin of plugins) {
    if (plugin.status !== "packed") continue;
    for (const link of plugin.links) {
      if (link.declared) continue;
      const packagePath = join(root, "profiles", link.profile, "package.json");
      const packageJson = await readJsonFile(packagePath);
      if (!packageJson) continue;
      const declaredSomewhere = DEPENDENCY_SECTIONS.some((section2) => typeof packageJson[section2]?.[link.linkName] === "string");
      if (declaredSomewhere) continue;
      const target = targetOf(plugin.source);
      if (!await exists(target)) {
        warnings.push(`${link.profile}/${link.linkName}: \u76EE\u6807\u76EE\u5F55\u4E0D\u5B58\u5728\uFF0C\u672A\u5199\u5165\u4F9D\u8D56\u58F0\u660E\uFF08${target}\uFF09`);
        continue;
      }
      const section = link.section || "dependencies";
      packageJson[section] ||= {};
      packageJson[section][link.linkName] = `link:${forwardPath(target)}`;
      await writeFile(packagePath, JSON.stringify(packageJson, null, 2) + "\n");
      added.push(`${link.profile}/${link.linkName}`);
    }
  }
  return { added, warnings };
}
async function runPackageManager(command, args, cwd) {
  const options = { cwd, timeout: 18e4, windowsHide: true, maxBuffer: 16 * 1024 * 1024 };
  if (process.platform !== "win32" || !/\.(cmd|bat)$/i.test(command)) return execFileAsync(command, args, options);
  return execFileAsync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", command, ...args], options);
}
async function missingRuntimeDependencies(root) {
  const packageJson = await readJsonFile(join(root, "package.json"));
  if (!packageJson) return [];
  const missing = [];
  for (const dependency of dependencyNames(packageJson)) {
    if (!await exists(join(root, "node_modules", ...dependency.split("/"), "package.json"))) missing.push(dependency);
  }
  return missing;
}
async function repairExternalRuntimeDependencies(root, plugins, mappings) {
  const repaired = [];
  const warnings = [];
  for (const plugin of plugins) {
    if (plugin.kind !== "directory" || plugin.bootstrap || plugin.status !== "packed") continue;
    const target = mappings.find((item) => normalizedPath(item.source) === normalizedPath(plugin.source))?.target || plugin.source;
    let missing = await missingRuntimeDependencies(target);
    if (!missing.length) continue;
    const attempts = [
      { command: process.platform === "win32" ? "pnpm.cmd" : "pnpm", args: ["install", "--prod", "--no-frozen-lockfile", "--ignore-scripts", "--config.auto-install-peers=false"] },
      { command: process.platform === "win32" ? "npm.cmd" : "npm", args: ["install", "--omit=dev", "--ignore-scripts", "--no-package-lock", "--legacy-peer-deps"] }
    ];
    const errors = [];
    for (const attempt of attempts) {
      try {
        await runPackageManager(attempt.command, attempt.args, target);
        missing = await missingRuntimeDependencies(target);
        if (!missing.length) {
          repaired.push(plugin.packageName || target);
          break;
        }
      } catch (error) {
        errors.push(error?.shortMessage || error?.message || String(error));
      }
    }
    if (missing.length) warnings.push(`${plugin.packageName || target}: \u7F3A\u5C11\u8FD0\u884C\u4F9D\u8D56 ${missing.join(", ")}\uFF1B\u81EA\u52A8\u5B89\u88C5\u5931\u8D25${errors.length ? `\uFF08${errors.join(" | ")}\uFF09` : ""}`);
  }
  return { repaired, warnings };
}
async function reinstallProfiles(root) {
  const warnings = [];
  const installed = [];
  const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  for (const profile of await listProfiles(root)) {
    if (!profile.packageJson?.dsh?.profile) continue;
    try {
      await runPackageManager(command, ["install", "--no-frozen-lockfile"], profile.root);
      installed.push(profile.name);
    } catch (error) {
      warnings.push(`${profile.name}: ${error?.shortMessage || error?.message || String(error)}`);
    }
  }
  return { installed, warnings };
}
async function replaceLocalLink(linkPath, target, kind) {
  await mkdir(dirname(linkPath), { recursive: true });
  await rm(linkPath, { recursive: true, force: true });
  try {
    await symlink(target, linkPath, kind === "directory" ? "junction" : "file");
  } catch (error) {
    await rm(linkPath, { recursive: true, force: true });
    await symlink(target, linkPath);
  }
}
function dependencyLinkPath(profileRoot, packageName) {
  const linkPath = resolve(profileRoot, "node_modules", ...packageName.split("/"));
  const nodeModulesRoot = resolve(profileRoot, "node_modules");
  if (!isInside(nodeModulesRoot, linkPath)) throw new Error(`\u4E0D\u5B89\u5168\u7684\u63D2\u4EF6\u540D\u79F0\uFF1A${packageName}`);
  return linkPath;
}
async function ensureProfileLinks(root, plugins, mappings) {
  const warnings = [];
  const linked = [];
  const targetOf = (source) => mappings.find((item) => normalizedPath(item.source) === normalizedPath(source))?.target || source;
  const request = /* @__PURE__ */ new Map();
  const profileNames = /* @__PURE__ */ new Set();
  for (const profile of await listProfiles(root)) {
    profileNames.add(profile.name);
    for (const link of declaredLinks(profile)) {
      const target = link.linkName === SELF_PACKAGE ? currentPluginRoot() : targetOf(link.path);
      request.set(`${profile.name}|${link.linkName}`, { profile: profile.name, packageName: link.linkName, target });
    }
  }
  for (const plugin of plugins) {
    if (plugin.status === "missing") continue;
    const target = targetOf(plugin.source);
    if (!await exists(target)) {
      if (plugin.status !== "skipped") warnings.push(`${plugin.packageName}: \u627E\u4E0D\u5230\u63D2\u4EF6\u76EE\u5F55 ${target}`);
      continue;
    }
    for (const link of plugin.links) {
      if (!profileNames.has(link.profile)) continue;
      request.set(`${link.profile}|${link.linkName}`, { profile: link.profile, packageName: link.linkName, target: link.linkName === SELF_PACKAGE ? currentPluginRoot() : target });
    }
  }
  for (const item of request.values()) {
    const profileRoot = join(root, "profiles", item.profile);
    const info = await lstat(item.target).catch(() => void 0);
    if (!info) {
      warnings.push(`${item.profile}/${item.packageName}: \u627E\u4E0D\u5230\u672C\u5730\u63D2\u4EF6\u76EE\u5F55 ${item.target}`);
      continue;
    }
    try {
      await replaceLocalLink(dependencyLinkPath(profileRoot, item.packageName), item.target, info.isDirectory() ? "directory" : "file");
      linked.push(`${item.profile}/${item.packageName}`);
    } catch (error) {
      warnings.push(`${item.profile}/${item.packageName}: \u65E0\u6CD5\u91CD\u65B0\u5EFA\u7ACB\u94FE\u63A5\uFF1A${String(error)}`);
    }
  }
  return { linked, warnings };
}
async function validateRestore(root, plugins, mappings, restored) {
  const reports = [];
  const warnings = [];
  const targetOf = (source) => mappings.find((item) => normalizedPath(item.source) === normalizedPath(source))?.target || source;
  for (const plugin of plugins) {
    const target = plugin.bootstrap ? currentPluginRoot() : targetOf(plugin.source);
    const relocated = normalizedPath(target) !== normalizedPath(plugin.source);
    const packageJson = await readJsonFile(join(target, "package.json"));
    const actualPath = await realpath(target).catch(() => void 0);
    const packageJsonMatches = !plugin.packageName || plugin.kind === "file" || packageJson?.name === plugin.packageName;
    const entryName = plugin.entry || packageJson?.main;
    const entryExists = Boolean(actualPath) && (!entryName || await exists(join(target, entryName)));
    const entryWasMissing = plugin.entryPresent === false && !entryExists;
    const links = [];
    for (const link of plugin.links) {
      const linkPath = dependencyLinkPath(join(root, "profiles", link.profile), link.linkName);
      const linkTarget = await realpath(linkPath).catch(() => void 0);
      const ok = Boolean(linkTarget && actualPath && normalizedPath(linkTarget) === normalizedPath(actualPath));
      links.push({ profile: link.profile, linkName: link.linkName, linkPath, ok, message: ok ? void 0 : `\u94FE\u63A5\u672A\u6307\u5411\u63D2\u4EF6\u76EE\u5F55\uFF08${linkPath}\uFF09` });
    }
    const failedLinks = links.filter((link) => !link.ok);
    let status;
    if (plugin.bootstrap) status = "preserved";
    else if (plugin.status === "missing") status = "missing";
    else if (plugin.status === "skipped") status = actualPath ? "skipped" : "missing";
    else if (!actualPath) status = "failed";
    else if (!packageJsonMatches || !entryExists && !entryWasMissing || failedLinks.length) status = "failed";
    else status = plugin.status === "inside-home" ? "inside-home" : "restored";
    const succeeded = status === "restored" || status === "inside-home" || status === "skipped";
    const message = status === "skipped" ? actualPath ? plugin.reason || "\u8BE5\u63D2\u4EF6\u672A\u5305\u542B\u5728\u672C\u6B21\u5907\u4EFD\u4E2D\uFF0C\u672C\u673A\u539F\u6709\u76EE\u5F55\u5DF2\u4FDD\u7559" : `\u8BE5\u63D2\u4EF6\u672A\u52FE\u9009\u5907\u4EFD\uFF0C\u4E14\u672C\u673A\u6CA1\u6709\u76EE\u5F55\uFF1A${target}` : succeeded ? entryWasMissing ? `\u8BE5\u63D2\u4EF6\u5728\u5907\u4EFD\u65F6\u5C31\u5DF2\u7ECF\u7F3A\u5C11\u5165\u53E3\u6587\u4EF6 ${entryName}\uFF0C\u5DF2\u6309\u539F\u6837\u6062\u590D` : void 0 : [
      plugin.status === "missing" ? plugin.reason || "\u5907\u4EFD\u4E2D\u6CA1\u6709\u8BE5\u63D2\u4EF6\u7684\u6587\u4EF6\uFF0C\u65E0\u6CD5\u6062\u590D" : void 0,
      !actualPath ? `\u76EE\u5F55\u4E0D\u5B58\u5728\uFF1A${target}` : void 0,
      !packageJsonMatches ? `package.json \u540D\u79F0\u4E0D\u5339\u914D\uFF1A${packageJson?.name || "\u7F3A\u5C11 package.json"}` : void 0,
      !entryExists && !entryWasMissing ? `\u5165\u53E3\u6587\u4EF6\u4E0D\u5B58\u5728\uFF1A${entryName || "\u672A\u58F0\u660E\u5165\u53E3"}` : void 0,
      failedLinks.length ? `profile \u94FE\u63A5\u672A\u6307\u5411\u63D2\u4EF6\u76EE\u5F55\uFF1A${failedLinks.map((link) => `${link.profile}/${link.linkName}`).join(", ")}` : void 0
    ].filter(Boolean).join("\uFF1B") || void 0;
    reports.push({ packageName: plugin.packageName, configuredPath: plugin.source, restoredPath: plugin.status === "missing" ? void 0 : target, relocated, status, files: restored.get(normalizedPath(plugin.source)) || 0, links, packageJsonMatches, entryExists, message });
    if (status === "failed" && message) warnings.push(`${plugin.packageName}\uFF08${target}\uFF09\uFF1A${message}`);
  }
  return { reports, warnings };
}
async function restoreBackup(encoded, force = false) {
  if (typeof encoded !== "string" || encoded.length < 16) throw fail("\u6CA1\u6709\u6536\u5230\u6709\u6548\u7684 ZIP \u5907\u4EFD", 400, "error.backup.archiveMissing");
  let archive;
  try {
    archive = Buffer.from(encoded, "base64");
  } catch {
    throw fail("\u5907\u4EFD\u5185\u5BB9\u4E0D\u662F\u6709\u6548\u7684 Base64", 400, "error.backup.archiveInvalid");
  }
  return restoreArchive(archive, force);
}
async function restoreArchive(archive, force = false) {
  const entries = unzipSync(archive);
  const manifestEntry = entries.find(({ entry }) => entry.name === "manifest.json");
  if (!manifestEntry) throw fail("\u8FD9\u4E0D\u662F dsh-helloai-bak \u5907\u4EFD\uFF1A\u7F3A\u5C11 manifest.json", 400, "error.backup.manifestMissing");
  let manifest;
  try {
    manifest = JSON.parse(new TextDecoder().decode(manifestEntry.data));
  } catch {
    throw fail("\u5907\u4EFD\u7684 manifest.json \u635F\u574F", 400, "error.backup.manifestInvalid");
  }
  if (manifest.plugin !== SELF_PACKAGE || ![1, 2, 3, 4].includes(manifest.format)) throw fail("\u5907\u4EFD\u7248\u672C\u4E0D\u53D7\u652F\u6301", 400, "error.backup.versionUnsupported");
  const home = dshHome();
  const preRestoreSnapshot = await writePreRestoreSnapshot();
  const backupTime = Date.parse(manifest.createdAt || "");
  const guardActive = !force && Number.isFinite(backupTime);
  const notOlderThan = guardActive ? backupTime : 0;
  const skippedNewer = [];
  let skippedNewerCount = 0;
  const onSkip = (relativeName) => {
    skippedNewerCount += 1;
    if (skippedNewer.length < 100) skippedNewer.push(relativeName);
  };
  const restoreOptions = { notOlderThan, onSkip };
  const archived = new Map(entries.map(({ entry, data }) => [entry.name, data]));
  const bootstrapSpecs = await captureBootstrapSpecs(home);
  const restoredHome = await restoreEntries(entries, home, "dsh-home", (relativeName) => isGeneratedPath(relativeName), restoreOptions);
  const plugins = pluginsFromManifest(manifest);
  const mappings = [];
  const restoredPaths = /* @__PURE__ */ new Map();
  const used = /* @__PURE__ */ new Set();
  const preserved = [];
  const restoredPlugins = [];
  const relocatedPlugins = [];
  const missingPlugins = [];
  const skippedPlugins = [];
  const failedPlugins = [];
  for (const plugin of plugins) {
    const choice = await chooseTarget(plugin, home, used);
    used.add(normalizedPath(choice.target));
    mappings.push({ source: plugin.source, target: choice.target });
    if (choice.preserved) {
      preserved.push(plugin.packageName);
      continue;
    }
    if (plugin.status === "missing") {
      missingPlugins.push(`${plugin.packageName}\uFF08\u539F\u8DEF\u5F84 ${plugin.source}\uFF09`);
      continue;
    }
    if (plugin.status === "skipped" || plugin.status === "inside-home") continue;
    try {
      if (notOlderThan > 0 && plugin.kind === "directory" && await exists(choice.target)) {
        const conflict = await firstConflictingEntry(choice.target, notOlderThan, archived, plugin.archive);
        if (conflict) {
          skippedPlugins.push(plugin.packageName);
          skippedNewerCount += 1;
          if (skippedNewer.length < 100) skippedNewer.push(`${plugin.packageName}/${conflict}`);
          plugin.status = "skipped";
          plugin.reason = "\u672C\u5730\u5B58\u5728\u6BD4\u5907\u4EFD\u66F4\u65B0\u7684\u6539\u52A8\uFF0C\u672C\u6B21\u672A\u8986\u76D6";
          continue;
        }
      }
      const count = await restorePluginPayload(entries, plugin, choice.target, restoreOptions);
      restoredPaths.set(normalizedPath(plugin.source), count);
      restoredPlugins.push(plugin.packageName);
      if (choice.relocated) relocatedPlugins.push(`${plugin.packageName} \u2192 ${choice.target}`);
    } catch (error) {
      plugin.status = "failed";
      plugin.reason = error instanceof Error ? error.message : String(error);
      failedPlugins.push(`${plugin.packageName}\uFF08${plugin.reason}\uFF09`);
    }
  }
  await rewriteProfilePaths(home, mappings);
  await restoreBootstrapSpecs(home, bootstrapSpecs);
  const dependencies = await ensurePluginDependencies(home, plugins, mappings);
  const runtimeRepair = await repairExternalRuntimeDependencies(home, plugins, mappings);
  const install = await reinstallProfiles(home);
  const links = await ensureProfileLinks(home, plugins, mappings);
  const validation = await validateRestore(home, plugins, mappings, restoredPaths);
  const installWarnings = [...dependencies.warnings, ...runtimeRepair.warnings, ...install.warnings, ...links.warnings, ...validation.warnings];
  return {
    restored: restoredHome + [...restoredPaths.values()].reduce((sum, count) => sum + count, 0),
    createdAt: manifest.createdAt,
    dshHome: home,
    backupFormat: manifest.format,
    pluginCount: plugins.length,
    pluginsRestored: restoredPlugins,
    pluginsPreserved: preserved,
    pluginsMissing: missingPlugins,
    pluginsFailed: failedPlugins,
    pluginsRelocated: relocatedPlugins,
    preRestoreSnapshot,
    overwriteGuard: guardActive ? "guard" : force ? "forced" : "unguarded",
    skippedNewer,
    skippedNewerCount,
    pluginsSkippedNewer: skippedPlugins,
    addedPluginDependencies: dependencies.added,
    reinstalledProfiles: install.installed,
    repairedRuntimePlugins: runtimeRepair.repaired,
    linkedPlugins: links.linked,
    restoreDiagnostics: validation.reports,
    installWarnings
  };
}
function registerRoute(ctx, route) {
  try {
    return ctx.webServer.register(route);
  } catch (error) {
    const table = ctx.webServer.prefixes;
    if (!(table instanceof Map) || !table.has(route.path)) throw error;
    table.delete(route.path);
    ctx.logger?.warn?.(`helloai-backup: \u63A5\u7BA1\u4E86\u4E0A\u4E00\u6B21\u8FD0\u884C\u9057\u7559\u7684 API \u8DEF\u7531 ${route.path}`);
    return ctx.webServer.register(route);
  }
}
function mountRoute(ctx, route) {
  const mount = () => registerRoute(ctx, route);
  if (typeof ctx.effect === "function") ctx.effect(mount, "helloai-backup api route");
  else mount();
}
function apply(ctx) {
  const trustedHosts = Array.isArray(ctx.webRuntime.trustedHosts) ? ctx.webRuntime.trustedHosts : [];
  mountRoute(ctx, { kind: "prefix", path: PREFIX, handler: async (req, res) => {
    const path = new URL(req.url || "/", "http://localhost").pathname.replace(/\/+$/, "");
    try {
      if (!requestAllowed(req, trustedHosts)) return json(res, 403, { ok: false, code: "error.backup.origin", error: "\u8BF7\u6C42\u6765\u6E90\u4E0D\u53D7\u4FE1\u4EFB" });
      if (req.method === "GET" && path === `${PREFIX}/status`) {
        const root = dshHome();
        const rootInfo = await stat(root).catch(() => void 0);
        let plugins = [];
        if (rootInfo?.isDirectory()) plugins = await discoverPlugins(root).catch(() => []);
        const selectable = plugins.filter((plugin) => plugin.status === "packed");
        return json(res, 200, {
          ok: true,
          dshHome: root,
          date: localDate(),
          format: FORMAT,
          excluded: [...EXCLUDED_ROOTS, "node_modules", ".pnpm"],
          plugins: plugins.map((plugin) => ({
            packageName: plugin.packageName,
            source: plugin.source,
            kind: plugin.kind,
            version: plugin.version,
            status: plugin.status,
            reason: plugin.reason,
            bootstrap: plugin.bootstrap,
            links: plugin.links,
            // The settings list offers a checkbox for every packable plugin.
            selectable: plugin.status === "packed",
            defaultSelected: plugin.status === "packed"
          })),
          pluginCount: plugins.length,
          packableCount: selectable.length
        });
      }
      if (req.method === "POST" && path === `${PREFIX}/prepare`) {
        const body = await readBody(req);
        return json(res, 200, await prepareBackup({ include: Array.isArray(body.include) ? body.include.filter((item) => typeof item === "string") : void 0 }));
      }
      if (req.method === "GET" && path === `${PREFIX}/download`) {
        const query = new URL(req.url || "/", "http://localhost").searchParams;
        const chunk = await readBackupChunk(query.get("token") || "", Number(query.get("offset") || 0), Number(query.get("length") || DOWNLOAD_CHUNK));
        res.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-length": chunk.data.byteLength,
          "cache-control": "no-store",
          "x-dsh-helloai-total": String(chunk.total),
          "x-dsh-helloai-offset": String(chunk.offset),
          "x-dsh-helloai-filename": chunk.filename
        });
        return res.end(chunk.data);
      }
      if (req.method === "GET" && path === `${PREFIX}/backups`) {
        return json(res, 200, { ok: true, backups: await listBackupRecords(), directory: forwardPath(join(dshHome(), BACKUP_DIRECTORY)) });
      }
      if (req.method === "POST" && path === `${PREFIX}/backups/delete`) {
        const body = await readBody(req);
        return json(res, 200, { ok: true, ...await deleteBackupRecord(String(body.id || "")) });
      }
      if (req.method === "POST" && path === `${PREFIX}/backups/restore`) {
        const body = await readBody(req);
        const result = await restoreBackupRecord(String(body.id || ""), body.force === true);
        return json(res, 200, responseForRestore(result));
      }
      if (req.method !== "POST") return json(res, 405, { ok: false, code: "error.backup.method", error: "\u53EA\u652F\u6301 GET/POST" });
      if (path === `${PREFIX}/backup`) {
        const body = await readBody(req);
        const result = await makeBackup({ include: Array.isArray(body.include) ? body.include.filter((item) => typeof item === "string") : void 0 });
        const packed = (result.manifest.plugins || []).filter((plugin) => plugin.status === "packed");
        res.writeHead(200, {
          "content-type": "application/zip",
          "content-disposition": `attachment; filename="${result.filename}"`,
          "content-length": result.archive.byteLength,
          "cache-control": "no-store",
          "x-dsh-helloai-plugins": String(packed.length),
          "x-dsh-helloai-skipped": String((result.manifest.plugins || []).filter((plugin) => plugin.status === "skipped").length)
        });
        return res.end(Buffer.from(result.archive));
      }
      if (path === `${PREFIX}/restore`) {
        const body = await readBody(req);
        return json(res, 200, responseForRestore(await restoreBackup(body.archive || "", body.force === true)));
      }
      return json(res, 404, { ok: false, code: "error.backup.notFound", error: "\u672A\u77E5\u5907\u4EFD\u63A5\u53E3" });
    } catch (caught) {
      const error = caught;
      return json(res, error.statusCode || 500, { ok: false, code: error.code || "error.backup.failed", error: error.message || String(error) });
    }
  } });
}
export {
  apply,
  deleteBackupRecord,
  discoverPlugins,
  inject,
  listBackupRecords,
  makeBackup,
  name,
  prepareBackup,
  readBackupChunk,
  restoreBackup,
  restoreBackupRecord
};
//# sourceMappingURL=index.js.map
