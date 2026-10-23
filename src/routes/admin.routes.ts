import { Router, Request, Response } from 'express';
import { prisma } from '../lib/db.js';
import { requireAdmin } from '../lib/auth/session.js';
import { encryptSecret, maskApiKey, decryptSecret } from '../lib/security/crypto.js';
import { AIProviderService } from '../lib/ai/ai-provider-service.js';
import { validateWeights, QualityWeights, JobMatchWeights } from '../lib/scoring/scoring-engine.js';

const router = Router();
router.use(requireAdmin);

// GET /api/admin/ai-config
router.get('/ai-config', async (_req: Request, res: Response) => {
  try {
    const configs = await prisma.aIProviderConfig.findMany({
      orderBy: { provider: 'asc' },
    });

    const openAiMeta = AIProviderService.getProvider('OPENAI').getProviderMetadata();
    const geminiMeta = AIProviderService.getProvider('GEMINI').getProviderMetadata();

    const responseData = configs.map((c) => {
      const meta = c.provider === 'OPENAI' ? openAiMeta : geminiMeta;
      return {
        provider: c.provider,
        displayName: meta.displayName,
        modelId: c.modelId,
        isActive: c.isActive,
        isConfigured: c.isConfigured,
        keyMasked: c.keyMasked || null,
        lastTestedAt: c.lastTestedAt,
        lastTestStatus: c.lastTestStatus,
        lastTestMessage: c.lastTestMessage,
        supportedModels: meta.supportedModels,
        updatedAt: c.updatedAt,
      };
    });

    return res.json({ providers: responseData });
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : 'Failed to fetch AI configurations';
    return res.status(500).json({ error: errorMsg });
  }
});

// PUT /api/admin/ai-config
router.put('/ai-config', async (req: Request, res: Response) => {
  try {
    const admin = req.auth!.user!;
    const { provider, modelId, apiKey, isActive } = req.body;

    if (provider !== 'OPENAI' && provider !== 'GEMINI') {
      return res.status(400).json({ error: 'Provider must be OPENAI or GEMINI.' });
    }

    const meta = AIProviderService.getProvider(provider).getProviderMetadata();
    const isValidCustomModel = typeof modelId === 'string' && /^[a-zA-Z0-9._:-]{2,80}$/.test(modelId.trim());
    const selectedModel = meta.supportedModels.includes(modelId)
      ? modelId
      : (isValidCustomModel ? modelId.trim() : meta.defaultModel);

    const existing = await prisma.aIProviderConfig.findUnique({
      where: { provider },
    });

    let encryptedData = undefined;
    let masked = undefined;

    if (apiKey && apiKey.trim().length > 0) {
      const trimmedKey = apiKey.trim();

      // Format validation to prevent saving corrupted strings
      if (provider === 'OPENAI') {
        if (!trimmedKey.startsWith('sk-') || trimmedKey.length < 20) {
          return res.status(400).json({
            error: 'Invalid OpenAI API key format. Keys must start with "sk-" and be at least 20 characters.',
          });
        }
      } else if (provider === 'GEMINI') {
        if (trimmedKey.length < 15 || !/^[A-Za-z0-9_-]+$/.test(trimmedKey)) {
          return res.status(400).json({
            error: 'Invalid Gemini API key format. Keys must be alphanumeric and at least 15 characters.',
          });
        }
      }

      // Pre-flight connection test if requested
      if (req.body.testBeforeSave === true) {
        const testRes = await AIProviderService.testConnection(
          provider,
          trimmedKey,
          selectedModel
        );
        if (!testRes.success) {
          return res.status(400).json({
            error: `Connection test failed for ${provider}: ${testRes.message}. Credential not saved.`,
          });
        }
      }

      const encrypted = encryptSecret(trimmedKey);
      masked = maskApiKey(trimmedKey);
      encryptedData = {
        encryptedKey: encrypted.ciphertext,
        iv: encrypted.iv,
        authTag: encrypted.authTag,
        keyMasked: masked,
        isConfigured: true,
      };
    }

    const willBeConfigured = encryptedData ? true : existing?.isConfigured;
    if (isActive === true && !willBeConfigured) {
      return res.status(400).json({ error: 'Cannot activate a provider without an API credential.' });
    }

    await prisma.$transaction(async (tx) => {
      if (isActive === true) {
        await tx.aIProviderConfig.updateMany({
          where: { provider: { not: provider } },
          data: { isActive: false },
        });
      }

      await tx.aIProviderConfig.upsert({
        where: { provider },
        update: {
          modelId: selectedModel,
          isActive: isActive !== undefined ? isActive : existing?.isActive,
          updatedBy: admin.email,
          ...(encryptedData || {}),
        },
        create: {
          provider,
          modelId: selectedModel,
          isActive: Boolean(isActive),
          isConfigured: Boolean(encryptedData),
          updatedBy: admin.email,
          ...(encryptedData || {}),
        },
      });

      await tx.adminAuditLog.create({
        data: {
          adminId: admin.id,
          adminEmail: admin.email,
          action: 'UPDATE_AI_CONFIG',
          resourceType: 'AI_CONFIG',
          resourceId: provider,
          details: JSON.stringify({
            provider,
            modelId: selectedModel,
            isActive,
            keyUpdated: Boolean(apiKey),
          }),
          outcome: 'SUCCESS',
        },
      });
    });

    return res.json({
      success: true,
      message: `${provider} configuration updated successfully.`,
    });
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : 'Save failed';
    return res.status(500).json({ error: errorMsg });
  }
});

