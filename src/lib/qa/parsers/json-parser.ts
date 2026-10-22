import { RawExtractedQuestion, JSONImportQuestionSchema } from '../types.js';

export interface JSONParseResult {
  questions: RawExtractedQuestion[];
  errors: Array<{ index: number; message: string }>;
}

export function parseJSONQA(jsonString: string): JSONParseResult {
  if (!jsonString || typeof jsonString !== 'string') {
    return { questions: [], errors: [{ index: 0, message: 'Empty or invalid JSON payload' }] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonString);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Syntax error';
    return { questions: [], errors: [{ index: 0, message: `JSON parse error: ${msg}` }] };
  }

  let itemsArray: unknown[] = [];
  if (Array.isArray(parsed)) {
    itemsArray = parsed;
  } else if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    if (Array.isArray(obj.questions)) {
      itemsArray = obj.questions;
    } else if (Array.isArray(obj.items)) {
      itemsArray = obj.items;
    } else if (Array.isArray(obj.data)) {
      itemsArray = obj.data;
    } else if (typeof obj.question === 'string' && typeof obj.answer === 'string') {
      itemsArray = [obj];
    } else {
      return {
        questions: [],
        errors: [{ index: 0, message: 'Expected JSON array of question objects or an object with a "questions" array.' }],
      };
    }
  }

  const questions: RawExtractedQuestion[] = [];
  const errors: Array<{ index: number; message: string }> = [];

  for (let i = 0; i < itemsArray.length; i++) {
    const item = itemsArray[i];
    const validation = JSONImportQuestionSchema.safeParse(item);
    if (!validation.success) {
      errors.push({
        index: i,
        message: validation.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join(', '),
      });
      continue;
    }

    const data = validation.data;
    questions.push({
      question: data.question.trim(),
      answer: data.answer.trim(),
      explanation: data.explanation?.trim() || null,
      technology: data.technology?.trim() || null,
      topic: data.topic?.trim() || 'General',
      subtopic: data.subtopic?.trim() || null,
      difficulty: data.difficulty || null,
      questionType: data.questionType || (data.options && data.options.length > 0 ? 'MULTIPLE_CHOICE' : 'SHORT_ANSWER'),
      options: data.options || null,
      correctOption: data.correctOption?.trim() || null,
      tags: data.tags || null,
      sourceUrl: data.sourceUrl || null,
    });
  }

  return { questions, errors };
}
