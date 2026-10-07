import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectDirectory, restoreEntries, unzipSync, zipSync } from "./lib/zip.js";

const source = await mkdtemp(join(tmpdir(), "dsh-helloai-bak-test-"));
const target = await mkdtemp(join(tmpdir(), "dsh-helloai-bak-restore-"));
try {
  await writeFile(join(source, "settings.yaml"), "language: zh-CN\n");
  const entries = await collectDirectory(source, () => false);
  const relocated = entries.map((entry) => ({ ...entry, name: `dsh-home/${entry.name}` }));
  const archive = zipSync(relocated);
  const decoded = unzipSync(archive);
  await restoreEntries(decoded, target, "dsh-home");
  const content = await readFile(join(target, "settings.yaml"), "utf8");
  if (!content.includes("zh-CN")) throw new Error("restored content mismatch");
  await writeFile(join(target, "unsafe-link"), "keep me\n");
  await restoreEntries([{ entry: { name: "dsh-home/unsafe-link", originalSize: 10, compressedSize: 10, compression: 0, externalAttributes: 0xa0000000 }, data: new TextEncoder().encode("C:\\outside") }], target, "dsh-home");
  if (await readFile(join(target, "unsafe-link"), "utf8") !== "keep me\n") throw new Error("unsafe symlink replaced an existing file");
  console.log("archive round-trip passed");
} finally { await rm(source, { recursive: true, force: true }); await rm(target, { recursive: true, force: true }); }
