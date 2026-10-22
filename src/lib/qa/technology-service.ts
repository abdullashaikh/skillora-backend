import { prisma } from '../db.js';
import { cleanStringForMatching } from '../scoring/skill-normalizer.js';

export interface CanonicalTechnology {
  id: string;
  canonicalName: string;
  normalizedName: string;
  category: string;
  aliases: string[];
  isActive: boolean;
}

export class TechnologyService {
  private static cachedSkills: CanonicalTechnology[] | null = null;
  private static cacheExpiry = 0;

  public static invalidateCache() {
    this.cachedSkills = null;
    this.cacheExpiry = 0;
  }

  /**
   * Retrieves all active canonical technologies.
   */
  public static async getAllActiveTechnologies(): Promise<CanonicalTechnology[]> {
    const now = Date.now();
    if (this.cachedSkills && now < this.cacheExpiry) {
      return this.cachedSkills;
    }

    const skills = await prisma.skill.findMany({
      where: { isActive: true },
      orderBy: { canonicalName: 'asc' },
    });

    const parsed: CanonicalTechnology[] = skills.map((s) => {
      let aliases: string[] = [];
      try {
        aliases = JSON.parse(s.aliases);
      } catch {
        aliases = [];
      }
      return {
        id: s.id,
        canonicalName: s.canonicalName,
        normalizedName: s.normalizedName,
        category: s.category,
        aliases,
        isActive: s.isActive,
      };
    });

    this.cachedSkills = parsed;
    this.cacheExpiry = now + 60000; // 1 minute cache
    return parsed;
  }

  /**
   * Resolves a raw string or technology alias to its canonical Skill entity.
   */
  public static async findCanonicalSkill(rawName?: string | null): Promise<CanonicalTechnology | null> {
    if (!rawName || typeof rawName !== 'string') return null;

    const cleanInput = cleanStringForMatching(rawName);
    if (!cleanInput) return null;

    const allSkills = await this.getAllActiveTechnologies();

    for (const skill of allSkills) {
      if (cleanStringForMatching(skill.canonicalName) === cleanInput) {
        return skill;
      }
      if (skill.normalizedName === cleanInput) {
        return skill;
      }
      for (const alias of skill.aliases) {
        if (cleanStringForMatching(alias) === cleanInput) {
          return skill;
        }
      }
    }

    return null;
  }

  /**
   * Registers a new canonical technology or updates aliases if already existing.
   */
  public static async registerTechnology(
    canonicalName: string,
    category: string,
    aliases: string[] = []
  ): Promise<CanonicalTechnology> {
    const cleanNormalized = cleanStringForMatching(canonicalName);
    const existing = await prisma.skill.findFirst({
      where: {
        OR: [{ canonicalName }, { normalizedName: cleanNormalized }],
      },
    });

    if (existing) {
      let currentAliases: string[] = [];
      try {
        currentAliases = JSON.parse(existing.aliases);
      } catch {
        currentAliases = [];
      }
      const combined = Array.from(new Set([...currentAliases, ...aliases]));

      const updated = await prisma.skill.update({
        where: { id: existing.id },
        data: {
          aliases: JSON.stringify(combined),
          category: category || existing.category,
          isActive: true,
        },
      });

      this.invalidateCache();

      return {
        id: updated.id,
        canonicalName: updated.canonicalName,
        normalizedName: updated.normalizedName,
        category: updated.category,
        aliases: combined,
        isActive: updated.isActive,
      };
    }

    const created = await prisma.skill.create({
      data: {
        canonicalName: canonicalName.trim(),
        normalizedName: cleanNormalized,
        category: category.trim(),
        aliases: JSON.stringify(aliases),
        isActive: true,
      },
    });

    this.invalidateCache();

    // Check if new technology has coverage; if none, create ContentCoverageTask
    await this.checkAndCreateCoverageTask(created.id);

    return {
      id: created.id,
      canonicalName: created.canonicalName,
      normalizedName: created.normalizedName,
      category: created.category,
      aliases,
      isActive: created.isActive,
    };
  }

  /**
   * Adds an alias to an existing canonical skill.
   */
  public static async addAlias(skillId: string, newAlias: string): Promise<CanonicalTechnology> {
    const skill = await prisma.skill.findUnique({ where: { id: skillId } });
    if (!skill) throw new Error(`Skill with ID ${skillId} not found.`);

    let currentAliases: string[] = [];
    try {
      currentAliases = JSON.parse(skill.aliases);
    } catch {
      currentAliases = [];
    }

    const normalizedNew = newAlias.trim().toLowerCase();
    if (!currentAliases.some((a) => a.toLowerCase() === normalizedNew)) {
      currentAliases.push(newAlias.trim());
      await prisma.skill.update({
        where: { id: skillId },
        data: { aliases: JSON.stringify(currentAliases) },
      });
      this.invalidateCache();
    }

    return {
      id: skill.id,
      canonicalName: skill.canonicalName,
      normalizedName: skill.normalizedName,
      category: skill.category,
      aliases: currentAliases,
      isActive: skill.isActive,
    };
  }

  /**
   * Returns distinct topics associated with a canonical technology in the published question bank.
   */
  public static async getTopicsForTechnology(technologyId: string): Promise<string[]> {
    const questions = await prisma.question.findMany({
      where: {
        technologyId,
        reviewStatus: 'APPROVED',
      },
      select: { topic: true },
      distinct: ['topic'],
    });

    return questions.map((q) => q.topic).filter(Boolean).sort();
  }

  /**
   * Retrieves technology coverage statistics (published question counts, pending staging count, active sources).
   */
  public static async getTechnologyCoverageStats() {
    const technologies = await this.getAllActiveTechnologies();

    const stats = await Promise.all(
      technologies.map(async (tech) => {
        const publishedCount = await prisma.question.count({
          where: {
            technologyId: tech.id,
            reviewStatus: 'APPROVED',
          },
        });

        const pendingCount = await prisma.contentImportItem.count({
          where: {
            matchedSkillId: tech.id,
            reviewStatus: 'PENDING',
          },
        });

        const sourceCount = await prisma.contentSourceTechnology.count({
          where: { skillId: tech.id },
        });

        const task = await prisma.contentCoverageTask.findUnique({
          where: { skillId: tech.id },
        });

        return {
          id: tech.id,
          canonicalName: tech.canonicalName,
          category: tech.category,
          aliases: tech.aliases,
          publishedCount,
          pendingCount,
          sourceCount,
          coverageStatus: publishedCount >= 10 ? 'HEALTHY' : publishedCount > 0 ? 'PARTIAL' : 'NO_COVERAGE',
          taskStatus: task?.status || null,
        };
      })
    );

    return stats;
  }

  /**
   * If a skill has 0 published questions and no active source, creates a coverage task.
   */
  public static async checkAndCreateCoverageTask(skillId: string): Promise<void> {
    const count = await prisma.question.count({
      where: { technologyId: skillId, reviewStatus: 'APPROVED' },
    });

    if (count === 0) {
      await prisma.contentCoverageTask.upsert({
        where: { skillId },
        update: { status: 'PENDING' },
        create: {
          skillId,
          status: 'PENDING',
          notes: 'Technology has 0 published interview questions. Register an approved source.',
        },
      });
    } else {
      await prisma.contentCoverageTask.updateMany({
        where: { skillId },
        data: { status: 'RESOLVED' },
      });
    }
  }
}
