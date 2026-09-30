import { describe, expect, it } from 'vitest';
import { json, stubFetch, timeoutError } from '../helpers/fetch.js';
import { IngestionError } from '../../src/errors/ingestion-error.js';
import { createSupadataTranscriptProvider } from '../../src/lib/transcript/supadata.js';

const VIDEO_ID = 'dQw4w9WgXcQ';
const WATCH_URL = `https://www.youtube.com/watch?v=${VIDEO_ID}`;

function supadata(...replies: Parameters<typeof stubFetch>) {
  const stub = stubFetch(...replies);
  const sleeps: number[] = [];
  const provider = createSupadataTranscriptProvider({
    apiKey: 'sd-test',
    timeoutMs: 30_000,
    jobPollAttempts: 3,
    jobPollIntervalMs: 2_000,
    fetch: stub.fetch,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  });
  return { provider, requests: stub.requests, sleeps };
}

async function failure(call: Promise<unknown>): Promise<IngestionError> {
  const error = await call.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(IngestionError);
  return error as IngestionError;
}

const transcript = {
  content: [
    { text: ' Welcome to the course. ', offset: 0, duration: 2500, lang: 'en' },
    { text: '   ', offset: 2500, duration: 500, lang: 'en' },
    { text: 'Today: gradient descent.', offset: 3000, duration: 4200, lang: 'en' },
  ],
  lang: 'en',
  availableLangs: ['en', 'es'],
};

