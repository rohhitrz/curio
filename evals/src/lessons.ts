import { GENERAL_KNOWLEDGE_NOTE } from '../../apps/server/src/pipelines/lessons/prompt.js';

/**
 * The part of a lesson the faithfulness judge checks (pure): fenced code blocks and the sections
 * the lesson labels as general knowledge are removed, since they are not meant to come from the
 * sources (decision L-10). A section runs from its `## ` heading to the next one.
 */
export function lessonForJudging(text: string): { text: string; generalKnowledgeSections: number } {
  const withoutCode = text.replace(/^```[^\n]*\n[\s\S]*?^```[ \t]*$/gm, '');
  const parts = withoutCode.split(/^(?=## )/m);
  let removed = 0;
  const kept = parts.filter((part) => {
    const body = part.replace(/^## [^\n]*\n/, '').trimStart();
    if (part.startsWith('## ') && body.startsWith(`> ${GENERAL_KNOWLEDGE_NOTE}`)) {
      removed += 1;
      return false;
    }
    return true;
  });
  return {
    text: kept
      .join('')
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
    generalKnowledgeSections: removed,
  };
}

/** Supported claims ÷ claims (test plan §6.3); null when a lesson made no checkable claim. */
export function lessonFaithfulness(claims: { supported: boolean }[]): number | null {
  if (claims.length === 0) return null;
  return Math.round((claims.filter((c) => c.supported).length / claims.length) * 1000) / 1000;
}

/** Mean of the lessons that made claims, weighted by claims (so a one-claim lesson weighs little). */
export function pooledFaithfulness(lessons: { claims: { supported: boolean }[] }[]): number | null {
  return lessonFaithfulness(lessons.flatMap((l) => l.claims));
}
