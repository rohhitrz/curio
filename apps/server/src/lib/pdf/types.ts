export interface PdfPage {
  /** 1-based. */
  pageNumber: number;
  /** May be empty (a blank page or a page that is only an image). */
  text: string;
}

export interface ParsedPdf {
  /** Every page, in order. At least one has text. */
  pages: PdfPage[];
}

/** Reads the text of a PDF, page by page. Failures are permanent `IngestionError`s. */
export interface PdfParser {
  parse(file: Uint8Array): Promise<ParsedPdf>;
}
