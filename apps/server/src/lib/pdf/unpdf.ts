import { extractText, getDocumentProxy } from 'unpdf';
import { ExtractionError } from '../../errors/extraction-error.js';
import type { PdfParser } from './types.js';

const PDF_MAGIC = '%PDF-';
/** Readers accept junk before the header, as long as it starts within the first 1024 bytes. */
const MAGIC_SEARCH_BYTES = 1024;

const messages = {
  notPdf: "This file isn't a PDF.",
  corrupted: "This PDF couldn't be opened. The file may be damaged.",
  password: 'This PDF is password-protected. Remove the password and upload it again.',
  scanned:
    'This PDF has no selectable text (it looks scanned). Scanned documents are not supported yet.',
};

function looksLikePdf(file: Uint8Array): boolean {
  const head = Buffer.from(file.buffer, file.byteOffset, Math.min(file.length, MAGIC_SEARCH_BYTES));
  return head.includes(PDF_MAGIC, 0, 'latin1');
}

function isPasswordError(error: unknown): boolean {
  return error instanceof Error && error.name === 'PasswordException';
}

export function createUnpdfParser(): PdfParser {
  return {
    async parse(file) {
      // The type is checked by content, not by the name or the declared Content-Type.
      if (!looksLikePdf(file)) throw ExtractionError.permanent('INVALID_FILE', messages.notPdf);

      let pageTexts: string[];
      try {
        // pdf.js takes ownership of the buffer it is given, so it gets a copy.
        const document = await getDocumentProxy(new Uint8Array(file));
        ({ text: pageTexts } = await extractText(document, { mergePages: false }));
      } catch (cause) {
        throw ExtractionError.permanent(
          'INVALID_FILE',
          isPasswordError(cause) ? messages.password : messages.corrupted,
          { cause },
        );
      }

      const pages = pageTexts.map((text, index) => ({ pageNumber: index + 1, text: text.trim() }));
      if (pages.every((page) => page.text === '')) {
        throw ExtractionError.permanent('NO_TEXT', messages.scanned);
      }
      return { pages };
    },
  };
}
