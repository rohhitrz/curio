import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AnswerMarkdown } from './answer-markdown';

const render = (text: string) =>
  renderToStaticMarkup(
    createElement(AnswerMarkdown, { text, citations: [], onCite: () => undefined }),
  );

describe('AnswerMarkdown math', () => {
  it('renders the model’s LaTeX with KaTeX', () => {
    const html = render('It minimizes \\(\\alpha\\|w\\|_2^2\\).');
    expect(html).toContain('class="katex"');
    // Shown as typeset symbols; the LaTeX source stays only in KaTeX's accessible annotation.
    expect(html).toContain('<span class="mord mathnormal" style="margin-right:0.0037em">α</span>');
    expect(html).not.toContain('It minimizes (');
  });

  it('leaves dollar amounts as text', () => {
    const html = render('A run costs $0.21 and a lesson $0.08.');
    expect(html).not.toContain('katex');
    expect(html).toContain('$0.21');
  });
});