// POST /api/admin/ai-config/test
router.post('/ai-config/test', async (req: Request, res: Response) => {
  try {
    const admin = req.auth!.user!;
    const { provider, modelId, apiKey } = req.body;

    if (provider !== 'OPENAI' && provider !== 'GEMINI') {
      return res.status(400).json({ error: 'Invalid provider' });
    }

    let effectiveApiKey = apiKey?.trim();
    const meta = AIProviderService.getProvider(provider).getProviderMetadata();
    const isValidCustomModel = typeof modelId === 'string' && /^[a-zA-Z0-9._:-]{2,80}$/.test(modelId.trim());
    const effectiveModel = meta.supportedModels.includes(modelId)
      ? modelId
      : (isValidCustomModel ? modelId.trim() : meta.defaultModel);

    if (!effectiveApiKey) {
      const existing = await prisma.aIProviderConfig.findUnique({
        where: { provider },
      });

      if (!existing || !existing.encryptedKey || !existing.iv || !existing.authTag) {
        return res.status(400).json({
          error: 'No API key provided and no stored credential found for this provider.',
        });
      }

      try {
        effectiveApiKey = decryptSecret({
          ciphertext: existing.encryptedKey,
          iv: existing.iv,
          authTag: existing.authTag,
        });
      } catch {
        return res.status(500).json({
          error: 'Failed to decrypt stored credential with current master key.',
        });
      }
    }

    const testResult = await AIProviderService.testConnection(
      provider,
      effectiveApiKey,
      effectiveModel
    );

    await prisma.adminAuditLog.create({
      data: {
        adminId: admin.id,
        adminEmail: admin.email,
        action: 'TEST_AI_CONFIG',
        resourceType: 'AI_CONFIG',
        resourceId: provider,
        details: JSON.stringify({
          provider,
          modelTested: testResult.modelTested,
          latencyMs: testResult.latencyMs,
        }),
        outcome: testResult.success ? 'SUCCESS' : 'FAILURE',
      },
    });

    return res.json(testResult);
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : 'Test failed';
    return res.status(500).json({ error: errorMsg });
  }
});

// DELETE /api/admin/ai-config/credential
router.delete('/ai-config/credential', async (req: Request, res: Response) => {
  try {
    const admin = req.auth!.user!;
    const provider = req.query.provider as 'OPENAI' | 'GEMINI' | undefined;

    if (provider !== 'OPENAI' && provider !== 'GEMINI') {
      return res.status(400).json({ error: 'Provider must be OPENAI or GEMINI.' });
    }

    await prisma.aIProviderConfig.update({
      where: { provider },
      data: {
        encryptedKey: null,
        iv: null,
        authTag: null,
        keyMasked: null,
        isConfigured: false,
        isActive: false,
        lastTestedAt: null,
        lastTestStatus: null,
        lastTestMessage: null,
      },
    });

    await prisma.adminAuditLog.create({
      data: {
        adminId: admin.id,
        adminEmail: admin.email,
        action: 'REMOVE_CREDENTIAL',
        resourceType: 'AI_CONFIG',
        resourceId: provider,
        details: JSON.stringify({ provider, credentialDeleted: true }),
        outcome: 'SUCCESS',
      },
    });

    return res.json({
      success: true,
      message: `API credential for ${provider} removed successfully.`,
    });
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : 'Removal failed';
    return res.status(500).json({ error: errorMsg });
  }
});

// GET /api/admin/scoring-config
router.get('/scoring-config', async (_req: Request, res: Response) => {
  try {
    const currentConfig = await prisma.scoringConfig.findFirst({
      where: { isCurrent: true },
      orderBy: { version: 'desc' },
    });

    return res.json({
      config: currentConfig
        ? {
            version: currentConfig.version,
            name: currentConfig.name,
            qualityWeights: JSON.parse(currentConfig.qualityWeights),
            jobMatchWeights: JSON.parse(currentConfig.jobMatchWeights),
            updatedAt: currentConfig.updatedAt,
          }
        : null,
    });
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : 'Failed to fetch scoring config';
    return res.status(500).json({ error: errorMsg });
  }
});

