import * as React from "react";

type Translate = (key: string, params?: Record<string, unknown>) => string;
type SectionProps = { t: Translate; close?: () => void };
type ClientContext = {
  effect: (effect: () => void | (() => void), label?: string) => unknown;
  locale: { register: (namespace: string, dictionary: Record<string, Record<string, string>>) => () => void; bind: (namespace: string) => Translate };
  slots: { inject: (name: string, factory: () => unknown) => unknown; register: (options: { name: string; id: string; order: number; label: () => string; icon: string; locale: string }, component: React.ComponentType<SectionProps>) => unknown };
};

type PluginLink = { profile: string; linkName: string; path: string; origin: string; declared: boolean; exists: boolean };
type PluginEntry = { packageName: string; source: string; kind: string; version?: string; status: string; reason?: string; bootstrap?: boolean; links: PluginLink[]; selectable?: boolean; defaultSelected?: boolean };
type Inventory = { dshHome: string; plugins: PluginEntry[]; pluginCount: number; packableCount: number };
type PluginReport = { packageName: string; configuredPath: string; restoredPath?: string; relocated: boolean; status: string; files: number; message?: string; links: Array<{ profile: string; linkName: string; ok: boolean; message?: string }> };
type RestoreReport = {
  restored: number;
  pluginsRestored: string[];
  pluginsPreserved: string[];
  pluginsMissing: string[];
  /** Plugins that threw while being written. Non-empty means a partial restore. */
  pluginsFailed: string[];
  pluginsRelocated: string[];
  addedPluginDependencies: string[];
  linkedPlugins: string[];
  reinstalledProfiles: string[];
  installWarnings: string[];
  restoreDiagnostics: PluginReport[];
  /** Written before anything was touched, so this restore can be rolled back. */
  preRestoreSnapshot?: { name: string; path: string; bytes: number };
  overwriteGuard?: "guard" | "forced" | "unguarded";
  /** Destinations the guard left alone because they postdate the archive. */
  skippedNewer?: string[];
  skippedNewerCount?: number;
  pluginsSkippedNewer?: string[];
};
type BackupRecord = {
  id: string;
  name: string;
  path: string;
  scope: string;
  size: number;
  modifiedAt: string;
  createdAt?: string;
  format?: number;
  plugins: string[];
  missing: number;
  restorable: boolean;
  note?: string;
};
type BackupState = { busy: boolean; message?: { kind: "success" | "error" | "warning"; text: string }; inventory?: Inventory; backups?: BackupRecord[]; report?: RestoreReport; scanned?: boolean };

const NS = "helloai-backup";
const API = "/api/dsh-helloai-bak";

/**
 * 插件版本号，由 `scripts/build.mjs` 在构建时从 package.json 注入 `define`。
 * `typeof` 守卫让没有注入 define 的场景（例如只跑 tsc 类型检查）退化成占位版本
 * 而不是抛 ReferenceError。
 */
declare const __HELLOAI_VERSION__: string;
const VERSION = typeof __HELLOAI_VERSION__ === "string" ? __HELLOAI_VERSION__ : "0.0.0";

