/** The model's last line when the learner seems ready to move on (L-10); never shown or saved. */
export const DONE_MARKER = '<<MODULE_DONE>>';

/**
 * Holds back streamed text that could be the start of the marker, so the learner never sees it
 * (pure, stateful). The marker counts only when nothing but whitespace follows it; anywhere
 * else it is ordinary text and is passed through at the end.
 */
export function createMarkerFilter(marker: string = DONE_MARKER) {
  let pending = '';

  /** Longest end of `text` that is a start of the marker. */
  function partialAtEnd(text: string): number {
    for (let n = Math.min(marker.length - 1, text.length); n > 0; n--) {
      if (text.endsWith(marker.slice(0, n))) return n;
    }
    return 0;
  }

  return {
    /** Text safe to show now. */
    push(delta: string): string {
      pending += delta;
      const at = pending.indexOf(marker);
      // From a full marker on, wait for the end: only then is it known to be last.
      if (at !== -1) {
        const out = pending.slice(0, at);
        pending = pending.slice(at);
        return out;
      }
      const keep = partialAtEnd(pending);
      const out = pending.slice(0, pending.length - keep);
      pending = pending.slice(pending.length - keep);
      return out;
    },
    /** The rest of the text, and whether the reply ended with the marker. */
    end(): { rest: string; found: boolean } {
      const rest = pending;
      pending = '';
      if (rest.startsWith(marker) && rest.slice(marker.length).trim() === '') {
        return { rest: '', found: true };
      }
      return { rest, found: false };
    },
  };
}

/** The full reply without a final marker (what is saved), and whether it had one. */
export function stripDoneMarker(text: string): { text: string; found: boolean } {
  const trimmed = text.trimEnd();
  if (!trimmed.endsWith(DONE_MARKER)) return { text, found: false };
  return { text: trimmed.slice(0, -DONE_MARKER.length).trimEnd(), found: true };
}
