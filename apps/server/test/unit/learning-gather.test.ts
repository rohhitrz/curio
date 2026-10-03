import { describe, expect, it } from 'vitest';
import { learningPaths } from '../../src/config/index.js';
import type { SearchResult } from '../../src/lib/search/index.js';
import {
  buildSelectionMessage,
  fallbackJudgements,
  judgeCandidates,
  searchRequests,
  selectResources,
  selectionSchema,
  toCandidates,
  type Candidate,
  type Judgement,
} from '../../src/pipelines/learning/gather.js';
import { createFakeLlm } from '../fakes/llm.js';

const limits = learningPaths;
const brief = { topic: ' Deep Learning ', level: 'BEGINNER', goal: 'JOB' } as const;

const result = (url: string, score = 0.5, title = url): SearchResult => ({
  title,
  url,
  snippet: `About ${url}`,
  score,
});

const candidate = (url: string, overrides: Partial<Candidate> = {}): Candidate => ({
  title: url,
  url,
  snippet: '',
  score: 0.5,
  purpose: 'popular',
  videoId: null,
  ...overrides,
});

const judge = (index: number, overrides: Partial<Judgement> = {}): Judgement => ({
  index,
  relevant: true,
  official: false,
  authority: 3,
  format: 'ARTICLE',
  ...overrides,
});

describe('searchRequests', () => {
  it('official docs, popular guides at the level and goal, and videos on the video sites', () => {
    expect(searchRequests(brief, limits)).toEqual([
      {
        purpose: 'official',
        request: { query: 'Deep Learning official documentation', maxResults: 5 },
      },
      {
        purpose: 'popular',
        request: { query: 'Deep Learning for beginners practical', maxResults: 8 },
      },
      {
        purpose: 'video',
        request: {
          query: 'Deep Learning for beginners explained',
          maxResults: 4,
          includeDomains: ['youtube.com'],
        },
      },
    ]);
  });
});

describe('toCandidates', () => {
  it('one candidate per page across searches, first search wins', () => {
    const candidates = toCandidates([
      { purpose: 'official', results: [result('https://docs.example.org/guide/')] },
      {
        purpose: 'popular',
        results: [
          result('https://www.docs.example.org/guide?utm_source=x'),
          result('https://blog.example.com/dl'),
        ],
      },
    ]);

    expect(candidates.map((c) => [c.purpose, c.url])).toEqual([
      ['official', 'https://docs.example.org/guide/'],
      ['popular', 'https://blog.example.com/dl'],
    ]);
  });

  it('YouTube videos get their canonical URL and video ID; channels and playlists are dropped', () => {
    const candidates = toCandidates([
      {
        purpose: 'video',
        results: [
          result('https://youtu.be/aircAruvnKk?t=10'),
          result('https://www.youtube.com/watch?v=aircAruvnKk'),
          result('https://www.youtube.com/@3blue1brown'),
          result('https://www.youtube.com/playlist?list=PLx'),
        ],
      },
    ]);

    expect(candidates).toEqual([
      expect.objectContaining({
        url: 'https://www.youtube.com/watch?v=aircAruvnKk',
        videoId: 'aircAruvnKk',
      }),
    ]);
  });

  it('drops links that are not web pages', () => {
    expect(
      toCandidates([
        { purpose: 'popular', results: [result('ftp://example.com/x'), result('not a url')] },
      ]),
    ).toEqual([]);
  });
});

