import { describe, expect, it } from 'vitest';
import { truncateForTrace } from '../../src/lib/tracing/index.js';

describe('truncateForTrace', () => {
  it('leaves short text alone and cuts long text with a note', () => {
    expect(truncateForTrace('short', 10)).toBe('short');
    expect(truncateForTrace('abcdefghijkl', 5)).toBe('abcde… [7 more chars]');
  });

  it('cuts strings inside objects and arrays, keeping other values', () => {
    expect(truncateForTrace({ a: 'abcdefgh', n: 3, list: ['abcdefgh', null] }, 3)).toEqual({
      a: 'abc… [5 more chars]',
      n: 3,
      list: ['abc… [5 more chars]', null],
    });
  });

  it('cuts inside a JSON string and returns valid JSON', () => {
    const result = truncateForTrace(JSON.stringify([{ content: 'abcdefgh' }]), 3);

    expect(JSON.parse(result as string)).toEqual([{ content: 'abc… [5 more chars]' }]);
  });
});
