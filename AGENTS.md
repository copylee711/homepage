# Repository Guidelines

## Project Structure

- `src/` contains the Vue 3 and TypeScript homepage, including components, composables, styles, and games. Vite serves static assets from `public/`.
- `backend/app/` contains the FastAPI service. Alembic migrations live in `backend/migrations/`, seed data in `backend/seed/`, and tests in `backend/tests/`.
- `agent-platform/` contains Iris's gateway, runner, and sandbox services. Its separate Vue app lives in `agent-platform/web/`, and Node tests live in `agent-platform/tests/`.
- `openwiki/` holds curated reference material. See `docs/development.md` for local setup and `deploy/README.md` for release procedures.

## Build and Development

- At the root, run `npm ci`, then `npm run dev` for Vite or `npm run build` for TypeScript checking and a production build.
- In `backend/`, run `uv sync --frozen --python 3.12`. For a fresh local database, run `uv run python -m app.cli migrate` and `uv run python -m app.cli seed`. Start the API with `uv run uvicorn app.asgi:app --port 8000`.
- For Iris, use Node 24 to match CI. Run `npm --prefix agent-platform/web ci` and `npm --prefix agent-platform/web run build`.

## Coding and Testing

Follow the surrounding file's style. Use two-space indentation in Vue and TypeScript, PascalCase for Vue component filenames, and four spaces and snake_case in Python.

- From `backend/`, run `uv run --frozen pytest -q` and `uv run --frozen ruff check app migrations tests`. Name Python tests `test_*.py`.
- For Iris, build its frontend, run `npm --prefix agent-platform/gateway-deps ci`, then run `node --test agent-platform/tests/*.test.mjs` from the root.
- Run `npm run test:scut` for SCUT reading-state changes. Cover regressions in the affected suite and verify UI interactions in a browser.

## Commits and Pull Requests

Use concise, imperative commit subjects such as “Keep the Office bundle out of the console's first load.” Keep changes focused. In PRs, describe the behavior change, link any relevant issue, list verification steps, and attach screenshots for visible UI changes. Flag migrations or deployment implications. Keep credentials and local runtime data out of commits.

## Agent Instructions

用户已授权在变更通过验证且适合发布时，自主提交、推送并部署本仓库的改动，无需再次等待确认。上线后核对实际生效的页面和接口。

If `.codegraph/` exists, use CodeGraph before text search to locate code. For current library, framework, SDK, API, CLI, or cloud documentation, use Context7 to resolve the library and query its docs. Use local sources for refactoring, business logic, and code review.