const DICT = {
  zh: {
    title: "备份与恢复",
    desc: "一键迁移 DeepSeek Harness 的设置、.dsh 配置、技能、Agent 预设和本地插件。",
    versionLabel: "插件版本 · 构建时取自 package.json",
    backup: "备份全部配置",
    restore: "从 ZIP 恢复",
    rescan: "重新扫描插件",
    scanning: "正在扫描本地插件…",
    scanningBackups: "正在读取备份记录…",
    refresh: "刷新",
    history: "备份记录",
    historySummary: "共 {count} 份备份，可直接恢复或删除不需要的。",
    historyEmpty: "还没有备份记录。点击“备份全部配置”后会在这里生成一条记录。",
    historyPacked: "含 {count} 个插件",
    historyRestore: "恢复",
    historyDelete: "删除",
    historyDeleted: "已删除：{name}",
    historyUnreadable: "无法读取",
    confirmRestoreRecord: "将从这个备份记录恢复：{name}。会覆盖同名设置、凭据和插件目录并重建 profile 链接，当前运行的本插件会保留。确定继续吗？",
    confirmDeleteRecord: "确定删除这个备份文件吗？删除后无法恢复：{name}",
    backupHint: "生成当天日期命名的 ZIP 文件；下方勾选的插件会连同运行依赖一起打包。",
    restoreHint: "选择以前生成的 ZIP。插件会恢复回 ZIP 记录的原始目录；如果该目录在本机不可用，会自动落到 DSH_HOME/plugins 下并改写 profile 链接。当前正在运行的本插件不会被覆盖。",
    included: "备份内容",
    expand: "展开",
    collapse: "收起",
    includedText: "设置文件、凭据、技能、Agent 预设、任务板、profile 配置，以及每一个本地插件的完整功能文件、运行依赖和 node_modules 链接关系。",
    excluded: "profile 的大型 node_modules 和 pnpm 缓存不会整包复制；插件自身必需的生产依赖会随 ZIP 保存。聊天记录、附件、日志、语音模型和 DSH 内置运行时仍会排除。",
    secrets: "备份包含凭据等敏感信息，请只通过可信渠道保存和传输。",
    plugins: "本地插件",
    pluginsSummary: "共发现 {total} 个本地插件，其中 {packable} 个可打包，已勾选 {selected} 个。",
    pluginsEmpty: "没有发现本地插件。",
    pluginsHidden: "{count} 个插件的目录已不存在，无法备份（点击查看）",
    pluginsHideUnavailable: "收起无法备份的插件",
    selectAll: "全选",
    pluginLinks: "链接",
    statusPacked: "将打包",
    statusInsideHome: "随 .dsh 备份",
    statusSelf: "无需备份",
    statusSkipped: "未勾选",
    statusMissing: "目录缺失",
    workingBackup: "正在整理配置并打包插件…",
    workingDownload: "正在下载备份 {done}/{total} MB…",
    workingRestore: "正在恢复配置与插件…",
    backupDone: "备份已下载：{name}（已打包 {count} 个本地插件）\n已保存副本：{path}",
    savedTo: "备份文件已生成，可直接复制使用：{path}",
    restoreDone: "恢复完成，共写入 {count} 个文件/目录；插件：恢复 {restored} 个、保留 {preserved} 个、缺失 {missing} 个，校正 {links} 个链接。{extra}请重启 DeepSeek Harness。",
    restorePartial: "恢复已写入文件，但仍有未修复的项目：{warnings}。{extra}请按提示处理后再重启 DeepSeek Harness。",
    pluginsFailed: "有插件写入失败，本机只是部分恢复：{items}",
    reportTitle: "本次恢复结果",
    reportRestored: "已恢复",
    reportPreserved: "已保留",
    reportMissing: "缺失",
    reportFailed: "失败",
    reportSkipped: "未备份",
    reportRelocated: "已迁移路径",
    reportLinks: "{count} 个链接",
    reportAdded: "补齐依赖声明：{items}",
    restoreSkippedTitle: "以下内容比这份备份更新，已保留未覆盖",
    restoreSkippedMore: "另有 {count} 项未列出（共 {total} 项）",
    restoreSnapshot: "恢复前的自动快照",
    restoreSnapshotHint: "这次恢复可以用它回退。",
    restoreForce: "仍然全部覆盖",
    confirmForce: "忽略更新检查，用备份内容覆盖所有文件？比备份更新的改动会被抹掉。恢复前仍会自动存一份快照。",
    restoreForced: "已强制覆盖：写入 {count} 个文件/目录。",
    cancel: "取消",
    choose: "选择 ZIP 文件",
    invalid: "请选择 .zip 备份文件。",
    confirmRestore: "恢复会覆盖同名设置、凭据和插件目录，并重新建立 profile 链接。比这份备份更新的文件会被自动跳过并列出（可以再点“仍然全部覆盖”）；恢复前会先自动存一份快照，随时可回退。插件优先回到 ZIP 记录的原始目录；原目录不可用时改到 DSH_HOME/plugins。当前正在运行的备份插件会保留。确定继续吗？",
    failed: "操作失败：{error}",
    networkFailed: "无法连接备份服务：连接被中断或服务正在重启。备份插件重新生成后会短暂离线，请刷新页面后重试；如果仍然失败，请完全重启 DeepSeek Harness。",
    downloadStalled: "下载中断：服务器返回了空数据块。请重新生成备份。",
    needsRestart: "这份界面比正在运行的备份服务新：请重启 DeepSeek Harness 让 Host 侧插件一并更新，然后重新点击备份。",
  },
  en: {
    title: "Backup & Recovery",
    desc: "Migrate DeepSeek Harness settings, .dsh configuration, skills, agent presets and local plugins.",
    versionLabel: "Plugin version · taken from package.json at build time",
    backup: "Back up all configuration",
    restore: "Restore from ZIP",
    rescan: "Rescan plugins",
    scanning: "Scanning local plugins…",
    scanningBackups: "Reading backup history…",
    refresh: "Refresh",
    history: "Backup history",
    historySummary: "{count} backup(s); restore or delete any of them.",
    historyEmpty: "No backups yet. Click “Back up all configuration” and a record will appear here.",
    historyPacked: "{count} plugin(s)",
    historyRestore: "Restore",
    historyDelete: "Delete",
    historyDeleted: "Deleted: {name}",
    historyUnreadable: "Unreadable",
    confirmRestoreRecord: "Restore from this backup record: {name}? Matching settings, credentials and plugin directories are overwritten and profile links are rebuilt. The running backup plugin is preserved. Continue?",
    confirmDeleteRecord: "Delete this backup file? This cannot be undone: {name}",
    backupHint: "Downloads a date-named ZIP; the checked plugins are packed together with their runtime dependencies.",
    restoreHint: "Choose a ZIP created by this plugin. Plugins return to the directories recorded in the ZIP; when that directory is unavailable here the payload lands in DSH_HOME/plugins and the profile links are rewritten. The running backup plugin is preserved.",
    included: "Included",
    expand: "Show more",
    collapse: "Show less",
    includedText: "Settings, credentials, skills, agent presets, task board, profile configuration, and every local plugin's complete files, runtime dependencies and node_modules link topology.",
    excluded: "Large profile node_modules and pnpm caches are not copied wholesale; required production dependencies inside plugins are included. Chat history, attachments, logs, speech models and built-in DSH runtimes remain excluded.",
    secrets: "The archive contains credentials and other sensitive data. Store and transfer it only through trusted channels.",
    plugins: "Local plugins",
    pluginsSummary: "{total} local plugin(s) found, {packable} packable, {selected} selected.",
    pluginsEmpty: "No local plugins found.",
    pluginsHidden: "{count} plugin(s) whose directory is gone cannot be backed up (click to view)",
    pluginsHideUnavailable: "Hide unavailable plugins",
    selectAll: "Select all",
    pluginLinks: "Links",
    statusPacked: "Will be packed",
    statusInsideHome: "Inside .dsh backup",
    statusSelf: "No backup needed",
    statusSkipped: "Not selected",
    statusMissing: "Directory missing",
    workingBackup: "Collecting configuration and packing plugins…",
    workingDownload: "Downloading backup {done}/{total} MB…",
    workingRestore: "Restoring configuration and plugins…",
    backupDone: "Backup downloaded: {name} ({count} local plugin(s) packed)\nCopy saved to: {path}",
    savedTo: "The backup file was created; you can copy it directly from {path}",
    restoreDone: "Restore complete: {count} files/directories written; plugins restored {restored}, preserved {preserved}, missing {missing}, {links} link(s) corrected. {extra}Restart DeepSeek Harness.",
    restorePartial: "Restore wrote the files, but some items are still unresolved: {warnings}. {extra}Resolve them before restarting DeepSeek Harness.",
    pluginsFailed: "Some plugins failed to be written; this machine is only partly restored: {items}",
    reportTitle: "Restore result",
    reportRestored: "Restored",
    reportPreserved: "Preserved",
    reportMissing: "Missing",
    reportFailed: "Failed",
    reportSkipped: "Not backed up",
    reportRelocated: "Relocated",
    reportLinks: "{count} link(s)",
    reportAdded: "Re-declared dependencies: {items}",
    restoreSkippedTitle: "Newer than this backup — left untouched",
    restoreSkippedMore: "{count} more not listed (of {total})",
    restoreSnapshot: "Automatic pre-restore snapshot",
    restoreSnapshotHint: "This restore can be rolled back with it.",
    restoreForce: "Overwrite everything anyway",
    confirmForce: "Ignore the freshness check and overwrite every file from the backup? Work newer than the backup will be lost. A snapshot is still taken first.",
    restoreForced: "Forced overwrite complete: {count} files/directories written.",
    cancel: "Cancel",
    choose: "Choose ZIP file",
    invalid: "Please choose a .zip backup file.",
    confirmRestore: "Restore overwrites matching settings, credentials and plugin directories and rebuilds profile links. Files newer than this backup are skipped and listed (you can then choose “Overwrite everything anyway”); a snapshot is taken first so the restore stays reversible. Plugins return to the paths recorded in the ZIP; when unavailable they move to DSH_HOME/plugins. The running backup plugin is preserved. Continue?",
    failed: "Operation failed: {error}",
    networkFailed: "Cannot reach the backup service: the connection was interrupted or the service is restarting. A rebuilt backup plugin goes offline briefly — reload the page and retry, or fully restart DeepSeek Harness if it keeps failing.",
    downloadStalled: "Download interrupted: the server returned an empty chunk. Please generate the backup again.",
    needsRestart: "This page is newer than the running backup service. Restart DeepSeek Harness so the host plugin updates too, then click backup again.",
  },
};

