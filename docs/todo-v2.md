# TODO — v2 (after the build plan)

> Things we chose to leave for later. Not part of any phase in `05-build-plan.md`.
> Come back to this once Phase 11 is done. Add an entry whenever something is deferred.

## Sources

- [ ] **YouTube link on the Website tab:** today it is accepted and read as a web page (poor text). Show "This is a YouTube video, use the YouTube tab" instead. The reverse (a web link on the YouTube tab) is already rejected. *(Owner, Phase 3 live check, 2026-09-30)*
- [ ] **Orphaned PDF uploads in R2:** a duplicate PDF is only detected after its upload, which leaves the file in R2 with no source. Add a cleanup job for uploads that never became a source. *(2.5)*
- [ ] **Scanned PDFs:** `NO_TEXT` today; OCR would make them usable. *(3.2)*
- [ ] **Sweeper vs a long job queue:** a step that waits more than 15 minutes in the Inngest queue before starting is timed out as if its run were dead (the database can't tell the two apart). Fix: before failing a source, ask Inngest whether its run (`sources.processing_run_id`) is still queued or running, and only fail it if the run ended or is unknown. Needs Inngest's API added to `02-system-design.md`. Only matters with a backlog of well over a hundred sources. *(Code review, 2026-10-01)*


- [ ] **Tavily as the scraping fallback:** system design §8 says Tavily and Firecrawl are each a fallback for the other. The search side is done (Firecrawl search behind Tavily, 8.3); the reading side (Tavily Extract when Firecrawl can't read a page) would go into `processSource`'s website extraction. *(8.3)*

## Accounts and deploys

- [ ] **Clerk production instance:** still on dev keys (`pk_test_`), because a production instance needs a custom domain. Steps: domain on `curio-web` → Clerk "Create production instance" (clone dev settings) → Clerk's DNS records → own OAuth credentials for any social login → `pk_live_` / `sk_live_` keys in both Vercel projects → new origin in `CORS_ORIGINS` and the `curio-prod` R2 CORS policy. Users get new Clerk IDs, so dev-instance data is not carried over: switch **before** the Phase 11 demo notebook if the domain exists by then. *(1.x; 10.6)*
- [ ] **Vercel Preview env:** the Inngest, OpenAI, Firecrawl and transcript keys are Production only, so `curio-server` preview deployments won't boot. *(3.x)*
- [ ] **Leftover dev upload:** a 12.7 MB file in `curio-dev` from 2026-09-29 under user `7226501d…`, likely an orphan from manual testing. *(2026-09-30)*



## Tooling

- [ ] **Learning-path eval full run:** 3 topics × 3 runs (~$0.30, ~40 min) for consistency numbers and the topic without official docs (French Revolution); skipped by the owner. Before it: the runner should write results per topic and retry transient DB errors (a dropped Neon connection crashed the first attempt), and the owner reviews `evals/dataset/paths.json`. *(8.7)*
- [ ] **Python path misses collections and classes:** the tutorial's classes chapter is past `officialSectionPages` (8). *(8.7)*

- [ ] **TypeScript 7:** pinned to `~6.0` because typescript-eslint 8.x doesn't support TS 7. Revisit when it does. *(0.1)*



## Not yet exercised live

- [ ] A password-protected PDF, and a YouTube video without captions (both covered by tests with fakes only). *(3.2)*