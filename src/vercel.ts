import { Vercel } from "@vercel/sdk";
import { Framework as VercelFramework } from "@vercel/sdk/models/createdeploymentgitsource1.js";
import { GetDeploymentEventsAcceptEnum } from "@vercel/sdk/funcs/deploymentsGetDeploymentEvents.js";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { ProjectInfo } from "./scan";

const TERMINAL_DEPLOYMENT_STATES = new Set(["READY", "ERROR", "CANCELED"]);

function createVercelClient(): Vercel {
  const token = process.env.VERCEL_TOKEN;
  if (!token) {
    throw new Error("VERCEL_TOKEN is not set. Add your Vercel access token to the environment.");
  }

  return new Vercel({ bearerToken: token });
}

export async function deployToVercel(
  project: ProjectInfo,
): Promise<{ id: string; url: string | null; readyState: string }> {
  const vercel = createVercelClient();
  const root = project.root;
  const filesToUpload = project.files.filter((file) => !file.directory);

  if (filesToUpload.length === 0) {
    throw new Error("No deployable files found in the selected project directory.");
  }

  const deploymentName = (project.name || basename(root))
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 52) || "velocity-project";
  const files: Array<{ file: string; sha: string; size: number }> = [];

  for (const projectFile of filesToUpload) {
    const contents = await readFile(join(root, projectFile.path));
    const sha = createHash("sha1").update(contents).digest("hex");

    await vercel.deployments.uploadFile({
      contentLength: contents.byteLength,
      xVercelDigest: sha,
      requestBody: contents,
    });

    files.push({
      file: projectFile.path,
      sha,
      size: contents.byteLength,
    });
  }

  const deployment = await vercel.deployments.createDeployment({
    skipAutoDetectionConfirmation: "1",
    requestBody: {
      name: deploymentName,
      files,
      target: "staging",
      projectSettings: {
        framework: Object.values(VercelFramework).find(
          (framework) => framework === project.framework?.slug,
        ) ?? null,
        buildCommand: project.buildCommand,
        installCommand: project.installCommand,
        outputDirectory: project.outputDir,
      },
    },
  });

  return {
    id: deployment.id,
    url: "url" in deployment ? `https://${deployment.url}` : null,
    readyState: deployment.readyState,
  };
}

export async function followVercelDeployment(
  deploymentId: string,
  onLog: (line: string) => void,
): Promise<{ readyState: string; logCount: number }> {
  const vercel = createVercelClient();
  let logCount = 0;
  const seenEvents = new Set<string>();
  let since = Date.now() - 30_000;
  let readyState = "QUEUED";

  while (!TERMINAL_DEPLOYMENT_STATES.has(readyState)) {
    const [events, deployment] = await Promise.all([
      vercel.deployments.getDeploymentEvents(
        { idOrUrl: deploymentId, direction: "forward", since, limit: 100 },
        { acceptHeaderOverride: GetDeploymentEventsAcceptEnum.applicationJson },
      ),
      vercel.deployments.getDeployment({ idOrUrl: deploymentId }),
    ]);

    const eventList = Array.isArray(events) ? events : [events];
    for (const event of eventList) {
      if (!event) continue;

      const id = "id" in event && typeof event.id === "string" ? event.id : undefined;
      if (id && seenEvents.has(id)) continue;
      if (id) seenEvents.add(id);

      const date = "date" in event && typeof event.date === "number" ? event.date : undefined;
      if (date !== undefined) since = Math.max(since, date - 1);

      let text: string | undefined;
      if ("text" in event && typeof event.text === "string") {
        text = event.text;
      } else if ("payload" in event && typeof event.payload.text === "string") {
        text = event.payload.text;
      }

      if (text?.trim()) {
        onLog(text);
        logCount += 1;
      }
    }

    readyState = deployment.readyState;
    if (!TERMINAL_DEPLOYMENT_STATES.has(readyState)) {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }

  return { readyState, logCount };
}
