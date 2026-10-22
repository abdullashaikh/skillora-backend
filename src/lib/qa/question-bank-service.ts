import { prisma } from '../db.js';
import { DifficultyLevel, QuestionType, ReviewStatus } from './types.js';

export interface QuestionBankQueryFilters {
  technologyId?: string;
  topic?: string;
  difficulty?: DifficultyLevel;
  questionType?: QuestionType;
  search?: string;
  page?: number;
  limit?: number;
}

export class QuestionBankService {
  /**
   * Retrieves published questions with filtering, pagination, and source attribution.
   * Directly queries MySQL with zero external AI calls!
   */
  public static async getPublishedQuestions(filters: QuestionBankQueryFilters = {}) {
    const page = Math.max(1, filters.page || 1);
    const limit = Math.min(50, Math.max(1, filters.limit || 10));
    const skip = (page - 1) * limit;

    const whereClause: any = {
      reviewStatus: ReviewStatus.APPROVED,
      ...(filters.technologyId ? { technologyId: filters.technologyId } : {}),
      ...(filters.topic ? { topic: filters.topic } : {}),
      ...(filters.difficulty ? { difficulty: filters.difficulty } : {}),
      ...(filters.questionType ? { questionType: filters.questionType } : {}),
      ...(filters.search
        ? {
            OR: [
              { questionText: { contains: filters.search } },
              { topic: { contains: filters.search } },
              { subtopic: { contains: filters.search } },
            ],
          }
        : {}),
    };

    const [questions, totalCount] = await Promise.all([
      prisma.question.findMany({
        where: whereClause,
        include: {
          technology: {
            select: {
              id: true,
              canonicalName: true,
              category: true,
            },
          },
          source: {
            select: {
              name: true,
              attribution: true,
              licenseId: true,
            },
          },
          provenances: {
            select: {
              attribution: true,
              sourceUrl: true,
              licenseId: true,
            },
          },
        },
        orderBy: [{ createdAt: 'desc' }],
        skip,
        take: limit,
      }),
      prisma.question.count({ where: whereClause }),
    ]);

    const formatted = questions.map((q) => {
      let parsedOptions: string[] | null = null;
      if (q.options) {
        try {
          parsedOptions = JSON.parse(q.options);
        } catch {
          parsedOptions = null;
        }
      }

      let parsedLicense = null;
      if (q.licenseSnapshot) {
        try {
          parsedLicense = JSON.parse(q.licenseSnapshot);
        } catch {}
      }

      return {
        id: q.id,
        technology: q.technology,
        topic: q.topic,
        subtopic: q.subtopic,
        questionText: q.questionText,
        answerContent: q.answerContent,
        explanation: q.explanation,
        difficulty: q.difficulty,
        questionType: q.questionType,
        options: parsedOptions,
        correctOption: q.correctOption,
        sourceUrl: q.sourceUrl,
        attribution: q.source?.attribution || parsedLicense?.attributionText || 'Community Source',
        license: q.source?.licenseId || parsedLicense?.licenseId || 'Open Source',
        provenances: q.provenances,
        publishedAt: q.publishedAt,
      };
    });

    return {
      questions: formatted,
      pagination: {
        page,
        limit,
        totalCount,
        totalPages: Math.ceil(totalCount / limit),
      },
    };
  }

  /**
   * Retrieves a single published question by ID.
   */
  public static async getPublishedQuestionById(id: string) {
    const q = await prisma.question.findFirst({
      where: {
        id,
        reviewStatus: ReviewStatus.APPROVED,
      },
      include: {
        technology: true,
        source: true,
        provenances: true,
      },
    });

    if (!q) return null;

    let parsedOptions: string[] | null = null;
    if (q.options) {
      try {
        parsedOptions = JSON.parse(q.options);
      } catch {}
    }

    return {
      id: q.id,
      technology: q.technology,
      topic: q.topic,
      subtopic: q.subtopic,
      questionText: q.questionText,
      answerContent: q.answerContent,
      explanation: q.explanation,
      difficulty: q.difficulty,
      questionType: q.questionType,
      options: parsedOptions,
      correctOption: q.correctOption,
      sourceUrl: q.sourceUrl,
      attribution: q.source?.attribution || 'Original Source',
      license: q.source?.licenseId || 'Open License',
      provenances: q.provenances,
      publishedAt: q.publishedAt,
    };
  }

  /**
   * Returns list of technologies that have published questions available.
   */
  public static async getAvailableTechnologies() {
    const technologies = await prisma.skill.findMany({
      where: {
        isActive: true,
        questions: {
          some: { reviewStatus: ReviewStatus.APPROVED },
        },
      },
      select: {
        id: true,
        canonicalName: true,
        category: true,
        _count: {
          select: {
            questions: {
              where: { reviewStatus: ReviewStatus.APPROVED },
            },
          },
        },
      },
      orderBy: { canonicalName: 'asc' },
    });

    return technologies.map((t) => ({
      id: t.id,
      name: t.canonicalName,
      category: t.category,
      questionCount: t._count.questions,
    }));
  }

  /**
   * Returns topics available under a given technology.
   */
  public static async getTopicsForTechnology(technologyId: string) {
    const topics = await prisma.question.findMany({
      where: {
        technologyId,
        reviewStatus: ReviewStatus.APPROVED,
      },
      select: { topic: true },
      distinct: ['topic'],
      orderBy: { topic: 'asc' },
    });

    return topics.map((t) => t.topic).filter(Boolean);
  }
}
