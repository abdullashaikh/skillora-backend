import { Router, Request, Response } from 'express';
import multer from 'multer';
import { prisma } from '../lib/db.js';
import { parseDocument } from '../lib/parser/document-parser.js';
import { scrubPii } from '../lib/parser/pii-scrubber.js';
import { AIProviderService } from '../lib/ai/ai-provider-service.js';
import { normalizeSkills } from '../lib/scoring/skill-normalizer.js';
import { ScoringEngine, QualityWeights, JobMatchWeights } from '../lib/scoring/scoring-engine.js';
import { StructuredResumeExtractionSchema } from '../lib/ai/types.js';
import { resumeUploadRateLimiter } from '../lib/security/rate-limiter.js';

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
});

// In-flight concurrency lock to prevent parallel race conditions on guest quotas
const inFlightGuestUploads = new Set<string>();

// POST /api/resumes/analyze
router.post('/analyze', resumeUploadRateLimiter, upload.single('file'), async (req: Request, res: Response) => {
  const auth = req.auth;
  if (!auth) {
    return res.status(400).json({ error: 'Session context missing.' });
  }

  // 1. Quotas & Concurrency Locks (1 analysis allowed per guest session)
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  if (auth.isGuest) {
    if (inFlightGuestUploads.has(auth.guestSessionId)) {
      return res.status(429).json({
        error: 'An analysis is already in progress for your guest session. Please wait for it to complete.',
        isQuotaReached: true,
      });
    }

    const recentGuestCount = await prisma.resumeAnalysis.count({
      where: {
        guestSessionId: auth.guestSessionId,
        status: { in: ['COMPLETED', 'PROCESSING', 'PENDING'] },
      },
    });
    if (recentGuestCount >= 1) {
      return res.status(429).json({
        error: 'Guest analysis limit reached (1 resume per guest session). Please create a free account or log in to unlock full reports and unlimited analyses.',
        isQuotaReached: true,
      });
    }

    // Acquire lock for this guest session
    inFlightGuestUploads.add(auth.guestSessionId);
  } else if (auth.user) {
    const recentUserCount = await prisma.resumeAnalysis.count({
      where: {
        userId: auth.user.id,
        createdAt: { gte: oneDayAgo },
      },
    });
    if (recentUserCount >= 50) {
      return res.status(429).json({
        error: 'Daily analysis limit reached (50 analyses). Please try again tomorrow.',
      });
    }
  }

  try {

    // 2. Validate uploaded file
    const file = req.file;
    if (!file) {
      return res.status(400).json({ error: 'No resume file uploaded.' });
    }

    const targetJobDescription = (req.body.targetJobDescription as string) || undefined;
    const targetRole = (req.body.targetRole as string) || undefined;

    // 3. Document Parsing
    console.log(`[Resume Upload] Step 1: Parsing document "${file.originalname}" (${file.buffer.length} bytes)...`);
    const parsedDoc = await parseDocument(file.buffer, file.originalname, {
      maxSizeBytes: parseInt(process.env.MAX_FILE_SIZE_BYTES || '5242880', 10),
      maxPages: parseInt(process.env.MAX_PAGE_COUNT || '5', 10),
    });
    console.log(`[Resume Upload] Step 1 Complete: Extracted ${parsedDoc.text.length} chars.`);

    // 4. Scrub PII
    console.log('[Resume Upload] Step 2: Scrubbing PII...');
    const sanitized = scrubPii(parsedDoc.text, 20000);
    console.log('[Resume Upload] Step 2 Complete: Scrubbed PII items:', sanitized.piiRedacted);

    // 5. Active Scoring Weights
    const scoringConfig = await prisma.scoringConfig.findFirst({
      where: { isCurrent: true },
      orderBy: { version: 'desc' },
    });

    let qualityWeights: QualityWeights | undefined;
    let jobMatchWeights: JobMatchWeights | undefined;
    if (scoringConfig) {
      try {
        qualityWeights = JSON.parse(scoringConfig.qualityWeights);
        jobMatchWeights = JSON.parse(scoringConfig.jobMatchWeights);
      } catch {
        // use default
      }
    }

    // 6. External AI Extraction
    console.log('[Resume Upload] Step 3: Calling AIProviderService.extract...');
    const extractionResult = await AIProviderService.extract({
      sanitizedResumeText: sanitized.sanitizedText,
      targetJobDescription,
      userId: auth.user?.id,
      guestSessionId: auth.guestSessionId,
      isGuest: auth.isGuest,
    });
    console.log('[Resume Upload] Step 3 Complete: AI extraction succeeded.');

    const structuredData = extractionResult.extraction.data;
    if (parsedDoc.warnings.length > 0) {
      structuredData.warnings.push(...parsedDoc.warnings);
    }

    // 7. Canonical Skill Normalization
    const normalizedSkills = await normalizeSkills(structuredData.skills);

    // 8. Deterministic Scoring
    const qualityScoreReport = ScoringEngine.calculateQualityScore(
      structuredData,
      normalizedSkills,
      qualityWeights
    );

    let jobMatchReport: ReturnType<typeof ScoringEngine.calculateJobMatchScore> | null = null;
    if (targetJobDescription && targetJobDescription.trim().length > 20) {
      jobMatchReport = ScoringEngine.calculateJobMatchScore(
        structuredData,
        normalizedSkills,
        targetJobDescription,
        jobMatchWeights
      );
    }

    const scoreBreakdown = {
      qualityDimensions: qualityScoreReport.dimensions,
      jobMatchDimensions: jobMatchReport?.dimensions || null,
      matchedSkills: jobMatchReport?.matchedSkills || [],
      missingSkills: jobMatchReport?.missingSkills || [],
      suggestions: [
        ...qualityScoreReport.suggestions,
        ...structuredData.suggestedImprovements,
      ].filter((v, i, a) => a.indexOf(v) === i),
      disclaimer:
        'These scores and evaluations are deterministic estimates generated by the application rules to guide resume enhancement. They do not predict or guarantee employment outcomes or official employer ATS results.',
    };

    // 9. Expiration for guests
    const guestExpiryHours = parseInt(process.env.GUEST_REPORT_EXPIRY_HOURS || '24', 10);
    const expiresAt = auth.isGuest
      ? new Date(Date.now() + guestExpiryHours * 60 * 60 * 1000)
      : null;

    // 10. Persist records
    const sanitizedOriginalName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');

    const resumeRecord = await prisma.resume.create({
      data: {
        userId: auth.user?.id,
        guestSessionId: auth.guestSessionId,
        originalName: sanitizedOriginalName,
        mimeType: parsedDoc.mimeType,
        fileSize: parsedDoc.fileSizeBytes,
        pageCount: parsedDoc.pageCount,
        expiresAt,
      },
    });

    const analysis = await prisma.resumeAnalysis.create({
      data: {
        userId: auth.user?.id,
        guestSessionId: auth.guestSessionId,
        resumeId: resumeRecord.id,
        status: 'COMPLETED',
        schemaVersion: '1.0',
        providerUsed: extractionResult.provider,
        modelUsed: extractionResult.model,
        promptTemplateVersion: extractionResult.promptVersion,
        scoringConfigVersion: scoringConfig?.version || 1,
        targetJobDescription: targetJobDescription || null,
        targetRole: targetRole || null,
        qualityScore: qualityScoreReport.totalScore,
        jobMatchScore: jobMatchReport ? jobMatchReport.totalScore : null,
        scoreBreakdown: JSON.stringify(scoreBreakdown),
        extractedProfile: JSON.stringify(structuredData),
        warnings: JSON.stringify(structuredData.warnings),
        isGuest: auth.isGuest,
        expiresAt,
      },
    });

    if (normalizedSkills.length > 0) {
      await prisma.resumeAnalysisSkill.createMany({
        data: normalizedSkills.map((s) => ({
          analysisId: analysis.id,
          skillId: s.skillId,
          rawName: s.rawName,
          canonicalName: s.canonicalName,
          category: s.category,
          evidence: s.evidence,
          sourceSection: s.sourceSection,
          confidence: s.confidence,
          isExplicit: s.isExplicit,
        })),
      });
    }

    const isLocked = Boolean(auth.isGuest || (auth.user && !auth.user.isEmailVerified && auth.user.role !== 'ADMIN'));
    const lockReason = auth.isGuest ? 'GUEST' : (auth.user && !auth.user.isEmailVerified ? 'UNVERIFIED' : null);

    if (isLocked) {
      return res.json({
        success: true,
        analysisId: analysis.id,
        qualityScore: qualityScoreReport.totalScore,
        jobMatchScore: null,
        scoreBreakdown: {
          qualityDimensions: null,
          jobMatchDimensions: null,
          matchedSkills: null,
          missingSkills: null,
          suggestions: null,
          disclaimer: 'These scores and evaluations are deterministic estimates generated by our assessment rules to guide resume enhancement. They do not predict or guarantee employment outcomes or official employer ATS results.',
        },
        skills: [],
        extractedProfile: null,
        isGuest: auth.isGuest,
        isLocked: true,
        lockReason,
        expiresAt,
        message: auth.isGuest
          ? 'Your resume ATS score is ready! Create a free account or log in to unlock your full detailed report, extracted skills, and recommendations.'
          : 'Please verify your email address to unlock your full detailed report.',
      });
    }

    return res.json({
      success: true,
      analysisId: analysis.id,
      qualityScore: qualityScoreReport.totalScore,
      jobMatchScore: jobMatchReport ? jobMatchReport.totalScore : null,
      scoreBreakdown,
      skills: normalizedSkills,
      extractedProfile: structuredData,
      isGuest: false,
      isLocked: false,
      lockReason: null,
      expiresAt: null,
    });
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : 'An error occurred during resume analysis.';
    return res.status(500).json({ error: errorMsg });
  } finally {
    if (auth.isGuest) {
      inFlightGuestUploads.delete(auth.guestSessionId);
    }
  }
});

