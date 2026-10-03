# CLAUDE.md — Curio

NotebookLM-style learning app: sources or a topic → grounded, cited answers,
learning paths, lessons. Showcase: reliable ingestion + eval-proven RAG.

## Read first, every session
1. `docs/PROGRESS.md` (where we are)
2. `docs/05-build-plan.md` (current phase steps)
3. Only the docs the step touches: `01-prd` · `02-system-design` ·
   `03-database-design` · `04-api-design` · `06-test-plan` · `07-decisions`

Docs are the source of truth. If code and docs disagree, stop and ask.

## Every step
Build → targeted tests pass (unit + the integration files the change
touches) → lint + typecheck → update `PROGRESS.md` → commit (code +
PROGRESS together)

## Checkpoints (mid-phase and phase end)
`pnpm db:test:up` (local test Postgres in Docker) → full test suite
(under a minute) passes → push. Every push to `main` deploys, so nothing
is pushed without a full run. Don't run two integration runs at once:
they share the local test database.

## Git
- Conventional Commits (`feat(scope): …`, `fix(scope): …`)
- Never change git config or identity
- **Never add Claude as co-author or any Claude attribution**
- Never commit `.env` or secrets
- Push fails → stop and tell the owner

## Stop and ask when
- A phase is complete (summarize + how to verify, wait for approval)
- A key or account is missing from `.env` (never invent or placeholder)
- A step is marked 🛑 STOP
- A doc seems wrong or conflicts with another (propose the doc change first)
- Adding a dependency or service not in `02-system-design.md`

## Rules that must never break
- Layering: Route → Controller → Service → Repository → DB
- External services only via provider interfaces in `src/lib/`
- Limits, models, thresholds, flags only in `src/config/`
- Every query scoped by `userId`; others' resources → 404
- Every input validated with Zod from `packages/shared`
- Tests never call external APIs (fake providers, local test Postgres)
- Only `pnpm eval` calls real LLM APIs, and only when a step says so
- TypeScript strict, ESM