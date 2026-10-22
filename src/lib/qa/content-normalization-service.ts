import crypto from 'crypto';
import {
  DifficultyLevel,
  LicenseSnapshot,
  NormalizedQuestionRecord,
  QuestionType,
  RawExtractedQuestion,
} from './types.js';
import { TechnologyService } from './technology-service.js';

export function normalizeTextContent(text: string): string {
  if (!text) return '';
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    // Remove non-printable control characters except \n and \t
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .trim();
}

/**
 * Computes a deterministic SHA-256 hash for exact deduplication.
 * Canonicalizes whitespace and casing to detect identical questions with trivial spacing differences.
 */
export function computeDeterministicContentHash(questionText: string): string {
  const canonical = questionText
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

export function normalizeDifficulty(raw?: string | DifficultyLevel | null): DifficultyLevel {
  if (!raw) return DifficultyLevel.UNKNOWN;
  const lower = String(raw).toLowerCase().trim();

  if (['beginner', 'easy', 'basic', 'junior', '1', 'level 1'].includes(lower)) {
    return DifficultyLevel.BEGINNER;
  }
  if (['intermediate', 'medium', 'mid', 'mid-level', '2', 'level 2'].includes(lower)) {
    return DifficultyLevel.INTERMEDIATE;
  }
  if (['advanced', 'hard', 'expert', 'senior', '3', 'level 3'].includes(lower)) {
    return DifficultyLevel.ADVANCED;
  }
  return DifficultyLevel.UNKNOWN;
}

export function normalizeQuestionType(
  raw?: string | QuestionType | null,
  options?: string[] | null
): QuestionType {
  if (options && options.length > 0) {
    return QuestionType.MULTIPLE_CHOICE;
  }
  if (!raw) return QuestionType.SHORT_ANSWER;

  const lower = String(raw).toLowerCase().trim();
  if (['multiple_choice', 'multiple choice', 'mcq', 'choice'].includes(lower)) {
    return QuestionType.MULTIPLE_CHOICE;
  }
  if (['code_output', 'code output', 'output', 'predict output'].includes(lower)) {
    return QuestionType.CODE_OUTPUT;
  }
  if (['debugging', 'debug', 'find bug', 'fix code'].includes(lower)) {
    return QuestionType.DEBUGGING;
  }
  if (['open_ended', 'open ended', 'discussion', 'architectural'].includes(lower)) {
    return QuestionType.OPEN_ENDED;
  }
  return QuestionType.SHORT_ANSWER;
}

export class ContentNormalizationService {
  /**
   * Normalizes an array of raw extracted questions against canonical skills,
   * difficulty enums, question types, and generates content hashes.
   */
  public static async normalizeBatch(
    rawQuestions: RawExtractedQuestion[],
    defaultLicense: LicenseSnapshot,
    fallbackTechnologyName?: string | null,
    fallbackTopic?: string
  ): Promise<NormalizedQuestionRecord[]> {
    const results: NormalizedQuestionRecord[] = [];

    for (const raw of rawQuestions) {
      const questionText = normalizeTextContent(raw.question);
      const answerContent = normalizeTextContent(raw.answer);
      const explanation = raw.explanation ? normalizeTextContent(raw.explanation) : null;

      const validationErrors: string[] = [];

      if (!questionText || questionText.length < 5) {
        validationErrors.push('Question text must be at least 5 characters');
      }

      if (!answerContent || answerContent.length < 3) {
        validationErrors.push('Answer content must be at least 3 characters');
      }

      // Resolve technology against canonical skills
      const techToSearch = raw.technology || fallbackTechnologyName || null;
      const matchedSkill = await TechnologyService.findCanonicalSkill(techToSearch);

      const topic = normalizeTextContent(raw.topic || fallbackTopic || 'General');
      const subtopic = raw.subtopic ? normalizeTextContent(raw.subtopic) : null;
      const difficulty = normalizeDifficulty(raw.difficulty);
      const questionType = normalizeQuestionType(raw.questionType, raw.options);
      const contentHash = computeDeterministicContentHash(questionText);

      // Clean options if any
      let cleanOptions: string[] | null = null;
      if (raw.options && Array.isArray(raw.options)) {
        cleanOptions = raw.options.map((o) => normalizeTextContent(o)).filter(Boolean);
        if (cleanOptions.length === 0) cleanOptions = null;
      }

      const tags = (raw.tags || [])
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean);

      results.push({
        normalizedQuestion: questionText,
        normalizedAnswer: answerContent,
        explanation,
        detectedTechnology: raw.technology || fallbackTechnologyName || null,
        matchedSkillId: matchedSkill ? matchedSkill.id : null,
        canonicalTechnologyName: matchedSkill ? matchedSkill.canonicalName : null,
        topic: topic || 'General',
        subtopic,
        difficulty,
        questionType,
        options: cleanOptions,
        correctOption: raw.correctOption ? raw.correctOption.trim() : null,
        tags,
        contentHash,
        sourceUrl: raw.sourceUrl || defaultLicense.originalSourceUrl || null,
        externalContentId: raw.externalContentId || null,
        licenseSnapshot: defaultLicense,
        validationErrors,
      });
    }

    return results;
  }
}
