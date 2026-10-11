import { frameworkList, type Framework } from "@vercel/frameworks";
import { detectFramework, LocalFileSystemDetector } from "@vercel/fs-detectors";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { globby } from "globby";
import { basename, join, resolve } from "node:path";

export type PackageManager = "bun" | "pnpm" | "yarn" | "npm";

export interface ProjectFile {
  path: string;
  directory: boolean;
}

export interface ProjectInfo {
  root: string;
  files: ProjectFile[];
  name: string;
  framework: Framework | null;
  installCommand: string | null;
  buildCommand: string | null;
  outputDir: string | null;
  packageManager: PackageManager;
  nodeVersion: string | null;
  typescript: boolean;
  envFiles: string[];
  envVariableCount: number;
  warnings: string[];
}

function settingValue(s: unknown): string | null {
  const value = s as { value?: string | null; placeholder?: string } | undefined;
  return value?.value ?? null;
}

export async function detectVercelFramework(cwd: string): Promise<Framework | null> {
  const fs = new LocalFileSystemDetector(cwd);
  const list = [...frameworkList];
  const result: unknown = await detectFramework({ fs, frameworkList: list });

  if (!result) return null;
  if (typeof result === "string") return list.find((framework) => framework.slug === result) ?? null;
  return result as Framework;
}

