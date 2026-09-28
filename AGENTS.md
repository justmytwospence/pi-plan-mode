# Pi Plan Mode Guidelines

This is a standalone fork of `packages/pi-plan-mode` from
[narumiruna/pi-extensions](https://github.com/narumiruna/pi-extensions), extracted with
`git subtree split` so upstream history is preserved. The `upstream` remote points at the monorepo;
re-run `git subtree split -P packages/pi-plan-mode` there to pick up upstream fixes.

- Pi loads `src/index.ts` directly through jiti; there is no build step. Runtime dependencies must be
  installed (`npm ci --omit=dev`) wherever the package is loaded from a local path.
- Run `npm run check` (biome, typecheck, vitest) before committing.
- Copy the live branch when creating a fresh implementation session because `pi --no-session` and
  `getSessionFile() === undefined` do not imply an empty in-memory branch.
