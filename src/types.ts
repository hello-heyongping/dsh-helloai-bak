/** Where a local plugin link was discovered. */
export type LinkOrigin = "declared" | "linked" | "bundle";

export type DependencySection = "dependencies" | "optionalDependencies" | "devDependencies";

/** One physical link (junction/symlink) or declared link:/file: spec that makes a plugin visible to a profile. */
export type PluginLink = {
  profile: string;
  /** The name the plugin is exposed as inside the profile's node_modules (may be scoped). */
  linkName: string;
  /** Resolved absolute directory/file the link points at when the backup was taken. */
  path: string;
  /** The raw target exactly as stored on disk (may be relative), kept for diagnostics. */
  target?: string;
  kind: "directory" | "file";
  origin: LinkOrigin;
  /** True when the profile package.json already declared this link:/file: dependency. */
  declared: boolean;
  section?: DependencySection;
  /** The exact dependency spec found in package.json, when declared. */
  spec?: string;
  /** False for a dangling link whose target no longer exists. */
  exists: boolean;
};

/**
 * Every local plugin the backup found. `status` explains what happened to it:
 * - packed: payload is inside the ZIP and can be restored
 * - missing: link exists but its target is gone, so there is nothing to package
 * - inside-home: payload already lives in DSH_HOME and travels with the dsh-home part
 * - self: this backup plugin itself; never packed because the running copy is kept
 * - skipped: the user unchecked it in the settings list
 * - failed: the payload could not be written during restore
 */
export type LocalPlugin = {
  packageName: string;
  source: string;
  archive: string;
  kind: "directory" | "file";
  version?: string;
  pluginId?: string;
  entry?: string;
  /** Whether the declared entry existed when the backup was taken (undefined for file plugins). */
  entryPresent?: boolean;
  /** Uncompressed payload size in bytes (0 when nothing was packaged). */
  bytes: number;
  fileCount: number;
  runtimeDependencies: string[];
  bootstrap?: boolean;
  status: "packed" | "missing" | "inside-home" | "self" | "skipped" | "failed";
  reason?: string;
  links: PluginLink[];
};

export type ExternalRoot = {
  source: string;
  archive: string;
  kind: "directory" | "file";
  packageName?: string;
  bootstrap?: boolean;
  /** Runtime dependencies bundled inside the local plugin archive. */
  runtimeDependencies?: string[];
  /** The package entry used for post-restore validation. */
  entry?: string;
};

export type BackupManifest = {
  format: 1 | 2 | 3 | 4;
  plugin: "dsh-helloai-bak";
  createdAt: string;
  dshHomeName: string;
  included: string[];
  excluded: string[];
  entryCount: number;
  includesSecrets: true;
  /** Format 4: complete local plugin inventory with link topology. */
  plugins?: LocalPlugin[];
  /** Formats 1-4: flattened plugin payload list kept for compatibility. */
  externalRoots?: ExternalRoot[];
  installWarnings?: string[];
};

export type BackupInfo = {
  ok: true;
  filename: string;
  bytes: number;
  entryCount: number;
  dshHome: string;
  included: string[];
  excluded: string[];
  plugins?: LocalPlugin[];
  externalRoots?: ExternalRoot[];
};

export type RestorePluginReport = {
  packageName: string;
  configuredPath: string;
  restoredPath?: string;
  relocated: boolean;
  status: "restored" | "preserved" | "missing" | "failed" | "inside-home" | "skipped";
  files: number;
  links: Array<{ profile: string; linkName: string; linkPath: string; ok: boolean; message?: string }>;
  packageJsonMatches: boolean;
  entryExists: boolean;
  message?: string;
};

export type ErrorPayload = { ok: false; code: string; error: string };
