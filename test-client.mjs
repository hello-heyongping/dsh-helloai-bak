/**
 * Renders the real built client bundle (lib/client.js) inside jsdom against a
 * stubbed API. Covers: the plugin checklist (self and missing entries disabled),
 * which plugins the backup request asks for, retrying a transient network
 * failure, a successful download, and the persistent-failure path.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import * as React from "react";
import { createRoot } from "react-dom/client";

const MARKET = "C:\\Downloads\\dsh-market-v1.45.0";
const PLUGIN_A = "D:\\plugins\\plugin-a";
const INVENTORY = {
  ok: true,
  dshHome: "C:\\Users\\example\\.dsh",
  pluginCount: 4,
  packableCount: 2,
  plugins: [
    { packageName: "dsh-market", source: MARKET, kind: "directory", version: "1.45.0", status: "packed", selectable: true, defaultSelected: true, links: [{ profile: "desktop", linkName: "dsh-market", path: MARKET, origin: "linked", declared: false, exists: true }] },
    { packageName: "@example/plugin-a", source: PLUGIN_A, kind: "directory", version: "1.0.0", status: "packed", selectable: true, defaultSelected: true, links: [{ profile: "desktop", linkName: "@example/plugin-a", path: PLUGIN_A, origin: "declared", declared: true, exists: true }] },
    { packageName: "dsh-helloai-bak", source: "D:\\DeepSeek Harness plugin\\dsh-helloai-bak", kind: "directory", version: "1.1.1", status: "self", reason: "这是备份插件自身；恢复时始终保留本机正在运行的版本，因此无需打包", bootstrap: true, selectable: false, defaultSelected: false, links: [{ profile: "desktop", linkName: "dsh-helloai-bak", path: "D:\\DeepSeek Harness plugin\\dsh-helloai-bak", origin: "declared", declared: true, exists: true }] },
    { packageName: "dsh-gone", source: "D:\\plugins\\dsh-gone", kind: "directory", status: "missing", reason: "链接指向的插件目录已不存在，无法打包", selectable: false, defaultSelected: false, links: [{ profile: "desktop", linkName: "dsh-gone", path: "D:\\plugins\\dsh-gone", origin: "linked", declared: false, exists: false }] },
  ],
};

const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", { url: "http://127.0.0.1:19387/" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
// Record the parts the client assembles so the reassembled bytes can be verified.
let capturedParts;
globalThis.Blob = class RecordingBlob extends dom.window.Blob {
  constructor(parts, options) { super(parts, options); capturedParts = parts; }
};
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
// jsdom has no object URLs and blocks anchor navigation; stub both for downloads.
let capturedBlob;
URL.createObjectURL = (blob) => { capturedBlob = blob; return "blob:stub"; };
URL.revokeObjectURL = () => {};
let downloaded = "";
dom.window.HTMLAnchorElement.prototype.click = function click() { downloaded = this.download; };

const networkError = () => { throw new TypeError("Failed to fetch"); };
const ARCHIVE = Buffer.from("PK\u0003\u0004-helloai-archive-payload");
const CHUNK = 8;
const STAGED_PATH = "C:\\Users\\example\\.dsh\\backups\\dsh-helloai-backup-2026-10-01.zip";
let statusFailures = 1;
let backupBehaviour = "ok";
let lastPrepareBody;
let lastDeletedId;
let lastRecordRestoreId;
let history = [
  { id: "C:\\Users\\example\\.dsh\\backups\\b1.zip", name: "dsh-helloai-backup-2026-10-01T05-34-21.zip", path: "C:\\Users\\example\\.dsh\\backups\\b1.zip", scope: "dsh-home", size: 16474168, modifiedAt: "2026-10-01T05:34:21.000Z", createdAt: "2026-10-01T05:34:21.000Z", format: 4, plugins: ["dsh-market", "@example/plugin-a"], missing: 5, restorable: true },
  { id: "D:\\DeepSeek Harness plugin\\dsh-helloai-bak\\dsh-helloai-backup-2026-10-01-v3.zip", name: "dsh-helloai-backup-2026-10-01-v3.zip", path: "D:\\DeepSeek Harness plugin\\dsh-helloai-bak\\dsh-helloai-backup-2026-10-01-v3.zip", scope: "plugin-directory", size: 11756036, modifiedAt: "2026-09-30T22:10:00.000Z", plugins: [], missing: 0, restorable: false, note: "不是本插件生成的备份" },
];
const downloadOffsets = [];
const calls = [];
dom.window.fetch = globalThis.fetch = async (url, init) => {
  const text = String(url);
  calls.push(`${init?.method || "GET"} ${text}`);
  if (text.endsWith("/status")) {
    if (statusFailures > 0) { statusFailures -= 1; return networkError(); }
    return { ok: true, status: 200, json: async () => INVENTORY };
  }
  if (text.endsWith("/backups")) return { ok: true, status: 200, json: async () => ({ ok: true, backups: history, directory: "C:\\Users\\example\\.dsh\\backups" }) };
  if (text.endsWith("/backups/delete")) {
    lastDeletedId = JSON.parse(init.body).id;
    history = history.filter((record) => record.id !== lastDeletedId);
    return { ok: true, status: 200, json: async () => ({ ok: true, deleted: "dsh-helloai-backup-2026-10-01T05-34-21.zip", backups: history }) };
  }
  if (text.endsWith("/backups/restore")) {
    lastRecordRestoreId = JSON.parse(init.body).id;
    return { ok: true, status: 200, json: async () => ({ ok: true, restored: 12, pluginsRestored: ["dsh-market"], pluginsPreserved: ["dsh-helloai-bak"], pluginsMissing: [], pluginsRelocated: [], addedPluginDependencies: [], linkedPlugins: ["desktop/dsh-market"], reinstalledProfiles: ["desktop"], installWarnings: [], restoreDiagnostics: [{ packageName: "dsh-market", configuredPath: "C:\\Downloads\\dsh-market", restoredPath: "C:\\Downloads\\dsh-market", relocated: false, status: "restored", files: 269, links: [{ profile: "desktop", linkName: "dsh-market", linkPath: "x", ok: true }], packageJsonMatches: true, entryExists: true }] }) };
  }
  if (text.endsWith("/prepare")) {
    lastPrepareBody = init?.body ? JSON.parse(init.body) : undefined;
    if (backupBehaviour === "network") return networkError();
    if (backupBehaviour === "old-host") return { ok: false, status: 404, json: async () => ({ ok: false, error: "未知备份接口" }) };
    if (backupBehaviour === "error") return { ok: false, status: 500, json: async () => ({ ok: false, error: "备份失败：磁盘已满" }) };
    return { ok: true, status: 200, json: async () => ({ ok: true, token: "token-1", filename: "dsh-helloai-backup-2026-10-01.zip", path: STAGED_PATH, size: ARCHIVE.length, chunkSize: CHUNK, plugins: lastPrepareBody.include.map(() => "plugin"), skipped: [], missing: [] }) };
  }
  if (text.includes("/download?")) {
    const query = new URLSearchParams(text.slice(text.indexOf("?") + 1));
    const offset = Number(query.get("offset"));
    downloadOffsets.push(offset);
    if (backupBehaviour === "chunk-network" && offset > 0) return networkError();
    const slice = ARCHIVE.subarray(offset, offset + Number(query.get("length")));
    return { ok: true, status: 200, arrayBuffer: async () => slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.length) };
  }
  throw new Error(`unexpected request ${text}`);
};

let loaded;
dom.window.__ModuleLoader__ = { load: ({ factory }) => { loaded = factory((name) => name === "react" ? React : undefined); } };
const code = await readFile(new URL("./lib/client.js", import.meta.url), "utf8");
new Function("window", "document", "require", "module", "exports", code)(dom.window, dom.window.document, (name) => name === "react" ? React : undefined, { exports: {} }, {});
assert.ok(loaded?.apply, "client bundle exports apply()");

let registered;
const dictionary = loaded.DICT.zh;
const ctx = {
  effect: (run) => (typeof run === "function" ? run() : undefined),
  locale: { register: () => () => {}, bind: () => (key) => dictionary[key] ?? key },
  slots: { inject: (_name, factory) => factory(), register: (_options, component) => { registered = component; } },
};
loaded.apply(ctx);
assert.ok(registered, "settings section registered");

const container = document.getElementById("root");
createRoot(container).render(React.createElement(registered, { t: (key) => dictionary[key] ?? key }));
const settle = async (ms = 700) => { await new Promise((resolve) => setTimeout(resolve, ms)); };
const button = (label) => [...container.querySelectorAll("button")].find((element) => element.textContent.includes(label));

// 1. The first /status attempt fails like an in-flight request dropped by a plugin
//    reload; the retry must recover and still render the inventory.
await settle(900);
for (const expected of ["本地插件", "dsh-market", "@example/plugin-a", dictionary.statusPacked, dictionary.statusSelf, "desktop/dsh-market", "1.45.0"]) {
  assert.ok(container.innerHTML.includes(expected), `settings section should render ${expected}`);
}
assert.ok(container.innerHTML.includes("共发现 4 个本地插件，其中 2 个可打包，已勾选 2 个"), "plugin summary rendered");
assert.ok(!container.innerHTML.includes("{total}"), "no unsubstituted template placeholders");

// The version badge next to the title must come from package.json through the
// build-time `define`, so bumping the version can never leave the UI stale.
const declaredVersion = JSON.parse(await readFile(new URL("./package.json", import.meta.url), "utf8")).version;
const versionBadge = container.querySelector(".dsh-helloai-version");
assert.ok(versionBadge, "title carries a version badge");
assert.equal(versionBadge.textContent, `V${declaredVersion}`, "badge shows the package.json version");
assert.equal(container.querySelector(".dsh-helloai-title .dsh-helloai-title-text")?.textContent, dictionary.title, "title text still rendered next to the badge");
assert.equal(versionBadge.getAttribute("title"), dictionary.versionLabel, "badge says where the version comes from");

assert.ok(calls.filter((call) => call.endsWith("/status")).length >= 2, "the failed /status call was retried");

// The help card shows one paragraph until the user expands it.
assert.ok(container.innerHTML.includes(dictionary.includedText), "first help paragraph visible");
assert.ok(!container.innerHTML.includes(dictionary.excluded), "extra help paragraphs collapsed");
const helpToggle = container.querySelector(".dsh-helloai-card-toggle");
helpToggle.click();
await settle(200);
assert.ok(container.innerHTML.includes(dictionary.excluded), "expanded help reveals the rest");
container.querySelector(".dsh-helloai-card-toggle").click();
await settle(200);
assert.ok(!container.innerHTML.includes(dictionary.excluded), "help collapses again");

// Plugins whose directory is gone stay out of the list by default.
assert.ok(!container.innerHTML.includes("dsh-gone"), "unavailable plugin hidden by default");
assert.ok(!container.innerHTML.includes("链接指向的插件目录已不存在"), "unavailable reason hidden by default");
assert.ok(container.innerHTML.includes("1 个插件的目录已不存在"), "hidden plugins summarised");
const more = () => container.querySelector(".dsh-helloai-more");
more().click();
await settle(200);
assert.ok(container.innerHTML.includes("dsh-gone"), "revealed on request");
assert.ok(container.innerHTML.includes("链接指向的插件目录已不存在"), "reason shown once revealed");
more().click();
await settle(200);
assert.ok(!container.innerHTML.includes("dsh-gone"), "hidden again");

// 2. Only packable plugins are checkable; the running backup plugin never is.
const boxes = [...container.querySelectorAll(".dsh-helloai-plugin-check")];
assert.equal(boxes.length, 3, "one checkbox per listed plugin");
assert.equal(boxes.filter((box) => box.disabled).length, 1, "the self plugin is not selectable");
assert.equal(boxes.filter((box) => box.checked).length, 2, "packable plugins are selected by default");
assert.ok(button("备份全部配置"), "backup button rendered");

// 3. Unchecking a plugin must remove it from the backup request, and the archive
//    must arrive as small chunks that reassemble into the downloaded file.
boxes.find((box) => box.getAttribute("aria-label") === "@example/plugin-a").click();
await settle(200);
assert.ok(container.innerHTML.includes("已勾选 1 个"), "selection count follows the checkbox");
button("备份全部配置").click();
await settle(700);
assert.deepEqual(lastPrepareBody.include, [MARKET], "only the checked plugin is requested");
assert.deepEqual(downloadOffsets, [0, 8, 16, 24], "archive fetched in bounded chunks");
assert.ok(downloaded.endsWith(".zip"), `backup should download a zip, got "${downloaded}"`);
assert.ok(capturedBlob, "a blob was handed to the downloader");
assert.deepEqual(Buffer.concat(capturedParts.map((part) => Buffer.from(part))), ARCHIVE, "chunks reassemble into the exact archive bytes");
assert.ok(container.innerHTML.includes("已打包 1 个本地插件"), "backup reports the packed plugin count");
assert.ok(container.innerHTML.includes(STAGED_PATH), "success message shows the staged file path");

// 4. Select-all restores both, then a persistent network failure must explain
//    itself instead of showing a raw TypeError.
container.querySelector(".dsh-helloai-selectall input").click();
await settle(200);
assert.ok(container.innerHTML.includes("已勾选 2 个"), "select all restores the selection");
backupBehaviour = "network";
button("备份全部配置").click();
await settle(6000);
assert.ok(container.innerHTML.includes(dictionary.networkFailed.slice(0, 12)), "persistent failure shows the network guidance");
assert.ok(!container.innerHTML.includes("Failed to fetch"), "raw browser error is not shown to the user");

// 5. A server-side error keeps its own message.
backupBehaviour = "error";
button("备份全部配置").click();
await settle(400);
assert.ok(container.innerHTML.includes("磁盘已满"), "server error message surfaced");

// 6. A failure in the middle of the chunk loop still points at the complete file
//    already written to disk.
backupBehaviour = "chunk-network";
button("备份全部配置").click();
await settle(6000);
assert.ok(container.innerHTML.includes("已生成，可直接复制使用"), "mid-download failure reports the saved path");
assert.ok(container.innerHTML.includes(STAGED_PATH), "saved path is shown when the download fails");

// 7. A page newer than the host plugin explains the restart requirement.
backupBehaviour = "old-host";
button("备份全部配置").click();
await settle(600);
assert.ok(container.innerHTML.includes(dictionary.needsRestart.slice(0, 10)), "stale host build asks for a restart");
assert.ok(!container.innerHTML.includes("HTTP 404"), "raw 404 is not shown to the user");

// 8. Backup history: every archive is listed with restore/delete, unusable ones flagged.
assert.ok(container.innerHTML.includes("备份记录"), "history card rendered");
assert.ok(container.innerHTML.includes("dsh-helloai-backup-2026-10-01T05-34-21.zip"), "staged archive listed");
assert.ok(container.innerHTML.includes("dsh-helloai-backup-2026-10-01-v3.zip"), "archive from the plugin directory listed");
assert.ok(container.innerHTML.includes("含 2 个插件"), "history reports the packed plugin count");
assert.ok(container.innerHTML.includes("不是本插件生成的备份"), "unreadable archive is flagged");

dom.window.confirm = () => true;
const historyRows = () => [...container.querySelectorAll("li")].filter((row) => row.textContent.includes("dsh-helloai-backup-"));
const stagedRow = historyRows().find((row) => row.textContent.includes("b1.zip") || row.textContent.includes("05-34-21"));
const restoreButton = [...stagedRow.querySelectorAll("button")].find((element) => element.textContent.includes("恢复"));
restoreButton.click();
await settle(500);
assert.equal(lastRecordRestoreId, "C:\\Users\\example\\.dsh\\backups\\b1.zip", "restore uses the record id, not an upload");
assert.ok(container.innerHTML.includes("恢复完成"), "record restore reports its result");

const deleteRow = historyRows().find((row) => row.textContent.includes("05-34-21"));
[...deleteRow.querySelectorAll("button")].find((element) => element.textContent.includes("删除")).click();
await settle(500);
assert.equal(lastDeletedId, "C:\\Users\\example\\.dsh\\backups\\b1.zip", "delete targets the selected record");
assert.ok(container.innerHTML.includes("已删除："), "delete is confirmed in the UI");
assert.ok(!historyRows().some((row) => row.textContent.includes("05-34-21")), "deleted record disappears from the list");

// 9. The two accent-filled action buttons (backup / restore) must print their label
//    in white in every theme. `--dsw-alias-label-primary-foreground` cannot be used
//    for that: it means "the opposite of label-primary", so in the dark theme it
//    resolves to near-black (#0f1115) and the label went black on a blue fill. The
//    stylesheet now takes the always-light toast label with a literal white
//    fallback, and each label sits in its own span so the colour cannot be
//    inherited away from it.
const stylesheet = container.querySelector("style").textContent;
assert.ok(
  stylesheet.includes("--dsh-helloai-accent-on:var(--dsw-alias-toast-label,#fff)"),
  "the accent label colour is an always-light token with a white fallback",
);
assert.ok(
  !stylesheet.includes("--dsh-helloai-accent-on:var(--dsw-alias-label-primary-foreground"),
  "the accent label no longer follows the theme-flipping foreground token",
);
assert.ok(
  stylesheet.includes(".dsh-helloai-btn-accent-label{color:var(--dsh-helloai-accent-on,#fff)!important}"),
  "the filled-button label pins the white ink against outer overrides",
);
const actionLabels = [...container.querySelectorAll(".dsh-helloai-actions .dsh-helloai-btn")]
  .filter((element) => !element.classList.contains("dsh-helloai-ghost"));
assert.equal(actionLabels.length, 2, "backup and restore are the two filled actions");
assert.ok(
  actionLabels.every((element) => element.firstElementChild?.className === "dsh-helloai-btn-accent-label"),
  "both filled actions carry that label span",
);
console.log("client settings section passed");
