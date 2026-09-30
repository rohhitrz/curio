export interface ScrapedPage {
  /** The page's own title, when it has one. */
  title: string | null;
  /** Main content as markdown, headings included. Never empty. */
  markdown: string;
}

/** Reads a web page. Failures are `ExtractionError`s, already classified transient or permanent. */
export interface ScraperProvider {
  scrape(url: string): Promise<ScrapedPage>;
}
