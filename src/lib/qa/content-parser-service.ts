import { ParserType, RawExtractedQuestion, WebsiteParserConfig } from './types.js';
import { parseMarkdownQA } from './parsers/markdown-parser.js';
import { parseJSONQA } from './parsers/json-parser.js';
import { parseCSVQA, CSVColumnMapping } from './parsers/csv-parser.js';
import { parseHTMLQA } from './parsers/html-parser.js';

export interface ContentParserOptions {
  filename?: string;
  sourceUrl?: string;
  parserType?: ParserType;
  defaultTopic?: string;
  parserConfig?: Record<string, any>;
  customCsvMapping?: Partial<CSVColumnMapping>;
}

export interface UnifiedParseResult {
  questions: RawExtractedQuestion[];
  errors: string[];
  detectedFormat: string;
}

export class ContentParserService {
  /**
   * Automatically determines format and extracts structured Q&A.
   */
  public static parse(content: string, options: ContentParserOptions = {}): UnifiedParseResult {
    const filename = options.filename?.toLowerCase() || '';
    const parserType = options.parserType || ParserType.AUTO;
    const defaultTopic = options.defaultTopic || 'General';

    // 1. Explicit ParserType override
    if (parserType === ParserType.MARKDOWN_HEADINGS) {
      const questions = parseMarkdownQA(content, defaultTopic);
      return { questions, errors: [], detectedFormat: 'MARKDOWN' };
    }

    if (parserType === ParserType.JSON_SCHEMA) {
      const result = parseJSONQA(content);
      return {
        questions: result.questions,
        errors: result.errors.map((e) => `Item ${e.index}: ${e.message}`),
        detectedFormat: 'JSON',
      };
    }

    if (parserType === ParserType.CSV_MAPPING) {
      const result = parseCSVQA(content, options.customCsvMapping);
      return {
        questions: result.questions,
        errors: result.rejectedRows.map((r) => `Row ${r.rowNumber}: ${r.reason}`),
        detectedFormat: 'CSV',
      };
    }

    if (parserType === ParserType.HTML_SELECTORS) {
      const htmlConfig: WebsiteParserConfig = options.parserConfig || {};
      const questions = parseHTMLQA(content, htmlConfig, defaultTopic, options.sourceUrl);
      return { questions, errors: [], detectedFormat: 'HTML' };
    }

    // 2. Auto-detect by extension
    if (filename.endsWith('.json')) {
      const result = parseJSONQA(content);
      return {
        questions: result.questions,
        errors: result.errors.map((e) => `Item ${e.index}: ${e.message}`),
        detectedFormat: 'JSON',
      };
    }

    if (filename.endsWith('.csv')) {
      const result = parseCSVQA(content, options.customCsvMapping);
      return {
        questions: result.questions,
        errors: result.rejectedRows.map((r) => `Row ${r.rowNumber}: ${r.reason}`),
        detectedFormat: 'CSV',
      };
    }

    if (filename.endsWith('.md') || filename.endsWith('.markdown')) {
      const questions = parseMarkdownQA(content, defaultTopic);
      return { questions, errors: [], detectedFormat: 'MARKDOWN' };
    }

    if (filename.endsWith('.html') || filename.endsWith('.htm') || content.trim().startsWith('<!DOCTYPE') || content.trim().startsWith('<html')) {
      const htmlConfig: WebsiteParserConfig = options.parserConfig || {};
      const questions = parseHTMLQA(content, htmlConfig, defaultTopic, options.sourceUrl);
      return { questions, errors: [], detectedFormat: 'HTML' };
    }

    // 3. Fallback heuristic detection by content structure
    const trimmed = content.trim();
    if (trimmed.startsWith('[') || (trimmed.startsWith('{') && trimmed.includes('"question"'))) {
      const result = parseJSONQA(content);
      if (result.questions.length > 0) {
        return {
          questions: result.questions,
          errors: result.errors.map((e) => `Item ${e.index}: ${e.message}`),
          detectedFormat: 'JSON',
        };
      }
    }

    if (trimmed.includes('#') || trimmed.includes('###') || /^Q\d*:/m.test(trimmed)) {
      const questions = parseMarkdownQA(content, defaultTopic);
      if (questions.length > 0) {
        return { questions, errors: [], detectedFormat: 'MARKDOWN' };
      }
    }

    // Try CSV tokenizer
    if (trimmed.includes(',') && trimmed.includes('\n')) {
      const csvResult = parseCSVQA(content, options.customCsvMapping);
      if (csvResult.questions.length > 0) {
        return {
          questions: csvResult.questions,
          errors: csvResult.rejectedRows.map((r) => `Row ${r.rowNumber}: ${r.reason}`),
          detectedFormat: 'CSV',
        };
      }
    }

    // Default to markdown/text parser
    const fallbackQuestions = parseMarkdownQA(content, defaultTopic);
    return { questions: fallbackQuestions, errors: [], detectedFormat: 'TEXT' };
  }
}
