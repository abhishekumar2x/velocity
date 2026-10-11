import {
  intro,
  outro,
  select,
  confirm,
  isCancel,
  note,
  spinner,
  log,
} from "@clack/prompts";
import pc from "picocolors";
import { resolve } from "node:path";
import { exit } from "node:process";
import { projectTree, scanProject, type ProjectInfo } from "./scan";
import { deployToVercel, followVercelDeployment } from "./vercel";

type Provider = "vercel" | "netlify";

function treeRow(label: string, value: string): string {
  return `  ${pc.dim(label.padEnd(12))}${value}`;
}

function printScan(info: ProjectInfo): void {
  const framework = info.framework
    ? `${pc.cyan(info.framework.name)}${info.framework.name.toLowerCase().includes("sveltekit") ? pc.dim(" (SSR)") : ""}`
    : pc.yellow("Not detected");

  note(
    [
      treeRow("Framework", framework),
      treeRow("Build", info.buildCommand ?? pc.yellow("no build command detected")),
      treeRow("Output", info.outputDir ?? pc.dim("not detected")),
      treeRow("Package mgr", info.packageManager),
      treeRow("TypeScript", info.typescript ? pc.green("yes") : "no"),
      treeRow("Env vars", `${info.envVariableCount} detected (values hidden)`),
    ].join("\n"),
    "Detected settings",
  );

  for (const warning of info.warnings) log.warn(warning);
  if (!info.framework) {
    log.warn("No framework matched. Provider compatibility must be checked before deployment.");
  }
}

async function velocity(): Promise<void> {
  intro(`${pc.cyan("◆")} ${pc.bold("velocity")}`);

  const projectRoot = resolve(process.argv[2] ?? process.cwd());
  const scan = spinner();
  scan.start("Scanning project…");

  let info: ProjectInfo | null;
  try {
    info = await scanProject("F:/nextjs-test");
    scan.stop(info ? "Project scanned" : "No project detected");
  } catch (error) {
    scan.stop("Project scan failed");
    log.error(error instanceof Error ? error.message : String(error));
    outro(pc.red("Could not scan this project."));
    exit(1);
  }

  if (!info) {
    outro(pc.red("No project found. Run velocity from your project root."));
    exit(1);
  }

  printScan(info);

  console.log("");
  note(projectTree(info), "Project structure");
  console.log("");

  const provider = await select<Provider>({
    message: "Deploy to?",
    options: [
      { value: "vercel", label: "Vercel" },
      { value: "netlify", label: "Netlify (not implemented)" },
    ],
  });

  if (isCancel(provider)) {
    outro("Cancelled.");
    exit(0);
  }

  const proceed = await confirm({ message: "Continue with deployment setup?" });
  if (isCancel(proceed) || !proceed) {
    outro("Cancelled. No deployment was started.");
    exit(0);
  }

  if (provider === "netlify") {
    outro(pc.yellow("Netlify deployment is not implemented yet."));
    return;
  }

  const deployment = spinner();
  deployment.start("Uploading files and creating a Vercel preview deployment…");
  let result: Awaited<ReturnType<typeof deployToVercel>>;
  try {
    result = await deployToVercel(info);
  } catch (error) {
    deployment.stop("Vercel deployment failed");
    log.error(error instanceof Error ? error.message : String(error));
    outro(pc.red("Could not create the Vercel deployment."));
    exit(1);
  }

  deployment.stop(`Vercel deployment created (${result.readyState})`);

  log.info("Streaming Vercel build logs…");
  let buildResult: Awaited<ReturnType<typeof followVercelDeployment>>;
  try {
    buildResult = await followVercelDeployment(result.id, (line) => console.log(line));
  } catch (error) {
    log.error(error instanceof Error ? error.message : String(error));
    outro(pc.red("Deployment was created, but its build logs could not be retrieved."));
    exit(1);
  }

  log.info(`Deployment finished (${buildResult.readyState}); received ${buildResult.logCount} log lines.`);
  note(
    [
      result.url ? pc.cyan(result.url) : `Deployment ID: ${result.id}`,
      `Status: ${buildResult.readyState}`,
    ].join("\n"),
    "Deployment",
  );

  if (buildResult.readyState !== "READY") {
    outro(pc.red(`Vercel deployment ended with status ${buildResult.readyState}.`));
    exit(1);
  }

  outro(pc.green("Deployment completed successfully."));
}

velocity().catch((error) => {
  log.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
