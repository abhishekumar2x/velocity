import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProjectInfo } from "./scan";

const ANSI_ESCAPE = /\u001b\[[0-?]*[ -/]*[@-~]/g;

function findDeployUrl(line: string): string | null {
  const cleanLine = line.replace(ANSI_ESCAPE, "");
  const websiteUrl = cleanLine.match(/Website URL:\s*(https?:\/\/[^\s"'<>]+)/i)?.[1];
  const netlifyUrl = cleanLine.match(/https?:\/\/[^\s"'<>]*\.netlify\.app[^\s"'<>]*/i)?.[0];
  const url = websiteUrl ?? netlifyUrl;
  return url ? url.replace(/[),.]+$/, "") : null;
}

export interface NetlifyDeploymentResult {
  url: string | null;
  readyState: "READY" | "ERROR";
  logCount: number;
}

async function hasNetlifyNextPlugin(project: ProjectInfo): Promise<boolean> {
  if (!project.files.some((file) => file.path === "package.json" && !file.directory)) return false;
  const packageJson: unknown = JSON.parse(await readFile(join(project.root, "package.json"), "utf8"));
  if (typeof packageJson !== "object" || packageJson === null) return false;

  for (const field of ["dependencies", "devDependencies"]) {
    if (!(field in packageJson)) continue;
    const dependencies = packageJson[field];
    if (
      typeof dependencies === "object" &&
      dependencies !== null &&
      "@netlify/plugin-nextjs" in dependencies
    ) {
      return true;
    }
  }
  return false;
}

function installNetlifyNextPlugin(
  projectRoot: string,
  onLog: (line: string) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("bun", ["add", "-d", "@netlify/plugin-nextjs"], {
      cwd: projectRoot,
      shell: process.platform === "win32",
      stdio: ["inherit", "pipe", "pipe"],
    });
    let output = "";
    let pending = "";

    const consume = (chunk: Buffer): void => {
      const lines = `${pending}${chunk.toString("utf8")}`.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) {
        if (!line) continue;
        output = `${output}${line}\n`.slice(-4_000);
        onLog(line);
      }
    };

    child.stdout.on("data", consume);
    child.stderr.on("data", consume);
    child.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        reject(new Error("Bun was not found on PATH; install Bun and retry the Netlify deployment."));
        return;
      }
      reject(new Error(`Could not start Bun to install Netlify's Next.js adapter: ${error.message}`));
    });
    child.on("close", (code) => {
      if (pending.trim()) {
        output = `${output}${pending}\n`.slice(-4_000);
        onLog(pending);
      }
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `Bun could not install @netlify/plugin-nextjs (exit code ${code ?? "unknown"}).${output ? `\n${output}` : ""}`,
        ),
      );
    });
  });
}

function hasNpm(projectRoot: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const child = spawn("npm", ["--version"], {
      cwd: projectRoot,
      shell: process.platform === "win32",
      windowsHide: true,
      stdio: "ignore",
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        resolve(false);
      } else {
        reject(new Error(`Could not check whether npm is available: ${error.message}`));
      }
    });
    child.on("close", (code) => resolve(code === 0));
  });
}

export async function deployToNetlify(
  project: ProjectInfo,
  onLog: (line: string) => void,
): Promise<NetlifyDeploymentResult> {
  if (project.framework?.name.toLowerCase().includes("next") && !(await hasNetlifyNextPlugin(project))) {
    if (project.packageManager === "bun") {
      onLog("Installing Netlify's Next.js adapter with Bun…");
      await installNetlifyNextPlugin(project.root, onLog);
    }
    if (
      project.packageManager !== "bun" &&
      !(await hasNpm(project.root))
    ) {
      throw new Error(
        "Netlify auto-installs @netlify/plugin-nextjs with npm, but npm is not available. Install Node.js LTS (which includes npm), or add the adapter to your project dependencies before retrying.",
      );
    }
  }

  return await new Promise<NetlifyDeploymentResult>((resolve, reject) => {
    let child;
    try {
      child = spawn("netlify", ["deploy", "--build"], {
        cwd: project.root,
        shell: process.platform === "win32",
        stdio: ["inherit", "pipe", "pipe"],
      });
    } catch (error) {
      reject(error);
      return;
    }

    let logCount = 0;
    let url: string | null = null;
    let outputTail = "";
    const pending = new Map<"stdout" | "stderr", string>([
      ["stdout", ""],
      ["stderr", ""],
    ]);

    const consume = (stream: "stdout" | "stderr", chunk: Buffer): void => {
      const lines = `${pending.get(stream) ?? ""}${chunk.toString("utf8")}`.split(/\r?\n/);
      pending.set(stream, lines.pop() ?? "");

      for (const line of lines) {
        if (!line) continue;
        onLog(line);
        logCount += 1;
        outputTail = `${outputTail}${line}\n`.slice(-4_000);
        if (!url) url = findDeployUrl(line);
      }
    };

    child.stdout.on("data", (chunk: Buffer) => consume("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => consume("stderr", chunk));
    child.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        reject(
          new Error(
            "Netlify CLI was not found. Install it with `bun add --global netlify-cli`, then run `netlify login`.",
          ),
        );
        return;
      }
      reject(new Error(`Could not start Netlify CLI: ${error.message}`));
    });
    child.on("close", (code) => {
      for (const stream of ["stdout", "stderr"] as const) {
        const line = pending.get(stream)?.trimEnd();
        if (!line) continue;
        onLog(line);
        logCount += 1;
        outputTail = `${outputTail}${line}\n`.slice(-4_000);
        if (!url) url = findDeployUrl(line);
      }

      if (
        code !== 0 &&
        /(?:netlify: command not found|'netlify' is not recognized|netlify is not recognized)/i.test(outputTail)
      ) {
        reject(
          new Error(
            "Netlify CLI was not found. Install it with `bun add --global netlify-cli`, then run `netlify login`.",
          ),
        );
        return;
      }
      resolve({
        url,
        readyState: code === 0 ? "READY" : "ERROR",
        logCount,
      });
    });
  });
}
