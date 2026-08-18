# Contributing

## Development setup

The control plane uses Node.js 24 because it relies on the built-in `node:sqlite` module. Install dependencies with pnpm, then run the checks below:

```powershell
pnpm install
pnpm test
pnpm build
```

Run the UI and API together during development with `pnpm dev` and `pnpm dev:server` in separate terminals. Set `OPS_ALLOW_INSECURE_LOCAL=1` only for an isolated local session; all shared or deployed instances must set `OPS_ADMIN_TOKEN`.

## Pull requests

- Keep task inputs schema-limited; do not add arbitrary shell execution to the HTTP API.
- Add or update a smoke test when changing Agent protocol, task state, or authentication.
- Do not commit SQLite data, generated bundles, tokens, or `.env` files.
- Explain migration and rollback impact for schema or deployment changes.
