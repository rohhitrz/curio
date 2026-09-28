# PROGRESS — Curio

> Updated by the agent in the same commit as each completed step.
> Read this first in every new session.

## Current status
- **Phase:** 0 (Foundation)
- **Next step:** 0.2
- **State:** In progress

## Phases
| # | Phase | Status |
|---|---|---|
| 0 | Foundation | 🔨 In progress |
| 1 | Auth + notebooks + first deploy | ⏳ Not started |
| 2 | Sources (no processing) | ⏳ Not started |
| 3 | Ingestion pipeline | ⏳ Not started |
| 4 | Eval foundation | ⏳ Not started |
| 5 | Basic RAG chat | ⏳ Not started |
| 6 | Advanced retrieval | ⏳ Not started |
| 7 | Memory | ⏳ Not started |
| 8 | Learning paths | ⏳ Not started |
| 9 | Lessons | ⏳ Not started |
| 10 | Hardening | ⏳ Not started |
| 11 | Final evals + polish | ⏳ Not started |

Status values: ⏳ Not started · 🔨 In progress · ✅ Done (owner approved)

## Current phase steps: Phase 0
- [x] 0.1 Root: pnpm workspace, tsconfig, ESLint + Prettier, .gitignore, .env.example
- [ ] 0.2 packages/shared: Zod, error codes, error + pagination schemas
- [ ] 0.3 apps/server: Express 5, pino, helmet, CORS, error handler, /health
- [ ] 0.4 config/: env validation, limits, models, feature flags
- [ ] 0.5 Drizzle + Neon: pooled connection, drizzle-kit, vector extension migration
- [ ] 0.6 Vitest on Neon test branch; /health test
- [ ] 0.7 apps/web: Next.js, Tailwind, shadcn/ui, TanStack Query, API client

## Accounts & keys
| Service | Needed in phase | Status |
|---|---|---|
| Neon | 0 | ⬜ Not set up |
| Clerk | 1 | ⬜ Not set up |
| Vercel | 1 | ⬜ Not set up |
| Cloudflare R2 | 2 | ⬜ Not set up |
| Inngest | 3 | ⬜ Not set up |
| OpenAI | 3 | ⬜ Not set up |
| Firecrawl | 3 | ⬜ Not set up |
| Transcript API | 3 | ⬜ Not set up |
| Langfuse | 5 | ⬜ Not set up |
| Upstash | 5 | ⬜ Not set up |
| Cohere / Jina | 6 | ⬜ Not set up |
| Tavily | 8 | ⬜ Not set up |

## Blockers
- None

## Eval results so far
- None yet (baseline comes in Phase 4)

## Session log
<!-- Newest first. One entry per session:
### YYYY-MM-DD
- Done: steps X.Y–X.Z
- Commits: <short hashes>
- Notes: anything the next session must know
-->

### 2026-09-28
- Done: repo setup (private GitHub `rohhitrz/curio`), step 0.1
- Notes: TypeScript pinned to `~6.0` because typescript-eslint 8.x doesn't support TS 7 yet; revisit when it does. Root `.env` holds all env vars (`.env.example` lists Phase 0 keys only; each phase adds its own).
