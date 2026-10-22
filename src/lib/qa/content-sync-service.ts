import crypto from 'crypto';
import { prisma } from '../db.js';
import { GitHubSourceAdapter } from './github-source-adapter.js';
import { WebsiteSourceAdapter } from './website-source-adapter.js';
import { ContentNormalizationService } from './content-normalization-service.js';
import { DuplicateDetectionService } from './duplicate-detection-service.js';
import { ImportValidationService } from './import-validation-service.js';
import { TechnologyService } from './technology-service.js';
import {
  BatchExecutionResult,
  ContentReuseStatus,
  LicenseSnapshot,
  ReviewStatus,
  SourceStatus,
  SourceType,
} from './types.js';

export class ContentSyncService {
  /**
   * Executes a collection / sync job for a registered source.
   */
  public static async syncSource(
    sourceId: string,
    batchType: 'SCHEDULED_SYNC' | 'MANUAL_FETCH' | 'NEW_SKILL_COLLECTION' = 'MANUAL_FETCH',
    adminId?: string
  ): Promise<BatchExecutionResult> {
    const source = await prisma.contentSource.findUnique({
      where: { id: sourceId },
      include: {
        technologies: { include: { skill: true } },
      },
    });

    if (!source) throw new Error(`Source ${sourceId} not found.`);
    if (!source.isActive) throw new Error(`Source ${source.name} is disabled.`);

    // Concurrency lock: Check if source is already collecting
    if (source.status === SourceStatus.COLLECTING || source.status === SourceStatus.PARSING) {
      throw new Error(`Source ${source.name} is currently running an active collection job.`);
    }

    // Set status to COLLECTING
    await prisma.contentSource.update({
      where: { id: sourceId },
      data: { status: SourceStatus.COLLECTING },
    });

    // Create ContentImportBatch
    const batch = await prisma.contentImportBatch.create({
      data: {
        sourceId,
        batchType,
        status: 'IN_PROGRESS',
        initiatedByAdminId: adminId || null,
      },
    });

    const errorReport: Array<{ fileOrUrl: string; message: string; rowOrIndex?: number }> = [];
    let totalDiscovered = 0;
    let newItemsCount = 0;
    let changedItemsCount = 0;
    let duplicateItemsCount = 0;
    let rejectedItemsCount = 0;
    let errorsCount = 0;

    try {
      const defaultLicense: LicenseSnapshot = {
        licenseId: source.licenseId || 'UNVERIFIED',
        licenseName: source.licenseId || 'Registered Source',
        licenseUrl: source.licenseReference || source.url || '',
        attributionText: source.attribution || `Source: ${source.url}`,
        originalSourceUrl: source.url || '',
        retrievedAt: new Date().toISOString(),
        isRedistributable: source.contentReuseStatus === ContentReuseStatus.PERMITTED,
      };

      const primarySkillName = source.technologies[0]?.skill.canonicalName;
      const primarySkillId = source.technologies[0]?.skill.id;

      // 1. Collect documents from adapter
      let collectedDocs: Array<{
        documentUrl: string;
        sourcePath?: string;
        sourceRevision?: string;
        contentHash: string;
        rawContent: string;
        license: LicenseSnapshot;
        questions: any[];
        errors: string[];
      }> = [];

      if (source.sourceType === SourceType.GITHUB_REPO || source.sourceType === SourceType.GITHUB_FILE) {
        if (!source.url) throw new Error('GitHub source missing URL.');
        collectedDocs = await GitHubSourceAdapter.collect(source.url, { maxFiles: 10 });
      } else if (source.sourceType === SourceType.WEBSITE) {
        if (!source.url) throw new Error('Website source missing URL.');
        let parserConfig = {};
        try {
          if (source.parserConfig) parserConfig = JSON.parse(source.parserConfig);
        } catch {}
        const pages = await WebsiteSourceAdapter.collect(source.url, parserConfig, defaultLicense);
        collectedDocs = pages.map((p) => ({
          documentUrl: p.pageUrl,
          sourcePath: p.pageUrl,
          sourceRevision: p.sourceRevision,
          contentHash: p.contentHash,
          rawContent: p.rawContent,
          license: p.license,
          questions: p.questions,
          errors: p.errors,
        }));
      }

      // Update source status to PARSING
      await prisma.contentSource.update({
        where: { id: sourceId },
        data: { status: SourceStatus.PARSING },
      });

      // 2. Process each collected document
      for (const doc of collectedDocs) {
        if (doc.errors.length > 0) {
          errorsCount += doc.errors.length;
          doc.errors.forEach((err) => errorReport.push({ fileOrUrl: doc.documentUrl, message: err }));
        }

        // Check if document previously imported with same contentHash
        const existingDoc = await prisma.sourceDocument.findFirst({
          where: {
            sourceId,
            contentHash: doc.contentHash,
          },
        });

        if (existingDoc && existingDoc.status === 'PROCESSED') {
          // Document content is identical (unchanged) -> Skip re-importing unchanged files
          await prisma.sourceDocument.update({
            where: { id: existingDoc.id },
            data: { lastRetrievedAt: new Date() },
          });
          continue;
        }

        // Upsert SourceDocument record
        const sourceDocRecord = await prisma.sourceDocument.create({
          data: {
            sourceId,
            documentUrl: doc.documentUrl,
            sourcePath: doc.sourcePath || null,
            sourceRevision: doc.sourceRevision || null,
            contentHash: doc.contentHash,
            status: 'PROCESSED',
          },
        });

        // 3. Normalize questions
        const normalizedList = await ContentNormalizationService.normalizeBatch(
          doc.questions,
          doc.license || defaultLicense,
          primarySkillName
        );

        totalDiscovered += normalizedList.length;

        // 4. Staging and duplicate detection for each question
        const seenHashesInBatch = new Set<string>();
        const itemsToInsert: any[] = [];

        for (const record of normalizedList) {
          // Intra-batch duplicate check
          let isIntraBatchDuplicate = false;
          if (seenHashesInBatch.has(record.contentHash)) {
            isIntraBatchDuplicate = true;
          } else {
            seenHashesInBatch.add(record.contentHash);
          }

          const validation = ImportValidationService.validateRecord(record, source.contentReuseStatus);
          if (!validation.isValid) {
            rejectedItemsCount++;
            validation.errors.forEach((e) => errorReport.push({ fileOrUrl: doc.documentUrl, message: e }));
          }

          const dupCheck = await DuplicateDetectionService.checkForDuplicate(record);
          const isDuplicate = isIntraBatchDuplicate || dupCheck.isDuplicate;

          if (isDuplicate) {
            duplicateItemsCount++;
          } else {
            newItemsCount++;
          }

          // Check if question existed previously in this source but was modified (changed content)
          let isChanged = false;
          if (doc.sourcePath) {
            const priorQuestion = await prisma.question.findFirst({
              where: {
                sourceId,
                questionText: record.normalizedQuestion,
                contentHash: { not: record.contentHash },
              },
            });
            if (priorQuestion) {
              isChanged = true;
              changedItemsCount++;
            }
          }

          // Map to a Skill via source technology mapping, falling back to alias/name matching
          let matchedSkillId = record.matchedSkillId || primarySkillId || null;
          if (!matchedSkillId) {
            const skillCandidate = await TechnologyService.findCanonicalSkill(
              record.detectedTechnology || record.topic || source.name
            );
            if (skillCandidate) {
              matchedSkillId = skillCandidate.id;
            }
          }

          itemsToInsert.push({
            id: crypto.randomUUID(),
            batchId: batch.id,
            sourceDocumentId: sourceDocRecord.id,
            rawContent: JSON.stringify(record),
            normalizedQuestion: record.normalizedQuestion,
            normalizedAnswer: record.normalizedAnswer,
            contentHash: record.contentHash,
            detectedTechnology: record.detectedTechnology,
            matchedSkillId,
            topic: record.topic,
            subtopic: record.subtopic,
            difficulty: record.difficulty,
            questionType: record.questionType,
            options: record.options ? JSON.stringify(record.options) : null,
            correctOption: record.correctOption,
            explanation: record.explanation,
            tags: record.tags.length > 0 ? JSON.stringify(record.tags) : null,
            sourceUrl: record.sourceUrl,
            validationErrors: validation.errors.length > 0 ? JSON.stringify(validation.errors) : null,
            isDuplicate,
            duplicateMatchId: dupCheck.existingQuestionId || null,
            duplicateScore: isIntraBatchDuplicate ? 1.0 : dupCheck.matchScore,
            duplicateDifference: isIntraBatchDuplicate
              ? 'Duplicate within same import batch'
              : dupCheck.differenceSummary || (isChanged ? 'Changed upstream content' : null),
            reviewStatus: ReviewStatus.PENDING,
          });
        }

        // Chunked insertion in transactions (100 items per chunk)
        const CHUNK_SIZE = 100;
        for (let i = 0; i < itemsToInsert.length; i += CHUNK_SIZE) {
          const chunk = itemsToInsert.slice(i, i + CHUNK_SIZE);
          await prisma.$transaction(async (tx) => {
            await tx.contentImportItem.createMany({
              data: chunk,
            });
          });
        }
      }

      const finalBatchStatus =
        errorsCount > 0 && newItemsCount === 0 && duplicateItemsCount === 0
          ? 'FAILED'
          : errorsCount > 0
          ? 'PARTIALLY_FAILED'
          : 'COMPLETED';

      // Update Batch completion
      await prisma.contentImportBatch.update({
        where: { id: batch.id },
        data: {
          status: finalBatchStatus,
          totalDiscovered,
          newItemsCount,
          changedItemsCount,
          duplicateItemsCount,
          rejectedItemsCount,
          errorsCount,
          errorReport: errorReport.length > 0 ? JSON.stringify(errorReport) : null,
          completedAt: new Date(),
        },
      });

      // Update Source status
      await prisma.contentSource.update({
        where: { id: sourceId },
        data: {
          status: newItemsCount > 0 ? SourceStatus.AWAITING_CONTENT_REVIEW : SourceStatus.READY,
          lastSyncAt: new Date(),
          lastSyncStatus: finalBatchStatus === 'COMPLETED' ? 'SUCCESS' : 'FAILED',
          lastError: errorsCount > 0 ? `${errorsCount} error(s) occurred during import` : null,
          nextSyncAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // Next month
        },
      });

      return {
        batchId: batch.id,
        sourceId,
        status: finalBatchStatus,
        totalDiscovered,
        newItemsCount,
        changedItemsCount,
        duplicateItemsCount,
        rejectedItemsCount,
        errorsCount,
        errorReport,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Sync execution failed';

      await prisma.contentImportBatch.update({
        where: { id: batch.id },
        data: {
          status: 'FAILED',
          errorMessage: msg,
          completedAt: new Date(),
        },
      });

      await prisma.contentSource.update({
        where: { id: sourceId },
        data: {
          status: SourceStatus.FAILED,
          lastSyncStatus: 'FAILED',
          lastError: msg,
        },
      });

      throw err;
    }
  }
}
