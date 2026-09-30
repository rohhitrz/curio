/** Errors queued here are thrown by the next calls, one per call, before any result is returned. */
function failureQueue() {
  const queue = [];
  return {
    push: (...errors) => queue.push(...errors),
    throwNext() {
      const error = queue.shift();
      if (error) throw error;
    },
  };
}
export function createFakeScraper(
  page = { title: 'Example page', markdown: '# Example\n\nSome text.' },
) {
  const failures = failureQueue();
  const calls = [];
  const provider = {
    scrape(url) {
      calls.push(url);
      failures.throwNext();
      return Promise.resolve(page);
    },
  };
  return { provider, calls, failNext: failures.push };
}
export function createFakeTranscript(
  video = { title: 'Example video', durationSeconds: 600 },
  transcript = {
    language: 'en',
    segments: [
      { text: 'Hello.', startSeconds: 0, endSeconds: 2 },
      { text: 'Welcome.', startSeconds: 2, endSeconds: 5 },
    ],
  },
) {
  const failures = failureQueue();
  const calls = [];
  const provider = {
    getVideo(videoId) {
      calls.push(`video:${videoId}`);
      failures.throwNext();
      return Promise.resolve(video);
    },
    getTranscript(videoId) {
      calls.push(`transcript:${videoId}`);
      failures.throwNext();
      return Promise.resolve(transcript);
    },
  };
  return { provider, calls, failNext: failures.push };
}
export function createFakePdfParser(parsed = { pages: [{ pageNumber: 1, text: 'Page one.' }] }) {
  const failures = failureQueue();
  const calls = [];
  const provider = {
    parse(file) {
      calls.push(file);
      failures.throwNext();
      return Promise.resolve(parsed);
    },
  };
  return { provider, calls, failNext: failures.push };
}
//# sourceMappingURL=extraction.js.map
