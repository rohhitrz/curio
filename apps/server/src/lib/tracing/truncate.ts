const MAX_DEPTH = 8;

function truncateString(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}… [${value.length - maxChars} more chars]`;
}

function truncateValue(value: unknown, maxChars: number, depth: number): unknown {
  if (typeof value === 'string') return truncateString(value, maxChars);
  if (depth >= MAX_DEPTH || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => truncateValue(item, maxChars, depth + 1));
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, truncateValue(item, maxChars, depth + 1)]),
  );
}

/**
 * Cuts every string in `data` to `maxChars`, so traces never hold full source text (prompts carry
 * whole chunks). JSON strings, which is how span inputs and outputs arrive, are truncated inside
 * and stay valid JSON.
 */
export function truncateForTrace(data: unknown, maxChars: number): unknown {
  if (typeof data === 'string') {
    try {
      const parsed: unknown = JSON.parse(data);
      if (parsed !== null && typeof parsed === 'object') {
        return JSON.stringify(truncateValue(parsed, maxChars, 0));
      }
    } catch {
      // Not JSON: plain text.
    }
    return truncateString(data, maxChars);
  }
  return truncateValue(data, maxChars, 0);
}