describe('selectResources', () => {
  it('the official result takes OFFICIAL (DOCS); the rest by authority, one per site', () => {
    const candidates = [
      candidate('https://docs.example.org/guide', { purpose: 'official' }),
      candidate('https://wiki.example.com/dl'),
      candidate('https://a.example.com/dl'),
      candidate('https://docs.example.org/other'),
      candidate('https://spam.example.com/buy'),
    ];
    const judgements = [
      judge(0, { official: true, authority: 5, format: 'ARTICLE' }),
      judge(1, { authority: 4 }),
      judge(2, { authority: 2 }),
      judge(3, { authority: 5, format: 'DOCS' }),
      judge(4, { relevant: false, authority: 5 }),
    ];

    expect(selectResources(candidates, judgements, limits)).toEqual([
      {
        role: 'OFFICIAL',
        resourceType: 'DOCS',
        title: 'https://docs.example.org/guide',
        url: 'https://docs.example.org/guide',
        videoId: null,
      },
      expect.objectContaining({ role: 'POPULAR', url: 'https://wiki.example.com/dl' }),
      expect.objectContaining({ role: 'POPULAR', url: 'https://a.example.com/dl' }),
    ]);
  });

  it('no official docs → the most authoritative readable page takes the role, in its own format', () => {
    const candidates = [
      candidate('https://www.youtube.com/watch?v=aircAruvnKk', { videoId: 'aircAruvnKk' }),
      candidate('https://britannica.example.com/history'),
      candidate('https://blog.example.com/history'),
    ];
    const judgements = [judge(0, { authority: 5 }), judge(1, { authority: 4 }), judge(2)];

    const selected = selectResources(candidates, judgements, limits);

    expect(selected[0]).toMatchObject({
      role: 'OFFICIAL',
      resourceType: 'ARTICLE',
      url: 'https://britannica.example.com/history',
    });
    expect(selected.map((s) => s.resourceType)).toEqual(['ARTICLE', 'VIDEO', 'ARTICLE']);
  });

  it('at most maxPopular popular resources, of which at most maxVideos videos', () => {
    const videos = ['aaaaaaaaaaa', 'bbbbbbbbbbb'].map((id) =>
      candidate(`https://www.youtube.com/watch?v=${id}`, { videoId: id }),
    );
    const pages = Array.from({ length: 8 }, (_, i) =>
      candidate(`https://site${String(i)}.example`),
    );
    const candidates = [...videos, ...pages];
    const judgements = candidates.map((_, i) => judge(i, { authority: i < 2 ? 5 : 3 }));

    const selected = selectResources(candidates, judgements, { maxPopular: 5, maxVideos: 1 });

    expect(selected).toHaveLength(6);
    expect(selected.filter((s) => s.role === 'OFFICIAL')).toHaveLength(1);
    expect(selected.filter((s) => s.resourceType === 'VIDEO')).toHaveLength(1);
  });

  it('ties: higher search score, then search order; the same input always gives the same path', () => {
    const candidates = [
      candidate('https://official.example', { purpose: 'official' }),
      candidate('https://first.example', { score: 0.4 }),
      candidate('https://second.example', { score: 0.9 }),
      candidate('https://third.example', { score: 0.9 }),
    ];
    const judgements = candidates.map((_, i) => judge(i, { official: i === 0 }));

    const urls = selectResources(candidates, judgements, limits).map((s) => s.url);

    expect(urls).toEqual([
      'https://official.example',
      'https://second.example',
      'https://third.example',
      'https://first.example',
    ]);
    expect(
      selectResources(candidates, [...judgements].reverse(), limits).map((s) => s.url),
    ).toEqual(urls);
  });

  it('nothing relevant and readable → nothing selected', () => {
    const candidates = [
      candidate('https://www.youtube.com/watch?v=aircAruvnKk', { videoId: 'aircAruvnKk' }),
      candidate('https://spam.example'),
    ];

    expect(selectResources(candidates, [judge(0), judge(1, { relevant: false })], limits)).toEqual(
      [],
    );
  });

  it('a candidate the model did not judge is left out', () => {
    const candidates = [candidate('https://a.example'), candidate('https://b.example')];

    expect(selectResources(candidates, [judge(1)], limits).map((s) => s.url)).toEqual([
      'https://b.example',
    ]);
  });
});

describe('fallbackJudgements', () => {
  it('all relevant; the top official-search page stands in as official', () => {
    const candidates = [
      candidate('https://popular.example'),
      candidate('https://www.youtube.com/watch?v=aircAruvnKk', {
        purpose: 'official',
        videoId: 'aircAruvnKk',
      }),
      candidate('https://docs.example', { purpose: 'official' }),
    ];

    const judgements = fallbackJudgements(candidates);

    expect(judgements.map((j) => j.official)).toEqual([false, false, true]);
    expect(judgements.every((j) => j.relevant)).toBe(true);
    expect(selectResources(candidates, judgements, limits)[0]?.url).toBe('https://docs.example');
  });
});

describe('judgeCandidates', () => {
  it('one resourceSelection call with the numbered results; snippets cut', async () => {
    const llm = createFakeLlm(JSON.stringify({ judgements: [judge(0)] }));
    const candidates = [candidate('https://a.example', { title: 'A', snippet: 'x'.repeat(400) })];

    const judgements = await judgeCandidates(brief, candidates, {
      llm: llm.provider,
      snippetMaxChars: 300,
    });

    expect(judgements).toEqual([judge(0)]);
    const [request] = llm.requests;
    expect(request?.task).toBe('resourceSelection');
    expect(request?.messages[0]?.content).toContain('[0] A\nURL: https://a.example');
    expect(request?.messages[0]?.content).toContain(`${'x'.repeat(300)}…`);
    expect(request?.messages[0]?.content).not.toContain('x'.repeat(301));
  });

  it('no candidates → no call', async () => {
    const llm = createFakeLlm();

    expect(await judgeCandidates(brief, [], { llm: llm.provider, snippetMaxChars: 300 })).toEqual(
      [],
    );
    expect(llm.requests).toHaveLength(0);
  });

  it('the message names the topic, level and goal', () => {
    expect(buildSelectionMessage(brief, [], 300)).toContain(
      'Topic:  Deep Learning \nLevel: beginner\nGoal: job',
    );
    expect(selectionSchema.safeParse({ judgements: [judge(0, { authority: 6 })] }).success).toBe(
      false,
    );
  });
});
