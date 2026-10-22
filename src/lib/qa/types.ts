import { z } from 'zod';
import {
  DifficultyLevel,
  QuestionType,
  ReviewStatus,
  SourceStatus,
  SourceType,
  ContentReuseStatus,
  ParserType,
  SyncFrequency,
} from '@prisma/client';

export {
  DifficultyLevel,
  QuestionType,
  ReviewStatus,
  SourceStatus,
  SourceType,
  ContentReuseStatus,
  ParserType,
  SyncFrequency,
};

// ==========================================
// License & Rights Types
// ==========================================

export interface LicenseSnapshot {
  licenseId: string; // e.g. "MIT", "Apache-2.0", "CC-BY-4.0", "Public Domain", "Proprietary"
  licenseName?: string;
  licenseUrl?: string;
  attributionText?: string;
  originalSourceUrl: string;
  retrievedAt: string;
  isRedistributable: boolean;
  notes?: string;
}

// ==========================================
// Extracted & Normalized Common Q&A Model
// ==========================================

export interface RawExtractedQuestion {
  question: string;
  answer: string;
  explanation?: string | null;
  technology?: string | null;
  topic?: string | null;
  subtopic?: string | null;
  difficulty?: string | DifficultyLevel | null;
  questionType?: string | QuestionType | null;
  options?: string[] | null;
  correctOption?: string | null;
  tags?: string[] | null;
  sourceUrl?: string | null;
  externalContentId?: string | null;
  rawSnippet?: string | null;
}

export interface NormalizedQuestionRecord {
  normalizedQuestion: string;
  normalizedAnswer: string;
  explanation: string | null;
  detectedTechnology: string | null;
  matchedSkillId: string | null;
  canonicalTechnologyName: string | null;
  topic: string;
  subtopic: string | null;
  difficulty: DifficultyLevel;
  questionType: QuestionType;
  options: string[] | null;
  correctOption: string | null;
  tags: string[];
  contentHash: string; // Deterministic SHA-256 of normalized text
  sourceUrl: string | null;
  externalContentId: string | null;
  licenseSnapshot: LicenseSnapshot;
  validationErrors: string[];
}

// ==========================================
// Website Parser Configuration Schema
// ==========================================

export const WebsiteParserConfigSchema = z.object({
  mainContentSelector: z.string().optional(),
  questionSelector: z.string().optional(),
  answerSelector: z.string().optional(),
  topicSelector: z.string().optional(),
  difficultySelector: z.string().optional(),
  paginationSelector: z.string().optional(),
  permittedUrlPatterns: z.array(z.string()).optional(),
  maxPages: z.number().int().min(1).max(20).optional(),
  maxQuestions: z.number().int().min(1).max(500).optional(),
});

export type WebsiteParserConfig = z.infer<typeof WebsiteParserConfigSchema>;

// ==========================================
// Validation Schemas
// ==========================================

export const JSONImportQuestionSchema = z.object({
  question: z.string().min(5, 'Question text must be at least 5 characters'),
  answer: z.string().min(5, 'Answer text must be at least 5 characters'),
  explanation: z.string().optional().nullable(),
  technology: z.string().optional().nullable(),
  topic: z.string().optional().nullable(),
  subtopic: z.string().optional().nullable(),
  difficulty: z.enum(['BEGINNER', 'INTERMEDIATE', 'ADVANCED', 'UNKNOWN', 'beginner', 'intermediate', 'advanced', 'unknown']).optional().nullable(),
  questionType: z.enum(['SHORT_ANSWER', 'MULTIPLE_CHOICE', 'CODE_OUTPUT', 'DEBUGGING', 'OPEN_ENDED', 'short_answer', 'multiple_choice', 'code_output', 'debugging', 'open_ended']).optional().nullable(),
  options: z.array(z.string()).optional().nullable(),
  correctOption: z.string().optional().nullable(),
  tags: z.array(z.string()).optional().nullable(),
  sourceUrl: z.string().optional().nullable(),
  attribution: z.string().optional().nullable(),
});

export const JSONImportBatchSchema = z.array(JSONImportQuestionSchema);

// ==========================================
// Duplicate Match Result
// ==========================================

export interface DuplicateMatchResult {
  isDuplicate: boolean;
  matchType: 'EXACT' | 'FUZZY' | 'NONE';
  matchScore: number; // 0.0 - 1.0
  existingQuestionId?: string;
  existingQuestionText?: string;
  existingSourceUrl?: string | null;
  differenceSummary?: string;
}

// ==========================================
// Import Batch Summary
// ==========================================

export interface BatchExecutionResult {
  batchId: string;
  sourceId: string;
  status: 'COMPLETED' | 'FAILED' | 'PARTIALLY_FAILED';
  totalDiscovered: number;
  newItemsCount: number;
  changedItemsCount: number;
  duplicateItemsCount: number;
  rejectedItemsCount: number;
  errorsCount: number;
  errorReport: Array<{ fileOrUrl: string; message: string; rowOrIndex?: number }>;
}
