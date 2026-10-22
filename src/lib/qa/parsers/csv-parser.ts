import { RawExtractedQuestion } from '../types.js';

export interface CSVColumnMapping {
  question: string;
  answer: string;
  technology?: string;
  topic?: string;
  subtopic?: string;
  difficulty?: string;
  explanation?: string;
  questionType?: string;
  options?: string;
  sourceUrl?: string;
}

export interface CSVParseResult {
  questions: RawExtractedQuestion[];
  headers: string[];
  totalRows: number;
  rejectedRows: Array<{ rowNumber: number; reason: string }>;
}

/**
 * Standard RFC-4180 compliant CSV line tokenizer supporting multiline quoted values.
 */
export function tokenizeCSV(csvText: string): string[][] {
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentField = '';
  let insideQuotes = false;

  for (let i = 0; i < csvText.length; i++) {
    const char = csvText[i];
    const nextChar = csvText[i + 1];

    if (insideQuotes) {
      if (char === '"') {
        if (nextChar === '"') {
          // Escaped quote: ""
          currentField += '"';
          i++; // Skip escaped quote
        } else {
          // Closing quote
          insideQuotes = false;
        }
      } else {
        currentField += char;
      }
    } else {
      if (char === '"') {
        insideQuotes = true;
      } else if (char === ',') {
        currentRow.push(currentField);
        currentField = '';
      } else if (char === '\r') {
        if (nextChar === '\n') {
          i++;
        }
        currentRow.push(currentField);
        currentField = '';
        rows.push(currentRow);
        currentRow = [];
      } else if (char === '\n') {
        currentRow.push(currentField);
        currentField = '';
        rows.push(currentRow);
        currentRow = [];
      } else {
        currentField += char;
      }
    }
  }

  if (currentField.length > 0 || currentRow.length > 0) {
    currentRow.push(currentField);
    rows.push(currentRow);
  }

  return rows;
}

/**
 * Auto-detects standard column names from CSV headers.
 */
export function autoDetectColumnMapping(headers: string[]): CSVColumnMapping {
  const clean = headers.map((h) => h.toLowerCase().trim().replace(/[^a-z0-9]/g, ''));
  const mapping: CSVColumnMapping = {
    question: '',
    answer: '',
  };

  for (let i = 0; i < headers.length; i++) {
    const h = clean[i];
    const raw = headers[i];

    if (!mapping.question && ['question', 'q', 'questiontext', 'prompt', 'problem', 'title'].includes(h)) {
      mapping.question = raw;
    } else if (!mapping.answer && ['answer', 'a', 'answercontent', 'solution', 'response', 'correctanswer'].includes(h)) {
      mapping.answer = raw;
    } else if (!mapping.technology && ['technology', 'tech', 'skill', 'programminglanguage', 'language'].includes(h)) {
      mapping.technology = raw;
    } else if (!mapping.topic && ['topic', 'category', 'theme'].includes(h)) {
      mapping.topic = raw;
    } else if (!mapping.subtopic && ['subtopic', 'subcategory'].includes(h)) {
      mapping.subtopic = raw;
    } else if (!mapping.difficulty && ['difficulty', 'level', 'difficultylevel'].includes(h)) {
      mapping.difficulty = raw;
    } else if (!mapping.explanation && ['explanation', 'explain', 'detail', 'rationale'].includes(h)) {
      mapping.explanation = raw;
    } else if (!mapping.questionType && ['questiontype', 'type', 'format'].includes(h)) {
      mapping.questionType = raw;
    } else if (!mapping.options && ['options', 'choices', 'answers'].includes(h)) {
      mapping.options = raw;
    } else if (!mapping.sourceUrl && ['sourceurl', 'url', 'link', 'source'].includes(h)) {
      mapping.sourceUrl = raw;
    }
  }

  // Fallbacks: If question or answer weren't explicitly matched, use column 0 and column 1
  if (!mapping.question && headers.length > 0) {
    mapping.question = headers[0];
  }
  if (!mapping.answer && headers.length > 1) {
    mapping.answer = headers[1];
  }

  return mapping;
}

