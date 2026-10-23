import { Router, Request, Response } from 'express';
import multer from 'multer';
import { requireAdmin } from '../lib/auth/session.js';
import { ContentSourceService } from '../lib/qa/content-source-service.js';
import { ManualImportService } from '../lib/qa/manual-import-service.js';
import { QuestionReviewService } from '../lib/qa/question-review-service.js';
import { ContentSyncService } from '../lib/qa/content-sync-service.js';
import { ContentScheduler } from '../lib/qa/content-scheduler.js';
import { TechnologyService } from '../lib/qa/technology-service.js';
import { validateSafeUrl } from '../lib/qa/url-validator.js';
import { ImportValidationService } from '../lib/qa/import-validation-service.js';
import { GitHubSourceAdapter } from '../lib/qa/github-source-adapter.js';
import { ContentNormalizationService } from '../lib/qa/content-normalization-service.js';
import { prisma } from '../lib/db.js';
import { ReviewStatus } from '../lib/qa/types.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB max upload
});

const router = Router();
router.use(requireAdmin);

// ==========================================
// 1. Dashboard Metrics
// ==========================================

router.get('/qa-dashboard/stats', async (_req: Request, res: Response) => {
  try {
    const [
      totalSources,
      sourcesAwaitingReview,
      activeSources,
      publishedQuestions,
      pendingStagedQuestions,
      duplicateStagedQuestions,
      rejectedStagedQuestions,
      recentBatches,
      recentTasks,
      coverageStats,
    ] = await Promise.all([
      prisma.contentSource.count(),
      prisma.contentSource.count({ where: { status: 'AWAITING_PERMISSION_REVIEW' } }),
      prisma.contentSource.count({ where: { isActive: true } }),
      prisma.question.count({ where: { reviewStatus: 'APPROVED' } }),
      prisma.contentImportItem.count({ where: { reviewStatus: 'PENDING' } }),
      prisma.contentImportItem.count({ where: { isDuplicate: true } }),
      prisma.contentImportItem.count({ where: { reviewStatus: 'REJECTED' } }),
      prisma.contentImportBatch.findMany({
        take: 10,
        orderBy: { startedAt: 'desc' },
        include: { source: { select: { name: true, sourceType: true } } },
      }),
      prisma.contentCoverageTask.findMany({
        where: { status: 'PENDING' },
        include: { skill: true },
        take: 10,
      }),
      TechnologyService.getTechnologyCoverageStats(),
    ]);

    const lastSyncBatch = await prisma.contentImportBatch.findFirst({
      where: { status: 'COMPLETED' },
      orderBy: { completedAt: 'desc' },
    });

    return res.json({
      sources: {
        total: totalSources,
        awaitingReview: sourcesAwaitingReview,
        active: activeSources,
      },
      questions: {
        published: publishedQuestions,
        pendingReview: pendingStagedQuestions,
        duplicates: duplicateStagedQuestions,
        rejected: rejectedStagedQuestions,
      },
      lastSync: lastSyncBatch ? lastSyncBatch.completedAt : null,
      recentBatches,
      pendingCoverageTasks: recentTasks,
      technologyCoverage: coverageStats,
    });
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : 'Failed to fetch QA dashboard statistics';
    return res.status(500).json({ error: errorMsg });
  }
});

// ==========================================
// 2. Source Management
// ==========================================

// GET /api/admin/content-sources
router.get('/content-sources', async (req: Request, res: Response) => {
  try {
    const sources = await ContentSourceService.listSources({
      status: req.query.status as any,
      sourceType: req.query.sourceType as any,
      technologyId: req.query.technologyId as string,
      search: req.query.search as string,
    });
    return res.json({ sources });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Failed to list content sources';
    return res.status(500).json({ error: msg });
  }
});

// POST /api/admin/content-sources
router.post('/content-sources', async (req: Request, res: Response) => {
  try {
    const adminId = req.auth!.user!.id;
    const source = await ContentSourceService.createSource({
      ...req.body,
      adminId,
    });
    return res.status(201).json({ source });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Failed to create content source';
    return res.status(400).json({ error: msg });
  }
});

// GET /api/admin/content-sources/:id
router.get('/content-sources/:id', async (req: Request, res: Response) => {
  try {
    const source = await ContentSourceService.getSourceById(req.params.id);
    return res.json({ source });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Source not found';
    return res.status(404).json({ error: msg });
  }
});

