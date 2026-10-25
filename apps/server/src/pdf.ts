/** Reads a PDF with pdf.js (via unpdf): the text of the first pages, and the document properties. */
import { extractText, getDocumentProxy } from 'unpdf';
import type { PdfContent, PdfReader } from '@zoning/core';

/** Zoning maps are one big sheet or a short atlas; dates sit on the first pages (title block) or the last (revision list). */
const MAX_PAGES = 6;

export const readPdf: PdfReader = async (bytes): Promise<PdfContent> => {
  // pdf.js takes ownership of the buffer it is given, so hand it a copy.
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  try {
    const meta = await pdf.getMetadata().catch(() => null);
    const info = (meta?.info ?? {}) as Record<string, unknown>;
    const pages = pdf.numPages;
    const { text } = await extractText(pdf, { mergePages: false });
    const list = Array.isArray(text) ? text : [text];
    const picked = pages <= MAX_PAGES ? list : [...list.slice(0, MAX_PAGES - 1), list[list.length - 1]];
    return {
      text: picked.join('\n'),
      pages,
      info: {
        creationDate: typeof info.CreationDate === 'string' ? info.CreationDate : undefined,
        modDate: typeof info.ModDate === 'string' ? info.ModDate : undefined,
        title: typeof info.Title === 'string' ? info.Title : undefined,
      },
    };
  } finally {
    await (pdf as unknown as { destroy?: () => Promise<void> }).destroy?.()?.catch?.(() => undefined);
  }
};