export function detectPackageManager(cwd: string): PackageManager {
  if (existsSync(join(cwd, "bun.lock")) || existsSync(join(cwd, "bun.lockb"))) return "bun";
  if (existsSync(join(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(cwd, "yarn.lock"))) return "yarn";
  return "npm";
}

async function readPackageJson(cwd: string): Promise<Record<string, unknown> | null> {
  const path = join(cwd, "package.json");
  if (!existsSync(path)) return null;
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

async function detectNodeVersion(cwd: string, pkg: Record<string, unknown> | null): Promise<string | null> {
  if (pkg && typeof pkg.engines === "object" && pkg.engines && "node" in pkg.engines) {
    const nodeValue = (pkg.engines as Record<string, unknown>).node;
    if (typeof nodeValue === "string") return nodeValue;
  }

  for (const file of [".nvmrc", ".node-version"]) {
    const filePath = join(cwd, file);
    if (existsSync(filePath)) return (await readFile(filePath, "utf8")).trim();
  }

  return null;
}

const PUBLIC_PREFIXES = ["NEXT_PUBLIC_", "NUXT_PUBLIC_", "VITE_", "PUBLIC_", "REACT_APP_"];
const SECRET_LIKE = /(SECRET|PRIVATE|PASSWORD|TOKEN|API_?KEY|SERVICE_ROLE)/i;

export async function scanEnv(
  cwd: string,
): Promise<{ files: string[]; warnings: string[]; variableCount: number }> {
  const warnings: string[] = [];
  const files = await globby([".env", ".env.*"], {
    cwd,
    onlyFiles: true,
    dot: true,
    followSymbolicLinks: false,
  });

  const keys = new Set<string>();
  const gitignorePath = join(cwd, ".gitignore");
  const gitignore = existsSync(gitignorePath) ? await readFile(gitignorePath, "utf8") : "";

  if (files.length > 0 && !/^\.env/m.test(gitignore)) {
    warnings.push(".env files found but not listed in .gitignore");
  }

  for (const file of files) {
    const content = await readFile(join(cwd, file), "utf8");

    for (const line of content.split(/\r?\n/)) {
      const key = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=?/)?.[1];
      if (!key) continue;

      keys.add(key);

      if (PUBLIC_PREFIXES.some((prefix) => key.startsWith(prefix)) && SECRET_LIKE.test(key)) {
        warnings.push(`${key} (${file}) is exposed to the browser; check it isn't a secret`);
      }
    }
  }

  return { files, warnings, variableCount: keys.size };
}

const TREE_IGNORES = new Set([
  ".git",
  "node_modules",
  ".svelte-kit",
  ".next",
  ".nuxt",
  ".output",
  "dist",
  "build",
  ".vercel",
  ".netlify",
  "coverage",
]);

const PROJECT_IGNORES = [
  "**/.git/**",
  "**/node_modules/**",
  ...[...TREE_IGNORES].filter((name) => name !== ".git" && name !== "node_modules").map((name) => `**/${name}/**`),
  "**/.env*",
  "**/.nvmrc",
  "**/.node-version",
];

async function readProjectFiles(root: string): Promise<ProjectFile[]> {
  const paths = await globby(["**/*"], {
    cwd: root,
    gitignore: true,
    onlyFiles: false,
    dot: true,
    followSymbolicLinks: false,
    ignore: PROJECT_IGNORES,
  });

  return Promise.all(
    paths.map(async (path) => ({
      path: path.split(/[\\/]/).join("/"),
      directory: (await stat(join(root, path))).isDirectory(),
    })),
  );
}

export async function scanProject(cwd = process.cwd()): Promise<ProjectInfo | null> {
  const root = resolve(cwd);
  const [framework, pkg] = await Promise.all([detectVercelFramework(root), readPackageJson(root)]);
  if (!framework && !pkg) return null;

  const [files, env] = await Promise.all([readProjectFiles(root), scanEnv(root)]);
  const packageManager = detectPackageManager(root);
  const dependencies = { ...((pkg && typeof pkg.dependencies === "object" && pkg.dependencies) || {}), ...((pkg && typeof pkg.devDependencies === "object" && pkg.devDependencies) || {}) };
  const buildCommand = pkg && typeof pkg.scripts === "object" && pkg.scripts && "build" in pkg.scripts
    ? `${packageManager} run build`
    : settingValue(framework?.settings?.buildCommand);

  return {
    root,
    files,
    name: (pkg && typeof pkg.name === "string" && pkg.name) || basename(root),
    framework,
    installCommand: settingValue(framework?.settings?.installCommand),
    buildCommand,
    outputDir: settingValue(framework?.settings?.outputDirectory),
    packageManager,
    nodeVersion: await detectNodeVersion(root, pkg),
    typescript: existsSync(join(root, "tsconfig.json")) || "typescript" in dependencies,
    envFiles: env.files,
    envVariableCount: env.variableCount,
    warnings: env.warnings,
  };
}

export function projectTree(project: ProjectInfo, maxDepth = 2): string {
  type TreeNode = { name: string; directory: boolean; children: Map<string, TreeNode> };

  const root: TreeNode = {
    name: basename(project.root) || project.root,
    directory: true,
    children: new Map(),
  };

  for (const file of project.files) {
    const parts = file.path.split("/").filter(Boolean);
    if (!parts.length || parts.length > maxDepth) continue;

    let parent = root;
    for (let index = 0; index < parts.length; index += 1) {
      const name = parts[index];
      if (!name) continue;

      let node = parent.children.get(name);

      if (!node) {
        const directory = index < parts.length - 1 || file.directory;
        node = { name, directory, children: new Map() };
        parent.children.set(name, node);
      } else if (index < parts.length - 1) {
        node.directory = true;
      }

      parent = node;
    }
  }

  const lines: string[] = [basename(project.root) || project.root];

  function render(node: TreeNode, prefix: string, depth: number): void {
    const entries = [...node.children.values()].sort((a, b) => {
      if (a.directory !== b.directory) return a.directory ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    const visible = entries.slice(0, 24);

    visible.forEach((entry, index) => {
      const last = index === visible.length - 1;
      const branch = last ? "└── " : "├── ";
      lines.push(`${prefix}${branch}${entry.directory ? entry.name + "/" : entry.name}`);

      if (entry.directory && depth < maxDepth) {
        render(entry, prefix + (last ? "    " : "│   "), depth + 1);
      }
    });

    if (entries.length > visible.length) {
      lines.push(`${prefix}└── … ${entries.length - visible.length} more entries`);
    }
  }

  render(root, "", 1);
  return lines.join("\n");
}
