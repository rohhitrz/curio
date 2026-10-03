import { updateNotebookSchema } from '@curio/shared';
import { describe, expect, it } from 'vitest';
import { normalizeTopicName } from '../../src/services/topics.service.js';

describe('normalizeTopicName', () => {
  it('ignores case, extra spaces and Unicode width', () => {
    expect(normalizeTopicName('  Machine   Learning ')).toBe('machine learning');
    expect(normalizeTopicName('MACHINE LEARNING')).toBe('machine learning');
    // Full-width letters (NFKC) and a non-breaking space.
    expect(normalizeTopicName('Ｍachine Learning')).toBe('machine learning');
  });

  it('keeps synonyms apart: they are related by similarity, never merged', () => {
    expect(normalizeTopicName('ML')).not.toBe(normalizeTopicName('Machine Learning'));
  });
});

describe('updateNotebookSchema', () => {
  it('accepts a topic, null to clear it, or a title', () => {
    expect(updateNotebookSchema.parse({ topic: '  Deep Learning ' })).toEqual({
      topic: 'Deep Learning',
    });
    expect(updateNotebookSchema.parse({ topic: null })).toEqual({ topic: null });
    expect(updateNotebookSchema.parse({ title: 'T' })).toEqual({ title: 'T' });
  });

  it('rejects an empty or too long topic, and an empty body', () => {
    expect(updateNotebookSchema.safeParse({ topic: '   ' }).success).toBe(false);
    expect(updateNotebookSchema.safeParse({ topic: 'x'.repeat(101) }).success).toBe(false);
    expect(updateNotebookSchema.safeParse({}).success).toBe(false);
  });
});
