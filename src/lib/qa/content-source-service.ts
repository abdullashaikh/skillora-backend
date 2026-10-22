import { prisma } from '../db.js';
import { validateSafeUrl } from './url-validator.js';
import { ImportValidationService } from './import-validation-service.js';
import { GitHubSourceAdapter } from './github-source-adapter.js';
import { WebsiteSourceAdapter } from './website-source-adapter.js';
import { ContentNormalizationService } from './content-normalization-service.js';
import { DuplicateDetectionService } from './duplicate-detection-service.js';
import {
  ContentReuseStatus,
  LicenseSnapshot,
  ParserType,
  ReviewStatus,
  SourceStatus,
  SourceType,
  SyncFrequency,
} from './types.js';

export interface CreateSourceInput {
  name: string;
  sourceType: SourceType;
  url?: string;
  technologyIds?: string[];
  topicRestrictions?: string;
  licenseId?: string;
  licenseReference?: string;
  attribution?: string;
  contentReuseStatus?: ContentReuseStatus;
  parserType?: ParserType;
  parserConfig?: string;
  syncFrequency?: SyncFrequency;
  adminNotes?: string;
  adminId: string;
}

export class ContentSourceService {
  /**
   * Registers a new content source.
   */
  public static async createSource(input: CreateSourceInput) {
    if (!input.name || input.name.trim().length < 3) {
      throw new Error('Source name must be at least 3 characters.');
    }

    if (input.url) {
      const urlCheck = await validateSafeUrl(input.url);
      if (!urlCheck.isValid) {
        throw new Error(`Invalid or prohibited source URL: ${urlCheck.error}`);
      }
    }

    // License rights verification
    const licenseCheck = ImportValidationService.validateSourceLicense(
      input.licenseId,
      input.licenseReference
    );

    const reuseStatus = input.contentReuseStatus || licenseCheck.status;
    const initialStatus = licenseCheck.isPermitted
      ? SourceStatus.READY
      : SourceStatus.AWAITING_PERMISSION_REVIEW;

    const source = await prisma.contentSource.create({
      data: {
        name: input.name.trim(),
        sourceType: input.sourceType,
        url: input.url?.trim() || null,
        topicRestrictions: input.topicRestrictions || null,
        licenseId: input.licenseId || null,
        licenseReference: input.licenseReference || null,
        attribution: input.attribution || null,
        contentReuseStatus: reuseStatus,
        parserType: input.parserType || ParserType.AUTO,
        parserConfig: input.parserConfig || null,
        syncFrequency: input.syncFrequency || SyncFrequency.MONTHLY,
        status: initialStatus,
        isActive: true,
        adminNotes: input.adminNotes || licenseCheck.notes,
        createdByAdminId: input.adminId,
        nextSyncAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // Next month
      },
    });

    // Link canonical technologies
    if (input.technologyIds && input.technologyIds.length > 0) {
      for (const skillId of input.technologyIds) {
        await prisma.contentSourceTechnology.create({
          data: { sourceId: source.id, skillId },
        }).catch(() => {});
      }
    }

    return this.getSourceById(source.id);
  }

  /**
   * Retrieves a source by ID with its associated technologies and recent batches.
   */
  public static async getSourceById(id: string) {
    const source = await prisma.contentSource.findUnique({
      where: { id },
      include: {
        technologies: {
          include: { skill: true },
        },
        batches: {
          orderBy: { startedAt: 'desc' },
          take: 5,
        },
        _count: {
          select: { questions: true, documents: true },
        },
      },
    });

    if (!source) throw new Error(`Content source with ID ${id} not found.`);
    return source;
  }