// PUT /api/admin/scoring-config
router.put('/scoring-config', async (req: Request, res: Response) => {
  try {
    const admin = req.auth!.user!;
    const { qualityWeights, jobMatchWeights, changeNotes } = req.body as {
      qualityWeights: QualityWeights;
      jobMatchWeights: JobMatchWeights;
      changeNotes?: string;
    };

    if (!validateWeights(qualityWeights as unknown as Record<string, number>)) {
      return res.status(400).json({ error: 'Resume Quality score weights must strictly sum to 100%.' });
    }

    if (!validateWeights(jobMatchWeights as unknown as Record<string, number>)) {
      return res.status(400).json({ error: 'Job Match score weights must strictly sum to 100%.' });
    }

    const latest = await prisma.scoringConfig.findFirst({
      orderBy: { version: 'desc' },
      select: { version: true },
    });
    const nextVersion = (latest?.version || 0) + 1;

    await prisma.$transaction([
      prisma.scoringConfig.updateMany({ data: { isCurrent: false } }),
      prisma.scoringConfig.create({
        data: {
          version: nextVersion,
          name: `Scoring Configuration v${nextVersion}`,
          qualityWeights: JSON.stringify(qualityWeights),
          jobMatchWeights: JSON.stringify(jobMatchWeights),
          isCurrent: true,
          changeNotes: changeNotes || 'Updated scoring dimension weights.',
          createdBy: admin.email,
        },
      }),
      prisma.adminAuditLog.create({
        data: {
          adminId: admin.id,
          adminEmail: admin.email,
          action: 'UPDATE_SCORING_CONFIG',
          resourceType: 'SCORING_CONFIG',
          resourceId: String(nextVersion),
          details: JSON.stringify({ version: nextVersion, qualityWeights, jobMatchWeights }),
        },
      }),
    ]);

    return res.json({
      success: true,
      message: `Scoring weights updated to version ${nextVersion}.`,
    });
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : 'Failed to update weights';
    return res.status(500).json({ error: errorMsg });
  }
});

// GET /api/admin/prompts
router.get('/prompts', async (_req: Request, res: Response) => {
  try {
    const versions = await prisma.promptTemplate.findMany({
      orderBy: { version: 'desc' },
    });
    return res.json({ versions });
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : 'Failed to fetch prompts';
    return res.status(500).json({ error: errorMsg });
  }
});

// POST /api/admin/prompts
router.post('/prompts', async (req: Request, res: Response) => {
  try {
    const admin = req.auth!.user!;
    const { action, version, name, systemPrompt, changeNotes } = req.body;

    if (action === 'ACTIVATE') {
      if (!version) {
        return res.status(400).json({ error: 'Version is required to activate.' });
      }

      await prisma.$transaction([
        prisma.promptTemplate.updateMany({ data: { isCurrent: false } }),
        prisma.promptTemplate.update({
          where: { version },
          data: { isCurrent: true },
        }),
        prisma.adminAuditLog.create({
          data: {
            adminId: admin.id,
            adminEmail: admin.email,
            action: 'ACTIVATE_PROMPT_VERSION',
            resourceType: 'PROMPT_TEMPLATE',
            resourceId: String(version),
            details: JSON.stringify({ activatedVersion: version }),
          },
        }),
      ]);

      return res.json({
        success: true,
        message: `Prompt version ${version} is now active.`,
      });
    }

    if (action === 'CREATE') {
      if (!name || !systemPrompt || systemPrompt.trim().length < 100) {
        return res.status(400).json({
          error: 'Prompt name and substantial system instructions (min 100 chars) are required.',
        });
      }

      const requiredSecurityPhrases = ['untrusted', 'schema', 'do not invent'];
      const lower = systemPrompt.toLowerCase();
      for (const phrase of requiredSecurityPhrases) {
        if (!lower.includes(phrase)) {
          return res.status(400).json({
            error: `System prompt must preserve required safety boundary: must contain "${phrase}".`,
          });
        }
      }

      const latest = await prisma.promptTemplate.findFirst({
        orderBy: { version: 'desc' },
        select: { version: true },
      });
      const nextVersion = (latest?.version || 0) + 1;

      const newPrompt = await prisma.promptTemplate.create({
        data: {
          version: nextVersion,
          name: name.trim(),
          systemPrompt: systemPrompt.trim(),
          schemaVersion: '1.0',
          isCurrent: false,
          changeNotes: changeNotes?.trim() || null,
          createdBy: admin.email,
        },
      });

      await prisma.adminAuditLog.create({
        data: {
          adminId: admin.id,
          adminEmail: admin.email,
          action: 'CREATE_PROMPT_VERSION',
          resourceType: 'PROMPT_TEMPLATE',
          resourceId: String(nextVersion),
          details: JSON.stringify({ version: nextVersion, name: newPrompt.name }),
        },
      });

      return res.json({
        success: true,
        prompt: newPrompt,
        message: `Prompt version ${nextVersion} saved successfully.`,
      });
    }

    return res.status(400).json({ error: 'Unsupported action.' });
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : 'Prompt action failed';
    return res.status(500).json({ error: errorMsg });
  }
});

