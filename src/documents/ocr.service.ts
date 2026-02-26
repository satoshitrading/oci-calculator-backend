import { Injectable } from '@nestjs/common';
import { createWorker } from 'tesseract.js';
import { fromBuffer } from 'pdf2pic';

const OCR_TEXT_THRESHOLD = 50;
const PDF2PIC_OPTIONS = {
  format: 'png' as const,
  density: 150,
  width: 1200,
  height: 1600,
  preserveAspectRatio: true,
};

@Injectable()
export class OcrService {
  /**
   * Extract text from an image buffer using Tesseract.js.
   */
  async extractTextFromImage(imageBuffer: Buffer): Promise<string> {
    const worker = await createWorker('eng', 1, {
      logger: () => {},
    });
    try {
      const {
        data: { text },
      } = await worker.recognize(imageBuffer);
      return text?.trim() ?? '';
    } finally {
      await worker.terminate();
    }
  }

  /**
   * Convert PDF buffer to image buffers and run OCR on each page.
   * Requires GraphicsMagick or ImageMagick and Ghostscript to be installed.
   */
  async extractTextFromPdfPages(pdfBuffer: Buffer, numPages: number): Promise<string> {
    if (numPages < 1) return '';

    let convert: (page: number, options: { responseType: 'buffer' }) => Promise<{ buffer?: Buffer }>;
    try {
      convert = fromBuffer(pdfBuffer, PDF2PIC_OPTIONS);
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : 'PDF to image conversion failed.';
      throw new Error(
        `Document could not be read. Scanned PDFs require OCR. ${msg} Install ImageMagick or GraphicsMagick and Ghostscript for scanned PDF support.`,
      );
    }

    const worker = await createWorker('eng', 1, { logger: () => {} });
    const parts: string[] = [];

    try {
      for (let page = 1; page <= numPages; page++) {
        let result: { buffer?: Buffer };
        try {
          result = await convert(page, { responseType: 'buffer' });
        } catch (convertErr) {
          break;
        }
        const buf = result?.buffer ?? (result as unknown as Buffer);
        if (buf && Buffer.isBuffer(buf) && buf.length > 0) {
          const { data } = await worker.recognize(buf);
          if (data?.text?.trim()) {
            parts.push(data.text.trim());
          }
        }
      }
    } finally {
      await worker.terminate();
    }

    return parts.join('\n\n');
  }

  /**
   * Returns true if the given text is considered too short (likely a scanned image PDF).
   */
  isTextInsufficient(text: string): boolean {
    return (text?.trim().length ?? 0) < OCR_TEXT_THRESHOLD;
  }
}
