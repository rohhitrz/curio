import { InngestTestEngine, mockCtx } from '@inngest/test';
import { and, eq } from 'drizzle-orm';
import pino from 'pino';
import { beforeEach, describe, expect, it } from 'vitest';
import { learningPaths as learningPathsConfig } from '../../src/config/index.js';
import { learningPaths, pathResources, sources, users } from '../../src/db/schema/index.js';
import { LlmError } from '../../src/errors/llm-error.js';
import { SearchError } from '../../src/errors/search-error.js';
import { createGenerateLearningPathFunction } from '../../src/inngest/generate-learning-path.js';
import { createProcessSourceFunction } from '../../src/inngest/process-source.js';
import { createInngestClient } from '../../src/lib/jobs/index.js';
import type { SearchProvider, SearchRequest, SearchResult } from '../../src/lib/search/index.js';
import type { Judgement } from '../../src/pipelines/learning/gather.js';
import { createLearningPathsRepository } from '../../src/repositories/learning-paths.repository.js';
import { createLearningPathGenerationService } from '../../src/services/learning-path-generation.service.js';
import { sha256Hex } from '../../src/services/source-identity.js';
import { createFakeLlm, type FakeLlm } from '../fakes/llm.js';
import { createFakeTracer } from '../fakes/tracing.js';
import { getTestDb, truncateAllTables } from '../helpers/db.js';
import { seedLearningPath } from '../helpers/learning.js';

const db = getTestDb();
const logger = pino({ level: 'silent' });
const client = createInngestClient({
  isDev: true,
  logger,
  fetch: () => Promise.reject(new Error('network is blocked in tests')),
});
const processSource = createProcessSourceFunction(client, {} as never);

/** What each search returns, by the purpose its query shows. */
const RESULTS: Record<'official' | 'popular' | 'video', SearchResult[]> = {
  official: [
    { title: 'DL Guide', url: 'https://docs.example.org/guide', snippet: 'Docs', score: 0.9 },
    { title: 'DL Wiki', url: 'https://wiki.example.com/dl', snippet: 'Wiki', score: 0.8 },
  ],
  popular: [
    { title: 'A', url: 'https://a.example.com/dl', snippet: '', score: 0.7 },
    { title: 'B', url: 'https://b.example.com/dl', snippet: '', score: 0.7 },
    { title: 'C', url: 'https://c.example.com/dl', snippet: '', score: 0.7 },
    { title: 'D', url: 'https://d.example.com/dl', snippet: '', score: 0.7 },
    { title: 'Buy', url: 'https://spam.example.com/buy', snippet: '', score: 0.7 },
  ],
  video: [
    {
      title: 'Video',
      url: 'https://www.youtube.com/watch?v=aircAruvnKk',
      snippet: '',
      score: 0.6,
    },
  ],
};
// Candidate order: official results, popular, video (see `toCandidates`).
const URLS = [...RESULTS.official, ...RESULTS.popular, ...RESULTS.video].map((r) => r.url);
const VIDEO_URL = 'https://www.youtube.com/watch?v=aircAruvnKk';

function purposeOf(request: SearchRequest): 'official' | 'popular' | 'video' {
  if (request.includeDomains?.includes('youtube.com')) return 'video';
  return request.query.includes('official documentation') ? 'official' : 'popular';
}

let searches: SearchRequest[];
let searchFailures: Partial<Record<'official' | 'popular' | 'video', Error>>;
let llm: FakeLlm;
/** How the fake ingestion leaves a source, by URL; default `READY`. `LEAVE` keeps it `PENDING`. */
let outcomes: Record<string, 'READY' | 'FAILED' | 'LEAVE'>;
let invoked: Set<string>;
/** Distinct sleep steps (the handler re-runs once per step, so a sleep is seen many times). */
let sleeps: Set<string>;
let userId: string;
let pathId: string;
let notebookId: string;
let currentAttempt = 0;

const search: SearchProvider = {
  search(request) {
    searches.push(request);
    const purpose = purposeOf(request);
    const failure = searchFailures[purpose];
    return failure ? Promise.reject(failure) : Promise.resolve(RESULTS[purpose]);
  },
};

