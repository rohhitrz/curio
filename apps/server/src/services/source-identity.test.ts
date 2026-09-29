import { describe, expect, it } from 'vitest';
import {
  canonicalYouTubeUrl,
  normalizeText,
  normalizeUrl,
  parseYouTubeVideoId,
  sha256Hex,
} from './source-identity.js';

describe('normalizeUrl', () => {
  const base = 'https://example.com/articles/rag';

  it.each([
    ['trailing slash', 'https://example.com/articles/rag/'],
    ['www', 'https://www.example.com/articles/rag'],
    ['host case', 'https://EXAMPLE.com/articles/rag'],
    ['utm params', 'https://example.com/articles/rag?utm_source=x&utm_medium=y'],
    ['other tracking params', 'https://example.com/articles/rag?fbclid=abc&gclid=def'],
    ['fragment', 'https://example.com/articles/rag#section-2'],
    ['default port', 'https://example.com:443/articles/rag'],
    ['surrounding spaces', '  https://example.com/articles/rag  '],
    ['all at once', 'HTTPS://WWW.Example.COM/articles/rag/?UTM_Campaign=z#top'],
  ])('%s → same as the plain URL', (_label, variant) => {
    expect(normalizeUrl(variant)).toBe(normalizeUrl(base));
    expect(sha256Hex(normalizeUrl(variant))).toBe(sha256Hex(normalizeUrl(base)));
  });

  it('keeps meaningful query params, in a stable order', () => {
    expect(normalizeUrl('https://example.com/search?q=rag&page=2&utm_source=x')).toBe(
      normalizeUrl('https://example.com/search?page=2&q=rag'),
    );
    expect(normalizeUrl('https://example.com/search?q=rag')).not.toBe(
      normalizeUrl('https://example.com/search?q=llm'),
    );
  });

  it('keeps path case and non-default ports', () => {
    expect(normalizeUrl('https://example.com/Docs')).not.toBe(
      normalizeUrl('https://example.com/docs'),
    );
    expect(normalizeUrl('http://example.com:8080/a')).toBe('http://example.com:8080/a');
  });

  it('root URL with and without slash match', () => {
    expect(normalizeUrl('https://example.com/')).toBe(normalizeUrl('https://example.com'));
  });
});

describe('parseYouTubeVideoId', () => {
  const id = 'dQw4w9WgXcQ';

  it.each([
    `https://www.youtube.com/watch?v=${id}`,
    `https://youtube.com/watch?v=${id}&t=42s`,
    `https://m.youtube.com/watch?feature=share&v=${id}`,
    `https://youtu.be/${id}`,
    `https://youtu.be/${id}?t=90`,
    `https://www.youtube.com/shorts/${id}`,
    `https://www.youtube.com/embed/${id}?start=10`,
    `https://www.youtube.com/live/${id}`,
    `https://music.youtube.com/watch?v=${id}`,
    `http://WWW.YOUTUBE.COM/watch?v=${id}#t=1m`,
  ])('%s → video ID', (url) => {
    expect(parseYouTubeVideoId(url)).toBe(id);
  });

  it.each([
    'not a url',
    'https://example.com/watch?v=dQw4w9WgXcQ',
    'https://www.youtube.com/',
    'https://www.youtube.com/watch',
    'https://www.youtube.com/watch?v=short',
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ!',
    'https://www.youtube.com/@somechannel',
    'https://www.youtube.com/playlist?list=PL123',
    'https://youtu.be/',
    'ftp://youtu.be/dQw4w9WgXcQ',
  ])('%s → null', (url) => {
    expect(parseYouTubeVideoId(url)).toBeNull();
  });

  it('canonical URL round-trips', () => {
    expect(parseYouTubeVideoId(canonicalYouTubeUrl(id))).toBe(id);
  });
});

describe('normalizeText', () => {
  it('same text with different line endings and edge whitespace → same hash', () => {
    const a = sha256Hex(normalizeText('line one\nline two'));
    expect(sha256Hex(normalizeText('  line one\r\nline two\r\n'))).toBe(a);
    expect(sha256Hex(normalizeText('line one\rline two'))).toBe(a);
  });
});
