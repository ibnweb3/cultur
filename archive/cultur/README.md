# Archived: Cultur

The earlier crypto-creator due-diligence service (TypeScript Worker + Python reference + curated registry).
This is an opt-in historical project. QlooVibe does not build or deploy it. Its original Qloo client and types were restored from commit `c70af51`; the historical scoring model remains separate from QlooVibe's design-token rules.

## Run the archived Worker locally

Requires Node.js 22 or newer. From this directory:

```sh
npm ci
npm test
npm run typecheck
npm run build
npm run dev
```

Open `http://127.0.0.1:8789`. REST docs are at `/docs`, health at `/health`, and MCP at `/mcp`. The checked-in Wrangler configuration uses local KV, a placeholder namespace ID, no cron schedule, and no public routes. `build` is a dry run; there is no deployment script. This configuration is for local development only.

Without a Qloo key the service runs and reports insufficient evidence. To enable external grounding, create an ignored `.dev.vars` file in this directory containing `QLOO_API_KEY=your-key`. This opt-in sends submitted names to Qloo and may query the configured public Ethereum RPC. The active application's credentials and storage are not used.

Bindings are generated with `npm run types`; tests use synthetic provider responses and do not require credentials. Dependency versions are pinned in `package-lock.json`.

## Run the Python reference

From `python-reference/`, create and activate a Python 3.13 virtual environment, then run:

```sh
python -m pip install -r requirements-dev.txt
python -m pytest -q
python -m uvicorn cultur.app:app --host 127.0.0.1 --port 7860
```

Install `requirements.txt` instead for runtime use without tests. Optional secrets belong in the ignored `python-reference/.env`. `CULTUR_REGISTRY_PATH` can point to a packaged `cases.json`; by default the checkout uses the sibling `registry/cases.json`.

The Docker build context must be this archive directory so the shared registry is included:

```sh
docker build -f python-reference/Dockerfile -t cultur-archive .
docker run --rm -p 127.0.0.1:7860:7860 cultur-archive
```

Docker sets the registry path to `/app/registry/cases.json`. Local SQLite data and secrets are excluded from its build context. No deployment or live-provider validation is performed by the test suites.