// PATCH /api/admin/content-sources/:id
router.patch('/content-sources/:id', async (req: Request, res: Response) => {
  try {
    const updated = await ContentSourceService.updateSource(req.params.id, req.body);
    return res.json({ source: updated });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Failed to update content source';
    return res.status(400).json({ error: msg });
  }
});

// DELETE /api/admin/content-sources/:id (Soft disable to preserve provenance)
router.delete('/content-sources/:id', async (req: Request, res: Response) => {
  try {
    await ContentSourceService.disableSource(req.params.id);
    return res.json({ success: true, message: 'Source disabled successfully.' });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Failed to disable source';
    return res.status(500).json({ error: msg });
  }
});

// POST /api/admin/content-sources/validate
router.post('/content-sources/validate', async (req: Request, res: Response) => {
  try {
    const { url, licenseId } = req.body;
    let urlResult = null;
    let githubInspection = null;

    if (url) {
      urlResult = await validateSafeUrl(url);
      if (urlResult.isValid && (url.includes('github.com') || url.includes('raw.githubusercontent.com'))) {
        try {
          githubInspection = await GitHubSourceAdapter.inspectTarget(url);
        } catch (inspectErr: unknown) {
          githubInspection = {
            isValid: false,
            error: inspectErr instanceof Error ? inspectErr.message : 'GitHub inspection failed',
          };
        }
      }
    }
    const detectedLicenseId = githubInspection?.license?.licenseId || licenseId;
    const licenseResult = detectedLicenseId ? ImportValidationService.validateSourceLicense(detectedLicenseId) : null;

    return res.json({
      urlValidation: urlResult,
      licenseValidation: licenseResult,
      githubInspection,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Validation failed';
    return res.status(400).json({ error: msg });
  }
});

// POST /api/admin/content-sources/preview-url
router.post('/content-sources/preview-url', async (req: Request, res: Response) => {
  try {
    const { url, licenseId, topic } = req.body;
    if (!url) return res.status(400).json({ error: 'URL is required for preview.' });

    const docs = await GitHubSourceAdapter.collect(url, { maxFiles: 1 });
    const allRaw = docs.flatMap((d) => d.questions);

    const defaultLicense = {
      licenseId: licenseId || docs[0]?.license?.licenseId || 'MIT',
      licenseName: licenseId || docs[0]?.license?.licenseName || 'MIT',
      licenseUrl: url,
      attributionText: `Source: ${url}`,
      originalSourceUrl: url,
      retrievedAt: new Date().toISOString(),
      isRedistributable: true,
    };

    const normalized = await ContentNormalizationService.normalizeBatch(
      allRaw.slice(0, 10),
      defaultLicense,
      topic || 'General'
    );

    return res.json({
      questions: normalized.slice(0, 10),
      totalDiscoveredInPreview: allRaw.length,
      sampleFile: docs[0]?.sourcePath || 'README.md',
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Preview failed';
    return res.status(400).json({ error: msg });
  }
});

// POST /api/admin/content-sources/:id/preview
router.post('/content-sources/:id/preview', async (req: Request, res: Response) => {
  try {
    const preview = await ContentSourceService.previewSource(req.params.id);
    return res.json(preview);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Preview failed';
    return res.status(400).json({ error: msg });
  }
});

// POST /api/admin/content-sources/:id/fetch
router.post('/content-sources/:id/fetch', async (req: Request, res: Response) => {
  try {
    const adminId = req.auth!.user!.id;
    const result = await ContentSyncService.syncSource(req.params.id, 'MANUAL_FETCH', adminId);
    return res.json({ success: true, result });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Fetch failed';
    return res.status(400).json({ error: msg });
  }
});

// GET /api/admin/content-sources/:id/history
router.get('/content-sources/:id/history', async (req: Request, res: Response) => {
  try {
    const batches = await prisma.contentImportBatch.findMany({
      where: { sourceId: req.params.id },
      orderBy: { startedAt: 'desc' },
      take: 20,
    });
    return res.json({ batches });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Failed to fetch history';
    return res.status(500).json({ error: msg });
  }
});

// ==========================================
// 3. Manual Dataset Imports
// ==========================================

// POST /api/admin/content-imports/preview
router.post('/content-imports/preview', upload.single('file'), async (req: Request, res: Response) => {
  try {
    let content = '';
    let filename = 'dataset.json';

    if (req.file) {
      content = req.file.buffer.toString('utf8');
      filename = req.file.originalname;
    } else if (req.body.content) {
      content = req.body.content;
      filename = req.body.filename || 'dataset.json';
    } else {
      return res.status(400).json({ error: 'No file or content supplied.' });
    }

    const licenseId = req.body.licenseId || 'CC-BY-4.0';
    const preview = await ManualImportService.previewFile(
      content,
      filename,
      {
        licenseId,
        attributionText: req.body.attribution || `Manual Import: ${filename}`,
        originalSourceUrl: `manual://${filename}`,
        retrievedAt: new Date().toISOString(),
        isRedistributable: true,
      },
      req.body.technology,
      req.body.csvMapping ? JSON.parse(req.body.csvMapping) : undefined
    );

    return res.json(preview);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Preview generation failed';
    return res.status(400).json({ error: msg });
  }
});

// POST /api/admin/content-imports/upload
router.post('/content-imports/upload', upload.single('file'), async (req: Request, res: Response) => {
  try {
    const adminId = req.auth!.user!.id;
    let content = '';
    let filename = 'dataset.json';

    if (req.file) {
      content = req.file.buffer.toString('utf8');
      filename = req.file.originalname;
    } else if (req.body.content) {
      content = req.body.content;
      filename = req.body.filename || 'dataset.json';
    } else {
      return res.status(400).json({ error: 'No file or content supplied.' });
    }

    const result = await ManualImportService.importFile(content, filename, adminId, {
      sourceName: req.body.sourceName,
      sourceId: req.body.sourceId,
      licenseId: req.body.licenseId,
      attribution: req.body.attribution,
      fallbackTechnologyId: req.body.fallbackTechnologyId,
      autoPublish: req.body.autoPublish === 'true' || req.body.autoPublish === true,
    });

    return res.status(201).json({ success: true, result });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Import failed';
    return res.status(400).json({ error: msg });
  }
});

// ==========================================
// 4. Staging & Review Queue
// ==========================================

// GET /api/admin/questions/staged
router.get('/questions/staged', async (req: Request, res: Response) => {
  try {
    const result = await QuestionReviewService.listStagedItems({
      batchId: req.query.batchId as string,
      reviewStatus: req.query.reviewStatus as ReviewStatus,
      isDuplicate: req.query.isDuplicate === 'true' ? true : req.query.isDuplicate === 'false' ? false : undefined,
      technologyId: req.query.technologyId as string,
      search: req.query.search as string,
      page: parseInt((req.query.page as string) || '1', 10),
      limit: parseInt((req.query.limit as string) || '25', 10),
    });
    return res.json(result);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Failed to fetch staged items';
    return res.status(500).json({ error: msg });
  }
});

// PATCH /api/admin/questions/staged/:id
router.patch('/questions/staged/:id', async (req: Request, res: Response) => {
  try {
    const updated = await QuestionReviewService.updateStagedItem(req.params.id, req.body);
    return res.json({ item: updated });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Failed to update item';
    return res.status(400).json({ error: msg });
  }
});

// POST /api/admin/questions/staged/:id/publish
router.post('/questions/staged/:id/publish', async (req: Request, res: Response) => {
  try {
    const adminId = req.auth!.user!.id;
    const published = await QuestionReviewService.publishStagedItem(req.params.id, adminId);
    return res.json({ success: true, question: published });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Failed to publish item';
    return res.status(400).json({ error: msg });
  }
});

// POST /api/admin/questions/staged/:id/reject
router.post('/questions/staged/:id/reject', async (req: Request, res: Response) => {
  try {
    const adminId = req.auth!.user!.id;
    const item = await QuestionReviewService.rejectStagedItem(req.params.id, adminId, req.body.notes);
    return res.json({ success: true, item });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Failed to reject item';
    return res.status(400).json({ error: msg });
  }
});

// POST /api/admin/questions/staged/:id/merge
router.post('/questions/staged/:id/merge', async (req: Request, res: Response) => {
  try {
    const adminId = req.auth!.user!.id;
    const { targetQuestionId } = req.body;
    if (!targetQuestionId) {
      return res.status(400).json({ error: 'targetQuestionId is required to merge duplicate.' });
    }
    const item = await QuestionReviewService.mergeDuplicateStagedItem(req.params.id, targetQuestionId, adminId);
    return res.json({ success: true, item });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Failed to merge duplicate';
    return res.status(400).json({ error: msg });
  }
});

// POST /api/admin/questions/staged/batch-publish
router.post('/questions/staged/batch-publish', async (req: Request, res: Response) => {
  try {
    const adminId = req.auth!.user!.id;
    const { batchId, onlyNonDuplicates } = req.body;
    if (!batchId) {
      return res.status(400).json({ error: 'batchId is required.' });
    }
    const result = await QuestionReviewService.batchPublish(batchId, adminId, onlyNonDuplicates ?? true);
    return res.json({ success: true, result });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Batch publish failed';
    return res.status(400).json({ error: msg });
  }
});

// POST /api/admin/questions/staged/publish-all
router.post('/questions/staged/publish-all', async (req: Request, res: Response) => {
  try {
    const adminId = req.auth!.user!.id;
    const { batchId, sourceId, technologyId, onlyNonDuplicates } = req.body;
    const result = await QuestionReviewService.publishAllFiltered(
      { batchId, sourceId, technologyId, onlyNonDuplicates },
      adminId
    );
    return res.json({ success: true, result });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Publish all failed';
    return res.status(400).json({ error: msg });
  }
});

// POST /api/admin/questions/staged/bulk-publish
router.post('/questions/staged/bulk-publish', async (req: Request, res: Response) => {
  try {
    const adminId = req.auth!.user!.id;
    const { itemIds } = req.body;
    if (!Array.isArray(itemIds) || itemIds.length === 0) {
      return res.status(400).json({ error: 'itemIds array is required.' });
    }
    const result = await QuestionReviewService.bulkPublishItems(itemIds, adminId);
    return res.json({ success: true, result });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Bulk publish failed';
    return res.status(400).json({ error: msg });
  }
});

// POST /api/admin/questions/staged/bulk-approve
router.post('/questions/staged/bulk-approve', async (req: Request, res: Response) => {
  try {
    const adminId = req.auth!.user!.id;
    const { itemIds } = req.body;
    if (!Array.isArray(itemIds) || itemIds.length === 0) {
      return res.status(400).json({ error: 'itemIds array is required.' });
    }
    const result = await QuestionReviewService.bulkApproveItems(itemIds, adminId);
    return res.json({ success: true, result });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Bulk approve failed';
    return res.status(400).json({ error: msg });
  }
});

// POST /api/admin/questions/staged/bulk-reject
router.post('/questions/staged/bulk-reject', async (req: Request, res: Response) => {
  try {
    const adminId = req.auth!.user!.id;
    const { itemIds, notes } = req.body;
    if (!Array.isArray(itemIds) || itemIds.length === 0) {
      return res.status(400).json({ error: 'itemIds array is required.' });
    }
    const result = await QuestionReviewService.bulkRejectItems(itemIds, adminId, notes);
    return res.json({ success: true, result });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Bulk reject failed';
    return res.status(400).json({ error: msg });
  }
});

// GET /api/admin/batches
router.get('/batches', async (_req: Request, res: Response) => {
  try {
    const batches = await prisma.contentImportBatch.findMany({
      orderBy: { startedAt: 'desc' },
      take: 50,
      include: {
        source: {
          select: { id: true, name: true, url: true, sourceType: true },
        },
      },
    });
    return res.json({ batches });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Failed to list batches';
    return res.status(500).json({ error: msg });
  }
});

// ==========================================
// 5. Published Question Bank Admin Control
// ==========================================

// GET /api/admin/questions
router.get('/questions', async (req: Request, res: Response) => {
  try {
    const page = Math.max(1, parseInt((req.query.page as string) || '1', 10));
    const limit = Math.min(100, parseInt((req.query.limit as string) || '25', 10));
    const skip = (page - 1) * limit;

    const where: any = {
      ...(req.query.technologyId ? { technologyId: req.query.technologyId as string } : {}),
      ...(req.query.topic ? { topic: req.query.topic as string } : {}),
      ...(req.query.difficulty ? { difficulty: req.query.difficulty as any } : {}),
      ...(req.query.reviewStatus ? { reviewStatus: req.query.reviewStatus as any } : {}),
      ...(req.query.search
        ? {
            OR: [
              { questionText: { contains: req.query.search as string } },
              { topic: { contains: req.query.search as string } },
            ],
          }
        : {}),
    };

    const [questions, totalCount] = await Promise.all([
      prisma.question.findMany({
        where,
        include: {
          technology: true,
          source: true,
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.question.count({ where }),
    ]);

    return res.json({
      questions,
      pagination: {
        page,
        limit,
        totalCount,
        totalPages: Math.ceil(totalCount / limit),
      },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Failed to fetch questions';
    return res.status(500).json({ error: msg });
  }
});

// PATCH /api/admin/questions/:id
router.patch('/questions/:id', async (req: Request, res: Response) => {
  try {
    const updated = await prisma.question.update({
      where: { id: req.params.id },
      data: {
        ...(req.body.questionText ? { questionText: req.body.questionText.trim() } : {}),
        ...(req.body.answerContent ? { answerContent: req.body.answerContent.trim() } : {}),
        ...(req.body.explanation !== undefined ? { explanation: req.body.explanation } : {}),
        ...(req.body.topic ? { topic: req.body.topic.trim() } : {}),
        ...(req.body.subtopic !== undefined ? { subtopic: req.body.subtopic } : {}),
        ...(req.body.difficulty ? { difficulty: req.body.difficulty } : {}),
        ...(req.body.questionType ? { questionType: req.body.questionType } : {}),
        ...(req.body.technologyId ? { technologyId: req.body.technologyId } : {}),
        ...(req.body.options !== undefined ? { options: JSON.stringify(req.body.options) } : {}),
        ...(req.body.correctOption !== undefined ? { correctOption: req.body.correctOption } : {}),
        ...(req.body.reviewStatus ? { reviewStatus: req.body.reviewStatus } : {}),
        lastVerifiedAt: new Date(),
      },
    });
    return res.json({ question: updated });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Failed to update question';
    return res.status(400).json({ error: msg });
  }
});

// POST /api/admin/questions/:id/archive
router.post('/questions/:id/archive', async (req: Request, res: Response) => {
  try {
    const archived = await prisma.question.update({
      where: { id: req.params.id },
      data: { reviewStatus: ReviewStatus.ARCHIVED },
    });
    return res.json({ success: true, question: archived });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Failed to archive question';
    return res.status(500).json({ error: msg });
  }
});

// ==========================================
// 6. Technology Catalogue & Coverage Management
// ==========================================

// GET /api/admin/technologies/coverage
router.get('/technologies/coverage', async (_req: Request, res: Response) => {
  try {
    const stats = await TechnologyService.getTechnologyCoverageStats();
    return res.json({ technologies: stats });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Failed to fetch technology coverage';
    return res.status(500).json({ error: msg });
  }
});

// POST /api/admin/technologies
router.post('/technologies', async (req: Request, res: Response) => {
  try {
    const { canonicalName, category, aliases } = req.body;
    if (!canonicalName || typeof canonicalName !== 'string' || !canonicalName.trim()) {
      return res.status(400).json({ error: 'canonicalName is required.' });
    }

    const result = await ContentScheduler.onNewTechnologyAdded({
      canonicalName: canonicalName.trim(),
      category: (category && typeof category === 'string' && category.trim()) || 'General',
      aliases,
    });

    return res.status(201).json(result);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Failed to register technology';
    return res.status(400).json({ error: msg });
  }
});

// POST /api/admin/technologies/:id/aliases
router.post('/technologies/:id/aliases', async (req: Request, res: Response) => {
  try {
    const { alias } = req.body;
    if (!alias || typeof alias !== 'string') {
      return res.status(400).json({ error: 'alias must be a non-empty string.' });
    }
    const updated = await TechnologyService.addAlias(req.params.id, alias);
    return res.json({ technology: updated });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Failed to add alias';
    return res.status(400).json({ error: msg });
  }
});

// POST /api/admin/scheduler/monthly-sync
router.post('/scheduler/monthly-sync', async (_req: Request, res: Response) => {
  try {
    const result = await ContentScheduler.runMonthlySync();
    return res.json({ success: true, result });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Monthly sync trigger failed';
    return res.status(500).json({ error: msg });
  }
});

export default router;
