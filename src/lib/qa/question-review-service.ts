import { prisma } from '../db.js';
import { DuplicateDetectionService } from './duplicate-detection-service.js';
import {
  DifficultyLevel,
  QuestionType,
  ReviewStatus,
} from './types.js';

export class QuestionReviewService {
  /**
   * Retrieves paginated staged items for admin review.
   */
  public static async listStagedItems(filters: {
    batchId?: string;
    reviewStatus?: ReviewStatus;
    isDuplicate?: boolean;
    technologyId?: string;
    search?: string;
    page?: number;
    limit?: number;
  } = {}) {
    const page = Math.max(1, filters.page || 1);
    const limit = Math.min(100, Math.max(1, filters.limit || 25));
    const skip = (page - 1) * limit;

    const whereClause: any = {
      ...(filters.batchId ? { batchId: filters.batchId } : {}),
      ...(filters.reviewStatus ? { reviewStatus: filters.reviewStatus } : {}),
      ...(filters.isDuplicate !== undefined ? { isDuplicate: filters.isDuplicate } : {}),
      ...(filters.technologyId ? { matchedSkillId: filters.technologyId } : {}),
      ...(filters.search
        ? {
            OR: [
              { normalizedQuestion: { contains: filters.search } },
              { topic: { contains: filters.search } },
              { detectedTechnology: { contains: filters.search } },
            ],
          }
        : {}),
    };

    const [items, totalCount] = await Promise.all([
      prisma.contentImportItem.findMany({
        where: whereClause,
        include: {
          matchedSkill: true,
          batch: {
            include: { source: true },
          },
          publishedQuestion: true,
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.contentImportItem.count({ where: whereClause }),
    ]);

    return {
      items,
      pagination: {
        page,
        limit,
        totalCount,
        totalPages: Math.ceil(totalCount / limit),
      },
    };
  }

  /**
   * Updates fields of a staged item during review (e.g. correcting wording, topic, difficulty).
   */
  public static async updateStagedItem(
    id: string,
    updates: {
      normalizedQuestion?: string;
      normalizedAnswer?: string;
      topic?: string;
      subtopic?: string;
      difficulty?: DifficultyLevel;
      questionType?: QuestionType;
      matchedSkillId?: string;
      options?: string[];
      correctOption?: string;
      explanation?: string;
      reviewNotes?: string;
    }
  ) {
    return prisma.contentImportItem.update({
      where: { id },
      data: {
        ...(updates.normalizedQuestion ? { normalizedQuestion: updates.normalizedQuestion.trim() } : {}),
        ...(updates.normalizedAnswer ? { normalizedAnswer: updates.normalizedAnswer.trim() } : {}),
        ...(updates.topic ? { topic: updates.topic.trim() } : {}),
        ...(updates.subtopic !== undefined ? { subtopic: updates.subtopic } : {}),
        ...(updates.difficulty ? { difficulty: updates.difficulty } : {}),
        ...(updates.questionType ? { questionType: updates.questionType } : {}),
        ...(updates.matchedSkillId !== undefined ? { matchedSkillId: updates.matchedSkillId } : {}),
        ...(updates.options !== undefined ? { options: JSON.stringify(updates.options) } : {}),
        ...(updates.correctOption !== undefined ? { correctOption: updates.correctOption } : {}),
        ...(updates.explanation !== undefined ? { explanation: updates.explanation } : {}),
        ...(updates.reviewNotes !== undefined ? { reviewNotes: updates.reviewNotes } : {}),
      },
    });
  }

  /**
   * Approves and publishes a staged question into the Question bank.
   */
  public static async publishStagedItem(id: string, adminId: string) {
    const item = await prisma.contentImportItem.findUnique({
      where: { id },
      include: {
        batch: { include: { source: true } },
      },
    });

    if (!item) throw new Error(`Staged item ${id} not found.`);

    // If item doesn't have a canonical skill mapped, find or require one
    if (!item.matchedSkillId) {
      throw new Error('Cannot publish question without associating a canonical technology.');
    }

    const source = item.batch.source;
    let licenseSnapshotStr = null;
    try {
      if (item.rawContent) {
        const parsed = JSON.parse(item.rawContent);
        if (parsed.licenseSnapshot) {
          licenseSnapshotStr = JSON.stringify(parsed.licenseSnapshot);
        }
      }
    } catch {}

    const published = await prisma.$transaction(async (tx) => {
      // Upsert Question in database
      const q = await tx.question.create({
        data: {
          technologyId: item.matchedSkillId!,
          topic: item.topic || 'General',
          subtopic: item.subtopic,
          questionText: item.normalizedQuestion,
          answerContent: item.normalizedAnswer,
          explanation: item.explanation,
          difficulty: item.difficulty,
          questionType: item.questionType,
          options: item.options,
          correctOption: item.correctOption,
          tags: item.tags,
          sourceId: source.id,
          sourceDocumentId: item.sourceDocumentId,
          sourceUrl: item.sourceUrl || source.url,
          licenseSnapshot: licenseSnapshotStr,
          contentHash: item.contentHash,
          reviewStatus: ReviewStatus.APPROVED,
          reviewedByAdminId: adminId,
          publishedAt: new Date(),
          lastVerifiedAt: new Date(),
        },
      });

      // Update staging item status
      await tx.contentImportItem.update({
        where: { id },
        data: {
          reviewStatus: ReviewStatus.APPROVED,
          publishedQuestionId: q.id,
          reviewedByAdminId: adminId,
          reviewedAt: new Date(),
        },
      });

      return q;
    });

    return published;
  }

  /**
   * Rejects a staged item.
   */
  public static async rejectStagedItem(id: string, adminId: string, notes?: string) {
    return prisma.contentImportItem.update({
      where: { id },
      data: {
        reviewStatus: ReviewStatus.REJECTED,
        reviewNotes: notes || null,
        reviewedByAdminId: adminId,
        reviewedAt: new Date(),
      },
    });
  }

  /**
   * Merges an incoming staged question as provenance into an existing question.
   */
  public static async mergeDuplicateStagedItem(id: string, targetQuestionId: string, adminId: string) {
    const item = await prisma.contentImportItem.findUnique({
      where: { id },
      include: { batch: { include: { source: true } } },
    });
    if (!item) throw new Error(`Staged item ${id} not found.`);

    await DuplicateDetectionService.mergeProvenance({
      questionId: targetQuestionId,
      sourceId: item.batch.sourceId,
      sourceUrl: item.sourceUrl || item.batch.source.url || undefined,
      attribution: item.batch.source.attribution || undefined,
      licenseId: item.batch.source.licenseId || undefined,
    });

    return prisma.contentImportItem.update({
      where: { id },
      data: {
        reviewStatus: ReviewStatus.ARCHIVED,
        reviewNotes: `Merged into existing Question ID: ${targetQuestionId}`,
        duplicateMatchId: targetQuestionId,
        reviewedByAdminId: adminId,
        reviewedAt: new Date(),
      },
    });
  }

  /**
   * Bulk publishes a list of staged items by ID.
   */
  public static async bulkPublishItems(itemIds: string[], adminId: string) {
    let publishedCount = 0;
    const errors: string[] = [];

    for (const id of itemIds) {
      try {
        await this.publishStagedItem(id, adminId);
        publishedCount++;
      } catch (err: unknown) {
        errors.push(err instanceof Error ? err.message : `Failed to publish ${id}`);
      }
    }

    return { total: itemIds.length, publishedCount, errors };
  }

  /**
   * Bulk marks staged items as APPROVED.
   */
  public static async bulkApproveItems(itemIds: string[], adminId: string) {
    const res = await prisma.contentImportItem.updateMany({
      where: { id: { in: itemIds } },
      data: {
        reviewStatus: ReviewStatus.APPROVED,
        reviewedByAdminId: adminId,
        reviewedAt: new Date(),
      },
    });
    return { count: res.count };
  }

  /**
   * Bulk marks staged items as REJECTED.
   */
  public static async bulkRejectItems(itemIds: string[], adminId: string, notes?: string) {
    const res = await prisma.contentImportItem.updateMany({
      where: { id: { in: itemIds } },
      data: {
        reviewStatus: ReviewStatus.REJECTED,
        reviewNotes: notes || 'Bulk rejected by administrator',
        reviewedByAdminId: adminId,
        reviewedAt: new Date(),
      },
    });
    return { count: res.count };
  }

  /**
   * Bulk publishes clean approved items from a batch.
   */
  public static async batchPublish(batchId: string, adminId: string, onlyNonDuplicates = true) {
    const items = await prisma.contentImportItem.findMany({
      where: {
        batchId,
        reviewStatus: ReviewStatus.PENDING,
        matchedSkillId: { not: null },
        ...(onlyNonDuplicates ? { isDuplicate: false } : {}),
      },
    });

    let publishedCount = 0;
    for (const item of items) {
      try {
        await this.publishStagedItem(item.id, adminId);
        publishedCount++;
      } catch {
        // Individual item failure
      }
    }

    return { totalMatched: items.length, publishedCount };
  }
}
