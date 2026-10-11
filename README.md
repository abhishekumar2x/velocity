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