describe('Supadata transcript', () => {
  it('asks for native captions and returns segments in seconds, without empty ones', async () => {
    const { provider, requests } = supadata(json(transcript));

    const result = await provider.getTranscript(VIDEO_ID);

    expect(result).toEqual({
      language: 'en',
      segments: [
        { text: 'Welcome to the course.', startSeconds: 0, endSeconds: 2.5 },
        { text: 'Today: gradient descent.', startSeconds: 3, endSeconds: 7.2 },
      ],
    });
    const [request] = requests;
    expect(request?.url.href.split('?')[0]).toBe('https://api.supadata.ai/v1/transcript');
    expect(Object.fromEntries(request?.url.searchParams ?? [])).toEqual({
      url: WATCH_URL,
      text: 'false',
      mode: 'native',
    });
    expect(request?.headers.get('x-api-key')).toBe('sd-test');
  });

  it('no captions (206 transcript-unavailable) → permanent NO_TRANSCRIPT', async () => {
    const { provider } = supadata(
      json({ error: 'transcript-unavailable', message: 'No transcript', details: '' }, 206),
    );

    const error = await failure(provider.getTranscript(VIDEO_ID));

    expect(error).toMatchObject({ code: 'NO_TRANSCRIPT', retryable: false });
    expect(error.message).toContain('no captions');
  });

  it('captions with no words → permanent NO_TRANSCRIPT', async () => {
    const { provider } = supadata(
      json({ content: [{ text: ' ', offset: 0, duration: 1000 }], lang: 'en' }),
    );

    expect(await failure(provider.getTranscript(VIDEO_ID))).toMatchObject({
      code: 'NO_TRANSCRIPT',
      retryable: false,
    });
  });

  it.each([
    ['not-found', 404],
    ['forbidden', 403],
  ])('%s (%i) → permanent VIDEO_UNAVAILABLE', async (id, status) => {
    const { provider } = supadata(json({ error: id, message: 'x' }, status));

    expect(await failure(provider.getTranscript(VIDEO_ID))).toMatchObject({
      code: 'VIDEO_UNAVAILABLE',
      retryable: false,
    });
  });

  it.each([
    ['limit-exceeded', 429],
    ['internal-error', 500],
  ])('%s (%i) → transient', async (id, status) => {
    const { provider } = supadata(json({ error: id, message: 'x' }, status));

    expect(await failure(provider.getTranscript(VIDEO_ID))).toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      retryable: true,
    });
  });

  it.each([
    ['unauthorized', 401],
    ['upgrade-required', 402],
  ])('%s (%i) → permanent, vendor detail kept for the log but not shown', async (id, status) => {
    const { provider } = supadata(json({ error: id, message: 'Check your API key' }, status));

    const error = await failure(provider.getTranscript(VIDEO_ID));

    expect(error).toMatchObject({ code: 'PROCESSING_FAILED', retryable: false });
    expect(error.message).toBe("We couldn't read this video. Please try again later.");
    expect((error.cause as Error).message).toBe(`Supadata ${status} ${id}: Check your API key`);
  });

  it('invalid-request (400) → permanent', async () => {
    const { provider } = supadata(json({ error: 'invalid-request', message: 'Bad url' }, 400));

    expect(await failure(provider.getTranscript(VIDEO_ID))).toMatchObject({
      code: 'PROCESSING_FAILED',
      retryable: false,
    });
  });

  it('timeout and network failure → transient', async () => {
    const timedOut = supadata(timeoutError());
    const offline = supadata(new TypeError('fetch failed'));

    expect(await failure(timedOut.provider.getTranscript(VIDEO_ID))).toMatchObject({
      retryable: true,
    });
    expect(await failure(offline.provider.getTranscript(VIDEO_ID))).toMatchObject({
      retryable: true,
    });
  });

  it('a gateway error page that is not JSON → transient', async () => {
    const { provider } = supadata(new Response('<html>Bad gateway</html>', { status: 502 }));

    expect(await failure(provider.getTranscript(VIDEO_ID))).toMatchObject({ retryable: true });
  });

  it('a 200 with an unexpected body → transient', async () => {
    const { provider } = supadata(json({ content: 'plain text, not segments' }));

    expect(await failure(provider.getTranscript(VIDEO_ID))).toMatchObject({ retryable: true });
  });

  describe('background job (202)', () => {
    it('polls the job until it completes', async () => {
      const { provider, requests, sleeps } = supadata(
        json({ jobId: 'job_1' }, 202),
        json({ status: 'queued', error: null }),
        json({ status: 'active', error: null }),
        json({ status: 'completed', error: null, ...transcript }),
      );

      const result = await provider.getTranscript(VIDEO_ID);

      expect(result.segments).toHaveLength(2);
      expect(requests.slice(1).map((r) => r.url.pathname)).toEqual([
        '/v1/transcript/job_1',
        '/v1/transcript/job_1',
        '/v1/transcript/job_1',
      ]);
      expect(sleeps).toEqual([2_000, 2_000, 2_000]);
    });

    it('still not ready after the last poll → transient', async () => {
      const { provider, requests } = supadata(
        json({ jobId: 'job_1' }, 202),
        json({ status: 'queued' }),
        json({ status: 'active' }),
        json({ status: 'active' }),
      );

      const error = await failure(provider.getTranscript(VIDEO_ID));

      expect(error).toMatchObject({ code: 'SERVICE_UNAVAILABLE', retryable: true });
      expect(error.message).toContain('still being prepared');
      expect(requests).toHaveLength(4);
    });

    it('the job fails because there are no captions → permanent NO_TRANSCRIPT', async () => {
      const { provider } = supadata(
        json({ jobId: 'job_1' }, 202),
        json({ status: 'failed', error: { error: 'transcript-unavailable', message: 'None' } }),
      );

      expect(await failure(provider.getTranscript(VIDEO_ID))).toMatchObject({
        code: 'NO_TRANSCRIPT',
        retryable: false,
      });
    });

    it('the job fails for an unknown reason → permanent PROCESSING_FAILED', async () => {
      const { provider } = supadata(
        json({ jobId: 'job_1' }, 202),
        json({ status: 'failed', error: null }),
      );

      expect(await failure(provider.getTranscript(VIDEO_ID))).toMatchObject({
        code: 'PROCESSING_FAILED',
        retryable: false,
      });
    });
  });

  describe('video details', () => {
    it('returns the title and the length in seconds', async () => {
      const { provider, requests } = supadata(
        json({
          platform: 'youtube',
          title: ' Intro to ML ',
          media: { type: 'video', duration: 754 },
        }),
      );

      expect(await provider.getVideo(VIDEO_ID)).toEqual({
        title: 'Intro to ML',
        durationSeconds: 754,
      });
      expect(requests[0]?.url.pathname).toBe('/v1/metadata');
      expect(requests[0]?.url.searchParams.get('url')).toBe(WATCH_URL);
    });

    it('missing title or length → null', async () => {
      const { provider } = supadata(json({ platform: 'youtube', title: null, media: {} }));

      expect(await provider.getVideo(VIDEO_ID)).toEqual({ title: null, durationSeconds: null });
    });

    it('not-found (404) → permanent VIDEO_UNAVAILABLE', async () => {
      const { provider } = supadata(json({ error: 'not-found', message: 'x' }, 404));

      expect(await failure(provider.getVideo(VIDEO_ID))).toMatchObject({
        code: 'VIDEO_UNAVAILABLE',
        retryable: false,
      });
    });
  });
});
