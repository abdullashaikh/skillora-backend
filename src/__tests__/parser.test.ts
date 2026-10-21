import { describe, it, expect } from 'vitest';
import { detectDocumentFormat, parseDocument } from '../lib/parser/document-parser';
import { scrubPii } from '../lib/parser/pii-scrubber';

describe('Document Parser & PII Scrubber', () => {
  it('should accurately detect PDF magic bytes', () => {
    const pdfBuffer = Buffer.from('%PDF-1.4 sample content');
    expect(detectDocumentFormat(pdfBuffer)).toBe('pdf');
  });

  it('should accurately detect DOCX / ZIP magic bytes', () => {
    const docxBuffer = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]);
    expect(detectDocumentFormat(docxBuffer)).toBe('docx');
  });

  it('should reject unknown binary signatures', () => {
    const rawTextBuffer = Buffer.from('Plain text without signature');
    expect(detectDocumentFormat(rawTextBuffer)).toBe('unknown');
  });

  it('should redact personal contact info while preserving technical facts', () => {
    const rawResumeText = `
John Doe
Email: john.doe@example.com
Phone: +1 (555) 234-5678
Address: 123 Main Street, Suite 400, New York, NY 10001
LinkedIn: https://linkedin.com/in/johndoe-developer

Professional Experience:
Software Engineer at TechCorp (2020 - 2024)
- Built high-performance microservices using TypeScript, Node.js, and PostgreSQL.
- Reduced database response times by 35%.
`;

    const result = scrubPii(rawResumeText);

    // Verified redactions
    expect(result.sanitizedText).not.toContain('john.doe@example.com');
    expect(result.sanitizedText).toContain('[EMAIL REDACTED]');

    expect(result.sanitizedText).not.toContain('(555) 234-5678');
    expect(result.sanitizedText).toContain('[PHONE REDACTED]');

    expect(result.sanitizedText).not.toContain('123 Main Street');
    expect(result.sanitizedText).toContain('[ADDRESS REDACTED]');

    // Verified preservation of factual skills and work history
    expect(result.sanitizedText).toContain('Software Engineer');
    expect(result.sanitizedText).toContain('TypeScript');
    expect(result.sanitizedText).toContain('PostgreSQL');
    expect(result.sanitizedText).toContain('35%');
  });

  it('should reject empty or undersized documents', async () => {
    const emptyBuffer = Buffer.alloc(0);
    await expect(parseDocument(emptyBuffer, 'resume.pdf')).rejects.toThrow(
      'Uploaded file is empty (0 bytes).'
    );
  });

  it('should parse real PDF document and extract text and page count', async () => {
    const fs = await import('fs/promises');
    const path = await import('path');
    const pdfPath = path.join(process.cwd(), 'samples', 'sample-resume.pdf');
    const buffer = await fs.readFile(pdfPath);

    const result = await parseDocument(buffer, 'sample-resume.pdf');
    expect(result.mimeType).toBe('application/pdf');
    expect(result.pageCount).toBe(1);
    expect(result.text).toContain('Alex Taylor');
    expect(result.text).toContain('Senior Full-Stack Software Engineer');
    expect(result.text).toContain('TypeScript');
    expect(result.text).toContain('PostgreSQL');
  });
});
