import type { IncomingMessage, ServerResponse } from "node:http";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { promisify } from "node:util";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { access, lstat, mkdir, open, readdir, readFile, readlink, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { collectDirectoryWithStats, readZipEntry, restoreEntries, unzipSync, zipSync, type ArchiveKind, type ArchiveEntry, type RestoreOptions, type ZipEntry } from "./zip.js";
import type { BackupManifest, DependencySection, ExternalRoot, LinkOrigin, LocalPlugin, PluginLink, RestorePluginReport } from "./types.js";

type CodedError = Error & { statusCode?: number; code?: string };
type RequestBody = { archive?: string; include?: string[]; stream?: boolean; id?: string; force?: boolean };
type PathMapping = { source: string; target: string };
type BootstrapSpec = { profile: string; section: string; spec: string };
type RuntimeDependencyInfo = { paths: string[]; names: string[] };
type ProfileContext = { name: string; root: string; packageJson: any };
type StagedArchive = { path: string; filename: string; size: number; plugins: string[]; skipped: string[]; createdAt: number };

const name = "helloai-backup";
const inject = ["webServer", "webRuntime"];
const PREFIX = "/api/dsh-helloai-bak";
const MAX_BODY = 768 * 1024 * 1024;
const SELF_PACKAGE = "dsh-helloai-bak";
const FORMAT = 4;
const DEPENDENCY_SECTIONS: readonly DependencySection[] = ["dependencies", "optionalDependencies", "devDependencies"];
const EXCLUDED_ROOTS = new Set(["dsh-runtimes", "sessions", "attachments", "logs", "speech-to-text", "backups"]);
const EXCLUDED_NAMES = new Set([".DS_Store", "Thumbs.db"]);
const GENERATED_SEGMENTS = new Set(["node_modules", ".pnpm", ".bin"]);
/** Staged archives live here and the directory is excluded from every backup. */
const BACKUP_DIRECTORY = "backups";
/**
 * The Desktop app serves the UI from `dsh-app://app` and relays every response
 * through a custom-protocol handler, which cannot deliver a multi-megabyte body
 * reliably (a ~12 MB backup worked, a ~16 MB one failed with "Failed to fetch").
 * Archives are therefore staged on disk and fetched in small chunks.
 */
const DOWNLOAD_CHUNK = 4 * 1024 * 1024;
const MAX_STAGED_ARCHIVES = 8;
const stagedArchives = new Map<string, StagedArchive>();
const execFileAsync = promisify(execFile);

function dshHome() { return resolve(process.env.DSH_HOME || join(homedir(), ".dsh")); }
function localDate() { const now = new Date(); const pad = (value: number) => String(value).padStart(2, "0"); return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`; }
function json(res: ServerResponse, status: number, payload: unknown) { const data = Buffer.from(JSON.stringify(payload)); res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": data.length, "cache-control": "no-store" }); res.end(data); }
function fail(message: string, statusCode = 400, code = "error.backup.request"): CodedError { const error = new Error(message) as CodedError; error.statusCode = statusCode; error.code = code; return error; }
function readBody(req: IncomingMessage, limit = MAX_BODY) {
  return new Promise<RequestBody>((resolveBody, reject) => {
    const chunks: Buffer[] = []; let size = 0; let settled = false;
    const rejectOnce = (error: Error) => { if (!settled) { settled = true; reject(error); } };
    req.on("data", (chunk: Buffer) => { if (settled) return; size += chunk.byteLength; if (size > limit) { rejectOnce(fail("恢复文件太大，超过 768 MB 限制", 413, "error.backup.bodyTooLarge")); req.resume(); return; } chunks.push(chunk); });
    req.on("error", rejectOnce);
    req.on("end", () => {
      if (settled) return;
      // An empty body is valid: older clients post /backup without a payload and
      // then every plugin is packed by default.
      const text = Buffer.concat(chunks).toString("utf8").trim();
      try { settled = true; resolveBody(text ? JSON.parse(text) as RequestBody : {}); } catch (error) { rejectOnce(fail(`请求不是有效 JSON：${String(error)}`, 400, "error.backup.invalidJson")); }
    });
  });
}
function isLoopbackHost(hostname: string) { return hostname === "localhost" || hostname === "::1" || /^127(?:\.\d{1,3}){3}$/.test(hostname); }
function requestAllowed(req: IncomingMessage, trustedHosts: string[]) {
  const host = String(req.headers.host || "").toLowerCase(); let parsedHost: URL; try { parsedHost = new URL(`http://${host}`); } catch { return false; }
  if (isLoopbackHost(parsedHost.hostname)) return true;
  const configured = trustedHosts.map((item) => item.toLowerCase().split(":")[0]); if (configured.includes(parsedHost.hostname)) return true;
  const origin = req.headers.origin; if (!origin || origin === "null") return true;
  try { const originUrl = new URL(origin); return originUrl.host.toLowerCase() === host; } catch { return false; }
}
function safeRel(value: string) { return value.replace(/[\\/]+/g, "/").replace(/^\.\//, ""); }
function normalizedPath(value: string) { return resolve(value).replace(/[\\/]+/g, "/").replace(/\/$/, "").toLowerCase(); }
function forwardPath(value: string) { return resolve(value).replace(/\\/g, "/"); }
function isInside(root: string, candidate: string) { const base = normalizedPath(root); const value = normalizedPath(candidate); return value === base || value.startsWith(`${base}/`); }
function isGeneratedPath(relativeName: string) { return safeRel(relativeName).split("/").some((part) => GENERATED_SEGMENTS.has(part)); }
function isRuntimePath(relativeName: string, runtimePaths: readonly string[]) {
  const normalized = safeRel(relativeName);
  return runtimePaths.some((item) => normalized === item || normalized.startsWith(`${item}/`));
}
function isRuntimePathOrParent(relativeName: string, runtimePaths: readonly string[]) {
  const normalized = safeRel(relativeName);
  return runtimePaths.some((item) => item === normalized || item.startsWith(`${normalized}/`) || normalized.startsWith(`${item}/`));
}
function isTextConfig(path: string) { return [".json", ".yaml", ".yml", ".jsonc"].includes(extname(path).toLowerCase()) || basename(path) === "package.json"; }
async function exists(path: string) { try { await access(path); return true; } catch { return false; } }
async function readJsonFile(path: string): Promise<any | undefined> { try { return JSON.parse(await readFile(path, "utf8")); } catch { return undefined; } }
function pathFromLocalSpec(profileRoot: string, spec: unknown) {
  if (typeof spec !== "string") return undefined;
  let value = spec.trim();
  if (value.startsWith("link:")) value = value.slice(5);
  else if (value.startsWith("file:")) value = value.slice(5);
  else return undefined;
  if (!value) return undefined;
  if (value.startsWith("~")) value = join(homedir(), value.slice(1));
  return resolve(profileRoot, value.replace(/\\/g, sep));
}
/**
 * Links that belong to the DeepSeek Harness installation itself (hoisted pnpm
 * dependencies, the packaged app.asar runtime, native modules) are not user
 * plugins and must never be packed into a backup.
 */
function isInstallOwnedPath(path: string) {
  const segments = normalizedPath(path).split("/").filter(Boolean);
  return segments.some((segment) => segment === "node_modules" || segment === "resources" || segment.endsWith(".asar") || segment.endsWith(".asar.unpacked"));
}
/** A directory is a DSH plugin when it carries a bundle patch or a `dsh` manifest field. */
async function isDshPluginPackage(path: string) {
  const packageJson = await readJsonFile(join(path, "package.json"));
  if (packageJson && (packageJson.dsh || packageJson.cordis)) return true;
  return exists(join(path, "cordis.patch.yml"));
}
function dependencyNames(packageJson: any): string[] {
  const names = new Set<string>();
  for (const section of ["dependencies", "optionalDependencies"] as const) {
    const deps = packageJson?.[section];
    if (!deps || typeof deps !== "object") continue;
    for (const dep of Object.keys(deps)) names.add(dep);
  }
  return [...names];
}
function resolveLinkTarget(linkPath: string, rawTarget: string) { return isAbsolute(rawTarget) ? resolve(rawTarget) : resolve(dirname(linkPath), rawTarget); }
function pluginSlug(value: string) { return (value || "plugin").replace(/^@/, "").replace(/[\\/]/g, "-").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "plugin"; }
function archiveSlug(plugin: LocalPlugin, index: number) { return `external/${String(index + 1).padStart(3, "0")}-${pluginSlug(plugin.packageName || basename(plugin.source))}`; }

/* ------------------------------------------------------------------ *
 * Plugin discovery
 * ------------------------------------------------------------------ */

async function listProfiles(root: string): Promise<ProfileContext[]> {
  const profilesRoot = join(root, "profiles");
  const entries = await readdir(profilesRoot, { withFileTypes: true }).catch(() => []);
  const profiles: ProfileContext[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const profileRoot = join(profilesRoot, entry.name);
    const packageJson = await readJsonFile(join(profileRoot, "package.json"));
    if (!packageJson) continue;
    profiles.push({ name: entry.name, root: profileRoot, packageJson });
  }
  return profiles.sort((a, b) => a.name.localeCompare(b.name));
}

/** Reads every dependency declaration that points at a path outside the profile. */
function declaredLinks(profile: ProfileContext): PluginLink[] {
  const links: PluginLink[] = [];
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

/**
 * Scans `<profile>/node_modules` for junctions/symlinks, which is how DeepSeek
 * Harness exposes every locally developed or hand-installed plugin. Relying on
 * package.json alone missed plugins that were linked without a declaration.
 */
async function linkedPlugins(profile: ProfileContext): Promise<PluginLink[]> {
  const nodeModules = join(profile.root, "node_modules");
  const links: PluginLink[] = [];
  const candidates: Array<{ linkName: string; linkPath: string }> = [];
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
    const info = await lstat(candidate.linkPath).catch(() => undefined);
    // Only reparse points are user plugins: plain directories are pnpm's hoisted
    // dependency tree and would balloon the archive with third-party packages.
    if (!info?.isSymbolicLink()) continue;
    const rawTarget = await readlink(candidate.linkPath).catch(() => "");
    const path = resolveLinkTarget(candidate.linkPath, rawTarget);
    if (isInstallOwnedPath(path)) continue;
    const targetInfo = await stat(path).catch(() => undefined);
    const kind: "directory" | "file" = targetInfo && !targetInfo.isDirectory() ? "file" : "directory";
    if (!targetInfo) { links.push({ profile: profile.name, linkName: candidate.linkName, path, target: rawTarget, kind, origin: "linked", declared: false, exists: false }); continue; }
    if (kind === "directory" && !await isDshPluginPackage(path)) continue;
    links.push({ profile: profile.name, linkName: candidate.linkName, path, target: rawTarget, kind, origin: "linked", declared: false, exists: true });
  }
  return links;
}

/** Bundles listed in `dsh.profile.bundles` that resolve to a local directory. */
async function bundleLinks(profile: ProfileContext): Promise<PluginLink[]> {
  const bundles = profile.packageJson?.dsh?.profile?.bundles;
  if (!Array.isArray(bundles)) return [];
  const nodeModules = join(profile.root, "node_modules");
  const links: PluginLink[] = [];
  for (const bundleName of bundles) {
    if (typeof bundleName !== "string") continue;
    const linkPath = join(nodeModules, ...bundleName.split("/"));
    const info = await lstat(linkPath).catch(() => undefined);
    if (!info?.isSymbolicLink()) continue;
    const rawTarget = await readlink(linkPath).catch(() => "");
    const path = resolveLinkTarget(linkPath, rawTarget);
    if (isInstallOwnedPath(path)) continue;
    // Classify by the TARGET, never by the link: on Windows lstat() on a
    // junction reports a symlink, so `info.isDirectory()` is false even when the
    // target is a directory. That mistake used to record kind "file" and make
    // ensureProfileLinks recreate a directory bundle as a file symlink, which
    // neither Node nor pnpm can resolve. `linkedPlugins` already does it this way.
    const targetInfo = await stat(path).catch(() => undefined);
    const kind: "directory" | "file" = targetInfo && !targetInfo.isDirectory() ? "file" : "directory";
    links.push({ profile: profile.name, linkName: bundleName, path, target: rawTarget, kind, origin: "bundle", declared: false, exists: Boolean(targetInfo) });
  }
  return links;
}

/**
 * Complete local plugin inventory: every distinct plugin directory outside
 * DSH_HOME plus the full link topology that makes it visible to each profile.
 */
async function discoverPlugins(root: string): Promise<LocalPlugin[]> {
  const profiles = await listProfiles(root);
  const all: PluginLink[] = [];
  for (const profile of profiles) all.push(...declaredLinks(profile), ...await linkedPlugins(profile), ...await bundleLinks(profile));

  const grouped = new Map<string, { source: string; links: PluginLink[] }>();
  const insideHome = new Map<string, { source: string; links: PluginLink[] }>();
  for (const link of all) {
    const bucket = isInside(root, link.path) ? insideHome : grouped;
    const key = normalizedPath(link.path);
    const item = bucket.get(key) || { source: link.path, links: [] };
    // A declared spec wins for provenance, but every physical link is recorded.
    if (!item.links.some((existing) => existing.profile === link.profile && existing.linkName === link.linkName)) item.links.push(link);
    else {
      const index = item.links.findIndex((existing) => existing.profile === link.profile && existing.linkName === link.linkName);
      if (index >= 0 && link.declared) item.links[index] = { ...item.links[index], declared: true, section: link.section, spec: link.spec, origin: "declared" };
    }
    bucket.set(key, item);
  }

  const build = async (source: string, links: PluginLink[], statusHint: LocalPlugin["status"]): Promise<LocalPlugin> => {
    const packageJson = await readJsonFile(join(source, "package.json"));
    const kind: "directory" | "file" = packageJson ? "directory" : (links.some((link) => link.kind === "file") ? "file" : "directory");
    const linkExists = links.some((link) => link.exists);
    const bootstrap = links.some((link) => link.linkName === SELF_PACKAGE) || packageJson?.name === SELF_PACKAGE;
    let status: LocalPlugin["status"] = statusHint;
    let reason: string | undefined;
    if (!linkExists) { status = "missing"; reason = "链接指向的插件目录已不存在，无法打包"; }
    else if (bootstrap) { status = "self"; reason = "这是备份插件自身；恢复时始终保留本机正在运行的版本，因此无需打包"; }
    else if (statusHint === "inside-home") reason = "插件位于 DSH_HOME 内，已随 dsh-home 备份";
    const entry = typeof packageJson?.main === "string" ? packageJson.main : (typeof packageJson?.exports?.["."] === "string" ? packageJson.exports["."] : undefined);
    // Remember whether the declared entry actually existed before the backup so a
    // plugin that was already incomplete is not blamed on the restore.
    const entryPresent = linkExists && kind === "directory" ? (entry ? await exists(join(source, entry)) : true) : undefined;
    return {
      packageName: String(packageJson?.name || links[0]?.linkName || basename(source)),
      source,
      archive: "",
      kind,
      version: typeof packageJson?.version === "string" ? packageJson.version : undefined,
      pluginId: typeof packageJson?.dsh?.id === "string" ? packageJson.dsh.id : undefined,
      entry,
      entryPresent,
      bytes: 0,
      fileCount: 0,
      runtimeDependencies: [],
      bootstrap,
      status,
      reason,
      links: links.sort((a, b) => a.profile.localeCompare(b.profile) || a.linkName.localeCompare(b.linkName)),
    };
  };

  const plugins: LocalPlugin[] = [];
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

/** The plugin whose directory holds the currently running copy of this plugin. */
function currentPluginRoot() { return resolve(dirname(fileURLToPath(import.meta.url)), ".."); }

/* ------------------------------------------------------------------ *
 * Backup
 * ------------------------------------------------------------------ */

async function collectRuntimeDependencies(root: string): Promise<RuntimeDependencyInfo> {
  const packageJson = await readJsonFile(join(root, "package.json"));
  if (!packageJson) return { paths: [], names: [] };
  const paths = new Set<string>();
  const names = new Set<string>();
  const queue: Array<{ name: string; base: string }> = dependencyNames(packageJson).map((dependency) => ({ name: dependency, base: root }));
  const visited = new Set<string>();
  while (queue.length) {
    const item = queue.shift()!;
    const packagePath = join(item.base, "node_modules", ...item.name.split("/"));
    const packageJsonPath = join(packagePath, "package.json");
    const packageInfo = await readJsonFile(packageJsonPath);
    if (!packageInfo) continue;
    const relativePath = safeRel(relative(root, packagePath));
    if (!relativePath || !relativePath.startsWith("node_modules/")) continue;
    const key = normalizedPath(packagePath);
    if (visited.has(key)) continue;
    visited.add(key); paths.add(relativePath); names.add(item.name);
    for (const dependency of dependencyNames(packageInfo)) {
      // Prefer a dependency nested in this package, then the plugin-level
      // hoisted node_modules directory. This mirrors Node's resolution rules.
      const nested = join(packagePath, "node_modules", ...dependency.split("/"));
      const hoisted = join(root, "node_modules", ...dependency.split("/"));
      if (await exists(join(nested, "package.json"))) queue.push({ name: dependency, base: packagePath });
      else if (await exists(join(hoisted, "package.json"))) queue.push({ name: dependency, base: root });
    }
  }
  return { paths: [...paths].sort(), names: [...names].sort() };
}

function externalSkip(relativeName: string, kind: ArchiveKind, runtimePaths: readonly string[] = []) {
  const normalized = safeRel(relativeName); const first = normalized.split("/")[0];
  // Local plugins need only their production dependencies.  Keeping every
  // node_modules directory made a backup huge and also copied package-manager
  // internals which are not portable between machines.
  if (first === "node_modules") {
    if (normalized === "node_modules" || normalized === "node_modules/") return runtimePaths.length === 0;
    if (!isRuntimePathOrParent(normalized, runtimePaths)) return true;
    if (normalized.split("/").includes(".pnpm") || normalized.split("/").includes(".bin")) return true;
  } else if (isGeneratedPath(normalized)) return true;
  if (first === ".git" || EXCLUDED_NAMES.has(basename(normalized)) || normalized.endsWith(".log") || normalized.endsWith(".zip") || normalized.endsWith(".tgz")) return true;
  if (kind === "symlink" && normalized.includes("..")) return true;
  return false;
}

/** One pass over a plugin directory that both archives its payload and measures it. */
async function packagePluginPayload(plugin: LocalPlugin) {
  const runtime = plugin.kind === "directory" ? await collectRuntimeDependencies(plugin.source) : { paths: [], names: [] };
  plugin.runtimeDependencies = runtime.paths;
  if (plugin.kind === "directory") {
    const collected = await collectDirectoryWithStats(plugin.source, (relativeName, kind) => externalSkip(relativeName, kind, runtime.paths));
    plugin.fileCount = collected.stats.fileCount;
    plugin.bytes = collected.stats.bytes;
    return collected.entries.map((entry) => ({ ...entry, name: `${plugin.archive}/${entry.name}` }) as ArchiveEntry);
  }
  const data = new Uint8Array(await readFile(plugin.source));
  plugin.fileCount = 1;
  plugin.bytes = data.byteLength;
  return [{ name: `${plugin.archive}/payload${extname(plugin.source)}`, kind: "file" as ArchiveKind, mode: 0o600, data }];
}

type BackupOptions = { include?: readonly string[] };

/** Applies the settings-page selection: unlisted plugins are kept but not packed. */
function applySelection(plugins: LocalPlugin[], include?: readonly string[]) {
  if (!include) return plugins;
  const chosen = new Set(include.map((item) => normalizedPath(item)));
  for (const plugin of plugins) {
    if (plugin.status !== "packed") continue;
    if (chosen.has(normalizedPath(plugin.source))) continue;
    plugin.status = "skipped";
    plugin.reason = "未勾选，本次备份已跳过（本机目录保持不变）";
  }
  return plugins;
}

async function makeBackup(options: BackupOptions = {}) {
  const root = dshHome(); const rootInfo = await stat(root).catch(() => undefined); if (!rootInfo?.isDirectory()) throw fail(`找不到 DSH_HOME：${root}`, 404, "error.backup.homeMissing");
  const excluded: string[] = [];
  const homeSkip = (relativeName: string, kind: ArchiveKind) => { const normalized = safeRel(relativeName); const first = normalized.split("/")[0]; if (EXCLUDED_ROOTS.has(first) || isGeneratedPath(normalized) || EXCLUDED_NAMES.has(basename(normalized)) || normalized.endsWith(".log")) { if (normalized) excluded.push(normalized); return true; } if (kind === "symlink" && normalized.includes("..")) return true; return false; };
  const home = await collectDirectoryWithStats(root, homeSkip);
  const plugins = applySelection(await discoverPlugins(root), options.include);
  const externalEntries: ArchiveEntry[] = [];
  const packed: LocalPlugin[] = [];
  const installWarnings: string[] = [];
  for (const plugin of plugins) {
    if (plugin.status !== "packed") {
      // Only real problems belong in installWarnings; a plugin that simply lives
      // inside DSH_HOME is already covered by the dsh-home part of the archive.
      if (plugin.reason && (plugin.status === "missing" || plugin.status === "failed")) installWarnings.push(`${plugin.packageName}：${plugin.reason}（${plugin.source}）`);
      continue;
    }
    const payload = await packagePluginPayload(plugin);
    if (!payload.length) { plugin.status = "missing"; plugin.reason = "插件目录中没有可打包的文件"; installWarnings.push(`${plugin.packageName}：${plugin.reason}`); continue; }
    externalEntries.push({ name: `${plugin.archive}/`, kind: "dir", mode: 0o700, data: new Uint8Array() }, ...payload);
    packed.push(plugin);
  }
  const included = [...new Set(["dsh-home", ...home.entries.map((entry) => entry.name.split("/")[0]).filter(Boolean), ...packed.map((plugin) => plugin.archive.split("/")[0])])].sort();
  const externalRoots: ExternalRoot[] = packed.map((plugin) => ({ source: plugin.source, archive: plugin.archive, kind: plugin.kind, packageName: plugin.packageName, bootstrap: plugin.bootstrap, runtimeDependencies: plugin.runtimeDependencies, entry: plugin.entry }));
  const manifest: BackupManifest = {
    format: FORMAT,
    plugin: SELF_PACKAGE,
    createdAt: new Date().toISOString(),
    dshHomeName: basename(root),
    included,
    excluded: [...new Set(excluded)].sort(),
    entryCount: 0,
    includesSecrets: true,
    plugins,
    externalRoots,
    installWarnings: installWarnings.length ? installWarnings : undefined,
  };
  const archiveEntries: ArchiveEntry[] = [{ name: "manifest.json", kind: "file", mode: 0o600, data: new Uint8Array() }, { name: "dsh-home/", kind: "dir", mode: 0o700, data: new Uint8Array() }, ...home.entries.map((entry) => ({ ...entry, name: `dsh-home/${entry.name}` })), ...externalEntries];
  manifest.entryCount = archiveEntries.length;
  archiveEntries[0] = { name: "manifest.json", kind: "file", mode: 0o600, data: new TextEncoder().encode(JSON.stringify(manifest, null, 2) + "\n") };
  return { archive: zipSync(archiveEntries), filename: `dsh-helloai-backup-${localDate()}.zip`, manifest };
}

/* ------------------------------------------------------------------ *
 * Staged download
 * ------------------------------------------------------------------ */

function backupDirectory() { return join(dshHome(), BACKUP_DIRECTORY); }

/** `YYYYMMDD-HHmmss` in local time — a person reads these names. */
function localStamp(date = new Date()) { const pad = (value: number) => String(value).padStart(2, "0"); return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`; }

/** Restores capture the state they are about to replace under this prefix. */
const PRE_RESTORE_PREFIX = "dsh-helloai-backup-prerestore-";

/**
 * Snapshot the current state before a restore touches anything.
 *
 * Without this a restore is irreversible: it overwrites files in place and the
 * backup it came from describes a state that no longer exists. Refusing to
 * proceed when the snapshot cannot be written is deliberate — failing closed
 * costs a retry, failing open costs data.
 *
 * @returns the snapshot's name, path, and size.
 */
async function writePreRestoreSnapshot() {
  try {
    const made = await makeBackup();
    const directory = backupDirectory();
    await mkdir(directory, { recursive: true });
    const name = await freeBackupName(directory, PRE_RESTORE_PREFIX);
    const target = join(directory, name);
    const temp = `${target}.tmp-${randomUUID()}`;
    try {
      await writeFile(temp, Buffer.from(made.archive));
      await rename(temp, target);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
    return { name, path: forwardPath(target), bytes: made.archive.byteLength };
  } catch (error) {
    throw fail(`恢复前的自动快照失败，已中止恢复以免旧数据覆盖新数据：${error instanceof Error ? error.message : String(error)}`, 500, "error.backup.preRestoreSnapshotFailed");
  }
}

/** Two snapshots inside one second must not clobber each other. */
async function freeBackupName(directory: string, prefix: string) {
  for (let step = 0; step < 120; step += 1) {
    const name = `${prefix}${localStamp(new Date(Date.now() + step * 1000))}.zip`;
    if (!await exists(join(directory, name))) return name;
  }
  return `${prefix}${localStamp()}-${randomUUID().slice(0, 8)}.zip`;
}

/**
 * The first entry under `root` that both postdates `cutoff` and differs from the
 * bytes the archive holds, or undefined.
 *
 * A whole plugin directory is replaced by rename, so the per-file guard inside
 * `restoreEntries` never sees those files; this asks the same question one level
 * up. Comparing content first means a directory a previous restore already wrote
 * is not mistaken for local work, so restoring the same archive twice works.
 * Stops at the first conflict — the caller only needs a yes-or-no answer.
 */
async function firstConflictingEntry(root: string, cutoff: number, archived: ReadonlyMap<string, Uint8Array>, prefix: string): Promise<string | undefined> {
  const queue: string[] = [""];
  let visited = 0;
  while (queue.length) {
    const relative = queue.shift() as string;
    const items = await readdir(relative ? join(root, relative) : root, { withFileTypes: true }).catch(() => []);
    for (const item of items) {
      if ((visited += 1) > 200000) return undefined;
      const child = relative ? `${relative}/${item.name}` : item.name;
      if (isGeneratedPath(child)) continue;
      if (item.isDirectory()) { queue.push(child); continue; }
      const target = join(root, child);
      const info = await lstat(target).catch(() => undefined);
      if (!info || info.mtimeMs <= cutoff) continue;
      // Not in the archive at all: the directory gained something the backup never had.
      const original = archived.get(`${prefix}/${child}`);
      if (!original) return child;
      const bytes = await readFile(target).catch(() => undefined);
      if (!bytes || !bytes.equals(Buffer.from(original))) return child;
    }
  }
  return undefined;
}

/**
 * Forgets old download tokens only. Files are never removed here: the settings
 * page shows every backup in a history list and the user decides what to delete.
 */
async function pruneStagedArchives() {
  for (const [token, item] of [...stagedArchives.entries()].sort((a, b) => b[1].createdAt - a[1].createdAt)) {
    if (stagedArchives.size <= MAX_STAGED_ARCHIVES) break;
    stagedArchives.delete(token);
  }
}

/**
 * Builds the archive, writes it to `<DSH_HOME>/backups/` and returns a token.
 * The file stays on disk, so a browser that cannot receive the body still
 * leaves the user with a complete backup they can copy.
 */
async function prepareBackup(options: BackupOptions = {}) {
  const result = await makeBackup(options);
  const directory = backupDirectory();
  await mkdir(directory, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  // Two backups inside the same second must not overwrite each other.
  let filename = `dsh-helloai-backup-${stamp}.zip`;
  let path = join(directory, filename);
  for (let index = 2; await exists(path); index += 1) { filename = `dsh-helloai-backup-${stamp}-${index}.zip`; path = join(directory, filename); }
  const archive = Buffer.from(result.archive);
  await writeFile(path, archive);
  const token = randomUUID();
  const manifestPlugins = result.manifest.plugins || [];
  const plugins = manifestPlugins.filter((plugin) => plugin.status === "packed").map((plugin) => plugin.packageName);
  const skipped = manifestPlugins.filter((plugin) => plugin.status === "skipped").map((plugin) => plugin.packageName);
  stagedArchives.set(token, { path, filename, size: archive.byteLength, plugins, skipped, createdAt: Date.now() });
  await pruneStagedArchives();
  return { ok: true as const, token, filename, path, directory, size: archive.byteLength, chunkSize: DOWNLOAD_CHUNK, entryCount: result.manifest.entryCount, plugins, skipped, missing: manifestPlugins.filter((plugin) => plugin.status === "missing").map((plugin) => plugin.packageName) };
}

/** Reads one byte range of a staged archive. */
async function readBackupChunk(token: string, offset: number, length: number) {
  const staged = stagedArchives.get(token);
  if (!staged) throw fail("备份文件已过期，请重新生成", 410, "error.backup.tokenExpired");
  const start = Math.max(0, Math.min(Number.isFinite(offset) ? offset : 0, staged.size));
  const size = Math.max(0, Math.min(Number.isFinite(length) ? length : DOWNLOAD_CHUNK, DOWNLOAD_CHUNK, staged.size - start));
  const handle = await open(staged.path, "r");
  try {
    const buffer = Buffer.alloc(size);
    const { bytesRead } = await handle.read(buffer, 0, size, start);
    return { data: buffer.subarray(0, bytesRead), offset: start, total: staged.size, filename: staged.filename };
  } finally { await handle.close(); }
}

/* ------------------------------------------------------------------ *
 * Backup history
 * ------------------------------------------------------------------ */

const BACKUP_FILE_PATTERN = /^dsh-helloai-backup-.+\.zip$/i;

type BackupRecord = {
  id: string;
  name: string;
  path: string;
  scope: "dsh-home" | "plugin-directory";
  size: number;
  modifiedAt: string;
  createdAt?: string;
  format?: number;
  plugins: string[];
  missing: number;
  restorable: boolean;
  note?: string;
};

/** Archives are listed from the staging directory and the plugin's own folder. */
async function backupRecordRoots() {
  const roots: Array<{ root: string; scope: BackupRecord["scope"] }> = [
    { root: join(dshHome(), BACKUP_DIRECTORY), scope: "dsh-home" },
    { root: currentPluginRoot(), scope: "plugin-directory" },
  ];
  const seen = new Set<string>(); const unique: typeof roots = [];
  for (const entry of roots) { const key = normalizedPath(entry.root); if (seen.has(key)) continue; seen.add(key); unique.push(entry); }
  return unique;
}

async function listBackupRecords(): Promise<BackupRecord[]> {
  const records: BackupRecord[] = [];
  for (const { root, scope } of await backupRecordRoots()) {
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isFile() || !BACKUP_FILE_PATTERN.test(entry.name)) continue;
      const path = join(root, entry.name);
      const info = await stat(path).catch(() => undefined);
      if (!info) continue;
      const record: BackupRecord = { id: forwardPath(path), name: entry.name, path: forwardPath(path), scope, size: info.size, modifiedAt: info.mtime.toISOString(), plugins: [], missing: 0, restorable: false };
      try {
        const manifestBytes = await readZipEntry(path, "manifest.json");
        const manifest = manifestBytes ? JSON.parse(new TextDecoder().decode(manifestBytes)) as BackupManifest : undefined;
        if (manifest?.plugin !== SELF_PACKAGE) { record.note = "不是本插件生成的备份"; records.push(record); continue; }
        record.createdAt = manifest.createdAt;
        record.format = manifest.format;
        record.plugins = (manifest.plugins || []).filter((plugin) => plugin.status === "packed").map((plugin) => plugin.packageName);
        // Format 1-3 archives only carry the flattened external root list.
        if (!record.plugins.length && Array.isArray(manifest.externalRoots)) record.plugins = manifest.externalRoots.map((external) => external.packageName || basename(external.source));
        record.missing = (manifest.plugins || []).filter((plugin) => plugin.status === "missing").length;
        record.restorable = true;
      } catch { record.note = "备份内容无法读取"; }
      records.push(record);
    }
  }
  return records.sort((a, b) => (b.createdAt || b.modifiedAt).localeCompare(a.createdAt || a.modifiedAt));
}

/** Only files that appear in the backup list may be touched. */
async function resolveBackupRecord(id: string) {
  const target = resolve(id);
  const name = basename(target);
  if (!BACKUP_FILE_PATTERN.test(name)) throw fail("只能操作备份记录中的文件", 400, "error.backup.recordRefused");
  const roots = await backupRecordRoots();
  if (!roots.some((entry) => normalizedPath(dirname(target)) === normalizedPath(entry.root))) throw fail("只能操作备份目录中的文件", 400, "error.backup.recordRefused");
  if (!await exists(target)) throw fail(`备份文件不存在：${name}`, 404, "error.backup.recordMissing");
  return { target, name };
}

async function deleteBackupRecord(id: string) {
  const { target, name } = await resolveBackupRecord(id);
  await rm(target, { force: true });
  for (const [token, staged] of stagedArchives) if (normalizedPath(staged.path) === normalizedPath(target)) stagedArchives.delete(token);
  return { deleted: name, backups: await listBackupRecords() };
}

async function restoreBackupRecord(id: string, force = false) {
  const { target } = await resolveBackupRecord(id);
  return restoreArchive(new Uint8Array(await readFile(target)), force);
}

/**
 * A restore writes what it can and keeps going, so a plugin that threw is
 * reported in `pluginsFailed` rather than aborting the other plugins. Returning
 * `ok: true` in that case made a half-restored machine look like a success — the
 * caller now sees `ok: false` plus `partial`, and the pre-restore snapshot is
 * named so the user can roll back.
 */
function responseForRestore(result: Awaited<ReturnType<typeof restoreArchive>>) {
  const failed = result.pluginsFailed || [];
  if (!failed.length) return { ok: true, ...result };
  return {
    ok: false,
    partial: true,
    code: "error.backup.partial",
    error: `有 ${failed.length} 个插件恢复失败：${failed.join("；")}`,
    ...result,
  };
}

/* ------------------------------------------------------------------ *
 * Restore
 * ------------------------------------------------------------------ */

/** Rebuilds the plugin list for manifests written before format 4. */
function pluginsFromManifest(manifest: BackupManifest): LocalPlugin[] {
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
    links: [],
  }));
}

/** True when the drive/root a path lives on is available on this machine. */
async function pathIsReachable(path: string) {
  try { await mkdir(dirname(path), { recursive: true }); return true; } catch { return false; }
}

/**
 * Restores a plugin to the exact directory recorded in the backup. When that
 * directory cannot exist here (different machine, missing drive) the payload
 * falls back to `<DSH_HOME>/plugins/<name>` and the profile links are rewritten,
 * so a migrated backup still ends up with working plugins.
 */
async function chooseTarget(plugin: LocalPlugin, root: string, used: Set<string>) {
  if (plugin.bootstrap) return { target: currentPluginRoot(), relocated: false, preserved: true };
  if (await pathIsReachable(plugin.source)) return { target: plugin.source, relocated: false, preserved: false };
  const base = join(root, "plugins", pluginSlug(plugin.packageName || basename(plugin.source)));
  let candidate = base; let suffix = 1;
  while (used.has(normalizedPath(candidate)) || await exists(candidate)) { candidate = `${base}-${suffix}`; suffix += 1; }
  if (!await pathIsReachable(candidate)) throw fail(`无法在 ${candidate} 建立插件目录：原路径 ${plugin.source} 不可用`, 500, "error.backup.externalPathUnavailable");
  return { target: candidate, relocated: true, preserved: false };
}

async function restorePluginPayload(entries: readonly { entry: ZipEntry; data: Uint8Array }[], plugin: LocalPlugin, target: string, options: RestoreOptions = {}) {
  if (plugin.kind === "file") {
    const temp = join(dirname(target), `.dsh-helloai-restore-${randomUUID()}`); await mkdir(temp, { recursive: true });
    try {
      const count = await restoreEntries(entries, temp, plugin.archive);
      const payload = (await readdir(temp, { withFileTypes: true })).flatMap((item: { isDirectory(): boolean; name: string }) => item.isDirectory() ? [] : [join(temp, item.name)]).find((item: string) => basename(item).startsWith("payload"));
      if (!payload) throw new Error(`备份缺少本地插件包：${plugin.source}`);
      await rm(target, { recursive: true, force: true }); await mkdir(dirname(target), { recursive: true }); await rename(payload, target);
      return count;
    } finally { await rm(temp, { recursive: true, force: true }); }
  }
  const temp = join(dirname(target), `.dsh-helloai-restore-${randomUUID()}`);
  const old = join(dirname(target), `.dsh-helloai-old-${randomUUID()}`);
  await mkdir(temp, { recursive: true });
  let replaced = false;
  const filter = (relativeName: string, entry: ZipEntry) => externalSkip(relativeName, entry.name.endsWith("/") ? "dir" : "file", plugin.runtimeDependencies);
  try {
    const count = await restoreEntries(entries, temp, plugin.archive, filter);
    if (count === 0) throw new Error(`备份中没有可恢复的插件文件：${plugin.source}`);
    const packageJson = await readJsonFile(join(temp, "package.json"));
    if (packageJson?.name && plugin.packageName && plugin.packageName.includes("/") && packageJson.name !== plugin.packageName) {
      throw new Error(`插件 package.json 名称不匹配：期望 ${plugin.packageName}，实际 ${packageJson.name}`);
    }
    if (await exists(target)) {
      try { await rename(target, old); }
      catch {
        // A third-party plugin may still be loaded by the running Harness.
        // Fall back to an in-place write instead of making restore fail just
        // because Windows cannot rename an open directory. This path leaves
        // files the archive does not carry in place, so the age guard applies.
        return await restoreEntries(entries, target, plugin.archive, filter, options);
      }
    }
    await rename(temp, target); replaced = true;
    await rm(old, { recursive: true, force: true });
    return count;
  } catch (error) {
    if (!replaced && await exists(old) && !await exists(target)) { try { await rename(old, target); } catch { /* preserve the original error */ } }
    throw error;
  } finally {
    await rm(temp, { recursive: true, force: true });
    if (replaced) await rm(old, { recursive: true, force: true });
  }
}

function replacePath(text: string, source: string, target: string) { const sourceForward = source.replace(/\\/g, "/"); const targetForward = target.replace(/\\/g, "/"); const escapedSource = source.replace(/\\/g, "\\\\"); const escapedTarget = target.replace(/\\/g, "\\\\"); return text.split(sourceForward).join(targetForward).split(escapedSource).join(escapedTarget).split(source).join(target); }
async function captureBootstrapSpecs(root: string): Promise<BootstrapSpec[]> {
  const result: BootstrapSpec[] = [];
  for (const profile of await listProfiles(root)) {
    for (const section of DEPENDENCY_SECTIONS) {
      const spec = profile.packageJson?.[section]?.[SELF_PACKAGE];
      if (typeof spec === "string") result.push({ profile: profile.name, section, spec });
    }
  }
  return result;
}
async function restoreBootstrapSpecs(root: string, specs: readonly BootstrapSpec[]) {
  for (const saved of specs) {
    const path = join(root, "profiles", saved.profile, "package.json"); const packageJson = await readJsonFile(path); if (!packageJson) continue;
    packageJson[saved.section] ||= {}; packageJson[saved.section][SELF_PACKAGE] = saved.spec; await writeFile(path, JSON.stringify(packageJson, null, 2) + "\n");
  }
}
async function rewriteProfilePaths(root: string, mappings: readonly PathMapping[]) {
  if (!mappings.length) return; const profilesRoot = join(root, "profiles"); const profiles = await readdir(profilesRoot, { withFileTypes: true }).catch(() => []);
  for (const profile of profiles) { if (!profile.isDirectory()) continue; const profileRoot = join(profilesRoot, profile.name); for (const file of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"]) { const path = join(profileRoot, file); if (!isTextConfig(path) || !(await exists(path))) continue; let text = await readFile(path, "utf8"); for (const mapping of mappings) text = replacePath(text, mapping.source, mapping.target); await writeFile(path, text); } }
}

/**
 * Re-declares plugins that were physically linked but never listed in the
 * profile's package.json. Without this a later `pnpm install` prunes the
 * junction and the restored plugin silently disappears again.
 */
async function ensurePluginDependencies(root: string, plugins: readonly LocalPlugin[], mappings: readonly PathMapping[]) {
  const added: string[] = []; const warnings: string[] = [];
  const targetOf = (source: string) => mappings.find((item) => normalizedPath(item.source) === normalizedPath(source))?.target || source;
  for (const plugin of plugins) {
    // Only plugins whose payload this backup owns: never edit the profile for a
    // plugin the user chose not to back up.
    if (plugin.status !== "packed") continue;
    for (const link of plugin.links) {
      if (link.declared) continue;
      const packagePath = join(root, "profiles", link.profile, "package.json");
      const packageJson = await readJsonFile(packagePath);
      if (!packageJson) continue;
      const declaredSomewhere = DEPENDENCY_SECTIONS.some((section) => typeof packageJson[section]?.[link.linkName] === "string");
      if (declaredSomewhere) continue;
      const target = targetOf(plugin.source);
      if (!await exists(target)) { warnings.push(`${link.profile}/${link.linkName}: 目标目录不存在，未写入依赖声明（${target}）`); continue; }
      const section: DependencySection = link.section || "dependencies";
      packageJson[section] ||= {};
      packageJson[section][link.linkName] = `link:${forwardPath(target)}`;
      await writeFile(packagePath, JSON.stringify(packageJson, null, 2) + "\n");
      added.push(`${link.profile}/${link.linkName}`);
    }
  }
  return { added, warnings };
}

/**
 * Node refuses to spawn `.cmd`/`.bat` shims directly on Windows (EINVAL), which
 * used to make every package-manager repair silently fail. Route them through
 * the command interpreter instead.
 */
async function runPackageManager(command: string, args: string[], cwd: string) {
  const options = { cwd, timeout: 180_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 };
  if (process.platform !== "win32" || !/\.(cmd|bat)$/i.test(command)) return execFileAsync(command, args, options);
  return execFileAsync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", command, ...args], options);
}

async function missingRuntimeDependencies(root: string) {
  const packageJson = await readJsonFile(join(root, "package.json"));
  if (!packageJson) return [];
  const missing: string[] = [];
  for (const dependency of dependencyNames(packageJson)) {
    if (!await exists(join(root, "node_modules", ...dependency.split("/"), "package.json"))) missing.push(dependency);
  }
  return missing;
}

async function repairExternalRuntimeDependencies(root: string, plugins: readonly LocalPlugin[], mappings: readonly PathMapping[]) {
  const repaired: string[] = []; const warnings: string[] = [];
  for (const plugin of plugins) {
    if (plugin.kind !== "directory" || plugin.bootstrap || plugin.status !== "packed") continue;
    const target = mappings.find((item) => normalizedPath(item.source) === normalizedPath(plugin.source))?.target || plugin.source;
    let missing = await missingRuntimeDependencies(target); if (!missing.length) continue;
    const attempts: Array<{ command: string; args: string[] }> = [
      { command: process.platform === "win32" ? "pnpm.cmd" : "pnpm", args: ["install", "--prod", "--no-frozen-lockfile", "--ignore-scripts", "--config.auto-install-peers=false"] },
      { command: process.platform === "win32" ? "npm.cmd" : "npm", args: ["install", "--omit=dev", "--ignore-scripts", "--no-package-lock", "--legacy-peer-deps"] },
    ];
    const errors: string[] = [];
    for (const attempt of attempts) {
      try {
        await runPackageManager(attempt.command, attempt.args, target);
        missing = await missingRuntimeDependencies(target);
        if (!missing.length) { repaired.push(plugin.packageName || target); break; }
      } catch (error: any) { errors.push(error?.shortMessage || error?.message || String(error)); }
    }
    if (missing.length) warnings.push(`${plugin.packageName || target}: 缺少运行依赖 ${missing.join(", ")}；自动安装失败${errors.length ? `（${errors.join(" | ")}）` : ""}`);
  }
  return { repaired, warnings };
}

async function reinstallProfiles(root: string) {
  const warnings: string[] = []; const installed: string[] = []; const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  for (const profile of await listProfiles(root)) {
    if (!profile.packageJson?.dsh?.profile) continue;
    try { await runPackageManager(command, ["install", "--no-frozen-lockfile"], profile.root); installed.push(profile.name); } catch (error: any) { warnings.push(`${profile.name}: ${error?.shortMessage || error?.message || String(error)}`); }
  }
  return { installed, warnings };
}

async function replaceLocalLink(linkPath: string, target: string, kind: "directory" | "file") {
  await mkdir(dirname(linkPath), { recursive: true });
  await rm(linkPath, { recursive: true, force: true });
  try {
    await symlink(target, linkPath, kind === "directory" ? "junction" : "file");
  } catch (error) {
    // A normal symlink is a useful fallback on systems where junctions are
    // unavailable. Do not silently leave the stale package directory behind.
    await rm(linkPath, { recursive: true, force: true });
    await symlink(target, linkPath);
  }
}

function dependencyLinkPath(profileRoot: string, packageName: string) {
  const linkPath = resolve(profileRoot, "node_modules", ...packageName.split("/"));
  const nodeModulesRoot = resolve(profileRoot, "node_modules");
  if (!isInside(nodeModulesRoot, linkPath)) throw new Error(`不安全的插件名称：${packageName}`);
  return linkPath;
}

/**
 * Recreates every plugin junction: both the recorded topology (format 4) and
 * the declared link:/file: specs that older backups relied on.
 */
async function ensureProfileLinks(root: string, plugins: readonly LocalPlugin[], mappings: readonly PathMapping[]) {
  const warnings: string[] = []; const linked: string[] = [];
  const targetOf = (source: string) => mappings.find((item) => normalizedPath(item.source) === normalizedPath(source))?.target || source;
  const request = new Map<string, { profile: string; packageName: string; target: string }>();
  const profileNames = new Set<string>();
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
    if (!await exists(target)) { if (plugin.status !== "skipped") warnings.push(`${plugin.packageName}: 找不到插件目录 ${target}`); continue; }
    for (const link of plugin.links) {
      if (!profileNames.has(link.profile)) continue;
      request.set(`${link.profile}|${link.linkName}`, { profile: link.profile, packageName: link.linkName, target: link.linkName === SELF_PACKAGE ? currentPluginRoot() : target });
    }
  }
  for (const item of request.values()) {
    const profileRoot = join(root, "profiles", item.profile);
    const info = await lstat(item.target).catch(() => undefined);
    if (!info) { warnings.push(`${item.profile}/${item.packageName}: 找不到本地插件目录 ${item.target}`); continue; }
    try {
      await replaceLocalLink(dependencyLinkPath(profileRoot, item.packageName), item.target, info.isDirectory() ? "directory" : "file");
      linked.push(`${item.profile}/${item.packageName}`);
    } catch (error) { warnings.push(`${item.profile}/${item.packageName}: 无法重新建立链接：${String(error)}`); }
  }
  return { linked, warnings };
}

/** Per-plugin post-restore verification reported to the settings page. */
async function validateRestore(root: string, plugins: readonly LocalPlugin[], mappings: readonly PathMapping[], restored: ReadonlyMap<string, number>) {
  const reports: RestorePluginReport[] = []; const warnings: string[] = [];
  const targetOf = (source: string) => mappings.find((item) => normalizedPath(item.source) === normalizedPath(source))?.target || source;
  for (const plugin of plugins) {
    const target = plugin.bootstrap ? currentPluginRoot() : targetOf(plugin.source);
    const relocated = normalizedPath(target) !== normalizedPath(plugin.source);
    const packageJson = await readJsonFile(join(target, "package.json"));
    const actualPath = await realpath(target).catch(() => undefined);
    const packageJsonMatches = !plugin.packageName || plugin.kind === "file" || packageJson?.name === plugin.packageName;
    const entryName = plugin.entry || packageJson?.main;
    const entryExists = Boolean(actualPath) && (!entryName || await exists(join(target, entryName)));
    const entryWasMissing = plugin.entryPresent === false && !entryExists;
    const links: RestorePluginReport["links"] = [];
    for (const link of plugin.links) {
      const linkPath = dependencyLinkPath(join(root, "profiles", link.profile), link.linkName);
      const linkTarget = await realpath(linkPath).catch(() => undefined);
      const ok = Boolean(linkTarget && actualPath && normalizedPath(linkTarget) === normalizedPath(actualPath));
      links.push({ profile: link.profile, linkName: link.linkName, linkPath, ok, message: ok ? undefined : `链接未指向插件目录（${linkPath}）` });
    }
    const failedLinks = links.filter((link) => !link.ok);
    let status: RestorePluginReport["status"];
    if (plugin.bootstrap) status = "preserved";
    else if (plugin.status === "missing") status = "missing";
    else if (plugin.status === "skipped") status = actualPath ? "skipped" : "missing";
    else if (!actualPath) status = "failed";
    else if (!packageJsonMatches || (!entryExists && !entryWasMissing) || failedLinks.length) status = "failed";
    else status = plugin.status === "inside-home" ? "inside-home" : "restored";
    const succeeded = status === "restored" || status === "inside-home" || status === "skipped";
    const message = status === "skipped"
      ? (actualPath ? (plugin.reason || "该插件未包含在本次备份中，本机原有目录已保留") : `该插件未勾选备份，且本机没有目录：${target}`)
      : succeeded
        ? (entryWasMissing ? `该插件在备份时就已经缺少入口文件 ${entryName}，已按原样恢复` : undefined)
        : [
          plugin.status === "missing" ? (plugin.reason || "备份中没有该插件的文件，无法恢复") : undefined,
          !actualPath ? `目录不存在：${target}` : undefined,
          !packageJsonMatches ? `package.json 名称不匹配：${packageJson?.name || "缺少 package.json"}` : undefined,
          !entryExists && !entryWasMissing ? `入口文件不存在：${entryName || "未声明入口"}` : undefined,
          failedLinks.length ? `profile 链接未指向插件目录：${failedLinks.map((link) => `${link.profile}/${link.linkName}`).join(", ")}` : undefined,
        ].filter(Boolean).join("；") || undefined;
    reports.push({ packageName: plugin.packageName, configuredPath: plugin.source, restoredPath: plugin.status === "missing" ? undefined : target, relocated, status, files: restored.get(normalizedPath(plugin.source)) || 0, links, packageJsonMatches, entryExists, message });
    if (status === "failed" && message) warnings.push(`${plugin.packageName}（${target}）：${message}`);
  }
  return { reports, warnings };
}

async function restoreBackup(encoded: string, force = false) {
  if (typeof encoded !== "string" || encoded.length < 16) throw fail("没有收到有效的 ZIP 备份", 400, "error.backup.archiveMissing");
  let archive: Uint8Array; try { archive = Buffer.from(encoded, "base64"); } catch { throw fail("备份内容不是有效的 Base64", 400, "error.backup.archiveInvalid"); }
  return restoreArchive(archive, force);
}

/**
 * Restores an already-decoded archive, whether it arrived by upload or from a backup record.
 *
 * Two safety rules apply, in this order:
 *  1. the state being replaced is snapshotted first, so the restore is reversible;
 *  2. a destination modified after the archive was created is left alone, so an
 *     old backup cannot roll back newer work. `force` turns rule 2 off (rule 1
 *     always runs).
 */
async function restoreArchive(archive: Uint8Array, force = false) {
  const entries = unzipSync(archive);
  const manifestEntry = entries.find(({ entry }) => entry.name === "manifest.json"); if (!manifestEntry) throw fail("这不是 dsh-helloai-bak 备份：缺少 manifest.json", 400, "error.backup.manifestMissing");
  let manifest: BackupManifest; try { manifest = JSON.parse(new TextDecoder().decode(manifestEntry.data)) as BackupManifest; } catch { throw fail("备份的 manifest.json 损坏", 400, "error.backup.manifestInvalid"); }
  if (manifest.plugin !== SELF_PACKAGE || ![1, 2, 3, 4].includes(manifest.format)) throw fail("备份版本不受支持", 400, "error.backup.versionUnsupported");
  const home = dshHome();
  // Rule 1: capture what we are about to overwrite.
  const preRestoreSnapshot = await writePreRestoreSnapshot();
  // Rule 2: an archive knows when it was taken, so anything modified later is
  // local work it never saw. A manifest without a usable timestamp disables the
  // guard rather than silently treating every file as stale.
  const backupTime = Date.parse(manifest.createdAt || "");
  const guardActive = !force && Number.isFinite(backupTime);
  const notOlderThan = guardActive ? backupTime : 0;
  const skippedNewer: string[] = [];
  let skippedNewerCount = 0;
  const onSkip = (relativeName: string) => { skippedNewerCount += 1; if (skippedNewer.length < 100) skippedNewer.push(relativeName); };
  const restoreOptions: RestoreOptions = { notOlderThan, onSkip };
  /** Archive contents by entry name, for the directory-level conflict check. */
  const archived = new Map(entries.map(({ entry, data }) => [entry.name, data] as const));

  const bootstrapSpecs = await captureBootstrapSpecs(home);
  const restoredHome = await restoreEntries(entries, home, "dsh-home", (relativeName) => isGeneratedPath(relativeName), restoreOptions);
  const plugins = pluginsFromManifest(manifest);
  const mappings: PathMapping[] = []; const restoredPaths = new Map<string, number>(); const used = new Set<string>();
  const preserved: string[] = []; const restoredPlugins: string[] = []; const relocatedPlugins: string[] = []; const missingPlugins: string[] = [];
  const skippedPlugins: string[] = [];
  /**
   * A plugin that threw while being written used to be pushed onto
   * `missingPlugins` ("not in this backup"), which made a genuine restore
   * failure read like a benign omission. Track it separately so the caller can
   * report a partial restore instead of success.
   */
  const failedPlugins: string[] = [];
  for (const plugin of plugins) {
    const choice = await chooseTarget(plugin, home, used);
    used.add(normalizedPath(choice.target));
    mappings.push({ source: plugin.source, target: choice.target });
    if (choice.preserved) { preserved.push(plugin.packageName); continue; }
    if (plugin.status === "missing") { missingPlugins.push(`${plugin.packageName}（原路径 ${plugin.source}）`); continue; }
    // Skipped by the user, or already delivered inside the dsh-home part.
    if (plugin.status === "skipped" || plugin.status === "inside-home") continue;
    try {
      // A directory plugin is replaced by rename, which the per-file guard never
      // sees; ask the same question about the directory as a whole first.
      if (notOlderThan > 0 && plugin.kind === "directory" && await exists(choice.target)) {
        const conflict = await firstConflictingEntry(choice.target, notOlderThan, archived, plugin.archive);
        if (conflict) {
          skippedPlugins.push(plugin.packageName);
          skippedNewerCount += 1;
          if (skippedNewer.length < 100) skippedNewer.push(`${plugin.packageName}/${conflict}`);
          plugin.status = "skipped";
          plugin.reason = "本地存在比备份更新的改动，本次未覆盖";
          continue;
        }
      }
      const count = await restorePluginPayload(entries, plugin, choice.target, restoreOptions);
      restoredPaths.set(normalizedPath(plugin.source), count);
      restoredPlugins.push(plugin.packageName);
      if (choice.relocated) relocatedPlugins.push(`${plugin.packageName} → ${choice.target}`);
    } catch (error) {
      plugin.status = "failed";
      plugin.reason = error instanceof Error ? error.message : String(error);
      failedPlugins.push(`${plugin.packageName}（${plugin.reason}）`);
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
    installWarnings,
  };
}

/* ------------------------------------------------------------------ *
 * HTTP surface
 * ------------------------------------------------------------------ */

type Route = { kind: string; path: string; handler: (req: IncomingMessage, res: ServerResponse) => unknown };

interface HostContext {
  webRuntime: { trustedHosts?: string[] };
  webServer: { register(route: Route): () => void; prefixes?: Map<string, unknown> };
  effect?(execute: () => () => void, label?: string): unknown;
  logger?: { warn?(message: unknown): void };
}

/**
 * Register the prefix route so the plugin fiber owns the disposer.
 *
 * `apply` is a plain function, so cordis builds it with `new` and reads only
 * `init`/`initHooks` from the result: a disposer merely *returned* by `apply` is
 * dropped. The route then outlived its fiber, and the next activation failed
 * with `webserver: duplicate prefix route`. An effect keeps the disposer on the
 * fiber, so disabling the plugin removes the route again.
 */
function registerRoute(ctx: HostContext, route: Route): () => void {
  try {
    return ctx.webServer.register(route);
  } catch (error) {
    // A route leaked by an older build is still in the live table with no fiber
    // behind it; replace it so this activation owns the registration and can
    // dispose it. Anything else is a real composition error and must surface.
    const table = ctx.webServer.prefixes;
    if (!(table instanceof Map) || !table.has(route.path)) throw error;
    table.delete(route.path);
    ctx.logger?.warn?.(`helloai-backup: 接管了上一次运行遗留的 API 路由 ${route.path}`);
    return ctx.webServer.register(route);
  }
}

/** Mount the route as a fiber effect, falling back for hosts without `effect`. */
function mountRoute(ctx: HostContext, route: Route): void {
  const mount = () => registerRoute(ctx, route);
  if (typeof ctx.effect === "function") ctx.effect(mount, "helloai-backup api route");
  else mount();
}

function apply(ctx: HostContext) {
  const trustedHosts = Array.isArray(ctx.webRuntime.trustedHosts) ? ctx.webRuntime.trustedHosts : [];
  mountRoute(ctx, { kind: "prefix", path: PREFIX, handler: async (req, res) => {
    const path = new URL(req.url || "/", "http://localhost").pathname.replace(/\/+$/, "");
    try {
      if (!requestAllowed(req, trustedHosts)) return json(res, 403, { ok: false, code: "error.backup.origin", error: "请求来源不受信任" });
      if (req.method === "GET" && path === `${PREFIX}/status`) {        const root = dshHome();
        const rootInfo = await stat(root).catch(() => undefined);
        let plugins: Awaited<ReturnType<typeof discoverPlugins>> = [];
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
            defaultSelected: plugin.status === "packed",
          })),
          pluginCount: plugins.length,
          packableCount: selectable.length,
        });
      }
      // Staged chunked download: what the settings page uses, because the Desktop
      // app relays responses through a custom protocol that cannot carry one
      // multi-megabyte body reliably.
      if (req.method === "POST" && path === `${PREFIX}/prepare`) {
        const body = await readBody(req);
        return json(res, 200, await prepareBackup({ include: Array.isArray(body.include) ? body.include.filter((item): item is string => typeof item === "string") : undefined }));
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
          "x-dsh-helloai-filename": chunk.filename,
        });
        return res.end(chunk.data);
      }
      // Backup history: the settings page lists these instead of leaving loose ZIPs around.
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
      if (req.method !== "POST") return json(res, 405, { ok: false, code: "error.backup.method", error: "只支持 GET/POST" });
      // Direct streaming stays available for plain HTTP clients (curl, tests) and
      // for older cached copies of the settings page.
      if (path === `${PREFIX}/backup`) {
        const body = await readBody(req);
        const result = await makeBackup({ include: Array.isArray(body.include) ? body.include.filter((item): item is string => typeof item === "string") : undefined });
        const packed = (result.manifest.plugins || []).filter((plugin) => plugin.status === "packed");
        res.writeHead(200, {
          "content-type": "application/zip",
          "content-disposition": `attachment; filename="${result.filename}"`,
          "content-length": result.archive.byteLength,
          "cache-control": "no-store",
          "x-dsh-helloai-plugins": String(packed.length),
          "x-dsh-helloai-skipped": String((result.manifest.plugins || []).filter((plugin) => plugin.status === "skipped").length),
        });
        return res.end(Buffer.from(result.archive));
      }
      if (path === `${PREFIX}/restore`) { const body = await readBody(req); return json(res, 200, responseForRestore(await restoreBackup(body.archive || "", body.force === true))); }
      return json(res, 404, { ok: false, code: "error.backup.notFound", error: "未知备份接口" });
    } catch (caught) { const error = caught as CodedError; return json(res, error.statusCode || 500, { ok: false, code: error.code || "error.backup.failed", error: error.message || String(error) }); }
  } });
}

export { apply, deleteBackupRecord, discoverPlugins, inject, listBackupRecords, makeBackup, name, prepareBackup, readBackupChunk, restoreBackup, restoreBackupRecord };
