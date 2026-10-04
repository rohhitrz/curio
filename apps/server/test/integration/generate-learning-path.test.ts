import { InngestTestEngine, mockCtx } from '@inngest/test';
import { and, eq } from 'drizzle-orm';
import pino from 'pino';
import { beforeEach, describe, expect, it } from 'vitest';
import { learningPaths as learningPathsConfig } from '../../src/config/index.js';
import {
  conceptCoverage,
  concepts,
  learningPaths,
  modules,
  pathResources,
  sources,
  users,
} from '../../src/db/schema/index.js';
import type { LlmTask } from '../../src/config/index.js';
import type { LlmProvider, LlmRequest } from '../../src/lib/llm/index.js';
import { LlmError } from '../../src/errors/llm-error.js';
import { SearchError } from '../../src/errors/search-error.js';
import { createGenerateLearningPathFunction } from '../../src/inngest/generate-learning-path.js';
import { createProcessSourceFunction } from '../../src/inngest/process-source.js';
import { createInngestClient } from '../../src/lib/jobs/index.js';
import type { SearchProvider, SearchRequest, SearchResult } from '../../src/lib/search/index.js';
import type { Judgement } from '../../src/pipelines/learning/gather.js';
import { createLearningPathsRepository } from '../../src/repositories/learning-paths.repository.js';
import { createLearningPathGenerationService } from '../../src/services/learning-path-generation.service.js';
import { createLearningPathOutlineService } from '../../src/services/learning-path-outline.service.js';
import { sha256Hex } from '../../src/services/source-identity.js';
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
let llm: ReturnType<typeof createRoutedLlm>;
/** What the branch wait does each time (the test engine can't wait for an event). */
let onWaitForBranch: (id: string) => Promise<unknown>;
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

/** Shorter than the real 72 slices: the test engine re-runs the handler once per step. */
const BRANCH_WAIT = { every: '1h', times: 3 };
const CORE = ['Neurons', 'Backpropagation'];
const OFFICIAL_ONLY = ['Gradient descent', 'Loss functions', 'Activation functions'];
const HOOK = { what: 'w', why: 'y', example: 'e', origin: 'o' };

/**
 * An LLM without API calls that answers by task, like the real prompts would be answered:
 * - map: every resource covers the core concepts; the official one 3 more; each one its own.
 * - merge: groups concepts by name. order: modules of 2 concepts, 2 branches when advanced.
 * `fail[task]` queues errors for that task; `failMapFor` fails map calls for those titles.
 */
function createRoutedLlm(selection: string | Error = judgements()) {
  const requests: LlmRequest[] = [];
  const fail: Partial<Record<LlmTask, Error[]>> = {};
  const failMapFor = new Set<string>();

  function answer(request: LlmRequest): unknown {
    const content = request.messages[0]?.content ?? '';
    switch (request.task) {
      case 'resourceSelection':
        if (selection instanceof Error) throw selection;
        return JSON.parse(selection) as unknown;
      case 'conceptMap': {
        const title = /Resource: (.*)/.exec(content)?.[1] ?? '';
        if (failMapFor.has(title)) throw new LlmError(true, 'map failed');
        const names = [...CORE, ...(title === 'DL Guide' ? OFFICIAL_ONLY : []), `Only in ${title}`];
        return { concepts: names.map((name) => ({ name, description: `About ${name}` })) };
      }
      // The model's own list (L-09): the core and one concept the official docs also cover.
      case 'conceptRecall':
        return {
          concepts: [...CORE, 'Gradient descent'].map((name) => ({
            name,
            description: `About ${name}`,
          })),
        };
      case 'conceptMerge': {
        const groups = new Map<string, string[]>();
        for (const [, id, name] of content.matchAll(/^\s+(\d+\.\d+) ([^:]+):/gm)) {
          if (!id || !name) continue;
          groups.set(name, [...(groups.get(name) ?? []), id]);
        }
        return {
          groups: [...groups].map(([name, members]) => ({
            name,
            description: `About ${name}`,
            members,
          })),
        };
      }
      case 'learningPath': {
        const numbers = [...content.matchAll(/^(\d+)\. ([^:]+):/gm)].map((m) => Number(m[1]));
        const modules = [];
        for (let i = 0; i < numbers.length; i += 2) {
          modules.push({
            title: `Module ${String(modules.length + 1)}`,
            summary: 'Summary',
            why: `Why module ${String(modules.length + 1)}`,
            difficulty: modules.length === 0 ? 'BEGINNER' : 'INTERMEDIATE',
            items: numbers
              .slice(i, i + 2)
              .map((n) => ({ concept: n, name: 'x', description: 'd' })),
          });
        }
        const branches = content.includes('Level: advanced')
          ? [
              { name: 'Foundations', description: 'The basics, deeper', modules: [1, 2] },
              { name: 'Deep dive', description: 'The rest', modules: [3, 4, 5] },
            ]
          : [];
        return { modules, branches };
      }
      case 'pathHook':
        return HOOK;
      default:
        throw new Error(`unexpected task ${request.task}`);
    }
  }

  const provider: LlmProvider = {
    generate: () => Promise.reject(new Error('not used')),
    stream: () => {
      throw new Error('not used');
    },
    generateObject(request, schema) {
      requests.push(request);
      const failure = fail[request.task]?.shift();
      if (failure) return Promise.reject(failure);
      try {
        const object = schema.parse(answer(request));
        return Promise.resolve({
          object,
          model: 'fake-llm',
          usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 },
        });
      } catch (err) {
        return Promise.reject(err instanceof Error ? err : new Error(String(err)));
      }
    },
  };
  return { provider, requests, fail, failMapFor };
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
        ? { status: 'READY', errorCode: null, extractedText: `Text of ${source?.title ?? ''}` }
        : { status: 'FAILED', errorCode: 'PAGE_NOT_FOUND', errorMessage: 'Gone' },
    )
    .where(and(eq(sources.id, sourceId), eq(sources.status, 'PENDING')));
}

