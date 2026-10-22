import crypto from 'crypto';
import { prisma } from '../db.js';
import { ContentParserService } from './content-parser-service.js';
import { ContentNormalizationService } from './content-normalization-service.js';
import { DuplicateDetectionService } from './duplicate-detection-service.js';
import { ImportValidationService } from './import-validation-service.js';
import { CSVColumnMapping } from './parsers/csv-parser.js';
import {
  ContentReuseStatus,
  LicenseSnapshot,
  NormalizedQuestionRecord,
  ReviewStatus,
  SourceType,
} from './types.js';

export interface ManualImportPreviewResult {
  filename: string;
  detectedFormat: string;
  totalParsed: number;
  validCount: number;
  rejectedCount: number;
  duplicatesCount: number;
  questions: NormalizedQuestionRecord[];
  errors: string[];
}

export class ManualImportService {
  /**
   * Generates a preview of an uploaded dataset file before saving to database.
   */
  public static async previewFile(
    fileContent: string,
    filename: string,
    licenseSnapshot: LicenseSnapshot,
    fallbackTechnology?: string,
    csvMapping?: Partial<CSVColumnMapping>
  ): Promise<ManualImportPreviewResult> {
    const parseResult = ContentParserService.parse(fileContent, {
      filename,
      customCsvMapping: csvMapping,
    });

    const normalized = await ContentNormalizationService.normalizeBatch(
      parseResult.questions,
      licenseSnapshot,
      fallbackTechnology
    );

    let validCount = 0;
    let rejectedCount = parseResult.errors.length;
    let duplicatesCount = 0;

    for (const record of normalized) {
      const validation = ImportValidationService.validateRecord(record, ContentReuseStatus.PERMITTED);
      if (!validation.isValid) {
        rejectedCount++;
        record.validationErrors.push(...validation.errors);
      } else {
        validCount++;
      }

      // Check duplicates
      const dupCheck = await DuplicateDetectionService.checkForDuplicate(record);
      if (dupCheck.isDuplicate) {
        duplicatesCount++;
      }
    }

    return {
      filename,
      detectedFormat: parseResult.detectedFormat,
      totalParsed: parseResult.questions.length,
      validCount,
      rejectedCount,
      duplicatesCount,
      questions: normalized,
      errors: parseResult.errors,
    };
  }

  /**
   * Performs the actual import of a manual dataset into a ContentSource, creating
   * a ContentImportBatch and ContentImportItem staging records.
   */
  public static async importFile(
    fileContent: string,
    filename: string,
    adminId: string,
    options: {
      sourceName?: string;
      sourceId?: string;
      licenseId?: string;
      attribution?: string;
      fallbackTechnologyId?: string;
      csvMapping?: Partial<CSVColumnMapping>;
      autoPublish?: boolean;
    } = {}
  ) {
    const licenseSnapshot: LicenseSnapshot = {
      licenseId: options.licenseId || 'CC-BY-4.0',
      licenseName: options.licenseId || 'Manual Dataset Import',
      originalSourceUrl: `manual-upload://${filename}`,
      retrievedAt: new Date().toISOString(),
      isRedistributable: true,
      attributionText: options.attribution || `Imported dataset: ${filename}`,
    };

    let sourceId = options.sourceId;
    if (!sourceId) {
      // Create manual ContentSource
      const source = await prisma.contentSource.create({
        data: {
          name: options.sourceName || `Manual Dataset: ${filename}`,
          sourceType: SourceType.MANUAL,
          url: `manual://${filename}`,
          licenseId: licenseSnapshot.licenseId,
          attribution: licenseSnapshot.attributionText,
          status: 'READY',
          createdByAdminId: adminId,
        },
      });
      sourceId = source.id;

      if (options.fallbackTechnologyId) {
        await prisma.contentSourceTechnology.create({
          data: {
            sourceId: source.id,
            skillId: options.fallbackTechnologyId,
          },
        });
      }
    }

    // Create Document record
    const contentHash = crypto.createHash('sha256').update(fileContent, 'utf8').digest('hex');
    const doc = await prisma.sourceDocument.create({
      data: {
        sourceId,
        documentUrl: `manual://${filename}`,
        sourcePath: filename,
        contentHash,
        status: 'PROCESSED',
      },
    });

    // Create Import Batch
    const batch = await prisma.contentImportBatch.create({
      data: {
        sourceId,
        batchType: 'FILE_UPLOAD',
        status: 'IN_PROGRESS',
        initiatedByAdminId: adminId,
      },
    });

    const preview = await this.previewFile(
      fileContent,
      filename,
      licenseSnapshot,
      undefined,
      options.csvMapping
    );

    let newCount = 0;
    let dupCount = 0;
    let rejCount = 0;

    for (const record of preview.questions) {
      const dupCheck = await DuplicateDetectionService.checkForDuplicate(record);
      const isDuplicate = dupCheck.isDuplicate;

      if (isDuplicate) dupCount++;
      else newCount++;

      const validation = ImportValidationService.validateRecord(record);
      if (!validation.isValid) rejCount++;

      // Create Staging Item
      const stagedItem = await prisma.contentImportItem.create({
        data: {
          batchId: batch.id,
          sourceDocumentId: doc.id,
          rawContent: JSON.stringify(record),
          normalizedQuestion: record.normalizedQuestion,
          normalizedAnswer: record.normalizedAnswer,
          contentHash: record.contentHash,
          detectedTechnology: record.detectedTechnology,
          matchedSkillId: record.matchedSkillId || options.fallbackTechnologyId || null,
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
          duplicateScore: dupCheck.matchScore,
          duplicateDifference: dupCheck.differenceSummary || null,
          reviewStatus: options.autoPublish && validation.isValid && !isDuplicate ? ReviewStatus.APPROVED : ReviewStatus.PENDING,
        },
      });

      // If auto-publish enabled for clean records and skill mapped
      if (options.autoPublish && validation.isValid && !isDuplicate && (record.matchedSkillId || options.fallbackTechnologyId)) {
        const skillId = record.matchedSkillId || options.fallbackTechnologyId!;
        const published = await prisma.question.create({
          data: {
            technologyId: skillId,
            topic: record.topic,
            subtopic: record.subtopic,
            questionText: record.normalizedQuestion,
            answerContent: record.normalizedAnswer,
            explanation: record.explanation,
            difficulty: record.difficulty,
            questionType: record.questionType,
            options: record.options ? JSON.stringify(record.options) : null,
            correctOption: record.correctOption,
            tags: record.tags.length > 0 ? JSON.stringify(record.tags) : null,
            sourceId,
            sourceDocumentId: doc.id,
            sourceUrl: record.sourceUrl,
            licenseSnapshot: JSON.stringify(licenseSnapshot),
            contentHash: record.contentHash,
            reviewStatus: ReviewStatus.APPROVED,
            reviewedByAdminId: adminId,
            publishedAt: new Date(),
          },
        });

        await prisma.contentImportItem.update({
          where: { id: stagedItem.id },
          data: { publishedQuestionId: published.id },
        });
      }
    }

    // Complete batch
    await prisma.contentImportBatch.update({
      where: { id: batch.id },
      data: {
        status: 'COMPLETED',
        totalDiscovered: preview.questions.length,
        newItemsCount: newCount,
        duplicateItemsCount: dupCount,
        rejectedItemsCount: rejCount,
        completedAt: new Date(),
      },
    });

    return {
      batchId: batch.id,
      sourceId,
      totalDiscovered: preview.questions.length,
      newItemsCount: newCount,
      duplicateItemsCount: dupCount,
      rejectedItemsCount: rejCount,
    };
  }
}