  /**
   * Updates an existing content source.
   */
  public static async updateSource(id: string, updates: Partial<CreateSourceInput> & { status?: SourceStatus; isActive?: boolean }) {
    const existing = await prisma.contentSource.findUnique({ where: { id } });
    if (!existing) throw new Error(`Source ${id} not found.`);

    if (updates.url && updates.url !== existing.url) {
      const urlCheck = await validateSafeUrl(updates.url);
      if (!urlCheck.isValid) {
        throw new Error(`Invalid source URL: ${urlCheck.error}`);
      }
    }

    // If license changes, re-evaluate rights
    let reuseStatus = updates.contentReuseStatus;
    if (updates.licenseId && updates.licenseId !== existing.licenseId) {
      const licenseCheck = ImportValidationService.validateSourceLicense(updates.licenseId);
      if (!reuseStatus) reuseStatus = licenseCheck.status;
    }

    await prisma.contentSource.update({
      where: { id },
      data: {
        ...(updates.name ? { name: updates.name.trim() } : {}),
        ...(updates.url ? { url: updates.url.trim() } : {}),
        ...(updates.topicRestrictions !== undefined ? { topicRestrictions: updates.topicRestrictions } : {}),
        ...(updates.licenseId !== undefined ? { licenseId: updates.licenseId } : {}),
        ...(updates.licenseReference !== undefined ? { licenseReference: updates.licenseReference } : {}),
        ...(updates.attribution !== undefined ? { attribution: updates.attribution } : {}),
        ...(reuseStatus ? { contentReuseStatus: reuseStatus } : {}),
        ...(updates.parserType ? { parserType: updates.parserType } : {}),
        ...(updates.parserConfig !== undefined ? { parserConfig: updates.parserConfig } : {}),
        ...(updates.syncFrequency ? { syncFrequency: updates.syncFrequency } : {}),
        ...(updates.status ? { status: updates.status } : {}),
        ...(updates.isActive !== undefined ? { isActive: updates.isActive } : {}),
        ...(updates.adminNotes !== undefined ? { adminNotes: updates.adminNotes } : {}),
      },
    });

    // Update technology associations if provided
    if (updates.technologyIds) {
      await prisma.contentSourceTechnology.deleteMany({ where: { sourceId: id } });
      for (const skillId of updates.technologyIds) {
        await prisma.contentSourceTechnology.create({
          data: { sourceId: id, skillId },
        }).catch(() => {});
      }
    }

    return this.getSourceById(id);
  }

  /**
   * Disables or soft-deletes a content source.
   */
  public static async disableSource(id: string): Promise<void> {
    await prisma.contentSource.update({
      where: { id },
      data: {
        status: SourceStatus.DISABLED,
        isActive: false,
      },
    });
  }

  /**
   * Lists content sources with optional status and type filters.
   */
  public static async listSources(filters: {
    status?: SourceStatus;
    sourceType?: SourceType;
    technologyId?: string;
    search?: string;
  } = {}) {
    return prisma.contentSource.findMany({
      where: {
        ...(filters.status ? { status: filters.status } : {}),
        ...(filters.sourceType ? { sourceType: filters.sourceType } : {}),
        ...(filters.search
          ? {
              OR: [
                { name: { contains: filters.search } },
                { url: { contains: filters.search } },
                { licenseId: { contains: filters.search } },
              ],
            }
          : {}),
        ...(filters.technologyId
          ? {
              technologies: {
                some: { skillId: filters.technologyId },
              },
            }
          : {}),
      },
      include: {
        technologies: {
          include: { skill: true },
        },
        _count: {
          select: { questions: true, documents: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Previews extracted questions from a source URL without saving to database.
   */
  public static async previewSource(id: string) {
    const source = await this.getSourceById(id);
    if (!source.url) throw new Error('Source does not have a configured URL.');

    const defaultLicense: LicenseSnapshot = {
      licenseId: source.licenseId || 'UNVERIFIED',
      licenseName: source.licenseId || 'Source License',
      licenseUrl: source.licenseReference || source.url,
      attributionText: source.attribution || `Source: ${source.url}`,
      originalSourceUrl: source.url,
      retrievedAt: new Date().toISOString(),
      isRedistributable: source.contentReuseStatus === ContentReuseStatus.PERMITTED,
    };

    const firstSkillName = source.technologies[0]?.skill.canonicalName;

    if (source.sourceType === SourceType.GITHUB_REPO || source.sourceType === SourceType.GITHUB_FILE) {
      const collectedDocs = await GitHubSourceAdapter.collect(source.url, { maxFiles: 2 });
      const allRaw = collectedDocs.flatMap((d) => d.questions);
      const normalized = await ContentNormalizationService.normalizeBatch(
        allRaw,
        defaultLicense,
        firstSkillName
      );
      return {
        source,
        documentsCount: collectedDocs.length,
        totalQuestionsFound: normalized.length,
        questions: normalized.slice(0, 10),
      };
    }

    if (source.sourceType === SourceType.WEBSITE) {
      let config = {};
      try {
        if (source.parserConfig) config = JSON.parse(source.parserConfig);
      } catch {}
      const pages = await WebsiteSourceAdapter.collect(source.url, config, defaultLicense);
      const allRaw = pages.flatMap((p) => p.questions);
      const normalized = await ContentNormalizationService.normalizeBatch(
        allRaw,
        defaultLicense,
        firstSkillName
      );
      return { source, documentsCount: pages.length, questions: normalized };
    }

    throw new Error(`Preview not supported for source type ${source.sourceType}`);
  }
}
