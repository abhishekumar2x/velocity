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
import {
  recommendProviders,
  suggestDeploymentFixes,
  type DeploymentProvider,
} from "./gemini";

function treeRow(label: string, value: string): string {
  return `  ${pc.dim(label.padEnd(12))}${value}`;
}

function securityScale(score: number): string {
  const filled = "█".repeat(score);
  const empty = "░".repeat(10 - score);

  if (score >= 8) return `${pc.green(filled)}${pc.dim(empty)}`;
  if (score >= 5) return `${pc.yellow(filled)}${pc.dim(empty)}`;
  return `${pc.red(filled)}${pc.dim(empty)}`;
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

  const recommendationSpinner = spinner();
  recommendationSpinner.start("Comparing deployment providers…");
  const comparison = await recommendProviders(info);
  recommendationSpinner.stop(
    comparison.source === "Gemini"
      ? "Provider comparison complete"
      : "Using built-in provider comparison",
  );

  console.log(`\n${pc.bold("Provider recommendations")} (${comparison.source})`);
  for (const recommendation of comparison.recommendations) {
    const providerName = recommendation.provider === "vercel" ? "Vercel" : "Netlify";
    console.log(
      `${recommendation.rank}. ${pc.bold(providerName)}${recommendation.rank === 1 ? pc.green(" — BEST FIT") : ""}: ${recommendation.reason}`,
    );
    console.log(
      `   Security: ${securityScale(recommendation.securityScore)} ${pc.bold(`${recommendation.securityScore}/10`)}`,
    );
    console.log(`   ${pc.dim(recommendation.securityNote)}`);
  }
  console.log(pc.dim("Best fit is ranked by project/framework compatibility; security scores are separate."));
  console.log("");
  console.log(pc.bold("Security suggestions"));
  comparison.securitySuggestions.forEach((suggestion) => {
    console.log(`• ${suggestion}`);
  });
  if (comparison.source === "built-in") {
    console.log(
      pc.dim("Built-in scores start at 6/10 and are reduced for scanner warnings; source files and provider settings were not reviewed."),
    );
  }
  console.log("");

  const provider = await select<DeploymentProvider>({
    message: "Deploy to?",
    options: comparison.recommendations.map(({ provider, rank }) => ({
      value: provider,
      label: `${provider === "vercel" ? "Vercel" : "Netlify"}${rank === 1 ? " (best fit)" : ""}${provider === "netlify" ? " (not implemented)" : ""}`,
    })),
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
  const deploymentLogs: string[] = [];
  let capturedLogCharacters = 0;
  let buildResult: Awaited<ReturnType<typeof followVercelDeployment>>;
  try {
    buildResult = await followVercelDeployment(result.id, (line) => {
      console.log(line);
      if (deploymentLogs.length < 2_000 && capturedLogCharacters < 500_000) {
        const capturedLine = line.slice(0, 5_000);
        deploymentLogs.push(capturedLine);
        capturedLogCharacters += capturedLine.length;
      }
    });
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

  const diagnosisSpinner = spinner();
  diagnosisSpinner.start("Checking completed logs for errors…");
  try {
    const suggestions = await suggestDeploymentFixes(
      info,
      deploymentLogs,
      buildResult.readyState,
    );
    if (suggestions) {
      diagnosisSpinner.stop("Deployment error analysis complete");
      note(
        suggestions.map((suggestion, index) => `${index + 1}. ${suggestion}`).join("\n"),
        "Gemini fix suggestions",
      );
    } else {
      diagnosisSpinner.stop("No deployment errors found in logs");
    }
  } catch (error) {
    diagnosisSpinner.stop("Could not analyze deployment errors");
    log.warn(
      `Gemini fix suggestions are unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

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
