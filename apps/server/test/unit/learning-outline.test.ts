import { describe, expect, it } from 'vitest';
import { learningPaths } from '../../src/config/index.js';
import { cutPath } from '../../src/pipelines/learning/cut.js';
import { fairShare, mapResource } from '../../src/pipelines/learning/map.js';
import {
  applyMerge,
  buildMergeMessage,
  consensusScore,
  type MappedResource,
  type PathConcept,
} from '../../src/pipelines/learning/merge.js';
import {
  applyOrder,
  InvalidOutlineError,
  type Outline,
  type PathOrderOutput,
} from '../../src/pipelines/learning/order.js';
import { toOutlineRows } from '../../src/services/learning-path-outline.service.js';
import { createFakeLlm } from '../fakes/llm.js';

const weights = learningPaths.consensus;
const rules = learningPaths.cut;

const resource = (
  resourceId: string,
  role: 'OFFICIAL' | 'POPULAR',
  names: string[],
): MappedResource => ({
  resourceId,
  role,
  title: resourceId,
  concepts: names.map((name) => ({ name, description: `About ${name}` })),
});

const concept = (
  key: number,
  score: number,
  overrides: Partial<PathConcept> = {},
): PathConcept => ({
  key,
  name: `C${String(key)}`,
  description: '',
  resourceIds: [],
  score,
  gap: false,
  ...overrides,
});

describe('consensusScore', () => {
  it('weight of the covering resources over all of them; official counts double', () => {
    const all = ['OFFICIAL', 'POPULAR', 'POPULAR', 'POPULAR'] as const;
    // total weight 2 + 3 = 5
    expect(consensusScore(['OFFICIAL', 'POPULAR'], [...all], weights)).toBe(0.6);
    expect(consensusScore(['POPULAR', 'POPULAR'], [...all], weights)).toBe(0.4);
    expect(consensusScore(['OFFICIAL'], [...all], weights)).toBe(0.4);
    expect(consensusScore([...all], [...all], weights)).toBe(1);
    expect(consensusScore([], [], weights)).toBe(0);
  });
});

describe('applyMerge', () => {
  const resources = [
    resource('r-official', 'OFFICIAL', ['Backpropagation', 'Neurons']),
    resource('r-a', 'POPULAR', ['Backprop', 'Loss functions']),
    resource('r-b', 'POPULAR', ['Backpropagation algorithm']),
  ];

  it('numbers concepts per resource for the model', () => {
    expect(buildMergeMessage('DL', resources)).toContain('  2.1 Backprop: About Backprop');
  });

  it('groups members, counts coverage by resource and scores it', () => {
    const merged = applyMerge(
      resources,
      [
        { name: 'Backpropagation', description: 'd', members: ['1.1', '2.1', '3.1'] },
        { name: 'Neurons', description: 'n', members: ['1.2'] },
        { name: 'Loss functions', description: 'l', members: ['2.2'] },
      ],
      weights,
    );

    expect(merged.map((c) => [c.key, c.name, c.resourceIds, c.score])).toEqual([
      [0, 'Backpropagation', ['r-official', 'r-a', 'r-b'], 1],
      [1, 'Neurons', ['r-official'], 0.5],
      [2, 'Loss functions', ['r-a'], 0.25],
    ]);
  });

  it('unknown IDs ignored, an ID claimed twice stays in its first group, left-out IDs stand alone', () => {
    const merged = applyMerge(
      resources,
      [
        { name: 'Backpropagation', description: 'd', members: ['1.1', '2.1', '9.9'] },
        { name: 'Again', description: 'x', members: ['2.1'] },
        { name: 'Nothing', description: 'x', members: ['7.1'] },
      ],
      weights,
    );

    expect(merged.map((c) => c.name)).toEqual([
      'Backpropagation',
      'Neurons',
      'Loss functions',
      'Backpropagation algorithm',
    ]);
    expect(merged.find((c) => c.name === 'Neurons')?.resourceIds).toEqual(['r-official']);
  });

  it('two concepts of one resource in a group cover it once', () => {
    const [only] = applyMerge(
      [resource('r', 'POPULAR', ['A', 'A again'])],
      [{ name: 'A', description: 'a', members: ['1.1', '1.2'] }],
      weights,
    );
    expect(only?.resourceIds).toEqual(['r']);
  });
});

