import { createHash } from 'node:crypto';

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Query params that only track clicks; they never change the page. */
const TRACKING_PARAMS = new Set([
  'fbclid',
  'gclid',
  'dclid',
  'msclkid',
  'mc_cid',
  'mc_eid',
  'igshid',
  'ref_src',
  '_ga',
  '_gl',
]);

function isTrackingParam(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.startsWith('utm_') || TRACKING_PARAMS.has(lower);
}

/**
 * Canonical form of a web URL for dedupe: lowercase host without `www.`, no default port,
 * no fragment, no tracking params, sorted query, no trailing slash. Path case is kept,
 * since paths are case-sensitive on most servers. Only used for hashing, never for fetching.
 */
export function normalizeUrl(raw: string): string {
  const url = new URL(raw.trim());
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  const port = url.port ? `:${url.port}` : '';

  const params = [...url.searchParams.entries()]
    .filter(([name]) => !isTrackingParam(name))
    .sort(([a, av], [b, bv]) => (a === b ? av.localeCompare(bv) : a.localeCompare(b)));
  const query = params.length > 0 ? `?${new URLSearchParams(params).toString()}` : '';

  const path = url.pathname.replace(/\/+$/, '');
  return `${url.protocol}//${host}${port}${path}${query}`;
}

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const YOUTUBE_HOSTS = new Set(['youtube.com', 'm.youtube.com', 'music.youtube.com']);

/**
 * The 11-char video ID from `watch?v=`, `youtu.be/`, `shorts/`, `embed/`, `live/` or `v/` URLs,
 * ignoring timestamps and other params. Returns null for anything that isn't a video URL.
 */
export function parseYouTubeVideoId(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;

  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  const segments = url.pathname.split('/').filter(Boolean);
  let id: string | null | undefined;

  if (host === 'youtu.be') {
    id = segments[0];
  } else if (YOUTUBE_HOSTS.has(host)) {
    if (segments[0] === 'watch') id = url.searchParams.get('v');
    else if (['shorts', 'embed', 'live', 'v'].includes(segments[0] ?? '')) id = segments[1];
  }

  return id && VIDEO_ID.test(id) ? id : null;
}

export function canonicalYouTubeUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

/** Line endings normalized, so the same text pasted on Windows and macOS dedupes. */
export function normalizeText(content: string): string {
  return content.replace(/\r\n?/g, '\n').trim();
}
