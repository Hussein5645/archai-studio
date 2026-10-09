# Contributing to ArchAI

Thanks for helping! ArchAI is a small team project, so a little coordination goes a long way.

## Before you start

- **Bugs**: open an issue with steps to reproduce, what you expected, what happened, and your
  platform (web, Windows desktop, Android / Quest, or which plugin and host app version).
- **Features and larger changes**: open an issue (or a discussion) first and describe the idea.
  ArchAI has a deliberate design (below); agreeing on the approach before coding saves everyone
  rework.
- Small fixes (typos, docs, obvious bugs) can go straight to a pull request.

## How ArchAI is built

- **Commands and a document.** Every action is a command with a zod input schema
  (`src/commands`); the project is a plain serialisable document (`src/document`). UI, shortcuts,
  plugins and agents all dispatch commands; nothing changes the document any other way. New
  features almost always mean a new command plus UI that dispatches it.
- **One platform boundary.** `src/platform/types.ts` is the only interface to the host (web,
  Electron, Android). Code in `src/` must not import Electron or call native APIs directly.
- **Docs next to the code.** Each feature has a note in `docs/`; update it when behaviour changes.
- Keep changes focused, match the style around them, and avoid new dependencies unless they
  clearly pay for themselves.

## Development

```bash
npm install
npm run dev        # web app
npm test           # unit tests
npm run typecheck
```

See the [README](README.md) for the desktop app, Android, plugins and running the cloud
(`workers/`) locally. Never point development builds at the hosted ArchAI cloud with test data;
run `wrangler dev` instead.

## Pull requests

1. Fork, create a branch from `main`, and keep the pull request about one thing.
2. Add or update tests for behaviour you change (`*.test.ts` next to the code; Playwright
   specs in `e2e/` for UI flows).
3. `npm run typecheck` and `npm test` must pass (CI runs them).
4. Describe what changed and why, and how you tested it. Screenshots help for UI changes.

By contributing you agree that your contribution is licensed under the project's license,
the GNU AGPL v3.0 (see [LICENSE](LICENSE)).

## Conduct

Be kind and constructive. See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
