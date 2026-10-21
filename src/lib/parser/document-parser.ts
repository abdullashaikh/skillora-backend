import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import mammoth from 'mammoth';

// Safe dynamic import for pdf-parse to avoid CommonJS/ESM bundling conflicts
async function parsePdfBuffer(buffer: Buffer): Promise<{ text: string; numpages: number }> {
  const pdfParseModule = await import('pdf-parse');
  const pdfParse = pdfParseModule.default || pdfParseModule;
  // Node 20+ Uint8Array conversion ensures pdf.js internal array buffer offsets remain exact
  const uint8Data = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const result = await (pdfParse as any)(uint8Data);
  return {
    text: result.text || '',
    numpages: result.numpages || 1,
  };
}

export interface ParseOptions {
  maxSizeBytes?: number;
  maxPages?: number;
}

export interface ParsedDocumentResult {
  text: string;
  pageCount: number | null;
  mimeType: string;
  fileSizeBytes: number;
  warnings: string[];
}

const PDF_MAGIC_BYTES = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d]); // "%PDF-"
const ZIP_MAGIC_BYTES = Buffer.from([0x50, 0x4b, 0x03, 0x04]);       // "PK\x03\x04"

/**
 * Validates magic bytes against expected file signatures.
 */
export function detectDocumentFormat(buffer: Buffer): 'pdf' | 'docx' | 'unknown' {
  if (buffer.length < 5) return 'unknown';

  if (buffer.subarray(0, 5).equals(PDF_MAGIC_BYTES)) {
    return 'pdf';
  }

  if (buffer.subarray(0, 4).equals(ZIP_MAGIC_BYTES)) {
    return 'docx';
  }

  return 'unknown';
}

const DEFAULT_MAX_SIZE = 5 * 1024 * 1024; // 5MB
const DEFAULT_MAX_PAGES = 5;

/**
 * Robust document parsing for PDF and DOCX files.
 * Performs signature verification, page count checks, size validation,
 * and safe temporary file lifecycle management.
 */
export async function parseDocument(
  fileBuffer: Buffer,
  originalFilename: string,
  options: ParseOptions = {}
): Promise<ParsedDocumentResult> {
  const maxSizeBytes = options.maxSizeBytes || DEFAULT_MAX_SIZE;
  const maxPages = options.maxPages || DEFAULT_MAX_PAGES;
  const warnings: string[] = [];

  // 1. File Size Verification
  if (fileBuffer.length === 0) {
    throw new Error('Uploaded file is empty (0 bytes).');
  }

  if (fileBuffer.length > maxSizeBytes) {
    const sizeMb = (fileBuffer.length / (1024 * 1024)).toFixed(2);
    const limitMb = (maxSizeBytes / (1024 * 1024)).toFixed(2);
    throw new Error(`File size (${sizeMb} MB) exceeds maximum allowed size of ${limitMb} MB.`);
  }

  // 2. Format & Magic Byte Verification
  const detectedFormat = detectDocumentFormat(fileBuffer);
  const ext = path.extname(originalFilename).toLowerCase();

  if (detectedFormat === 'unknown') {
    throw new Error(
      'Invalid or unsupported document format. Only valid PDF and DOCX files are accepted.'
    );
  }

  if (detectedFormat === 'pdf' && ext !== '.pdf') {
    warnings.push('File content is PDF, but filename extension was not .pdf.');
  }

  if (detectedFormat === 'docx' && ext !== '.docx') {
    warnings.push('File content is DOCX, but filename extension was not .docx.');
  }

  // 3. Isolated Temporary Storage for Processing
  const tempDir = path.join(process.cwd(), process.env.TEMP_STORAGE_DIR || 'temp');
  await fs.mkdir(tempDir, { recursive: true });

  const tempFilename = `${crypto.randomUUID()}.tmp`;
  const tempFilePath = path.join(tempDir, tempFilename);

  let rawExtractedText = '';
  let pageCount: number | null = null;
  const mimeType = detectedFormat === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

  try {
    // Write to private temp file for secure processing
    await fs.writeFile(tempFilePath, fileBuffer, { mode: 0o600 });

    if (detectedFormat === 'pdf') {
      const pdfData = await parsePdfBuffer(fileBuffer);
      pageCount = pdfData.numpages;

      if (pageCount > maxPages) {
        throw new Error(
          `Document has ${pageCount} pages, which exceeds the maximum limit of ${maxPages} pages.`
        );
      }

      rawExtractedText = pdfData.text;
    } else {
      // DOCX parsing via mammoth
      const result = await mammoth.extractRawText({ buffer: fileBuffer });
      rawExtractedText = result.value || '';
      if (result.messages && result.messages.length > 0) {
        for (const msg of result.messages) {
          if (msg.type === 'warning') {
            warnings.push(msg.message);
          }
        }
      }
      // DOCX does not have fixed physical pages, estimated based on character count ~ 3000 chars/page
      pageCount = Math.max(1, Math.ceil(rawExtractedText.length / 3000));
    }
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes('maximum limit')) {
      throw err;
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse document: ${message}`);
  } finally {
    // Safe immediate cleanup of temporary file
    try {
      await fs.unlink(tempFilePath);
    } catch {
      // Temp file already unlinked or not created
    }
  }

  // 4. Validate extracted text
  const trimmed = rawExtractedText.trim();
  if (!trimmed || trimmed.length < 50) {
    throw new Error(
      'Scanned document or non-extractable text detected. Please upload a text-based resume or run OCR on your document first.'
    );
  }

  return {
    text: trimmed,
    pageCount,
    mimeType,
    fileSizeBytes: fileBuffer.length,
    warnings,
  };
}

/**
 * Maintenance helper to clean up any abandoned temp files older than 1 hour.
 */
export async function cleanupStaleTempFiles(maxAgeMs = 60 * 60 * 1000): Promise<number> {
  const tempDir = path.join(process.cwd(), process.env.TEMP_STORAGE_DIR || 'temp');
  let cleanedCount = 0;
  try {
    const files = await fs.readdir(tempDir);
    const now = Date.now();
    for (const file of files) {
      if (!file.endsWith('.tmp')) continue;
      const filePath = path.join(tempDir, file);
      try {
        const stats = await fs.stat(filePath);
        if (now - stats.mtimeMs > maxAgeMs) {
          await fs.unlink(filePath);
          cleanedCount++;
        }
      } catch {
        // ignore individual file error
      }
    }
  } catch {
    // directory doesn't exist yet
  }
  return cleanedCount;
}
