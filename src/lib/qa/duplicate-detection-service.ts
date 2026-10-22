import { prisma } from '../db.js';
import { DuplicateMatchResult, NormalizedQuestionRecord } from './types.js';

const STOP_WORDS = new Set([
  'a', 'about', 'above', 'after', 'again', 'against', 'all', 'am', 'an', 'and', 'any', 'are', 'aren',
  'as', 'at', 'be', 'because', 'been', 'before', 'being', 'below', 'between', 'both', 'but', 'by',
  'can', 'could', 'did', 'do', 'does', 'doing', 'down', 'during', 'each', 'few', 'for', 'from',
  'further', 'had', 'has', 'have', 'having', 'he', 'her', 'here', 'hers', 'herself', 'him', 'himself',
  'his', 'how', 'i', 'if', 'in', 'into', 'is', 'it', 'its', 'itself', 'just', 'me', 'more', 'most',
  'my', 'myself', 'no', 'nor', 'not', 'now', 'of', 'off', 'on', 'once', 'only', 'or', 'other', 'our',
  'ours', 'ourselves', 'out', 'over', 'own', 'same', 'she', 'should', 'so', 'some', 'such', 'than',
  'that', 'the', 'their', 'theirs', 'them', 'themselves', 'then', 'there', 'these', 'they', 'this',
  'those', 'through', 'to', 'too', 'under', 'until', 'up', 'very', 'was', 'we', 'were', 'what', 'when',
  'where', 'which', 'while', 'who', 'whom', 'why', 'with', 'would', 'you', 'your', 'yours', 'yourself',
]);

function stemWord(word: string): string {
  return word
    .toLowerCase()
    .replace(/(ing|ed|es|s)$/, '')
    .trim();
}

/**
 * Tokenizes text into a unique set of stemmed, non-stopword tokens.
 */
function tokenizeWords(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w))
    .map(stemWord)
    .filter(Boolean);

  return new Set(words);
}

/**
 * Calculates Dice similarity coefficient (0.0 to 1.0) between two texts.
 */
export function calculateTokenSimilarity(textA: string, textB: string): number {
  const setA = tokenizeWords(textA);
  const setB = tokenizeWords(textB);

  if (setA.size === 0 || setB.size === 0) return 0;

  let intersectionCount = 0;
  for (const token of setA) {
    if (setB.has(token)) {
      intersectionCount++;
    }
  }

  // Dice coefficient: (2 * |A ∩ B|) / (|A| + |B|)
  return (2 * intersectionCount) / (setA.size + setB.size);
}

/**
 * Computes a readable difference summary between two questions.
 */
export function computeDifferenceSummary(textA: string, textB: string): string {
  const setA = tokenizeWords(textA);
  const setB = tokenizeWords(textB);

  const onlyInA = Array.from(setA).filter((w) => !setB.has(w)).slice(0, 5);
  const onlyInB = Array.from(setB).filter((w) => !setA.has(w)).slice(0, 5);

  const parts: string[] = [];
  if (onlyInA.length > 0) {
    parts.push(`Unique to incoming: [${onlyInA.join(', ')}]`);
  }
  if (onlyInB.length > 0) {
    parts.push(`Unique to existing: [${onlyInB.join(', ')}]`);
  }

  return parts.length > 0 ? parts.join('; ') : 'Nearly identical phrasing';
}

export class DuplicateDetectionService {
  /**
   * Checks whether a normalized question is an exact or fuzzy duplicate of any
   * published question in the database or staged question in the current system.
   */
  public static async checkForDuplicate(
    record: NormalizedQuestionRecord,
    similarityThreshold = 0.85
  ): Promise<DuplicateMatchResult> {
    // 1. Exact Content Hash Match in published questions
    const exactMatch = await prisma.question.findFirst({
      where: { contentHash: record.contentHash },
      select: { id: true, questionText: true, sourceUrl: true },
    });

    if (exactMatch) {
      return {
        isDuplicate: true,
        matchType: 'EXACT',
        matchScore: 1.0,
        existingQuestionId: exactMatch.id,
        existingQuestionText: exactMatch.questionText,
        existingSourceUrl: exactMatch.sourceUrl,
        differenceSummary: 'Identical normalized question text (Exact hash match)',
      };
    }

    // 2. Fuzzy Token Match against published questions in same technology or general
    const candidates = await prisma.question.findMany({
      where: {
        reviewStatus: 'APPROVED',
        ...(record.matchedSkillId ? { technologyId: record.matchedSkillId } : {}),
      },
      select: { id: true, questionText: true, sourceUrl: true },
      take: 200, // Search within top recent questions of this technology
      orderBy: { createdAt: 'desc' },
    });

    let bestScore = 0;
    let bestCandidate: typeof candidates[0] | null = null;

    for (const candidate of candidates) {
      const score = calculateTokenSimilarity(record.normalizedQuestion, candidate.questionText);
      if (score > bestScore) {
        bestScore = score;
        bestCandidate = candidate;
      }
    }

    if (bestScore >= similarityThreshold && bestCandidate) {
      return {
        isDuplicate: true,
        matchType: 'FUZZY',
        matchScore: Math.round(bestScore * 100) / 100,
        existingQuestionId: bestCandidate.id,
        existingQuestionText: bestCandidate.questionText,
        existingSourceUrl: bestCandidate.sourceUrl,
        differenceSummary: computeDifferenceSummary(record.normalizedQuestion, bestCandidate.questionText),
      };
    }

    return {
      isDuplicate: false,
      matchType: 'NONE',
      matchScore: 0,
    };
  }

  /**
   * Merges provenance from an incoming source into an existing published question.
   */
  public static async mergeProvenance(params: {
    questionId: string;
    sourceId?: string;
    sourceUrl?: string;
    sourceRevision?: string;
    attribution?: string;
    licenseId?: string;
  }): Promise<void> {
    await prisma.questionProvenance.create({
      data: {
        questionId: params.questionId,
        sourceId: params.sourceId || null,
        sourceUrl: params.sourceUrl || null,
        sourceRevision: params.sourceRevision || null,
        attribution: params.attribution || null,
        licenseId: params.licenseId || null,
        retrievedAt: new Date(),
      },
    });

    // Update question's lastVerifiedAt timestamp
    await prisma.question.update({
      where: { id: params.questionId },
      data: { lastVerifiedAt: new Date() },
    });
  }
}
