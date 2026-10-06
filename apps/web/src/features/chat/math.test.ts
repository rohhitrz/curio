import { describe, expect, it } from 'vitest';
import { normalizeMath } from './math';

describe('normalizeMath', () => {
  it('turns \\( … \\) into inline $$ … $$', () => {
    expect(
      normalizeMath('It minimizes \\(\\|Xw-y\\|_2^2+\\alpha\\|w\\|_2^2\\), where alpha [2].'),
    ).toBe('It minimizes $$\\|Xw-y\\|_2^2+\\alpha\\|w\\|_2^2$$, where alpha [2].');
  });

  it('turns \\[ … \\] into a display block', () => {
    expect(normalizeMath('Loss:\n\\[ \\sum_i w_i^2 \\]\nso')).toBe(
      'Loss:\n\n\n$$\n\\sum_i w_i^2\n$$\n\n\nso',
    );
  });

  it('leaves code, citation markers and prices alone', () => {
    const text = 'Costs $5 [1][2]. `\\(x\\)` and\n```\n\\[y\\]\n```';
    expect(normalizeMath(text)).toBe(text);
  });
});
