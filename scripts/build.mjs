import { access, readFile, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve, join } from "node:path";
import { build } from "esbuild";

// 面板角标显示的版本号以 package.json 为唯一来源：升级时只改 version，
// 重新构建就会把新版本烘进客户端产物，不需要再手改界面代码。
const { version } = JSON.parse(await readFile(resolve("package.json"), "utf8"));

const outputDirectory = resolve("lib");
const stagingDirectory = resolve(`.dsh-helloai-bak-build-${randomUUID()}`);
const backupDirectory = resolve(`.dsh-helloai-bak-build-backup-${randomUUID()}`);
let previousOutputMoved = false;
let published = false;
async function exists(path) { try { await access(path); return true; } catch { return false; } }
try {
  await build({ entryPoints: ["src/zip.ts", "src/index.ts", "src/types.ts"], outdir: stagingDirectory, outbase: "src", bundle: false, format: "esm", platform: "node", target: "node20", sourcemap: true });
  await build({ entryPoints: ["src/client.ts"], outfile: join(stagingDirectory, "client.js"), bundle: true, format: "cjs", platform: "browser", target: "es2022", external: ["react", "react-dom", "react/jsx-runtime", "react-dom/client"], minify: true, define: { "process.env.NODE_ENV": '"production"', __HELLOAI_VERSION__: JSON.stringify(version) }, banner: { js: "window.__ModuleLoader__.load({ id: \"@hello-heyongping/dsh-helloai-bak\", factory: (require) => {\nvar module = { exports: {} };\nvar exports = module.exports;" }, footer: { js: "return module.exports;\n} });" } });
  if (await exists(outputDirectory)) { await rename(outputDirectory, backupDirectory); previousOutputMoved = true; }
  try { await rename(stagingDirectory, outputDirectory); published = true; }
  catch (error) { if (previousOutputMoved) await rename(backupDirectory, outputDirectory); throw error; }
  if (published && previousOutputMoved) await rm(backupDirectory, { recursive: true, force: true });
} finally {
  await rm(stagingDirectory, { recursive: true, force: true });
  if (published && previousOutputMoved && await exists(backupDirectory)) await rm(backupDirectory, { recursive: true, force: true });
}
console.log("[dsh-helloai-bak] 已从 src 生成 Host 与客户端发布产物");



