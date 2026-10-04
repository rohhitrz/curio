import { describe, expect, it } from 'vitest';
import { lessonFaithfulness, lessonForJudging, pooledFaithfulness } from './lessons.js';

describe('lessonForJudging', () => {
  it('drops code blocks and general-knowledge sections, keeps the rest', () => {
    const lesson = [
      'Intro sentence.',
      '',
      '## Lists',
      'A list holds items in order [1].',
      '```python',
      'items = [1, 2]  # a list',
      '```',
      'After the code.',
      '',
      '## Recursion',
      '> General knowledge, not in the resources.',
      'A function can call itself.',
      '',
      '## Key takeaways',
      '- Lists keep order [1].',
    ].join('\n');

    const result = lessonForJudging(lesson);

    expect(result.generalKnowledgeSections).toBe(1);
    expect(result.text).toContain('A list holds items in order [1].');
    expect(result.text).toContain('After the code.');
    expect(result.text).toContain('## Key takeaways');
    expect(result.text).not.toContain('items = [1, 2]');
    expect(result.text).not.toContain('call itself');
  });

  it('a note quoted later in a section does not remove it', () => {
    const lesson = '## Lists\nLists keep order [1].\n> General knowledge, not in the resources.';
    expect(lessonForJudging(lesson)).toEqual({ text: lesson, generalKnowledgeSections: 0 });
  });
});

describe('faithfulness', () => {
  it('supported ÷ claims, rounded; no claims → null; pooled over lessons by claim', () => {
    expect(
      lessonFaithfulness([{ supported: true }, { supported: false }, { supported: true }]),
    ).toBe(0.667);
    expect(lessonFaithfulness([])).toBeNull();
    expect(
      pooledFaithfulness([
        { claims: [{ supported: true }] },
        { claims: [{ supported: false }, { supported: false }, { supported: true }] },
        { claims: [] },
      ]),
    ).toBe(0.5);
  });
});
