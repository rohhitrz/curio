/**
 * Reading a page as a section (decision L-08): a learning path's official docs often start on a
 * table of contents, with the content on the pages it links to.
 */

/** Markdown links `[text](url "title")`; images (`![…](…)`) are skipped by the caller. */
const MARKDOWN_LINK = /(!?)\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;

/** A last path segment with one of these extensions is a page; any other extension is a file. */
const PAGE_EXTENSIONS = new Set(['html', 'htm', 'php', 'asp', 'aspx', 'md']);

const host = (url: URL) => url.hostname.toLowerCase().replace(/^www\./, '');

/** The page's folder: its path up to and including the last `/`. */
function folderOf(url: URL): string {
  return url.pathname.slice(0, url.pathname.lastIndexOf('/') + 1);
}

/** One key per page: no scheme, `www`, hash, trailing `/` or trailing `index.html`. */
function pageKey(url: URL): string {
  const path = url.pathname.replace(/\/index\.html?$/i, '/').replace(/\/+$/, '');
  return `${host(url)}${path}`;
}

function isFile(url: URL): boolean {
  const last = url.pathname.split('/').pop() ?? '';
  const dot = last.lastIndexOf('.');
  if (dot <= 0) return false;
  return !PAGE_EXTENSIONS.has(last.slice(dot + 1).toLowerCase());
}

/**
 * The pages a page's main content links to within its own section, in page order: same host,
 * under the page's folder, not the page itself, no query strings or files, each page once. At
 * most `max`.
 */
export function sectionLinks(pageUrl: string, markdown: string, max: number): string[] {
  if (max <= 0) return [];
  let base: URL;
  try {
    base = new URL(pageUrl);
  } catch {
    return [];
  }
  const folder = folderOf(base);
  const seen = new Set([pageKey(base)]);
  const links: string[] = [];

  for (const match of markdown.matchAll(MARKDOWN_LINK)) {
    if (match[1] === '!' || !match[2]) continue;
    let url: URL;
    try {
      url = new URL(match[2], base);
    } catch {
      continue;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
    if (host(url) !== host(base) || !url.pathname.startsWith(folder)) continue;
    if (url.search !== '' || isFile(url)) continue;
    const key = pageKey(url);
    if (seen.has(key)) continue;
    seen.add(key);
    url.hash = '';
    links.push(url.toString());
    if (links.length >= max) break;
  }
  return links;
}

/** A page's markdown under its title, unless it already opens with a top-level heading. */
function underTitle(page: { url: string; title: string | null; markdown: string }): string {
  const markdown = page.markdown.trim();
  if (/^#\s/.test(markdown)) return markdown;
  return `# ${page.title?.trim() || page.url}\n\n${markdown}`;
}

/** The first page and the linked pages read, as one markdown text (headings keep them apart). */
export function joinSection(
  first: { url: string; title: string | null; markdown: string },
  linked: { url: string; title: string | null; markdown: string }[],
): string {
  return [first, ...linked].map(underTitle).join('\n\n');
}