// GET /api/admin/system-health
router.get('/system-health', async (_req: Request, res: Response) => {
  try {
    const startTime = Date.now();
    let dbOk = false;
    try {
      await prisma.$queryRaw`SELECT 1`;
      dbOk = true;
    } catch {
      dbOk = false;
    }
    const dbLatencyMs = Date.now() - startTime;

    const [totalAnalyses, guestAnalyses, registeredUsers, activeProvider, recent24hLogs] =
      await Promise.all([
        prisma.resumeAnalysis.count(),
        prisma.resumeAnalysis.count({ where: { isGuest: true } }),
        prisma.user.count({ where: { role: 'USER' } }),
        prisma.aIProviderConfig.findFirst({
          where: { isActive: true },
          select: { provider: true, modelId: true, isConfigured: true },
        }),
        prisma.aIUsageLog.findMany({
          where: { createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
          select: { status: true, durationMs: true },
        }),
      ]);

    const total24h = recent24hLogs.length;
    const failed24h = recent24hLogs.filter((l) => l.status === 'FAILED').length;
    const errorRate24h = total24h > 0 ? ((failed24h / total24h) * 100).toFixed(1) + '%' : '0.0%';
    const avgDuration24h =
      total24h > 0
        ? Math.round(recent24hLogs.reduce((sum, l) => sum + l.durationMs, 0) / total24h)
        : 0;

    return res.json({
      status: dbOk && activeProvider?.isConfigured ? 'HEALTHY' : 'DEGRADED',
      database: { connected: dbOk, latencyMs: dbLatencyMs },
      activeProvider: activeProvider
        ? {
            provider: activeProvider.provider,
            model: activeProvider.modelId,
            configured: activeProvider.isConfigured,
          }
        : null,
      metrics: {
        totalAnalyses,
        guestAnalyses,
        registeredUsers,
        totalRequestsLast24h: total24h,
        failedRequestsLast24h: failed24h,
        errorRateLast24h: errorRate24h,
        avgDurationMsLast24h: avgDuration24h,
      },
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: new Date(),
    });
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : 'Health check failed';
    return res.status(500).json({ error: errorMsg });
  }
});

// GET /api/admin/ai-usage (with Server-Side Pagination)
router.get('/ai-usage', async (req: Request, res: Response) => {
  try {
    const page = Math.max(1, parseInt((req.query.page as string) || '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt((req.query.limit as string) || '50', 10)));
    const skip = (page - 1) * limit;

    const [totalCount, logs] = await Promise.all([
      prisma.aIUsageLog.count(),
      prisma.aIUsageLog.findMany({
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        select: {
          id: true,
          provider: true,
          model: true,
          durationMs: true,
          status: true,
          inputTokens: true,
          outputTokens: true,
          totalTokens: true,
          estimatedCostUsd: true,
          errorMessage: true,
          isGuest: true,
          createdAt: true,
        },
      }),
    ]);

    const totalPages = Math.max(1, Math.ceil(totalCount / limit));

    return res.json({
      logs,
      pagination: {
        page,
        limit,
        totalCount,
        totalPages,
        hasMore: page < totalPages,
      },
    });
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : 'Failed to fetch usage logs';
    return res.status(500).json({ error: errorMsg });
  }
});

// GET /api/admin/audit-logs (with Server-Side Pagination)
router.get('/audit-logs', async (req: Request, res: Response) => {
  try {
    const page = Math.max(1, parseInt((req.query.page as string) || '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt((req.query.limit as string) || '50', 10)));
    const skip = (page - 1) * limit;

    const [totalCount, logs] = await Promise.all([
      prisma.adminAuditLog.count(),
      prisma.adminAuditLog.findMany({
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        select: {
          id: true,
          adminEmail: true,
          action: true,
          resourceType: true,
          resourceId: true,
          details: true,
          outcome: true,
          createdAt: true,
        },
      }),
    ]);

    const totalPages = Math.max(1, Math.ceil(totalCount / limit));

    return res.json({
      logs,
      pagination: {
        page,
        limit,
        totalCount,
        totalPages,
        hasMore: page < totalPages,
      },
    });
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : 'Failed to fetch audit logs';
    return res.status(500).json({ error: errorMsg });
  }
});

export default router;