describe('applyOrder', () => {
  const concepts = [concept(0, 1), concept(1, 0.6), concept(2, 0.4), concept(3, 0.2)];
  const item = (n: number | null, name = 'x') => ({ concept: n, name, description: 'd' });
  const limits = { maxGapConcepts: 1, minBranchConcepts: 2 };

  it('places concepts in module order; unknown and repeated numbers ignored', () => {
    const output: PathOrderOutput = {
      modules: [
        { title: ' Basics ', summary: 's', items: [item(2), item(1), item(9), item(2)] },
        { title: 'Empty', summary: 's', items: [item(42)] },
        { title: 'More', summary: 's', items: [item(3), item(4)] },
      ],
      branches: [],
    };

    const outline = applyOrder(concepts, output, limits);

    expect(outline.modules).toEqual([
      { title: 'Basics', summary: 's', conceptKeys: [1, 0] },
      { title: 'More', summary: 's', conceptKeys: [2, 3] },
    ]);
  });

  it('adds gap concepts up to the limit; left-out concepts get a last module', () => {
    const outline = applyOrder(
      concepts,
      {
        modules: [
          {
            title: 'Basics',
            summary: 's',
            items: [item(null, 'Linear algebra'), item(1), item(null, 'Calculus')],
          },
        ],
        branches: [],
      },
      limits,
    );

    expect(outline.concepts).toHaveLength(5);
    expect(outline.concepts[4]).toMatchObject({
      key: 4,
      name: 'Linear algebra',
      gap: true,
      score: 0,
    });
    expect(outline.modules).toEqual([
      { title: 'Basics', summary: 's', conceptKeys: [4, 0] },
      expect.objectContaining({ title: 'More concepts', conceptKeys: [1, 2, 3] }),
    ]);
  });

  it('branches keep real modules, need enough concepts and distinct names', () => {
    const outline = applyOrder(
      concepts,
      {
        modules: [
          { title: 'A', summary: 's', items: [item(1), item(2)] },
          { title: 'B', summary: 's', items: [item(3)] },
          { title: 'C', summary: 's', items: [item(4)] },
        ],
        branches: [
          { name: 'Theory', description: 'd', modules: [1, 7] },
          { name: 'theory', description: 'dup', modules: [2, 3] },
          { name: 'Thin', description: 'd', modules: [3] },
          { name: 'Practice', description: 'd', modules: [3, 2, 2] },
        ],
      },
      limits,
    );

    expect(outline.branches).toEqual([
      { name: 'Theory', description: 'd', moduleIndexes: [0] },
      { name: 'Practice', description: 'd', moduleIndexes: [1, 2] },
    ]);
  });

  it('no usable module → InvalidOutlineError (retried)', () => {
    expect(() =>
      applyOrder(
        concepts,
        { modules: [{ title: 'X', summary: 's', items: [] }], branches: [] },
        limits,
      ),
    ).toThrow(InvalidOutlineError);
  });
});

describe('cutPath', () => {
  // Scores: 1 · 0.6 · 0.4 · 0.2 · 0.1, plus a gap concept in module 1.
  const outline: Outline = {
    concepts: [
      concept(0, 1, { resourceIds: ['a', 'b', 'c', 'd'] }),
      concept(1, 0.6, { resourceIds: ['a', 'b', 'c'] }),
      concept(2, 0.4, { resourceIds: ['a', 'b'] }),
      concept(3, 0.2, { resourceIds: ['a'] }),
      concept(4, 0.1, { resourceIds: ['b'] }),
      concept(5, 0, { gap: true }),
    ],
    modules: [
      { title: 'M1', summary: 's', conceptKeys: [5, 0, 1] },
      { title: 'M2', summary: 's', conceptKeys: [2, 3] },
      { title: 'M3', summary: 's', conceptKeys: [4] },
    ],
    branches: [
      { name: 'Deep', description: 'd', moduleIndexes: [1, 2] },
      { name: 'Wide', description: 'd', moduleIndexes: [0] },
    ],
  };
  const noMin = { ...rules, beginnerMinConcepts: 0, intermediateMinConcepts: 0 };

  it('beginner keeps high consensus only (with its module’s gap concept)', () => {
    const cut = cutPath(outline, 'BEGINNER', null, 4, noMin);

    expect(cut.modules).toEqual([{ title: 'M1', summary: 's', conceptKeys: [5, 0, 1] }]);
    expect(cut.skipped).toEqual([
      { key: 2, reason: 'Covered by 2 of 4 resources, beyond the basics' },
      { key: 3, reason: 'Covered by 1 of 4 resources, beyond the basics' },
      { key: 4, reason: 'Covered by 1 of 4 resources, beyond the basics' },
    ]);
  });

  it('intermediate keeps high + medium; empty modules dropped', () => {
    const cut = cutPath(outline, 'INTERMEDIATE', null, 4, noMin);

    expect(cut.modules.map((m) => [m.title, m.conceptKeys])).toEqual([
      ['M1', [5, 0, 1]],
      ['M2', [2]],
    ]);
    expect(cut.skipped.map((s) => s.key)).toEqual([3, 4]);
    expect(cut.skipped[0]?.reason).toBe('Covered by 1 of 4 resources, advanced');
  });

  it('too few kept → the best-covered skipped concepts are added back', () => {
    const cut = cutPath(outline, 'BEGINNER', null, 4, { ...noMin, beginnerMinConcepts: 4 });

    expect(cut.modules.flatMap((m) => m.conceptKeys).sort()).toEqual([0, 1, 2, 3, 5]);
  });

  it('each level has its own minimum', () => {
    const mins = { ...noMin, beginnerMinConcepts: 2, intermediateMinConcepts: 5 };

    expect(cutPath(outline, 'BEGINNER', null, 4, mins).skipped).toHaveLength(3);
    expect(cutPath(outline, 'INTERMEDIATE', null, 4, mins).skipped).toHaveLength(0);
  });

  it('a gap concept whose module keeps nothing is skipped with its own reason', () => {
    const lowFirst: Outline = {
      ...outline,
      modules: [
        { title: 'M1', summary: 's', conceptKeys: [5, 4] },
        { title: 'M2', summary: 's', conceptKeys: [0, 1, 2, 3] },
      ],
    };

    const cut = cutPath(lowFirst, 'BEGINNER', null, 4, noMin);

    expect(cut.skipped[0]).toEqual({
      key: 5,
      reason: 'A prerequisite none of the resources cover',
    });
  });

  it('advanced keeps only the chosen branch, whatever the scores', () => {
    const cut = cutPath(outline, 'ADVANCED', 'Deep', 4, rules);

    expect(cut.modules.map((m) => [m.title, m.conceptKeys])).toEqual([
      ['M2', [2, 3]],
      ['M3', [4]],
    ]);
    expect(cut.skipped).toEqual([
      { key: 5, reason: 'Not in the branch you picked' },
      { key: 0, reason: 'Not in the branch you picked' },
      { key: 1, reason: 'Not in the branch you picked' },
    ]);
  });

  it('advanced with no branch (none offered) is cut like intermediate', () => {
    expect(cutPath(outline, 'ADVANCED', null, 4, noMin)).toEqual(
      cutPath(outline, 'INTERMEDIATE', null, 4, noMin),
    );
  });

  it('the same input always gives the same path', () => {
    expect(cutPath(outline, 'BEGINNER', null, 4, rules)).toEqual(
      cutPath(structuredClone(outline), 'BEGINNER', null, 4, rules),
    );
  });
});