/**
 * The model's judgements: the docs site official (5), the video 4, the rest 3; the spam page
 * irrelevant. Selected: docs, video, wiki, a, b, c (d is the sixth popular page: cut).
 */
function judgements(overrides: (j: Judgement) => Judgement = (j) => j): string {
  return JSON.stringify({
    judgements: URLS.map((url, index) =>
      overrides({
        index,
        relevant: !url.includes('spam'),
        official: url.includes('docs.example.org'),
        authority: url.includes('docs.example.org') ? 5 : url === VIDEO_URL ? 4 : 3,
        format: url.includes('docs.example.org') ? 'DOCS' : 'ARTICLE',
      }),
    ),
  });
}

/** Stands in for `processSource`: sets the source as `outcomes` says (only from `PENDING`). */
async function fakeIngest(sourceId: string) {
  invoked.add(sourceId);
  const [source] = await db.select().from(sources).where(eq(sources.id, sourceId));
  const outcome = (source?.url && outcomes[source.url]) ?? 'READY';
  if (outcome === 'LEAVE') return;
  await db
    .update(sources)
    .set(
      outcome === 'READY'
        ? { status: 'READY', errorCode: null }
        : { status: 'FAILED', errorCode: 'PAGE_NOT_FOUND', errorMessage: 'Gone' },
    )
    .where(and(eq(sources.id, sourceId), eq(sources.status, 'PENDING')));
}

function createFunction() {
  const service = createLearningPathGenerationService({
    repository: createLearningPathsRepository(db),
    search,
    llm: llm.provider,
    tracer: createFakeTracer().tracer,
    logger,
    limits: learningPathsConfig,
  });
  return createGenerateLearningPathFunction(client, service, processSource, logger);
}

/**
 * Runs the job for the path. Ingestion runs and sleeps are stood in for in the context (the
 * test engine can't run an invoked function), so the handler sees them resolve.
 */
function run(attempt = 0, data: Record<string, unknown> = { pathId, userId }) {
  currentAttempt = attempt;
  const transformCtx = (ctx: Parameters<typeof mockCtx>[0]) => {
    const mocked = mockCtx(ctx);
    return {
      ...mocked,
      attempt: currentAttempt,
      step: {
        ...mocked.step,
        invoke: async (_id: string, opts: { data: { sourceId: string } }) => {
          await fakeIngest(opts.data.sourceId);
          return { status: 'ok' };
        },
        sleep: (id: string) => {
          sleeps.add(id);
          return Promise.resolve();
        },
      } as unknown as typeof mocked.step,
    };
  };
  const engine = new InngestTestEngine({ function: createFunction(), transformCtx });
  return engine.execute({ events: [{ name: 'path/requested', data }] });
}

async function path() {
  const [row] = await db.select().from(learningPaths).where(eq(learningPaths.id, pathId));
  return row;
}

const resources = () =>
  db
    .select({
      role: pathResources.role,
      resourceType: pathResources.resourceType,
      url: pathResources.url,
      sourceId: pathResources.sourceId,
    })
    .from(pathResources)
    .where(eq(pathResources.pathId, pathId));

beforeEach(async () => {
  await truncateAllTables();
  searches = [];
  searchFailures = {};
  llm = createFakeLlm(judgements());
  outcomes = {};
  invoked = new Set();
  sleeps = new Set();
  const [user] = await db.insert(users).values({ clerkUserId: 'user_learner' }).returning();
  if (!user) throw new Error('user not created');
  userId = user.id;
  const seeded = await seedLearningPath(userId);
  pathId = seeded.path.id;
  notebookId = seeded.notebook.id;
});

