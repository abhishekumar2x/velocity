# Velocity

Velocity is an open-source command-line tool for deploying web projects. It scans a project, detects its framework and environment, checks deployment compatibility, recommends a suitable hosting provider, and guides deployment from the terminal.

Project site: https://shred-insert-92832607.figma.site/
GitHub repository: https://github.com/abhishekumar2x/velocity

## How it works

1. Scan project files and configuration.
2. Detect the framework and environment.
3. Analyze deployment compatibility.
4. Recommend a hosting provider.
5. Let the developer choose a deployment target.
6. Run the provider workflow and show status in the terminal.

## Current support shown on the website

- **Vercel:** Supported; deployment is described as using the Vercel SDK.
- **Cloudflare:** Planned / coming soon.
- **Netlify:** Planned / coming soon.

Frameworks and project types listed as detected include Next.js, React + Vite, SvelteKit, Astro, Nuxt, Vue, SolidStart, Remix, and static HTML.

## Requirements

- Bun
- TypeScript
- An account with a supported deployment provider

## Install from source

```sh
git clone https://github.com/abhishekumar2x/velocity.git
cd velocity
bun install
```

Then open the project you want to deploy and run the CLI:

```sh
cd my-project
velocity
```

The site describes source installation; it does not advertise a packaged desktop installer.

## Notes

This README summarizes the information presented on the project website. Provider and framework availability may change; check the site or repository for the latest details.