function message(t: Translate, key: string, params: Record<string, unknown> = {}) {
  let text = t(key, params);
  for (const [name, value] of Object.entries(params)) text = text.replace(`{${name}}`, String(value));
  return text;
}
function errorText(value: unknown) { return value instanceof Error ? value.message : String(value); }
/**
 * A host plugin reload (file watcher / HMR) or a harness restart drops in-flight
 * requests, which the browser surfaces as `TypeError: Failed to fetch`. Those are
 * transient, so retry briefly and report something actionable when they persist.
 */
const RETRY_DELAYS = [400, 1200, 2500];
/**
 * A mutation must never be replayed: `/prepare` writes a fresh archive and a new
 * token on every call, so one lost response would leave a second orphan ZIP in
 * `$DSH_HOME/backups/` that only the history list can explain. `/restore`,
 * `/backups/restore` and `/backups/delete` are destructive for the same reason.
 * Only these reads are safe to retry: `/status`, `/backups` and the chunked
 * `/download` (which carries an explicit offset, so a retry resumes a no-op).
 */
function isRetryableRead(url: string) {
  return /\/(status|backups)(\?|$)/.test(url) || url.includes("/download?");
}
async function fetchWithRetry(t: Translate, url: string, init: RequestInit, retryable = isRetryableRead(url)) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(url, init);
      if (retryable && attempt < RETRY_DELAYS.length && response.status >= 502 && response.status <= 504) {
        await new Promise((resolve) => window.setTimeout(resolve, RETRY_DELAYS[attempt]));
        continue;
      }
      return response;
    } catch (error) {
      // A dropped connection may have reached the server and been applied, so a
      // mutation surfaces the failure instead of risking a double apply.
      if (!retryable || attempt >= RETRY_DELAYS.length) throw new Error(t("networkFailed"));
      console.warn("[dsh-helloai-bak] request failed, retrying", url.split("?")[0], error);
      await new Promise((resolve) => window.setTimeout(resolve, RETRY_DELAYS[attempt]));
    }
  }
}
function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a"); anchor.href = url; anchor.download = filename; anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
}
async function asBase64(file: File) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) binary += String.fromCharCode(...bytes.subarray(index, Math.min(index + chunk, bytes.length)));
  return btoa(binary);
}
function statusLabel(t: Translate, status: string) {
  if (status === "packed") return t("statusPacked");
  if (status === "inside-home") return t("statusInsideHome");
  if (status === "self") return t("statusSelf");
  if (status === "skipped") return t("statusSkipped");
  return t("statusMissing");
}
function statusClass(status: string) { return status === "packed" ? "ok" : status === "inside-home" || status === "self" ? "info" : status === "skipped" ? "muted" : "warn"; }
function formatSize(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";
  return bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
function formatTime(value?: string) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** The backup history: every archive on disk, with restore and delete per row. */
function BackupHistory({ t, backups, busy, onRestore, onDelete, onRefresh }: {
  t: Translate;
  backups?: BackupRecord[];
  busy: boolean;
  onRestore: (record: BackupRecord) => void;
  onDelete: (record: BackupRecord) => void;
  onRefresh: () => void;
}) {
  if (!backups) return null;
  return React.createElement("div", { className: "dsh-helloai-card" },
    React.createElement("div", { className: "dsh-helloai-plugin-title" },
      React.createElement("div", { className: "dsh-helloai-card-title" }, `🗂 ${t("history")}`),
      React.createElement("button", { type: "button", className: "dsh-helloai-btn dsh-helloai-ghost dsh-helloai-small", onClick: onRefresh, disabled: busy }, `⟳ ${t("refresh")}`),
    ),
    React.createElement("p", { className: "dsh-helloai-muted" }, backups.length ? message(t, "historySummary", { count: backups.length }) : t("historyEmpty")),
    backups.length ? React.createElement("ul", { className: "dsh-helloai-plugins" }, backups.map((record) => React.createElement("li", { key: record.id },
      React.createElement("div", { className: "dsh-helloai-plugin-head" },
        React.createElement("span", { className: "dsh-helloai-plugin-name" }, record.name),
        React.createElement("span", { className: "dsh-helloai-plugin-version" }, formatSize(record.size)),
        React.createElement("span", { className: "dsh-helloai-plugin-version" }, formatTime(record.createdAt || record.modifiedAt)),
        React.createElement("span", { className: `dsh-helloai-chip ${record.restorable ? "ok" : "warn"}` }, record.restorable ? message(t, "historyPacked", { count: record.plugins.length }) : (record.note || t("historyUnreadable"))),
      ),
      record.plugins.length ? React.createElement("div", { className: "dsh-helloai-plugin-links" }, `${t("plugins")}: ${record.plugins.join("，")}`) : null,
      React.createElement("div", { className: "dsh-helloai-plugin-actions" },
        React.createElement("button", { type: "button", className: "dsh-helloai-btn dsh-helloai-small", disabled: busy || !record.restorable, onClick: () => onRestore(record) }, `↩ ${t("historyRestore")}`),
        React.createElement("button", { type: "button", className: "dsh-helloai-btn dsh-helloai-ghost dsh-helloai-small dsh-helloai-danger", disabled: busy, onClick: () => onDelete(record) }, `🗑 ${t("historyDelete")}`),
      ),
      React.createElement("div", { className: "dsh-helloai-plugin-path" }, record.path),
    ))) : null,
  );
}


function PluginList({ t, inventory, selected, onToggle, onToggleAll, hiddenOpen, onToggleHidden }: {
  t: Translate;
  inventory?: Inventory;
  selected: Set<string>;
  onToggle: (source: string, checked: boolean) => void;
  onToggleAll: (checked: boolean) => void;
  hiddenOpen: boolean;
  onToggleHidden: () => void;
}) {
  if (!inventory) return null;
  const plugins = Array.isArray(inventory.plugins) ? inventory.plugins : [];
  const selectable = plugins.filter((plugin) => plugin.selectable);
  const selectedCount = selectable.filter((plugin) => selected.has(plugin.source)).length;
  const allSelected = selectable.length > 0 && selectedCount === selectable.length;
  // Plugins whose directory is gone cannot be backed up, so they stay out of the
  // list unless the user explicitly asks to see them.
  const hidden = plugins.filter((plugin) => plugin.status === "missing");
  const visible = hiddenOpen ? plugins : plugins.filter((plugin) => plugin.status !== "missing");
  return React.createElement("div", { className: "dsh-helloai-card" },
    React.createElement("div", { className: "dsh-helloai-plugin-title" },
      React.createElement("div", { className: "dsh-helloai-card-title" }, `🧩 ${t("plugins")}`),
      selectable.length ? React.createElement("label", { className: "dsh-helloai-selectall" },
        React.createElement("input", { type: "checkbox", checked: allSelected, onChange: (event: React.ChangeEvent<HTMLInputElement>) => onToggleAll(event.target.checked) }),
        t("selectAll"),
      ) : null,
    ),
    React.createElement("p", { className: "dsh-helloai-muted" }, plugins.length ? message(t, "pluginsSummary", { total: inventory.pluginCount, packable: inventory.packableCount, selected: selectedCount }) : t("pluginsEmpty")),
    visible.length ? React.createElement("ul", { className: "dsh-helloai-plugins" }, visible.map((plugin, index) => React.createElement("li", { key: `${plugin.packageName}-${index}`, className: plugin.selectable && selected.has(plugin.source) ? "selected" : undefined },
      React.createElement("div", { className: "dsh-helloai-plugin-head" },
        plugin.selectable
          ? React.createElement("input", { type: "checkbox", className: "dsh-helloai-plugin-check", checked: selected.has(plugin.source), onChange: (event: React.ChangeEvent<HTMLInputElement>) => onToggle(plugin.source, event.target.checked), "aria-label": plugin.packageName })
          : React.createElement("input", { type: "checkbox", className: "dsh-helloai-plugin-check", checked: false, disabled: true, title: plugin.reason || "", "aria-label": plugin.packageName }),
        React.createElement("span", { className: "dsh-helloai-plugin-name" }, plugin.packageName),
        plugin.version ? React.createElement("span", { className: "dsh-helloai-plugin-version" }, `v${plugin.version}`) : null,
        React.createElement("span", { className: `dsh-helloai-chip ${statusClass(plugin.status)}` }, statusLabel(t, plugin.status)),
      ),
      React.createElement("div", { className: "dsh-helloai-plugin-path" }, plugin.source),
      plugin.links?.length ? React.createElement("div", { className: "dsh-helloai-plugin-links" }, `${t("pluginLinks")}: ${plugin.links.map((link) => `${link.profile}/${link.linkName}${link.declared ? "" : " *"}`).join("，")}`) : null,
      plugin.reason ? React.createElement("div", { className: "dsh-helloai-plugin-reason" }, plugin.reason) : null,
    ))) : null,
    hidden.length && !hiddenOpen ? React.createElement("button", { type: "button", className: "dsh-helloai-more", onClick: onToggleHidden }, message(t, "pluginsHidden", { count: hidden.length })) : null,
    hiddenOpen && hidden.length ? React.createElement("button", { type: "button", className: "dsh-helloai-more", onClick: onToggleHidden }, t("pluginsHideUnavailable")) : null,
  );
}

function RestoreReportCard({ t, report, busy, onForce }: { t: Translate; report?: RestoreReport; busy: boolean; onForce: () => void }) {
  if (!report || !Array.isArray(report.restoreDiagnostics) || !report.restoreDiagnostics.length) return null;
  const labelFor = (status: string) => status === "restored" ? t("reportRestored") : status === "preserved" ? t("reportPreserved") : status === "inside-home" ? t("statusInsideHome") : status === "skipped" ? t("reportSkipped") : status === "missing" ? t("reportMissing") : t("reportFailed");
  const classFor = (status: string) => status === "restored" ? "ok" : status === "preserved" || status === "inside-home" ? "info" : status === "skipped" ? "muted" : "warn";
  const added = report.addedPluginDependencies || [];
  const skipped = report.skippedNewer || [];
  const skippedTotal = report.skippedNewerCount || skipped.length;
  const snapshot = report.preRestoreSnapshot;
  return React.createElement("div", { className: "dsh-helloai-card" },
    React.createElement("div", { className: "dsh-helloai-card-title" }, `📋 ${t("reportTitle")}`),
    snapshot ? React.createElement("p", { className: "dsh-helloai-muted" }, `${t("restoreSnapshot")}：${snapshot.name} · ${formatSize(snapshot.bytes)}`) : null,
    snapshot ? React.createElement("p", { className: "dsh-helloai-muted" }, t("restoreSnapshotHint")) : null,
    // The guard is the whole point of this card: say plainly what was left alone.
    skippedTotal ? React.createElement("div", { className: "dsh-helloai-warning" },
      React.createElement("div", null, `⚠ ${t("restoreSkippedTitle")}`),
      React.createElement("ul", { className: "dsh-helloai-skipped" }, skipped.map((name) => React.createElement("li", { key: name }, name))),
      skippedTotal > skipped.length ? React.createElement("div", null, message(t, "restoreSkippedMore", { count: skippedTotal - skipped.length, total: skippedTotal })) : null,
      report.overwriteGuard === "guard" ? React.createElement("button", { type: "button", className: "dsh-helloai-btn dsh-helloai-small", disabled: busy, onClick: onForce }, `⚠ ${t("restoreForce")}`) : null,
    ) : null,
    React.createElement("ul", { className: "dsh-helloai-plugins" }, report.restoreDiagnostics.map((item, index) => React.createElement("li", { key: `${item.packageName}-${index}` },
      React.createElement("div", { className: "dsh-helloai-plugin-head" },
        React.createElement("span", { className: "dsh-helloai-plugin-name" }, item.packageName),
        React.createElement("span", { className: `dsh-helloai-chip ${classFor(item.status)}` }, labelFor(item.status)),
        item.files ? React.createElement("span", { className: "dsh-helloai-plugin-version" }, `${item.files} files`) : null,
        item.links?.length ? React.createElement("span", { className: "dsh-helloai-plugin-version" }, message(t, "reportLinks", { count: item.links.length })) : null,
      ),
      React.createElement("div", { className: "dsh-helloai-plugin-path" }, item.relocated && item.restoredPath ? `${item.configuredPath} → ${item.restoredPath}` : (item.restoredPath || item.configuredPath)),
      item.message ? React.createElement("div", { className: "dsh-helloai-plugin-reason" }, item.message) : null,
    ))),
    added.length ? React.createElement("p", { className: "dsh-helloai-muted" }, message(t, "reportAdded", { items: added.join("，") })) : null,
  );
}

function BackupSection({ t }: SectionProps) {
  const [state, setState] = React.useState<BackupState>({ busy: false });
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [helpOpen, setHelpOpen] = React.useState(false);
  const [showMissing, setShowMissing] = React.useState(false);
  const selectionTouched = React.useRef(false);
  const inputRef = React.useRef<HTMLInputElement>(null);
  /**
   * Re-entrancy guard for the mutating flows. `state.busy` only disables the
   * button after React has re-rendered, so two clicks inside the same batch both
   * pass that check: without this flag a fast double click on "备份全部配置"
   * issues two POST /prepare calls, leaving two archives on disk, two download
   * dialogs and one visible message. A ref flips synchronously in the same tick.
   */
  const running = React.useRef(false);
  /**
   * Wraps a mutating flow so two invocations in the same tick cannot both run.
   * `busy` is still set for the UI; this flag is the actual gate.
   */
  const guarded = React.useCallback(<A extends unknown[]>(flow: (...args: A) => Promise<void>) => async (...args: A): Promise<void> => {
    if (running.current) return;
    running.current = true;
    try { await flow(...args); } finally { running.current = false; }
  }, []);
  /** The last restore request, so "overwrite anyway" can repeat it with force. */
  const lastRestore = React.useRef<{ archive?: string; id?: string } | undefined>(undefined);
  const loadInventory = React.useCallback(async (announce = false) => {
    setState((previous) => ({ ...previous, busy: true, message: announce ? { kind: "warning", text: t("scanning") } : previous.message }));
    try {
      const response = await fetchWithRetry(t, `${API}/status`, { headers: { "x-dsh-helloai-bak": "1" } });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body.ok === false) throw new Error(body.error || `HTTP ${response.status}`);
      const inventory = body as Inventory;
      // Default the checklist to every packable plugin, but never overwrite a
      // selection the user already made in this session.
      if (!selectionTouched.current) setSelected(new Set((inventory.plugins || []).filter((plugin) => plugin.defaultSelected ?? plugin.selectable).map((plugin) => plugin.source)));
      setState((previous) => ({ ...previous, busy: false, scanned: true, inventory, message: announce ? undefined : previous.message }));
    } catch (error) { setState((previous) => ({ ...previous, busy: false, scanned: true, message: { kind: "error", text: message(t, "failed", { error: errorText(error) }) } })); }
  }, [t]);
  const loadBackups = React.useCallback(async (announce = false) => {
    if (announce) setState((previous) => ({ ...previous, busy: true, message: { kind: "warning", text: t("scanningBackups") } }));
    try {
      const response = await fetchWithRetry(t, `${API}/backups`, { headers: { "x-dsh-helloai-bak": "1" } });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body.ok === false) throw new Error(body.error || `HTTP ${response.status}`);
      setState((previous) => ({ ...previous, busy: false, backups: Array.isArray(body.backups) ? body.backups : [], message: announce ? undefined : previous.message }));
    } catch (error) { setState((previous) => ({ ...previous, busy: false, message: { kind: "error", text: message(t, "failed", { error: errorText(error) }) } })); }
  }, [t]);
  const finishRestore = React.useCallback((body: any) => {
    const failed = Array.isArray(body.pluginsFailed) ? body.pluginsFailed : [];
    // A plugin that failed to be written is not a "missing from the backup" note:
    // it means the machine is only partly restored, so surface it as a warning.
    const warnings = failed.length ? [message(t, "pluginsFailed", { items: failed.join("; ") }), ...(Array.isArray(body.installWarnings) ? body.installWarnings : [])] : (Array.isArray(body.installWarnings) ? body.installWarnings : []);
    const report: RestoreReport = {
      restored: body.restored || 0,
      pluginsRestored: body.pluginsRestored || [],
      pluginsPreserved: body.pluginsPreserved || [],
      pluginsMissing: body.pluginsMissing || [],
      pluginsFailed: body.pluginsFailed || [],
      pluginsRelocated: body.pluginsRelocated || [],
      addedPluginDependencies: body.addedPluginDependencies || [],
      linkedPlugins: body.linkedPlugins || [],
      reinstalledProfiles: body.reinstalledProfiles || [],
      installWarnings: warnings,
      restoreDiagnostics: body.restoreDiagnostics || [],
      preRestoreSnapshot: body.preRestoreSnapshot,
      overwriteGuard: body.overwriteGuard,
      skippedNewer: body.skippedNewer || [],
      skippedNewerCount: body.skippedNewerCount || 0,
      pluginsSkippedNewer: body.pluginsSkippedNewer || [],
    };
    const extra = report.pluginsRelocated.length ? `${t("reportRelocated")}: ${report.pluginsRelocated.join("; ")}\n` : "";
    setState((previous) => ({ ...previous, busy: false, report, message: { kind: warnings.length ? "warning" : "success", text: message(t, warnings.length ? "restorePartial" : "restoreDone", { count: report.restored, restored: report.pluginsRestored.length, preserved: report.pluginsPreserved.length, missing: report.pluginsMissing.length, links: report.linkedPlugins.length || report.reinstalledProfiles.length, warnings: warnings.join("; "), extra }) } }));
    void loadInventory();
    void loadBackups();
  }, [t, loadInventory, loadBackups]);
  /** One restore, guarded or forced; `force` turns the freshness check off. */
  const submitRestore = React.useCallback(guarded(async (request: { archive?: string; id?: string }, force: boolean) => {
    setState((previous) => ({ ...previous, busy: true, report: undefined, message: { kind: "warning", text: t("workingRestore") } }));
    try {
      const url = request.id ? `${API}/backups/restore` : `${API}/restore`;
      const response = await fetchWithRetry(t, url, { method: "POST", headers: { "content-type": "application/json", "x-dsh-helloai-bak": "1" }, body: JSON.stringify({ ...request, force }) });
      const body = await response.json().catch(() => ({}));
      // A partial restore is still a result worth rendering: it lists which
      // plugins failed and names the pre-restore snapshot, which a thrown error
      // would hide behind a one-line message.
      const partial = body.ok === false && body.partial === true;
      if ((!response.ok || body.ok === false) && !partial) throw new Error(body.error || `HTTP ${response.status}`);
      finishRestore(body);
      if (force) setState((previous) => ({ ...previous, message: { kind: "warning", text: message(t, "restoreForced", { count: body.restored || 0 }) } }));
    } catch (error) { setState((previous) => ({ ...previous, busy: false, message: { kind: "error", text: message(t, "failed", { error: errorText(error) }) } })); }
  }), [t, finishRestore, guarded]);
  const scanned = React.useRef(false);
  React.useEffect(() => {
    if (scanned.current) return;
    scanned.current = true;
    void loadInventory(true);
    void loadBackups();
  }, [loadInventory, loadBackups]);
  const togglePlugin = React.useCallback((source: string, checked: boolean) => {
    selectionTouched.current = true;
    setSelected((previous) => { const next = new Set(previous); if (checked) next.add(source); else next.delete(source); return next; });
  }, []);
  const toggleAll = React.useCallback((checked: boolean) => {
    selectionTouched.current = true;
    setSelected(checked ? new Set((state.inventory?.plugins || []).filter((plugin) => plugin.selectable).map((plugin) => plugin.source)) : new Set());
  }, [state.inventory]);

  const runBackup = React.useCallback(guarded(async () => {
    setState((previous) => ({ ...previous, busy: true, message: { kind: "warning", text: t("workingBackup") } }));
    let staged: { token: string; filename: string; path: string; size: number; chunkSize: number; plugins: string[] } | undefined;
    try {
      const include = (state.inventory?.plugins || []).filter((plugin) => plugin.selectable && selected.has(plugin.source)).map((plugin) => plugin.source);
      const prepared = await fetchWithRetry(t, `${API}/prepare`, { method: "POST", headers: { "content-type": "application/json", "x-dsh-helloai-bak": "1" }, body: JSON.stringify({ include }) });
      // A page refresh can pick up this client before the host plugin itself is
      // reloaded; say so plainly instead of reporting a bare 404.
      if (prepared.status === 404) throw new Error(t("needsRestart"));
      const info = await prepared.json().catch(() => ({}));
      if (!prepared.ok || info.ok === false) throw new Error(info.error || `HTTP ${prepared.status}`);
      staged = info;
      // Fetch the staged archive in small pieces; the Desktop protocol bridge
      // cannot deliver one multi-megabyte body, but handles small ones reliably.
      const chunkSize = typeof info.chunkSize === "number" && info.chunkSize > 0 ? info.chunkSize : 4 * 1024 * 1024;
      const parts: BlobPart[] = [];
      for (let offset = 0; offset < info.size; offset += chunkSize) {
        setState((previous) => ({ ...previous, busy: true, message: { kind: "warning", text: message(t, "workingDownload", { done: Math.round(offset / 1048576), total: Math.round(info.size / 1048576) }) } }));
        const chunk = await fetchWithRetry(t, `${API}/download?token=${encodeURIComponent(info.token)}&offset=${offset}&length=${chunkSize}`, { headers: { "x-dsh-helloai-bak": "1" } });
        if (!chunk.ok) { const body = await chunk.json().catch(() => ({})); throw new Error(body.error || `HTTP ${chunk.status}`); }
        const buffer = await chunk.arrayBuffer();
        if (!buffer.byteLength) throw new Error(t("downloadStalled"));
        parts.push(buffer);
      }
      downloadBlob(new Blob(parts, { type: "application/zip" }), info.filename);
      setState((previous) => ({ ...previous, busy: false, message: { kind: "success", text: message(t, "backupDone", { name: info.filename, count: info.plugins.length, path: info.path }) } }));
      void loadInventory();
    } catch (error) {
      // The archive is already on disk, so report where to pick it up instead of
      // leaving the user with nothing but an error.
      const saved = staged ? `\n${message(t, "savedTo", { path: staged.path })}` : "";
      setState((previous) => ({ ...previous, busy: false, message: { kind: "error", text: `${message(t, "failed", { error: errorText(error) })}${saved}` } }));
    }
  }), [t, selected, state.inventory, loadInventory, guarded]);
  const runRestore = async (file: File | undefined) => {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".zip")) { setState((previous) => ({ ...previous, busy: false, message: { kind: "error", text: t("invalid") } })); return; }
    if (!window.confirm(t("confirmRestore"))) return;
    try {
      const archive = await asBase64(file);
      lastRestore.current = { archive };
      await submitRestore({ archive }, false);
    } finally { if (inputRef.current) inputRef.current.value = ""; }
  };

  const restoreFromRecord = async (record: BackupRecord) => {
    if (!window.confirm(message(t, "confirmRestoreRecord", { name: record.name }))) return;
    lastRestore.current = { id: record.id };
    await submitRestore({ id: record.id }, false);
  };

  /** Repeat the last restore with the freshness check switched off. */
  const forceRestore = async () => {
    if (!lastRestore.current) return;
    if (!window.confirm(t("confirmForce"))) return;
    await submitRestore(lastRestore.current, true);
  };
  const deleteRecord = React.useCallback(guarded(async (record: BackupRecord) => {
    if (!window.confirm(message(t, "confirmDeleteRecord", { name: record.name }))) return;
    setState((previous) => ({ ...previous, busy: true }));
    try {
      const response = await fetchWithRetry(t, `${API}/backups/delete`, { method: "POST", headers: { "content-type": "application/json", "x-dsh-helloai-bak": "1" }, body: JSON.stringify({ id: record.id }) });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body.ok === false) throw new Error(body.error || `HTTP ${response.status}`);
      setState((previous) => ({ ...previous, busy: false, backups: Array.isArray(body.backups) ? body.backups : previous.backups, message: { kind: "success", text: message(t, "historyDeleted", { name: body.deleted || record.name }) } }));
    } catch (error) { setState((previous) => ({ ...previous, busy: false, message: { kind: "error", text: message(t, "failed", { error: errorText(error) }) } })); }
  }), [t, guarded]);

  return React.createElement("section", { className: "dsh-helloai-backup" },
    React.createElement("style", null, CSS),
    React.createElement("div", { className: "dsh-helloai-head" },
      React.createElement("div", null,
        React.createElement("div", { className: "dsh-helloai-kicker" }, "HELLOAI | BACKUP & RECOVERY"),
        React.createElement("h2", { className: "dsh-helloai-title" },
          React.createElement("span", { className: "dsh-helloai-title-text" }, t("title")),
          React.createElement("span", { className: "dsh-helloai-version", title: t("versionLabel") }, `V${VERSION}`)),
        React.createElement("p", null, t("desc"))),
      React.createElement("div", { className: "dsh-helloai-actions" },
        React.createElement("button", { type: "button", className: "dsh-helloai-btn dsh-helloai-primary", onClick: runBackup, disabled: state.busy },
          React.createElement("span", { className: "dsh-helloai-btn-accent-label" }, `⬇ ${t("backup")}`)),
        React.createElement("button", { type: "button", className: "dsh-helloai-btn", onClick: () => inputRef.current?.click(), disabled: state.busy },
          React.createElement("span", { className: "dsh-helloai-btn-accent-label" }, `⬆ ${t("restore")}`)),
        React.createElement("button", { type: "button", className: "dsh-helloai-btn dsh-helloai-ghost", onClick: () => void loadInventory(true), disabled: state.busy }, `⟳ ${t("rescan")}`),        React.createElement("input", { ref: inputRef, type: "file", accept: ".zip,application/zip", hidden: true, onChange: (event: React.ChangeEvent<HTMLInputElement>) => void runRestore(event.target.files?.[0]) }),
      ),
    ),
    React.createElement("div", { className: "dsh-helloai-card" },
      React.createElement("button", { type: "button", className: "dsh-helloai-card-toggle", "aria-expanded": helpOpen, onClick: () => setHelpOpen((open) => !open) },
        React.createElement("span", { className: "dsh-helloai-card-title" }, `▣ ${t("included")}`),
        React.createElement("span", { className: "dsh-helloai-card-chevron" }, helpOpen ? `▾ ${t("collapse")}` : `▸ ${t("expand")}`),
      ),
      React.createElement("p", null, t("includedText")),
      helpOpen ? React.createElement("div", null,
        React.createElement("p", { className: "dsh-helloai-muted" }, t("excluded")),
        React.createElement("p", { className: "dsh-helloai-muted" }, t("backupHint")),
        React.createElement("p", { className: "dsh-helloai-muted" }, t("restoreHint")),
      ) : null,
    ),
    React.createElement(PluginList, { t, inventory: state.inventory, selected, onToggle: togglePlugin, onToggleAll: toggleAll, hiddenOpen: showMissing, onToggleHidden: () => setShowMissing((open) => !open) }),
    React.createElement(BackupHistory, { t, backups: state.backups, busy: state.busy, onRestore: (record) => void restoreFromRecord(record), onDelete: (record) => void deleteRecord(record), onRefresh: () => void loadBackups(true) }),
    React.createElement("div", { className: "dsh-helloai-warning" }, `⚠ ${t("secrets")}`),
    state.message ? React.createElement("div", { className: `dsh-helloai-message ${state.message.kind}` }, state.message.text) : null,
    React.createElement(RestoreReportCard, { t, report: state.report, busy: state.busy, onForce: () => void forceRestore() }),
  );
}

