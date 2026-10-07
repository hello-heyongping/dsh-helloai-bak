/**
 * 备份面板预览：用 jsdom 渲染真实的 lib/client.js 组件（桩掉 /api 接口），
 * 套上 DSH 主题令牌后截图，用来核对标题区（kicker / 标题 / 副标题）排版。
 *
 * 运行：node scripts/preview-panel.mjs
 * 主题令牌取自工作区的 .cache/dsh-ref/dsw-tokens.json（缺失时用回退色）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import * as React from "react";
import { createRoot } from "react-dom/client";

const here = import.meta.dirname ?? path.dirname(fileURLToPath(import.meta.url));
const plugin = path.resolve(here, "..");
const workspace = path.resolve(plugin, "..");
const output = path.join(os.tmpdir(), "helloai-bak-preview");
fs.mkdirSync(output, { recursive: true });

function findChrome() {
  const candidates = [];
  if (process.env.DSH_PREVIEW_CHROME) candidates.push(process.env.DSH_PREVIEW_CHROME);
  const playwright = path.join(os.homedir(), "AppData", "Local", "ms-playwright");
  if (fs.existsSync(playwright)) {
    for (const entry of fs.readdirSync(playwright)) {
      if (!entry.startsWith("chromium")) continue;
      for (const nested of ["chrome-win64/chrome.exe", "chrome-win/chrome.exe", "chrome-linux/chrome", "chrome-mac/Chromium.app/Contents/MacOS/Chromium"]) {
        candidates.push(path.join(playwright, entry, nested));
      }
    }
  }
  candidates.push("C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe");
  return candidates.find((candidate) => fs.existsSync(candidate));
}

// 1) 面板真实 CSS（构建产物里那份）
const bundle = fs.readFileSync(path.join(plugin, "lib", "client.js"), "utf8");
const cssMatch = bundle.match(/\.dsh-helloai-backup\{[\s\S]*?@container\(max-width:680px\)\{[^}]*\}[^}]*\}/);
if (!cssMatch) throw new Error("lib/client.js 里没有找到面板 CSS，请先运行 node scripts/build.mjs");
const panelCss = cssMatch[0];

// 2) DSH 主题令牌 + 一份「松绿」主题的预览覆盖（只为看图，取自已解析的松绿参数）
const tokenFile = path.join(workspace, ".cache", "dsh-ref", "dsw-tokens.json");
let tokenCss = ":root{--dsw-alias-bg-base:#101014;--dsw-alias-bg-layer-2:#1c1c20;--dsw-alias-bg-layer-1:#232329;--dsw-alias-label-primary:#f5f6f8;--dsw-alias-label-secondary:#b9bcc4;--dsw-alias-label-tertiary:#8b93a1;--dsw-alias-brand-primary:#f9fafb;--dsw-alias-border-l1:#ffffff1f}";
if (fs.existsSync(tokenFile)) {
  const tokens = JSON.parse(fs.readFileSync(tokenFile, "utf8"));
  const theme = (name) => {
    const body = (map) => Object.entries(map ?? {}).map(([key, value]) => `  --${key}: ${value};`).join("\n");
    return `:root[data-theme="${name}"]{\n${body(tokens[`${name}_static`])}\n${body(tokens[`${name}_alias`])}\n${body(tokens[`${name}_specific`])}\n}`;
  };
  tokenCss = [theme("light"), theme("dark")].join("\n");
}
const PINE = {
  "--dsw-alias-bg-base": "#232e2d",
  "--dsw-alias-bg-layer-1": "#232e2d",
  "--dsw-alias-bg-layer-2": "#283332",
  "--dsw-alias-bg-layer-3": "#2c3836",
  "--dsw-alias-label-primary": "#ccd8d3",
  "--dsw-alias-label-secondary": "#a9b5b0",
  "--dsw-alias-label-tertiary": "#9aa6a1",
  "--dsw-alias-label-primary-foreground": "#131a19",
  "--dsw-alias-link": "#4cb08a",
  "--dsw-alias-button-info-fill": "#4cb08a",
  "--dsw-alias-button-info-hover": "#2f8f6b",
  "--dsw-alias-brand-primary": "#ccd8d3",
  "--dsw-alias-border-l1": "#ffffff0f",
  "--dsw-alias-border-l2": "#ffffff1f",
  "--dsw-alias-interactive-bg-hover": "#ffffff14",
  "--dsw-alias-state-success-primary": "#a6d189",
  "--dsw-alias-state-error-primary": "#e78284"
};
tokenCss += `\n:root[data-theme="pine"]{\n${Object.entries(PINE).map(([key, value]) => `  ${key}: ${value};`).join("\n")}\n}`;

// 3) 用真实组件渲染（桩掉接口）
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: "http://127.0.0.1:19387/" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });

const BACKUP = "C:\\Users\\example\\.dsh\\backups\\dsh-helloai-backup-2026-10-01.zip";
const INVENTORY = {
  ok: true,
  dshHome: "C:\\Users\\example\\.dsh",
  pluginCount: 4,
  packableCount: 2,
  plugins: [
    { packageName: "dsh-market", source: "C:\\Downloads\\dsh-market-v1.45.0", kind: "directory", version: "1.45.0", status: "packed", selectable: true, defaultSelected: true, links: [{ profile: "desktop", linkName: "dsh-market", path: "C:\\Downloads\\dsh-market-v1.45.0", origin: "linked", declared: false, exists: true }] },
    { packageName: "@hello-heyongping/dsh-helloai-theme", source: "D:\\DeepSeek Harness plugin\\dsh-helloai-theme", kind: "directory", version: "0.1.0", status: "packed", selectable: true, defaultSelected: true, links: [{ profile: "desktop", linkName: "@hello-heyongping/dsh-helloai-theme", path: "D:\\DeepSeek Harness plugin\\dsh-helloai-theme", origin: "declared", declared: true, exists: true }] },
    { packageName: "@hello-heyongping/dsh-helloai-bak", source: "D:\\DeepSeek Harness plugin\\dsh-helloai-bak", kind: "directory", version: "1.1.1", status: "self", reason: "这是备份插件自身；恢复时始终保留本机正在运行的版本，因此无需打包", bootstrap: true, selectable: false, defaultSelected: false, links: [{ profile: "desktop", linkName: "dsh-helloai-bak", path: "D:\\DeepSeek Harness plugin\\dsh-helloai-bak", origin: "declared", declared: true, exists: true }] },
  ],
};
const HISTORY = [
  { id: "b1", name: "dsh-helloai-backup-2026-10-01T05-34-21.zip", path: BACKUP, scope: "dsh-home", size: 16474168, modifiedAt: "2026-10-01T05:34:21.000Z", createdAt: "2026-10-01T05:34:21.000Z", format: 4, plugins: ["dsh-market", "@hello-heyongping/dsh-helloai-theme"], missing: 5, restorable: true },
];
dom.window.fetch = globalThis.fetch = async (url) => {
  const text = String(url);
  if (text.endsWith("/status")) return { ok: true, status: 200, json: async () => INVENTORY };
  if (text.endsWith("/backups")) return { ok: true, status: 200, json: async () => ({ ok: true, backups: HISTORY, directory: "C:\\Users\\example\\.dsh\\backups" }) };
  return { ok: true, status: 200, json: async () => ({ ok: true }) };
};

let loaded;
dom.window.__ModuleLoader__ = { load: ({ factory }) => { loaded = factory((name) => (name === "react" ? React : undefined)); } };
new Function("window", "document", "require", "module", "exports", bundle)(dom.window, dom.window.document, (name) => (name === "react" ? React : undefined), { exports: {} }, {});
if (!loaded?.apply) throw new Error("client bundle 没有导出 apply()");

let registered;
const dictionary = loaded.DICT.zh;
loaded.apply({
  effect: (run) => (typeof run === "function" ? run() : undefined),
  locale: { register: () => () => {}, bind: () => (key) => dictionary[key] ?? key },
  slots: { inject: (_name, factory) => factory(), register: (_options, component) => { registered = component; } },
});

createRoot(document.getElementById("root")).render(React.createElement(registered, { t: (key) => dictionary[key] ?? key }));
await new Promise((resolve) => setTimeout(resolve, 900));
const panel = document.getElementById("root").innerHTML;

const html = (mode) => `<!doctype html><html lang="zh-CN" data-theme="${mode}"><head><meta charset="utf-8"><style>
*{box-sizing:border-box}body{margin:0;padding:26px 30px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:"Microsoft YaHei",system-ui,sans-serif}
${tokenCss}
${panelCss}
</style></head><body>${panel}</body></html>`;

const chrome = findChrome();
for (const mode of ["light", "dark", "pine"]) {
  const page = path.join(output, `panel-${mode}.html`);
  const shot = path.join(output, `panel-${mode}.png`);
  fs.writeFileSync(page, html(mode), "utf8");
  if (!chrome) {
    console.log("没找到 Chrome/Chromium，仅生成 HTML：", page);
    continue;
  }
  execFileSync(chrome, ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1", "--window-size=820,900", `--screenshot=${shot}`, `file:///${page.replace(/\\/g, "/")}`], { stdio: "ignore" });
  console.log("渲染完成：", shot);
}