export function parseCSVQA(csvText: string, customMapping?: Partial<CSVColumnMapping>): CSVParseResult {
  if (!csvText || typeof csvText !== 'string') {
    return { questions: [], headers: [], totalRows: 0, rejectedRows: [] };
  }

  const rawRows = tokenizeCSV(csvText).filter((row) => row.some((cell) => cell.trim().length > 0));
  if (rawRows.length === 0) {
    return { questions: [], headers: [], totalRows: 0, rejectedRows: [] };
  }

  const headers = rawRows[0].map((h) => h.trim());
  const headerIndexMap = new Map<string, number>();
  headers.forEach((h, idx) => headerIndexMap.set(h, idx));

  const mapping: CSVColumnMapping = {
    ...autoDetectColumnMapping(headers),
    ...(customMapping || {}),
  };

  const qIdx = mapping.question ? headerIndexMap.get(mapping.question) : undefined;
  const aIdx = mapping.answer ? headerIndexMap.get(mapping.answer) : undefined;
  const techIdx = mapping.technology ? headerIndexMap.get(mapping.technology) : undefined;
  const topicIdx = mapping.topic ? headerIndexMap.get(mapping.topic) : undefined;
  const subtopicIdx = mapping.subtopic ? headerIndexMap.get(mapping.subtopic) : undefined;
  const diffIdx = mapping.difficulty ? headerIndexMap.get(mapping.difficulty) : undefined;
  const expIdx = mapping.explanation ? headerIndexMap.get(mapping.explanation) : undefined;
  const typeIdx = mapping.questionType ? headerIndexMap.get(mapping.questionType) : undefined;
  const optIdx = mapping.options ? headerIndexMap.get(mapping.options) : undefined;
  const urlIdx = mapping.sourceUrl ? headerIndexMap.get(mapping.sourceUrl) : undefined;

  const questions: RawExtractedQuestion[] = [];
  const rejectedRows: Array<{ rowNumber: number; reason: string }> = [];

  for (let r = 1; r < rawRows.length; r++) {
    const row = rawRows[r];
    const rowNumber = r + 1; // 1-based indexing for display

    if (qIdx === undefined || aIdx === undefined) {
      rejectedRows.push({ rowNumber, reason: 'Missing question or answer column mapping' });
      continue;
    }

    const questionText = row[qIdx]?.trim();
    const answerContent = row[aIdx]?.trim();

    if (!questionText || questionText.length < 5) {
      rejectedRows.push({ rowNumber, reason: 'Question is empty or too short (min 5 chars)' });
      continue;
    }

    if (!answerContent || answerContent.length < 3) {
      rejectedRows.push({ rowNumber, reason: 'Answer is empty or too short (min 3 chars)' });
      continue;
    }

    let parsedOptions: string[] | null = null;
    if (optIdx !== undefined && row[optIdx]) {
      const rawOpt = row[optIdx].trim();
      if (rawOpt.startsWith('[') && rawOpt.endsWith(']')) {
        try {
          parsedOptions = JSON.parse(rawOpt);
        } catch {
          parsedOptions = rawOpt.split(/;|\n|\|/).map((o) => o.trim()).filter(Boolean);
        }
      } else {
        parsedOptions = rawOpt.split(/;|\n|\|/).map((o) => o.trim()).filter(Boolean);
      }
    }

    questions.push({
      question: questionText,
      answer: answerContent,
      technology: techIdx !== undefined && row[techIdx] ? row[techIdx].trim() : null,
      topic: topicIdx !== undefined && row[topicIdx] ? row[topicIdx].trim() : 'General',
      subtopic: subtopicIdx !== undefined && row[subtopicIdx] ? row[subtopicIdx].trim() : null,
      difficulty: diffIdx !== undefined && row[diffIdx] ? row[diffIdx].trim() : null,
      explanation: expIdx !== undefined && row[expIdx] ? row[expIdx].trim() : null,
      questionType: typeIdx !== undefined && row[typeIdx] ? row[typeIdx].trim() : (parsedOptions && parsedOptions.length > 0 ? 'MULTIPLE_CHOICE' : 'SHORT_ANSWER'),
      options: parsedOptions,
      sourceUrl: urlIdx !== undefined && row[urlIdx] ? row[urlIdx].trim() : null,
    });
  }

  return {
    questions,
    headers,
    totalRows: rawRows.length - 1,
    rejectedRows,
  };
}