const CSS = `
.dsh-helloai-backup{--dsh-helloai-accent:var(--dsw-alias-link,#4176e6);--dsh-helloai-accent-fill:var(--dsw-alias-button-info-fill,var(--dsh-helloai-accent));--dsh-helloai-accent-hover:var(--dsw-alias-button-info-hover,var(--dsh-helloai-accent));--dsh-helloai-accent-on:var(--dsw-alias-toast-label,#fff);--dsh-helloai-accent-soft:color-mix(in srgb,var(--dsh-helloai-accent) 14%,transparent);--dsh-helloai-accent-line:color-mix(in srgb,var(--dsh-helloai-accent) 45%,transparent);container-type:inline-size;color:var(--dsw-alias-label-primary);font-size:14px}
.dsh-helloai-head{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;margin-bottom:18px}
.dsh-helloai-head h2{display:flex;align-items:baseline;gap:8px;margin:0 0 7px;font-size:18px;font-weight:650}.dsh-helloai-head p{margin:0;color:var(--dsw-alias-label-secondary);line-height:1.6}
/* 标题右上角的版本角标：贴着标题文字的上沿，主题换色时跟着 accent 走。 */
.dsh-helloai-version{align-self:flex-start;flex:none;border:1px solid var(--dsh-helloai-accent-line);border-radius:999px;background:var(--dsh-helloai-accent-soft);color:var(--dsh-helloai-accent);font-size:10px;font-weight:700;letter-spacing:.06em;line-height:15px;padding:0 6px;font-variant-numeric:tabular-nums;white-space:nowrap}
.dsh-helloai-kicker{font-size:11px;color:var(--dsw-alias-label-tertiary);letter-spacing:.08em;text-transform:uppercase;margin-bottom:3px}
/* accent 实心按钮上的字固定用白：填充色是品牌蓝（暗色主题下是浅蓝 #7aaaff），
   配白字；不能跟着 --dsw-alias-label-primary-foreground 走——那个 token 在暗色主题里
   解析成近黑 #0f1115（它描述的是「跟 label-primary 相反」，是给白底按钮用的），
   放在蓝底上就是黑字。--dsh-helloai-accent-on 兜底白，再用 !important 钉死字色。 */
.dsh-helloai-btn-accent-label{color:var(--dsh-helloai-accent-on,#fff)!important}
.dsh-helloai-actions{display:flex;flex-wrap:wrap;gap:10px;justify-content:flex-end;min-width:max-content}.dsh-helloai-btn{border:1px solid var(--dsh-helloai-accent-fill);border-radius:8px;background:var(--dsh-helloai-accent-fill);color:var(--dsh-helloai-accent-on);font-weight:600;padding:9px 14px;cursor:pointer;box-shadow:0 1px 2px color-mix(in srgb,var(--dsh-helloai-accent) 32%,transparent);transition:background .15s,border-color .15s,box-shadow .15s,transform .15s}.dsh-helloai-btn:hover:not(:disabled){background:var(--dsh-helloai-accent-hover);border-color:var(--dsh-helloai-accent-hover);box-shadow:0 2px 8px color-mix(in srgb,var(--dsh-helloai-accent) 30%,transparent);transform:translateY(-1px)}.dsh-helloai-btn:active:not(:disabled){background:var(--dsh-helloai-accent-hover);box-shadow:none;transform:translateY(0)}.dsh-helloai-btn:focus-visible{outline:2px solid var(--dsh-helloai-accent);outline-offset:2px}.dsh-helloai-btn:disabled{opacity:.55;cursor:wait}.dsh-helloai-primary{background:var(--dsh-helloai-accent-fill);border-color:var(--dsh-helloai-accent-fill);color:var(--dsh-helloai-accent-on)}.dsh-helloai-ghost{background:transparent;border-color:var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);font-weight:500;box-shadow:none}.dsh-helloai-ghost:hover:not(:disabled){background:var(--dsh-helloai-accent-soft);border-color:var(--dsh-helloai-accent-line);color:var(--dsh-helloai-accent);box-shadow:none}
.dsh-helloai-card{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:16px 18px;margin-top:12px}.dsh-helloai-card-title{font-weight:650;margin-bottom:8px}.dsh-helloai-card p{margin:7px 0;line-height:1.65}.dsh-helloai-muted{color:var(--dsw-alias-label-secondary)}
.dsh-helloai-card-toggle{display:flex;align-items:center;justify-content:space-between;gap:12px;width:100%;border:0;background:transparent;padding:0;cursor:pointer;color:var(--dsw-alias-label-primary);font:inherit;text-align:left}.dsh-helloai-card-toggle .dsh-helloai-card-title{margin-bottom:0}.dsh-helloai-card-toggle:hover .dsh-helloai-card-chevron{color:var(--dsw-alias-label-primary)}.dsh-helloai-card-chevron{color:var(--dsw-alias-label-secondary);font-size:12px;white-space:nowrap}
.dsh-helloai-more{display:block;margin-top:10px;border:0;background:transparent;padding:0;cursor:pointer;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;text-align:left}.dsh-helloai-more:hover{color:var(--dsh-helloai-accent);text-decoration:underline}
.dsh-helloai-plugins{list-style:none;margin:10px 0 0;padding:0;display:flex;flex-direction:column;gap:8px}.dsh-helloai-plugins li{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:9px 11px;background:color-mix(in srgb,var(--dsh-helloai-accent) 6%,transparent)}.dsh-helloai-plugins li.selected{border-color:color-mix(in srgb,var(--dsh-helloai-accent) 55%,var(--dsw-alias-border-l1))}
.dsh-helloai-plugin-title{display:flex;align-items:center;justify-content:space-between;gap:12px}.dsh-helloai-plugin-title .dsh-helloai-card-title{margin-bottom:0}
.dsh-helloai-selectall{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary);cursor:pointer;user-select:none}.dsh-helloai-selectall input{accent-color:var(--dsh-helloai-accent)}
.dsh-helloai-plugin-check{margin:0;flex:0 0 auto;cursor:pointer;accent-color:var(--dsh-helloai-accent)}.dsh-helloai-plugin-check:disabled{cursor:not-allowed;opacity:.5}
.dsh-helloai-plugin-head{display:flex;align-items:center;flex-wrap:wrap;gap:8px}.dsh-helloai-plugin-name{font-weight:600;overflow-wrap:anywhere}.dsh-helloai-plugin-version{color:var(--dsw-alias-label-secondary);font-size:12px}
.dsh-helloai-plugin-actions{display:flex;gap:8px;margin-top:8px}
.dsh-helloai-btn.dsh-helloai-small{padding:5px 10px;font-size:12px;font-weight:500;border-radius:6px}
.dsh-helloai-btn.dsh-helloai-danger{border-color:color-mix(in srgb,#dc2626 45%,var(--dsw-alias-border-l1));color:#ff8a8a}
.dsh-helloai-btn.dsh-helloai-danger:hover:not(:disabled){background:color-mix(in srgb,#dc2626 18%,transparent);border-color:#dc2626;box-shadow:none}
.dsh-helloai-chip{border-radius:999px;padding:2px 9px;font-size:12px;font-weight:600}.dsh-helloai-chip.ok{background:color-mix(in srgb,#16a34a 20%,transparent);color:#43c77a}.dsh-helloai-chip.info{background:color-mix(in srgb,#2563eb 20%,transparent);color:#7fb0ff}.dsh-helloai-chip.muted{background:color-mix(in srgb,var(--dsw-alias-label-secondary) 22%,transparent);color:var(--dsw-alias-label-secondary)}.dsh-helloai-chip.warn{background:color-mix(in srgb,#e3a008 22%,transparent);color:#e3a008}
.dsh-helloai-plugin-path{margin-top:4px;color:var(--dsw-alias-label-secondary);font-size:12px;overflow-wrap:anywhere}.dsh-helloai-plugin-links{margin-top:3px;color:var(--dsw-alias-label-secondary);font-size:12px;overflow-wrap:anywhere}.dsh-helloai-plugin-reason{margin-top:4px;color:#e3a008;font-size:12px;overflow-wrap:anywhere}
.dsh-helloai-warning,.dsh-helloai-message{margin-top:12px;border-radius:8px;padding:10px 12px;line-height:1.5;white-space:pre-line}.dsh-helloai-warning{background:color-mix(in srgb,#e3a008 12%,transparent);color:var(--dsw-alias-label-secondary)}
.dsh-helloai-skipped{margin:6px 0 0;padding-left:18px;max-height:180px;overflow:auto;font-size:12px}.dsh-helloai-skipped li{overflow-wrap:anywhere}
.dsh-helloai-warning .dsh-helloai-btn{margin-top:8px}.dsh-helloai-message.success{background:color-mix(in srgb,#16a34a 14%,transparent);color:#43c77a}.dsh-helloai-message.error{background:color-mix(in srgb,#dc2626 14%,transparent);color:#ff7777}.dsh-helloai-message.warning{background:color-mix(in srgb,#2563eb 14%,transparent);color:var(--dsw-alias-label-secondary)}
@container(max-width:680px){.dsh-helloai-head{display:block}.dsh-helloai-actions{justify-content:flex-start;margin-top:14px}.dsh-helloai-btn{flex:1}}
`;

function apply(ctx: ClientContext) {
  ctx.effect(() => ctx.locale.register(NS, DICT), "dsh-helloai-bak locale");
  ctx.slots.inject("settings.section", () => ctx.slots.register({ name: "settings.section", id: "helloai-backup", order: 18, label: () => ctx.locale.bind(NS)("title"), icon: "database", locale: NS }, BackupSection));
}

export { apply, NS, DICT };
export const inject = ["slots", "locale"];