// GET /api/resume-analyses (List with Server-Side Pagination)
router.get('/', async (req: Request, res: Response) => {
  try {
    const auth = req.auth;
    if (!auth) return res.status(401).json({ error: 'Unauthorized' });

    // Automatic cleanup of expired guest analyses
    try {
      await prisma.resumeAnalysis.deleteMany({
        where: {
          isGuest: true,
          expiresAt: { lt: new Date() },
        },
      });
    } catch {
      // non-blocking
    }

    const page = Math.max(1, parseInt((req.query.page as string) || '1', 10));
    const limit = Math.min(50, Math.max(1, parseInt((req.query.limit as string) || '10', 10)));
    const skip = (page - 1) * limit;

    if (auth.user) {
      const [totalCount, analyses] = await Promise.all([
        prisma.resumeAnalysis.count({
          where: { userId: auth.user.id },
        }),
        prisma.resumeAnalysis.findMany({
          where: { userId: auth.user.id },
          include: {
            resume: { select: { originalName: true, fileSize: true, mimeType: true } },
          },
          orderBy: { createdAt: 'desc' },
          skip,
          take: limit,
        }),
      ]);

      const totalPages = Math.max(1, Math.ceil(totalCount / limit));

      return res.json({
        analyses: analyses.map((a) => ({
          id: a.id,
          filename: a.resume?.originalName || 'Resume',
          qualityScore: a.qualityScore,
          jobMatchScore: a.jobMatchScore,
          targetRole: a.targetRole,
          createdAt: a.createdAt,
          status: a.status,
        })),
        pagination: {
          page,
          limit,
          totalCount,
          totalPages,
          hasMore: page < totalPages,
        },
        isGuest: false,
      });
    }

    const [guestTotal, guestAnalyses] = await Promise.all([
      prisma.resumeAnalysis.count({
        where: {
          guestSessionId: auth.guestSessionId,
          expiresAt: { gt: new Date() },
        },
      }),
      prisma.resumeAnalysis.findMany({
        where: {
          guestSessionId: auth.guestSessionId,
          expiresAt: { gt: new Date() },
        },
        include: {
          resume: { select: { originalName: true, fileSize: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
    ]);

    const guestTotalPages = Math.max(1, Math.ceil(guestTotal / limit));

    return res.json({
      analyses: guestAnalyses.map((a) => ({
        id: a.id,
        filename: a.resume?.originalName || 'Guest Resume',
        qualityScore: a.qualityScore,
        jobMatchScore: a.jobMatchScore,
        createdAt: a.createdAt,
        expiresAt: a.expiresAt,
        status: a.status,
      })),
      pagination: {
        page,
        limit,
        totalCount: guestTotal,
        totalPages: guestTotalPages,
        hasMore: page < guestTotalPages,
      },
      isGuest: true,
    });
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : 'Failed to fetch analyses';
    return res.status(500).json({ error: errorMsg });
  }
});

// GET /api/resume-analyses/:id
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const auth = req.auth;

    const analysis = await prisma.resumeAnalysis.findUnique({
      where: { id },
      include: {
        resume: true,
        skills: true,
      },
    });

    if (!analysis) {
      return res.status(404).json({ error: 'Report not found' });
    }

    // Ownership check
    if (analysis.userId) {
      if (!auth?.user || (auth.user.id !== analysis.userId && auth.user.role !== 'ADMIN')) {
        return res.status(403).json({ error: 'Access denied' });
      }
    } else if (analysis.isGuest) {
      if (analysis.guestSessionId !== auth?.guestSessionId) {
        return res.status(403).json({ error: 'Access denied' });
      }
      if (analysis.expiresAt && analysis.expiresAt < new Date()) {
        return res.status(410).json({ error: 'This temporary guest report has expired.' });
      }
    }

    let extractedProfile = null;
    let scoreBreakdown = null;
    let warnings: string[] = [];

    try {
      if (analysis.extractedProfile) extractedProfile = JSON.parse(analysis.extractedProfile);
      if (analysis.scoreBreakdown) scoreBreakdown = JSON.parse(analysis.scoreBreakdown);
      if (analysis.warnings) warnings = JSON.parse(analysis.warnings);
    } catch {
      // ignore
    }

    const isOwnerVerifiedUser = Boolean(
      auth?.user &&
      (auth.user.id === analysis.userId || auth.user.role === 'ADMIN') &&
      (auth.user.isEmailVerified || auth.user.role === 'ADMIN')
    );

    const isLocked = !isOwnerVerifiedUser;
    const lockReason = analysis.isGuest
      ? 'GUEST'
      : auth?.user && !auth.user.isEmailVerified
      ? 'UNVERIFIED'
      : 'GUEST';

    if (isLocked) {
      return res.json({
        id: analysis.id,
        filename: analysis.resume?.originalName || 'Resume',
        qualityScore: analysis.qualityScore,
        jobMatchScore: null,
        targetRole: null,
        targetJobDescription: null,
        scoreBreakdown: {
          qualityDimensions: null,
          jobMatchDimensions: null,
          matchedSkills: null,
          missingSkills: null,
          suggestions: null,
          disclaimer:
            'These scores and evaluations are deterministic estimates generated by our assessment rules to guide resume enhancement. They do not predict or guarantee employment outcomes or official employer ATS results.',
        },
        extractedProfile: null,
        skills: [],
        warnings: [],
        isGuest: analysis.isGuest,
        isLocked: true,
        lockReason,
        expiresAt: analysis.expiresAt,
        createdAt: analysis.createdAt,
      });
    }

    return res.json({
      id: analysis.id,
      filename: analysis.resume?.originalName || 'Resume',
      qualityScore: analysis.qualityScore,
      jobMatchScore: analysis.jobMatchScore,
      targetRole: analysis.targetRole,
      targetJobDescription: analysis.targetJobDescription,
      scoreBreakdown,
      extractedProfile,
      skills: analysis.skills,
      warnings,
      isGuest: false,
      isLocked: false,
      lockReason: null,
      expiresAt: analysis.expiresAt,
      createdAt: analysis.createdAt,
      providerUsed: analysis.providerUsed,
      modelUsed: analysis.modelUsed,
    });
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : 'Failed to load report';
    return res.status(500).json({ error: errorMsg });
  }
});

// PATCH /api/resume-analyses/:id/profile (Registered user corrections)
router.patch('/:id/profile', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const auth = req.auth;

    if (!auth?.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    if (!auth.user.isEmailVerified && auth.user.role !== 'ADMIN') {
      return res.status(403).json({ error: 'Please verify your email address to make profile corrections.' });
    }

    const analysis = await prisma.resumeAnalysis.findUnique({
      where: { id },
    });

    if (!analysis) {
      return res.status(404).json({ error: 'Report not found' });
    }

    if (analysis.userId !== auth.user.id && auth.user.role !== 'ADMIN') {
      return res.status(403).json({ error: 'Access denied' });
    }

    const { skills: updatedSkillsList, summary } = req.body;

    let currentProfile;
    try {
      currentProfile = JSON.parse(analysis.extractedProfile || '{}');
    } catch {
      currentProfile = {};
    }

    if (summary !== undefined) {
      currentProfile.summary = summary;
    }

    if (Array.isArray(updatedSkillsList)) {
      currentProfile.skills = updatedSkillsList.map((s) => ({
        name: typeof s === 'string' ? s : s.name,
        evidence: typeof s === 'object' && s.evidence ? s.evidence : null,
        sourceSection: typeof s === 'object' && s.sourceSection ? s.sourceSection : 'skills',
        confidence: 1.0,
      }));
    }

    const validatedProfile = StructuredResumeExtractionSchema.parse(currentProfile);
    const normalized = await normalizeSkills(validatedProfile.skills);

    const scoringConfig = await prisma.scoringConfig.findFirst({
      where: { isCurrent: true },
      orderBy: { version: 'desc' },
    });

    let qualityWeights: QualityWeights | undefined;
    let jobMatchWeights: JobMatchWeights | undefined;
    if (scoringConfig) {
      try {
        qualityWeights = JSON.parse(scoringConfig.qualityWeights);
        jobMatchWeights = JSON.parse(scoringConfig.jobMatchWeights);
      } catch {
        // default
      }
    }

    const qualityScoreReport = ScoringEngine.calculateQualityScore(
      validatedProfile,
      normalized,
      qualityWeights
    );

    let jobMatchReport: ReturnType<typeof ScoringEngine.calculateJobMatchScore> | null = null;
    if (analysis.targetJobDescription) {
      jobMatchReport = ScoringEngine.calculateJobMatchScore(
        validatedProfile,
        normalized,
        analysis.targetJobDescription,
        jobMatchWeights
      );
    }

    const updatedBreakdown = {
      qualityDimensions: qualityScoreReport.dimensions,
      jobMatchDimensions: jobMatchReport?.dimensions || null,
      matchedSkills: jobMatchReport?.matchedSkills || [],
      missingSkills: jobMatchReport?.missingSkills || [],
      suggestions: [
        ...qualityScoreReport.suggestions,
        ...validatedProfile.suggestedImprovements,
      ].filter((v, i, a) => a.indexOf(v) === i),
      disclaimer:
        'These scores and evaluations are deterministic estimates generated by the application rules to guide resume enhancement.',
    };

    await prisma.$transaction([
      prisma.resumeAnalysisSkill.deleteMany({
        where: { analysisId: id },
      }),
      prisma.resumeAnalysisSkill.createMany({
        data: normalized.map((s) => ({
          analysisId: id,
          skillId: s.skillId,
          rawName: s.rawName,
          canonicalName: s.canonicalName,
          category: s.category,
          evidence: s.evidence,
          sourceSection: s.sourceSection,
          confidence: s.confidence,
          isExplicit: s.isExplicit,
        })),
      }),
      prisma.resumeAnalysis.update({
        where: { id },
        data: {
          extractedProfile: JSON.stringify(validatedProfile),
          qualityScore: qualityScoreReport.totalScore,
          jobMatchScore: jobMatchReport ? jobMatchReport.totalScore : null,
          scoreBreakdown: JSON.stringify(updatedBreakdown),
        },
      }),
    ]);

    return res.json({
      success: true,
      qualityScore: qualityScoreReport.totalScore,
      jobMatchScore: jobMatchReport ? jobMatchReport.totalScore : null,
      skills: normalized,
      scoreBreakdown: updatedBreakdown,
      message: 'Profile and scores updated successfully.',
    });
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : 'Update failed';
    return res.status(500).json({ error: errorMsg });
  }
});

// DELETE /api/resume-analyses/:id
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const auth = req.auth;

    const analysis = await prisma.resumeAnalysis.findUnique({
      where: { id },
    });

    if (!analysis) {
      return res.status(404).json({ error: 'Report not found' });
    }

    if (analysis.userId) {
      if (!auth?.user || (auth.user.id !== analysis.userId && auth.user.role !== 'ADMIN')) {
        return res.status(403).json({ error: 'Access denied' });
      }
    } else if (analysis.isGuest) {
      if (analysis.guestSessionId !== auth?.guestSessionId) {
        return res.status(403).json({ error: 'Access denied' });
      }
    }

    if (analysis.resumeId) {
      await prisma.resume.delete({ where: { id: analysis.resumeId } }).catch(() => {});
    }

    await prisma.resumeAnalysis.delete({ where: { id } });

    return res.json({ success: true, message: 'Report deleted successfully.' });
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : 'Delete failed';
    return res.status(500).json({ error: errorMsg });
  }
});

export default router;