describe('generateLearningPath, part 1 (gather → read)', () => {
  it('gathers 1 official + popular resources, reads them all, and moves to MAPPING', async () => {
    const { result, error, ctx } = await run();

    expect(error).toBeUndefined();
    expect(result).toEqual({ status: 'read', ready: 6, total: 6 });
    expect(ctx.step.run.mock.calls.map(([id]) => id)).toEqual([
      'claim',
      'search',
      'select',
      'save-resources',
      'finish-reading-0',
    ]);
    expect((await path())?.status).toBe('MAPPING');
    expect(searches).toHaveLength(3);

    const saved = await resources();
    expect(saved).toHaveLength(6);
    expect(saved.filter((r) => r.role === 'OFFICIAL')).toEqual([
      expect.objectContaining({ resourceType: 'DOCS', url: 'https://docs.example.org/guide' }),
    ]);
    expect(saved.map((r) => r.url)).not.toContain('https://spam.example.com/buy');
    expect(saved.find((r) => r.url === VIDEO_URL)?.resourceType).toBe('VIDEO');

    const rows = await db.select().from(sources).where(eq(sources.notebookId, notebookId));
    expect(rows).toHaveLength(6);
    expect(rows.every((s) => s.origin === 'LEARNING_PATH' && s.status === 'READY')).toBe(true);
    expect(rows.find((s) => s.url === VIDEO_URL)).toMatchObject({
      type: 'YOUTUBE',
      metadata: { videoId: 'aircAruvnKk' },
    });
    expect(invoked).toEqual(new Set(rows.map((s) => s.id)));
  });

  it('2 of 6 resources fail → the path carries on', async () => {
    outcomes = { 'https://a.example.com/dl': 'FAILED', [VIDEO_URL]: 'FAILED' };

    const { result } = await run();

    expect(result).toEqual({ status: 'read', ready: 4, total: 6 });
    expect((await path())?.status).toBe('MAPPING');
  });

  it('4 of 6 resources fail → FAILED with the count', async () => {
    outcomes = Object.fromEntries(URLS.slice(1, 5).map((url) => [url, 'FAILED']));

    const { result } = await run();

    expect(result).toEqual({ status: 'stopped', reason: 'failed', code: 'TOO_FEW_RESOURCES' });
    expect(await path()).toMatchObject({
      status: 'FAILED',
      errorCode: 'TOO_FEW_RESOURCES',
      errorMessage: expect.stringContaining('Only 2 of 6 resources could be read') as string,
    });
  });

  it('retry: no new search; read resources are reused, failed ones read again', async () => {
    outcomes = Object.fromEntries(URLS.slice(1, 5).map((url) => [url, 'FAILED']));
    await run();
    const readyBefore = (await db.select().from(sources)).filter((s) => s.status === 'READY');
    // What the retry endpoint does (8.5): back to GATHERING, then a new event.
    await db.update(learningPaths).set({ status: 'GATHERING' }).where(eq(learningPaths.id, pathId));
    searches = [];
    invoked = new Set();
    outcomes = {};

    const { result, ctx } = await run();

    expect(result).toEqual({ status: 'read', ready: 6, total: 6 });
    expect(searches).toEqual([]);
    expect(ctx.step.run.mock.calls.map(([id]) => id)).not.toContain('search');
    expect(invoked.size).toBe(4);
    for (const source of readyBefore) expect(invoked.has(source.id)).toBe(false);
    expect(await resources()).toHaveLength(6);
    expect(await path()).toMatchObject({ status: 'MAPPING', errorCode: null });
  });

  it('a topic without official docs: the most authoritative page takes the official role', async () => {
    llm = createFakeLlm(
      judgements((j) => ({
        ...j,
        official: false,
        authority: URLS[j.index] === 'https://wiki.example.com/dl' ? 5 : 3,
        format: 'ARTICLE',
      })),
    );

    const { result } = await run();

    expect(result).toMatchObject({ status: 'read' });
    expect((await resources()).find((r) => r.role === 'OFFICIAL')).toMatchObject({
      url: 'https://wiki.example.com/dl',
      resourceType: 'ARTICLE',
    });
  });

  it('one search failing is fine; all failing retries, then fails the path', async () => {
    searchFailures = { video: new SearchError(false, 'down') };
    expect((await run()).result).toMatchObject({ status: 'read', total: 6 });
    expect((await resources()).map((r) => r.resourceType)).not.toContain('VIDEO');

    await truncateAllTables();
    const [user] = await db.insert(users).values({ clerkUserId: 'user_again' }).returning();
    if (!user) throw new Error('user not created');
    userId = user.id;
    pathId = (await seedLearningPath(userId)).path.id;
    const down = new SearchError(true, 'down');
    searchFailures = { official: down, popular: down, video: down };

    const early = await run(0);
    expect(early.error).toBeDefined();
    expect((await path())?.status).toBe('GATHERING');

    const last = await run(learningPathsConfig.jobRetries);
    expect(last.result).toEqual({ status: 'stopped', reason: 'failed', code: 'SEARCH_FAILED' });
    expect((await path())?.errorCode).toBe('SEARCH_FAILED');
  });

  it('the model down on the last attempt → search order picks the resources', async () => {
    llm = createFakeLlm(new LlmError(true, 'overloaded'));

    const { result } = await run(learningPathsConfig.jobRetries);

    expect(result).toMatchObject({ status: 'read' });
    expect((await resources()).find((r) => r.role === 'OFFICIAL')?.url).toBe(
      'https://docs.example.org/guide',
    );
  });

  it('the model down before the last attempt → the step throws, to be retried', async () => {
    llm = createFakeLlm(new LlmError(true, 'overloaded'));

    const { error } = await run(0);

    expect(error).toBeDefined();
    expect(await resources()).toHaveLength(0);
  });

  it('too few usable results → NO_RESOURCES, nothing saved', async () => {
    llm = createFakeLlm(
      judgements((j) => ({ ...j, relevant: URLS[j.index] === 'https://docs.example.org/guide' })),
    );

    const { result } = await run();

    expect(result).toEqual({ status: 'stopped', reason: 'failed', code: 'NO_RESOURCES' });
    expect(await resources()).toHaveLength(0);
    expect((await path())?.status).toBe('FAILED');
  });

  it('a page already in the notebook is reused, not added twice', async () => {
    const [existing] = await db
      .insert(sources)
      .values({
        notebookId,
        userId,
        type: 'WEBSITE',
        title: 'Mine',
        url: 'https://a.example.com/dl/',
        contentHash: sha256Hex('https://a.example.com/dl'),
        status: 'READY',
      })
      .returning();

    await run();

    expect((await resources()).find((r) => r.url === 'https://a.example.com/dl')?.sourceId).toBe(
      existing?.id,
    );
    expect(await db.select().from(sources)).toHaveLength(6);
  });

  it('sources still being read are waited for, then count as not read', async () => {
    outcomes = { [VIDEO_URL]: 'LEAVE' };

    const { result } = await run();

    expect(sleeps.size).toBe(learningPathsConfig.inFlightRecheck.times);
    expect(result).toEqual({ status: 'read', ready: 5, total: 6 });
  });

  it('a path not in GATHERING (a duplicate event) stops at the claim', async () => {
    await db.update(learningPaths).set({ status: 'READING' }).where(eq(learningPaths.id, pathId));

    const { result, ctx } = await run();

    expect(result).toEqual({ status: 'stopped', reason: 'not_gathering' });
    expect(ctx.step.run).toHaveBeenCalledTimes(1);
  });

  it("another user's path reads as missing", async () => {
    const [other] = await db.insert(users).values({ clerkUserId: 'user_other' }).returning();

    const { result } = await run(0, { pathId, userId: other?.id });

    expect(result).toEqual({ status: 'stopped', reason: 'not_found' });
    expect((await path())?.status).toBe('GATHERING');
  });

  it('is configured with the retry and concurrency limits from config', () => {
    expect(createFunction().opts).toMatchObject({
      id: 'generate-learning-path',
      retries: learningPathsConfig.jobRetries,
      concurrency: [
        { limit: learningPathsConfig.concurrency },
        { limit: learningPathsConfig.concurrencyPerUser, key: 'event.data.userId' },
      ],
    });
  });
});
