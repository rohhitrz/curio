/** Fenced code blocks and inline code: math delimiters inside them are left alone. */
const CODE = /(```[\s\S]*?```|`[^`\n]*`)/;

/**
 * The model writes LaTeX between `\( … \)` (inline) and `\[ … \]` (display); remark-math reads
 * dollars. Inline becomes `$$…$$` on one line (still inline: single-dollar math stays off so a
 * price like "$5" is never a formula), display becomes a `$$` block of its own.
 */
export function normalizeMath(text: string): string {
  return text
    .split(CODE)
    .map((part, index) =>
      index % 2 === 1
        ? part
        : part
            .replace(/\\\[([\s\S]+?)\\\]/g, (_m, tex: string) => `\n\n$$\n${tex.trim()}\n$$\n\n`)
            .replace(/\\\(([\s\S]+?)\\\)/g, (_m, tex: string) => `$$${tex.trim()}$$`),
    )
    .join('');
}