function createFunction() {
  const deps = {
    repository: createLearningPathsRepository(db),
    llm: llm.provider,
    tracer: createFakeTracer().tracer,
    logger,
    // The fixture has 11 concepts: a floor of 5 lets the consensus thresholds decide the cut.
    limits: {
      ...learningPathsConfig,
      cut: { ...learningPathsConfig.cut, beginnerMinConcepts: 5, intermediateMinConcepts: 5 },
    },
  };
  return createGenerateLearningPathFunction(
    client,
    createLearningPathGenerationService({ ...deps, search }),
    createLearningPathOutlineService(deps),
    processSource,
    logger,
    { inFlightRecheck: learningPathsConfig.inFlightRecheck, branchWait: BRANCH_WAIT },
  );
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
        waitForEvent: (id: string) => onWaitForBranch(id),
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
  llm = createRoutedLlm();
  onWaitForBranch = () => Promise.resolve(null);
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

/**
 * A full beginner run: 6 resources mapped into 11 concepts (2 covered by all, 3 by the official
 * docs only, 6 by one resource each); the 2 high ones pass, 3 more are added back to reach the
 * minimum; modules of 2 → 3 modules kept.
 */
const BEGINNER_READY = { status: 'ready', modules: 3, included: 5, skipped: 6 };

describe('generateLearningPath, part 1 (gather → read)', () => {
  it('gathers 1 official + popular resources and reads them all', async () => {
    const { result, error, ctx } = await run();

    expect(error).toBeUndefined();
    expect(result).toEqual(BEGINNER_READY);
    expect(ctx.step.run.mock.calls.map(([id]) => id).slice(0, 5)).toEqual([
      'claim',
      'search',
      'select',
      'save-resources',
      'finish-reading-0',
    ]);
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
    // Only the official docs are read as a section (L-08).
    const official = 'https://docs.example.org/guide';
    expect(rows.find((s) => s.url === official)?.metadata).toMatchObject({
      sectionPages: learningPathsConfig.officialSectionPages,
    });
    const others = rows.filter((s) => s.url !== official);
    expect(others.some((s) => 'sectionPages' in s.metadata)).toBe(false);
    expect(invoked).toEqual(new Set(rows.map((s) => s.id)));
  });

  it('2 of 6 resources fail → the path carries on', async () => {
    outcomes = { 'https://a.example.com/dl': 'FAILED', [VIDEO_URL]: 'FAILED' };

    const { result } = await run();

    expect(result).toMatchObject({ status: 'ready' });
    expect((await path())?.status).toBe('READY');
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

    expect(result).toEqual(BEGINNER_READY);
    expect(searches).toEqual([]);
    expect(ctx.step.run.mock.calls.map(([id]) => id)).not.toContain('search');
    expect(invoked.size).toBe(4);
    for (const source of readyBefore) expect(invoked.has(source.id)).toBe(false);
    expect(await resources()).toHaveLength(6);
    expect(await path()).toMatchObject({ status: 'READY', errorCode: null });
  });

  it('a topic without official docs: the most authoritative page takes the official role', async () => {
    llm = createRoutedLlm(
      judgements((j) => ({
        ...j,
        official: false,
        authority: URLS[j.index] === 'https://wiki.example.com/dl' ? 5 : 3,
        format: 'ARTICLE',
      })),
    );

    const { result } = await run();

    expect(result).toMatchObject({ status: 'ready' });
    expect((await resources()).find((r) => r.role === 'OFFICIAL')).toMatchObject({
      url: 'https://wiki.example.com/dl',
      resourceType: 'ARTICLE',
    });
  });

  it('one search failing is fine; all failing retries, then fails the path', async () => {
    searchFailures = { video: new SearchError(false, 'down') };
    expect((await run()).result).toMatchObject({ status: 'ready' });
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
    llm = createRoutedLlm(new LlmError(true, 'overloaded'));

    const { result } = await run(learningPathsConfig.jobRetries);

    expect(result).toMatchObject({ status: 'ready' });
    expect((await resources()).find((r) => r.role === 'OFFICIAL')?.url).toBe(
      'https://docs.example.org/guide',
    );
  });

  it('the model down before the last attempt → the step throws, to be retried', async () => {
    llm = createRoutedLlm(new LlmError(true, 'overloaded'));

    const { error } = await run(0);

    expect(error).toBeDefined();
    expect(await resources()).toHaveLength(0);
  });

  it('too few usable results → NO_RESOURCES, nothing saved', async () => {
    llm = createRoutedLlm(
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
    expect(result).toMatchObject({ status: 'ready' });
    const mappedTitles = llm.requests
      .filter((r) => r.task === 'conceptMap')
      .map((r) => /Resource: (.*)/.exec(r.messages[0]?.content ?? '')?.[1]);
    expect(new Set(mappedTitles).size).toBe(5);
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

const savedOutline = async () => ({
  modules: await db
    .select()
    .from(modules)
    .where(eq(modules.pathId, pathId))
    .orderBy(modules.position),
  concepts: await db.select().from(concepts).where(eq(concepts.pathId, pathId)),
  coverage: await db.select().from(conceptCoverage),
});

async function setLevel(level: 'BEGINNER' | 'INTERMEDIATE' | 'ADVANCED') {
  await db.update(learningPaths).set({ level }).where(eq(learningPaths.id, pathId));
}

describe('generateLearningPath, part 2 (map → outline → READY)', () => {
  it('beginner: concepts, coverage, modules and hook saved; status moves through to READY', async () => {
    const { result, ctx } = await run();

    expect(result).toEqual(BEGINNER_READY);
    const steps = ctx.step.run.mock.calls.map(([id]) => (typeof id === 'string' ? id : id.id));
    expect(steps.filter((id) => id.startsWith('map-'))).toHaveLength(6);
    // The official docs get the bigger map budget (L-08). Parallel steps may run more than once.
    const asked = new Map(
      llm.requests
        .filter((r) => r.task === 'conceptMap')
        .map((r) => {
          const content = r.messages[0]?.content ?? '';
          return [/Resource: (.*)/.exec(content)?.[1], /List at most (\d+)/.exec(content)?.[1]];
        }),
    );
    expect(asked.size).toBe(6);
    expect(
      [...asked].filter(([, max]) => max !== String(learningPathsConfig.maxConceptsPerResource)),
    ).toEqual([['DL Guide', String(learningPathsConfig.officialMaxConcepts)]]);
    expect(steps.slice(-5)).toEqual(['merge', 'order', 'build', 'hook', 'save']);
    expect(steps).not.toContain('offer-branches');
    expect((await path())?.status).toBe('READY');

    const outline = await savedOutline();
    expect(outline.modules.map((m) => [m.position, m.title])).toEqual([
      [1, 'Module 1'],
      [2, 'Module 2'],
      [3, 'Module 3'],
    ]);
    // The order step's why and difficulty are saved with each module.
    expect(outline.modules.map((m) => [m.why, m.difficulty])).toEqual([
      ['Why module 1', 'BEGINNER'],
      ['Why module 2', 'INTERMEDIATE'],
      ['Why module 3', 'INTERMEDIATE'],
    ]);
    // Every mapped resource is marked, for the progress screen.
    const marked = await db.select({ mappedAt: pathResources.mappedAt }).from(pathResources);
    expect(marked.every((r) => r.mappedAt !== null)).toBe(true);
    const included = outline.concepts.filter((c) => c.status === 'INCLUDED');
    expect(included.map((c) => c.name).sort()).toEqual([...CORE, ...OFFICIAL_ONLY].sort());
    expect(included.every((c) => c.moduleId !== null && c.position !== null)).toBe(true);
    const skipped = outline.concepts.filter((c) => c.status === 'SKIPPED');
    expect(skipped).toHaveLength(6);
    expect(skipped[0]).toMatchObject({
      moduleId: null,
      skipReason: 'Covered by 1 of 6 resources, beyond the basics',
    });
    const neurons = outline.concepts.find((c) => c.name === 'Neurons');
    expect(neurons?.consensusScore).toBe(1);
    expect(outline.coverage.filter((r) => r.conceptId === neurons?.id)).toHaveLength(6);
    // The model's own list votes (L-09): official 2 + model 1 of 2 + 5 + 1, never as coverage.
    expect(steps).toContain('recall');
    const descent = outline.concepts.find((c) => c.name === 'Gradient descent');
    expect(descent?.consensusScore).toBe(0.375);
    expect(outline.coverage.filter((r) => r.conceptId === descent?.id)).toHaveLength(1);
    expect((await path())?.hook).toEqual(HOOK);
  });

  it('advanced: pauses at AWAITING_BRANCH with the options; the pick resumes it and only that branch is kept', async () => {
    await setLevel('ADVANCED');
    const seen: unknown[] = [];
    onWaitForBranch = async () => {
      const row = await path();
      seen.push({ status: row?.status, options: row?.branchOptions });
      // What the branch endpoint does (8.5): save the pick, then send the event.
      await db
        .update(learningPaths)
        .set({ selectedBranch: 'Deep dive' })
        .where(eq(learningPaths.id, pathId));
      return { name: 'path/branch-selected', data: { pathId, userId } };
    };

    const { result } = await run();

    expect(seen[0]).toEqual({
      status: 'AWAITING_BRANCH',
      options: [
        { name: 'Foundations', description: 'The basics, deeper' },
        { name: 'Deep dive', description: 'The rest' },
      ],
    });
    expect(result).toMatchObject({ status: 'ready', modules: 3, included: 6 });
    const outline = await savedOutline();
    expect(
      outline.concepts.filter((c) => c.status === 'INCLUDED').map((c) => c.name),
    ).not.toContain('Neurons');
    expect(outline.concepts.find((c) => c.name === 'Neurons')?.skipReason).toBe(
      'Not in the branch you picked',
    );
    expect(await path()).toMatchObject({ status: 'READY', selectedBranch: 'Deep dive' });
  });

  it('advanced: no pick in time → FAILED BRANCH_NOT_PICKED', async () => {
    await setLevel('ADVANCED');

    const { result } = await run();

    expect(result).toEqual({ status: 'stopped', reason: 'failed', code: 'BRANCH_NOT_PICKED' });
    expect((await path())?.errorCode).toBe('BRANCH_NOT_PICKED');
  });

  it('2 resources not mapped (last attempt) → the path is still built from the rest', async () => {
    llm.failMapFor.add('A');
    llm.failMapFor.add('B');

    const { result } = await run(learningPathsConfig.jobRetries);

    expect(result).toMatchObject({ status: 'ready' });
    expect((await savedOutline()).concepts.find((c) => c.name === 'Neurons')?.consensusScore).toBe(
      1,
    );
    const marked = await db
      .select({ title: pathResources.title, mappedAt: pathResources.mappedAt })
      .from(pathResources);
    expect(
      marked
        .filter((r) => r.mappedAt === null)
        .map((r) => r.title)
        .sort(),
    ).toEqual(['A', 'B']);
  });

  it('4 resources not mapped → FAILED with the count', async () => {
    for (const title of ['A', 'B', 'C', 'Video']) llm.failMapFor.add(title);

    const { result } = await run(learningPathsConfig.jobRetries);

    expect(result).toEqual({ status: 'stopped', reason: 'failed', code: 'TOO_FEW_RESOURCES' });
    expect((await path())?.errorMessage).toContain(
      'Only 2 of 6 resources could be turned into concepts',
    );
  });

  it('a map failure before the last attempt throws, to be retried', async () => {
    llm.failMapFor.add('A');

    const { error } = await run(0);

    expect(error).toBeDefined();
    expect((await path())?.status).toBe('MAPPING');
  });

  it("the model's own list failing on the last attempt → built from the resources alone", async () => {
    llm.fail.conceptRecall = [new LlmError(true, 'down')];

    const { result } = await run(learningPathsConfig.jobRetries);

    expect(result).toEqual(BEGINNER_READY);
    const descent = (await savedOutline()).concepts.find((c) => c.name === 'Gradient descent');
    expect(descent?.consensusScore).toBe(0.286);
  });

  it('the hook failing on the last attempt → READY without a hook', async () => {
    llm.fail.pathHook = [new LlmError(true, 'down')];

    const { result } = await run(learningPathsConfig.jobRetries);

    expect(result).toEqual(BEGINNER_READY);
    expect(await path()).toMatchObject({ status: 'READY', hook: null });
  });

  it('merge failing throws (retried; the last failure fails the path through onFailure)', async () => {
    llm.fail.conceptMerge = [new LlmError(true, 'down')];

    const { error } = await run(learningPathsConfig.jobRetries);

    expect(error).toBeDefined();
    expect((await path())?.status).toBe('MAPPING');
    expect(await db.select().from(concepts)).toHaveLength(0);
  });
});