describe('toOutlineRows', () => {
  it('kept concepts placed by module and position; skipped ones with their reason', () => {
    const outline: Outline = {
      concepts: [concept(0, 1, { resourceIds: ['a'] }), concept(1, 0.1, { resourceIds: ['b'] })],
      modules: [{ title: 'M', summary: 's', conceptKeys: [0, 1] }],
      branches: [],
    };
    const rows = toOutlineRows(
      outline,
      {
        modules: [{ title: 'M', summary: 's', conceptKeys: [0] }],
        skipped: [{ key: 1, reason: 'why' }],
      },
      null,
    );

    expect(rows.modules).toEqual([{ title: 'M', summary: 's' }]);
    expect(rows.concepts).toEqual([
      expect.objectContaining({
        name: 'C0',
        status: 'INCLUDED',
        module: 0,
        position: 1,
        resourceIds: ['a'],
      }),
      expect.objectContaining({
        name: 'C1',
        status: 'SKIPPED',
        skipReason: 'why',
        module: null,
        position: null,
      }),
    ]);
  });
});

describe('fairShare', () => {
  const page = (title: string, length: number) =>
    `# ${title}\n${'x'.repeat(length - title.length - 3)}`;

  it('text within the budget is returned as it is', () => {
    expect(fairShare('# A\nshort', 100)).toBe('# A\nshort');
  });

  it('every page keeps its start; short pages leave their share to the long ones', () => {
    const text = [page('A', 100), page('B', 10), page('C', 100)].join('\n');

    const cut = fairShare(text, 152);

    expect(cut.length).toBeLessThanOrEqual(152);
    const parts = cut.split(/\n(?=# )/);
    expect(parts.map((p) => p.slice(0, 3))).toEqual(['# A', '# B', '# C']);
    // B keeps all 10; A and C split the rest (150 - 10 = 140, 70 each).
    expect(parts.map((p) => p.length)).toEqual([70, 10, 70]);
  });

  it('text without top-level headings is cut from the start', () => {
    expect(fairShare('abcdef', 3)).toBe('abc');
  });
});

describe('mapResource', () => {
  it('trims, drops blank and repeated names, keeps at most maxConcepts', async () => {
    const llm = createFakeLlm(
      JSON.stringify({
        concepts: [
          { name: ' Neurons ', description: ' d ' },
          { name: 'neurons', description: 'again' },
          { name: '  ', description: 'blank' },
          { name: 'Layers', description: 'l' },
          { name: 'Weights', description: 'w' },
        ],
      }),
    );

    const concepts = await mapResource(
      { topic: 'DL', level: 'BEGINNER', title: 'Guide', text: 'text', maxConcepts: 2 },
      { llm: llm.provider },
    );

    expect(concepts).toEqual([
      { name: 'Neurons', description: 'd' },
      { name: 'Layers', description: 'l' },
    ]);
    expect(llm.requests[0]?.task).toBe('conceptMap');
  });
});
