import { describe, expect, it } from 'vitest';
import { joinSection, sectionLinks } from './section.js';

const INDEX = 'https://docs.python.org/3/tutorial/index.html';

describe('sectionLinks', () => {
  it('keeps same-site links under the page folder, in page order', () => {
    const markdown = [
      '- [1. Whetting Your Appetite](https://docs.python.org/3/tutorial/appetite.html)',
      '- [3. An Informal Introduction](introduction.html)',
      '- [Library reference](https://docs.python.org/3/library/index.html)',
      '- [Elsewhere](https://example.com/3/tutorial/x.html)',
      '- [4. Control Flow](./controlflow.html#more-on-lists)',
    ].join('\n');

    expect(sectionLinks(INDEX, markdown, 10)).toEqual([
      'https://docs.python.org/3/tutorial/appetite.html',
      'https://docs.python.org/3/tutorial/introduction.html',
      'https://docs.python.org/3/tutorial/controlflow.html',
    ]);
  });

  it('drops anchors to the same page, the page itself, query strings, files, images and repeats', () => {
    const markdown = [
      '[Top](#top)',
      '[Home](https://www.docs.python.org/3/tutorial/)',
      '[Search](search.html?q=list)',
      '[Download](tutorial.zip)',
      '![Diagram](diagram.png)',
      '[Classes](classes.html)',
      '[Classes again](classes.html#inheritance)',
      '[Mail](mailto:docs@python.org)',
    ].join(' ');

    expect(sectionLinks(INDEX, markdown, 10)).toEqual([
      'https://docs.python.org/3/tutorial/classes.html',
    ]);
  });

  it('a page without a trailing slash: its folder is the parent', () => {
    const markdown =
      '[About](/book/en/v2/Getting-Started-About-Version-Control) [Blog](/blog/post) [Title](<v2/Basics> "t")';

    expect(sectionLinks('https://git-scm.com/book/en/v2', markdown, 10)).toEqual([
      'https://git-scm.com/book/en/v2/Getting-Started-About-Version-Control',
      'https://git-scm.com/book/en/v2/Basics',
    ]);
  });

  it('at most `max`; none for 0, a bad URL or no links', () => {
    const markdown = '[a](a.html) [b](b.html) [c](c.html)';
    expect(sectionLinks(INDEX, markdown, 2)).toHaveLength(2);
    expect(sectionLinks(INDEX, markdown, 0)).toEqual([]);
    expect(sectionLinks('not a url', markdown, 5)).toEqual([]);
    expect(sectionLinks(INDEX, 'No links here.', 5)).toEqual([]);
  });
});

describe('joinSection', () => {
  it('puts each page under its title unless it opens with one', () => {
    const text = joinSection({ url: INDEX, title: 'The Python Tutorial', markdown: 'Contents' }, [
      { url: 'u1', title: 'Lists', markdown: '# 5. Data Structures\n\nLists…' },
      { url: 'u2', title: null, markdown: 'Untitled page' },
    ]);

    expect(text).toBe(
      '# The Python Tutorial\n\nContents\n\n# 5. Data Structures\n\nLists…\n\n# u2\n\nUntitled page',
    );
  });
});
