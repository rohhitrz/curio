import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  conceptCoverage,
  concepts,
  learningPaths,
  memories,
  modules,
  notebooks,
  pathResources,
  sources,
  topics,
  users,
} from '../../src/db/schema/index.js';
import { fakeVector } from '../fakes/embeddings.js';
import { getTestDb, truncateAllTables } from '../helpers/db.js';
import { seedConcept, seedLearningPath } from '../helpers/learning.js';

const db = getTestDb();
let userId: string;

/** Postgres error code of a rejected query (drizzle wraps the driver error as `cause`). */
async function pgCode(query: Promise<unknown>): Promise<string | undefined> {
  try {
    await query;
  } catch (err) {
    const cause = (err as { cause?: { code?: string } }).cause;
    return cause?.code ?? (err as { code?: string }).code;
  }
  return undefined;
}

const UNIQUE_VIOLATION = '23505';

beforeEach(async () => {
  await truncateAllTables();
  const [user] = await db.insert(users).values({ clerkUserId: 'user_learner' }).returning();
  if (!user) throw new Error('user not created');
  userId = user.id;
});

async function seedResource(pathId: string, sourceId: string | null = null) {
  const [row] = await db
    .insert(pathResources)
    .values({
      pathId,
      sourceId,
      role: 'OFFICIAL',
      resourceType: 'DOCS',
      title: 'Official docs',
      url: 'https://example.com/docs',
    })
    .returning();
  if (!row) throw new Error('resource not created');
  return row;
}

async function seedModule(pathId: string, position: number) {
  const [row] = await db
    .insert(modules)
    .values({ pathId, position, title: `Module ${position}`, summary: 'Summary' })
    .returning();
  if (!row) throw new Error('module not created');
  return row;
}

describe('learning tables', () => {
  it('a new path defaults to GATHERING with no hook, branch or error', async () => {
    const { path } = await seedLearningPath(userId);

    expect(path).toMatchObject({
      status: 'GATHERING',
      hook: null,
      branchOptions: null,
      selectedBranch: null,
      errorCode: null,
    });
  });

  it('one path per notebook', async () => {
    const { notebook } = await seedLearningPath(userId);

    expect(
      await pgCode(
        db.insert(learningPaths).values({
          notebookId: notebook.id,
          userId,
          topic: 'Again',
          level: 'ADVANCED',
          goal: 'JOB',
        }),
      ),
    ).toBe(UNIQUE_VIOLATION);
  });

  it('jsonb hook and branch options round-trip; consensus score reads as a number', async () => {
    const { path } = await seedLearningPath(userId);
    const hook = { what: 'w', why: 'y', example: 'e', origin: 'o' };
    const branchOptions = [{ name: 'Maths', description: 'The maths behind it' }];
    await db
      .update(learningPaths)
      .set({ hook, branchOptions })
      .where(eq(learningPaths.id, path.id));
    const concept = await seedConcept(path.id);

    const [saved] = await db.select().from(learningPaths).where(eq(learningPaths.id, path.id));
    expect(saved).toMatchObject({ hook, branchOptions });
    expect(concept.consensusScore).toBe(0.5);
  });

  it('module positions are unique within a path', async () => {
    const { path } = await seedLearningPath(userId);
    const other = await seedLearningPath(userId, 'Statistics');
    await seedModule(path.id, 1);

    expect(await pgCode(seedModule(path.id, 1))).toBe(UNIQUE_VIOLATION);
    await seedModule(other.path.id, 1);
  });

  it('a concept is covered by a resource at most once', async () => {
    const { path } = await seedLearningPath(userId);
    const concept = await seedConcept(path.id);
    const resource = await seedResource(path.id);
    const row = { conceptId: concept.id, pathResourceId: resource.id };
    await db.insert(conceptCoverage).values(row);

    expect(await pgCode(db.insert(conceptCoverage).values(row))).toBe(UNIQUE_VIOLATION);
  });

  it('deleting the notebook removes the path, resources, concepts, coverage and modules', async () => {
    const { notebook, path } = await seedLearningPath(userId);
    const module = await seedModule(path.id, 1);
    const concept = await seedConcept(path.id);
    await db.update(concepts).set({ moduleId: module.id, position: 1 });
    const resource = await seedResource(path.id);
    await db.insert(conceptCoverage).values({ conceptId: concept.id, pathResourceId: resource.id });

    await db.delete(notebooks).where(eq(notebooks.id, notebook.id));

    expect(await db.select().from(learningPaths)).toHaveLength(0);
    expect(await db.select().from(pathResources)).toHaveLength(0);
    expect(await db.select().from(concepts)).toHaveLength(0);
    expect(await db.select().from(conceptCoverage)).toHaveLength(0);
    expect(await db.select().from(modules)).toHaveLength(0);
  });

  it('deleting a source keeps its resource with no source', async () => {
    const { notebook, path } = await seedLearningPath(userId);
    const [source] = await db
      .insert(sources)
      .values({
        notebookId: notebook.id,
        userId,
        type: 'WEBSITE',
        origin: 'LEARNING_PATH',
        title: 'Official docs',
        url: 'https://example.com/docs',
        contentHash: 'hash-docs',
      })
      .returning();
    if (!source) throw new Error('source not created');
    const resource = await seedResource(path.id, source.id);

    await db.delete(sources).where(eq(sources.id, source.id));

    const [left] = await db.select().from(pathResources).where(eq(pathResources.id, resource.id));
    expect(left?.sourceId).toBeNull();
  });

  it('deleting a module keeps its concepts, unassigned', async () => {
    const { path } = await seedLearningPath(userId);
    const module = await seedModule(path.id, 1);
    const concept = await seedConcept(path.id);
    await db.update(concepts).set({ moduleId: module.id, position: 1 });

    await db.delete(modules).where(eq(modules.id, module.id));

    const [left] = await db.select().from(concepts).where(eq(concepts.id, concept.id));
    expect(left?.moduleId).toBeNull();
  });

  it('deleting a concept keeps the UNDERSTOOD memory text, with no concept', async () => {
    const { path } = await seedLearningPath(userId);
    const concept = await seedConcept(path.id);
    const [topic] = await db
      .insert(topics)
      .values({
        name: 'Deep Learning',
        normalizedName: 'deep learning',
        embedding: fakeVector('dl'),
      })
      .returning();
    if (!topic) throw new Error('topic not created');
    const [memory] = await db
      .insert(memories)
      .values({
        userId,
        scope: 'TOPIC',
        topicId: topic.id,
        kind: 'UNDERSTOOD',
        content: 'Understands backpropagation',
        conceptId: concept.id,
        origin: 'LESSON_COMPLETED',
      })
      .returning();
    if (!memory) throw new Error('memory not created');

    await db.delete(concepts).where(eq(concepts.id, concept.id));

    const [left] = await db.select().from(memories).where(eq(memories.id, memory.id));
    expect(left).toMatchObject({ content: 'Understands backpropagation', conceptId: null });
  });

  it('a memory cannot point at a concept that does not exist', async () => {
    const [topic] = await db
      .insert(topics)
      .values({
        name: 'Deep Learning',
        normalizedName: 'deep learning',
        embedding: fakeVector('dl'),
      })
      .returning();
    if (!topic) throw new Error('topic not created');

    expect(
      await pgCode(
        db.insert(memories).values({
          userId,
          scope: 'TOPIC',
          topicId: topic.id,
          kind: 'UNDERSTOOD',
          content: 'x',
          conceptId: crypto.randomUUID(),
          origin: 'LESSON_COMPLETED',
        }),
      ),
    ).toBe('23503');
  });
});
