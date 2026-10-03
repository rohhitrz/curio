import { concepts, learningPaths, notebooks } from '../../src/db/schema/index.js';
import { getTestDb } from './db.js';

/** A learning notebook with its path (`GATHERING`) for `userId`. */
export async function seedLearningPath(userId: string, topic = 'Deep Learning') {
  const db = getTestDb();
  const [notebook] = await db
    .insert(notebooks)
    .values({ userId, title: topic, kind: 'LEARNING' })
    .returning();
  if (!notebook) throw new Error('notebook not created');
  const [path] = await db
    .insert(learningPaths)
    .values({ notebookId: notebook.id, userId, topic, level: 'BEGINNER', goal: 'CURIOSITY' })
    .returning();
  if (!path) throw new Error('path not created');
  return { notebook, path };
}

export async function seedConcept(pathId: string, name = 'Backpropagation') {
  const [concept] = await getTestDb()
    .insert(concepts)
    .values({ pathId, name, description: `About ${name}`, consensusScore: 0.5, status: 'INCLUDED' })
    .returning();
  if (!concept) throw new Error('concept not created');
  return concept;
}
