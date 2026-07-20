---
name: resolve-codex-runtime
description: Validate and expose the installed OpenAI Codex primary runtime when a built-in document, spreadsheet, PDF, or presentation skill requires load_workspace_dependencies but Codex CLI does not provide that tool. Use only for the missing-loader compatibility case; continue using the official runtime packages and the target artifact skill's authoring and verification rules.
---

# Resolve Codex Runtime

Use the native `load_workspace_dependencies` tool when it exists. When it is absent, the user has
authorized this plugin's resolver as its narrow compatibility replacement.

1. Run `node <skill-dir>/scripts/resolve-workspace-dependencies.mjs`.
2. Treat a successful JSON result as the only allowed source for `nodeExecutable`, `nodeModules`,
   and `artifactToolPackage`. Do not search for another runtime or install packages.
3. Create the target skill's temporary workspace. Link its `node_modules` to the returned
   `nodeModules` path without modifying the runtime directory.
4. Run generated `.mjs` files with the returned `nodeExecutable`.
5. Continue following the selected OpenAI artifact skill, including its required API docs,
   formula/content checks, rendering, and final export rules.

If the resolver exits nonzero, report its concise error as the blocker. Do not fall back to
`openpyxl`, `xlsxwriter`, `python-pptx`, guessed paths, global packages, or repo-local packages.

This bridge changes only dependency discovery. It does not relax sandbox, filesystem, artifact
quality, or visual verification requirements.
