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
comparison and general security guidance. Netlify deployment is not
implemented yet, and is identified as such in the recommendation and selector.
