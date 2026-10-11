import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProjectInfo } from "./scan";

export type DeploymentProvider = "vercel" | "netlify";

export interface ProviderRecommendation {
  provider: DeploymentProvider;
  rank: number;
  reason: string;
}

export interface ProviderComparison {
  recommendations: ProviderRecommendation[];
  securitySuggestions: string[];
  source: "Gemini" | "built-in";
  fallbackReason?: string;
}

const MODELS = ["gemini-3.8-flash", "gemini-3.5-flash"] as const;
const PROVIDERS: DeploymentProvider[] = ["vercel", "netlify"];
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const REVIEWABLE_FILE = /\.(?:[cm]?[jt]sx?|json|html|css|scss|py|go|rs|java|php|rb|vue|svelte)$/i;
const OMITTED_FILE = /(?:^|\/)(?:package-lock\.json|bun\.lockb?|yarn\.lock|pnpm-lock\.yaml|.*\.(?:min\.js|map))$/i;
const SENSITIVE_ASSIGNMENT =
  /^(\s*(?:export\s+)?["']?[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PRIVATE.?KEY|API.?KEY|CREDENTIAL)[A-Z0-9_]*["']?\s*[:=]\s*)(.+)$/i;
const MAX_SOURCE_FILES = 8;
const MAX_SOURCE_FILE_CHARACTERS = 2_500;
const MAX_SOURCE_CHARACTERS = 15_000;

async function collectSecurityContext(project: ProjectInfo): Promise<string> {
  const paths = project.files
    .filter((file) => !file.directory && REVIEWABLE_FILE.test(file.path) && !OMITTED_FILE.test(file.path))
    .sort((a, b) => a.path.localeCompare(b.path))
    .slice(0, MAX_SOURCE_FILES);
  const sections: string[] = [];
  let total = 0;

  for (const file of paths) {
    if (total >= MAX_SOURCE_CHARACTERS) break;
    const source = (await readFile(join(project.root, file.path), "utf8"))
      .split(/\r?\n/)
      .map((line) => line.replace(SENSITIVE_ASSIGNMENT, "$1[REDACTED]"))
      .join("\n")
      .slice(0, MAX_SOURCE_FILE_CHARACTERS);
    const section = `--- ${file.path} ---\n${source}`;
    const remaining = MAX_SOURCE_CHARACTERS - total;
    sections.push(section.slice(0, remaining));
    total += Math.min(section.length, remaining);
  }

  return sections.join("\n\n");
}

function fallbackComparison(project: ProjectInfo, reason?: string): ProviderComparison {
  const frameworkReason = project.framework
    ? `Detected ${project.framework.name}; Vercel can use the scanned framework settings.`
    : "Vercel deployment is integrated; framework was not detected, so verify compatibility.";

  return {
    source: "built-in",
    ...(reason ? { fallbackReason: reason } : {}),
    securitySuggestions: fallbackSecuritySuggestions(project),
    recommendations: [
      { provider: "vercel", rank: 1, reason: frameworkReason },
      {
        provider: "netlify",
        rank: 2,
        reason: "Netlify support is not implemented in Velocity yet, so deployment cannot proceed there.",
      },
    ],
  };
}

function fallbackSecuritySuggestions(project: ProjectInfo): string[] {
  if (project.warnings.length > 0) {
    return project.warnings.slice(0, 3).map((warning) => warning.endsWith(".") ? warning : `${warning}.`);
  }
  return ["Keep secrets out of source control and review access checks on sensitive routes."];
}

function parseRecommendations(value: unknown): ProviderRecommendation[] | null {
  if (typeof value !== "object" || value === null || !("recommendations" in value)) return null;
  const items = value.recommendations;
  if (!Array.isArray(items) || items.length !== PROVIDERS.length) return null;

  const parsed: ProviderRecommendation[] = [];
  for (const item of items) {
    if (
      typeof item !== "object" ||
      item === null ||
      !("provider" in item) ||
      !("reason" in item) ||
      !("rank" in item) ||
      (item.provider !== "vercel" && item.provider !== "netlify") ||
      typeof item.reason !== "string" ||
      item.reason.trim().length < 12 ||
      item.reason.trim().length > 140 ||
      typeof item.rank !== "number" ||
      !Number.isInteger(item.rank) ||
      item.rank < 1 ||
      item.rank > PROVIDERS.length
    ) {
      return null;
    }

    parsed.push({
      provider: item.provider,
      rank: item.rank,
      reason: item.reason.trim(),
    });
  }

  if (
    new Set(parsed.map((item) => item.provider)).size !== PROVIDERS.length ||
    new Set(parsed.map((item) => item.rank)).size !== PROVIDERS.length
  ) {
    return null;
  }

  return parsed.sort((a, b) => a.rank - b.rank);
}

function parseSecuritySuggestions(value: unknown): string[] | null {
  if (
    typeof value !== "object" ||
    value === null ||
    !("securitySuggestions" in value) ||
    !Array.isArray(value.securitySuggestions)
  ) {
    return null;
  }

  const suggestions = value.securitySuggestions
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim().replace(/\s+/g, " "))
    .filter((item) => item.length >= 15 && item.length <= 130 && /[.!?]$/.test(item))
    .slice(0, 3);

  return suggestions.length > 0 ? suggestions : null;
}

async function requestComparison(
  model: string,
  apiKey: string,
  project: ProjectInfo,
): Promise<Pick<ProviderComparison, "recommendations" | "securitySuggestions">> {
  const securityContext = await collectSecurityContext(project);
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              {
                text: [
                  "Rank Vercel and Netlify for deploying this project.",
                  "Return exactly one recommendation for each provider, ranked 1 and 2, with one factual reason under 20 words.",
                  "Consider detected framework, package manager, build command, output directory, and actual Velocity support.",
                  "Vercel deployment is implemented. Netlify deployment is not implemented in Velocity.",
                  "Do not claim a provider is deployable through Velocity if it is not.",
                  "Also review the supplied source/config snippets and return up to 3 specific, actionable security suggestions.",
                  "Security suggestions must be supported by the snippets. Do not claim checks were run or repeat credentials.",
                  "If no security issue is visible, return one practical security best practice.",
                  `Project name: ${project.name}`,
                  `Detected framework: ${project.framework?.name ?? "unknown"}`,
                  `Package manager: ${project.packageManager}`,
                  `Build command: ${project.buildCommand ?? "not detected"}`,
                  `Output directory: ${project.outputDir ?? "not detected"}`,
                  "",
                  "Selected project source/configuration (credentials redacted):",
                  securityContext,
                ].join("\n"),
              },
            ],
          },
        ],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 350,
          responseMimeType: "application/json",
          responseSchema: {
            type: "OBJECT",
            properties: {
              recommendations: {
                type: "ARRAY",
                items: {
                  type: "OBJECT",
                  properties: {
                    provider: { type: "STRING", enum: PROVIDERS },
                    rank: { type: "INTEGER" },
                    reason: { type: "STRING" },
                  },
                  required: ["provider", "rank", "reason"],
                },
              },
              securitySuggestions: {
                type: "ARRAY",
                items: { type: "STRING" },
              },
            },
            required: ["recommendations", "securitySuggestions"],
          },
        },
      }),
    },
  );

  if (!response.ok) {
    if (RETRYABLE_STATUSES.has(response.status) || response.status === 404) {
      throw new Error(`Gemini API returned HTTP ${response.status}.`);
    }
    throw new Error(`Gemini API returned HTTP ${response.status} ${response.statusText}.`);
  }

  const body: unknown = await response.json();
  if (
    typeof body !== "object" ||
    body === null ||
    !("candidates" in body) ||
    !Array.isArray(body.candidates)
  ) {
    throw new Error("Gemini returned an unexpected provider ranking.");
  }

  const candidate = body.candidates[0];
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    !("content" in candidate) ||
    typeof candidate.content !== "object" ||
    candidate.content === null ||
    !("parts" in candidate.content) ||
    !Array.isArray(candidate.content.parts)
  ) {
    throw new Error("Gemini did not return a provider ranking.");
  }

  for (const part of candidate.content.parts) {
    if (typeof part !== "object" || part === null || !("text" in part)) continue;
    if (typeof part.text !== "string") continue;

    let value: unknown;
    try {
      value = JSON.parse(part.text) as unknown;
    } catch {
      continue;
    }
    const recommendations = parseRecommendations(value);
    const securitySuggestions = parseSecuritySuggestions(value);
    if (recommendations && securitySuggestions) {
      return { recommendations, securitySuggestions };
    }
  }

  throw new Error("Gemini returned an invalid provider comparison or security review.");
}

export async function recommendProviders(project: ProjectInfo): Promise<ProviderComparison> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return fallbackComparison(
      project,
      "GEMINI_API_KEY is not set; using the built-in provider comparison.",
    );
  }

  let lastError = "Gemini could not produce a valid provider ranking.";
  for (const model of MODELS) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const recommendations = await requestComparison(model, apiKey, project);
        return { ...recommendations, source: "Gemini" };
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 800));
      }
    }
  }

  return fallbackComparison(project, `${lastError} Using the built-in provider comparison.`);
}
