const relative = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

const units: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 24 * 60 * 60],
  ['month', 30 * 24 * 60 * 60],
  ['week', 7 * 24 * 60 * 60],
  ['day', 24 * 60 * 60],
  ['hour', 60 * 60],
  ['minute', 60],
];

/** "3 minutes ago", "yesterday", "just now". */
export function timeAgo(iso: string, now: number = Date.now()): string {
  const seconds = Math.round((Date.parse(iso) - now) / 1000);
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) return relative.format(Math.round(seconds / size), unit);
  }
  return 'just now';
}

/** Short words that stay lowercase inside a title ("Pride and Prejudice"). */
const minorWords = new Set([
  'a',
  'an',
  'and',
  'as',
  'at',
  'by',
  'for',
  'in',
  'of',
  'on',
  'or',
  'the',
  'to',
  'vs',
  'with',
]);

/**
 * A notebook or topic name as shown: each all-lowercase word capitalized ("binary search" →
 * "Binary Search"), short joining words kept lowercase except first. A word with any capital
 * ("ML", "iPhone") is left as typed; the stored title never changes.
 */
export function displayTitle(title: string): string {
  return title.replace(/\S+/g, (word, offset: number) => {
    if (word !== word.toLowerCase()) return word;
    if (offset > 0 && minorWords.has(word)) return word;
    return word.charAt(0).toUpperCase() + word.slice(1);
  });
}
