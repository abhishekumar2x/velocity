# velocity

## Vercel preview deployments

Set `VERCEL_TOKEN` to a Vercel access token before running Velocity. Bun loads the
project's `.env` file automatically; alternatively, set the variable in your
shell. Keep the token private and never commit it.

Run `bun src/index.ts [project-directory]` to scan a project, select Vercel, and
create a preview deployment. Velocity uploads project files while excluding
environment files, dependency/build output directories, and files ignored by
Git. Environment variable values are not uploaded.

The scanner returns one project structure containing the resolved root,
detected settings, and filtered project file entries. The CLI displays that
structure and the Vercel adapter uses its file list for uploads.

Netlify is listed in the provider selector but is not implemented yet.

## Provider recommendations

Velocity ranks Vercel and Netlify for the detected project, explains the reason
for each ranking, and marks the top choice in the provider selector. It also
shows up to three security suggestions based on a bounded selection of source
and configuration files. Set `GEMINI_API_KEY` to use Gemini for these reviews.
Environment files and dependency lockfiles are excluded, and common credential
assignments are redacted before source snippets are sent. If the key is
unavailable or the API request fails, Velocity uses a built-in provider
comparison and framework-aware security guidance. Security suggestions include
up to five actionable bullet points. Each provider gets its own security score
and explanation, displayed on a colored 10-step scale. The best deployment fit
is ranked separately using framework and build compatibility, so the
recommendation remains clear when security scores tie. For a tie, the
higher-ranked project fit receives a transparent one-point edge; its note
clarifies that this is a fit adjustment, not additional security evidence.
Built-in scores start at 6/10 and are reduced for scanner warnings; they are
limited estimates because source files and provider settings were not reviewed.
Provider recommendations compare each provider's build and output settings
with the detected project configuration. Netlify deployment is not implemented
yet, and is identified as such in the selector.

After Vercel finishes streaming deployment logs, Velocity checks for build or
deployment errors and can ask Gemini for project-specific fix suggestions.
Only bounded error context is sent, with common secrets and tokens redacted.
Set `GEMINI_API_KEY` to enable this analysis. Short Gemini rate limits are
retried once when the API supplies a retry delay; persistent HTTP 429 responses
are reported with quota and billing checks to try.
