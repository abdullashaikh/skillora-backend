import { prisma } from '../db.js';
import { decryptSecret } from '../security/crypto.js';
import { OpenAIResumeProvider } from './openai-provider.js';
import { GeminiResumeProvider } from './gemini-provider.js';
import {
  ResumeAIProvider,
  ExtractionResult,
  ConnectionTestResult,
} from './types.js';

export class AIProviderService {
  private static openAIProvider = new OpenAIResumeProvider();
  private static geminiProvider = new GeminiResumeProvider();

  static getProvider(provider: 'OPENAI' | 'GEMINI'): ResumeAIProvider {
    if (provider === 'OPENAI') return this.openAIProvider;
    if (provider === 'GEMINI') return this.geminiProvider;
    throw new Error(`Unsupported AI provider: ${provider}`);
  }

  /**
   * Calculates an approximate usage cost based on published model token pricing.
   */
  private static calculateEstimatedCost(
    provider: string,
    model: string,
    inputTokens?: number,
    outputTokens?: number
  ): number | undefined {
    if (!inputTokens && !outputTokens) return undefined;
    const inp = inputTokens || 0;
    const out = outputTokens || 0;

    let costPerMillionIn = 0.15;
    let costPerMillionOut = 0.60;

    if (provider === 'GEMINI') {
      if (model.includes('flash')) {
        costPerMillionIn = 0.075;
        costPerMillionOut = 0.30;
      } else {
        costPerMillionIn = 1.25;
        costPerMillionOut = 5.00;
      }
    } else if (provider === 'OPENAI') {
      if (model.includes('nano')) {
        costPerMillionIn = 0.05;
        costPerMillionOut = 0.20;
      } else if (model.includes('mini')) {
        costPerMillionIn = 0.15;
        costPerMillionOut = 0.60;
      } else {
        costPerMillionIn = 2.50;
        costPerMillionOut = 10.00;
      }
    }

    const total = (inp / 1_000_000) * costPerMillionIn + (out / 1_000_000) * costPerMillionOut;
    return parseFloat(total.toFixed(6));
  }

  /**
   * Retrieves active provider and safely decrypts its credentials immediately before use.
   */
  static async getActiveProviderWithSecret(): Promise<{
    provider: 'OPENAI' | 'GEMINI';
    modelId: string;
    apiKey: string;
  }> {
    const config = await prisma.aIProviderConfig.findFirst({
      where: { isActive: true },
    });

    if (!config || !config.isConfigured || !config.encryptedKey || !config.iv || !config.authTag) {
      throw new Error(
        'No AI provider is currently configured or active. Please configure OpenAI or Google Gemini in the Admin Panel.'
      );
    }

    const apiKey = decryptSecret({
      ciphertext: config.encryptedKey,
      iv: config.iv,
      authTag: config.authTag,
    });

    return {
      provider: config.provider as 'OPENAI' | 'GEMINI',
      modelId: config.modelId,
      apiKey,
    };
  }

  /**
   * Executes resume extraction through the configured active AI provider.
   */
  static async extract(params: {
    sanitizedResumeText: string;
    targetJobDescription?: string;
    userId?: string;
    guestSessionId?: string;
    isGuest: boolean;
    analysisId?: string;
  }): Promise<{
    extraction: ExtractionResult;
    provider: string;
    model: string;
    promptVersion: number;
  }> {
    const active = await this.getActiveProviderWithSecret();
    const providerInstance = this.getProvider(active.provider);

    // Retrieve active prompt template
    const promptTemplate = await prisma.promptTemplate.findFirst({
      where: { isCurrent: true },
      orderBy: { version: 'desc' },
    });

    const systemPrompt = promptTemplate?.systemPrompt || 'Extract factual resume details into JSON.';
    const promptVersion = promptTemplate?.version || 1;

    // Retrieve active canonical skill names for prompt assistance
    const canonicalSkills = await prisma.skill.findMany({
      where: { isActive: true },
      select: { canonicalName: true },
      take: 80,
    });
    const knownSkillsList = canonicalSkills.map((s) => s.canonicalName);

    const startTime = Date.now();
    try {
      const extraction = await providerInstance.extractResumeData(
        {
          sanitizedResumeText: params.sanitizedResumeText,
          targetJobDescription: params.targetJobDescription,
          systemPrompt,
          knownSkillsList,
        },
        {
          apiKey: active.apiKey,
          modelId: active.modelId,
        }
      );

      const estimatedCost = this.calculateEstimatedCost(
        active.provider,
        active.modelId,
        extraction.tokenUsage?.inputTokens,
        extraction.tokenUsage?.outputTokens
      );

      // Record operational usage log (never store raw resume or prompt)
      await prisma.aIUsageLog.create({
        data: {
          provider: active.provider,
          model: active.modelId,
          analysisId: params.analysisId,
          userId: params.userId,
          isGuest: params.isGuest,
          durationMs: extraction.durationMs,
          status: 'SUCCESS',
          providerRequestId: extraction.providerRequestId,
          inputTokens: extraction.tokenUsage?.inputTokens,
          outputTokens: extraction.tokenUsage?.outputTokens,
          totalTokens: extraction.tokenUsage?.totalTokens,
          estimatedCostUsd: estimatedCost,
        },
      });

      return {
        extraction,
        provider: active.provider,
        model: active.modelId,
        promptVersion,
      };
    } catch (err: unknown) {
      const durationMs = Date.now() - startTime;
      const sanitizedError = err instanceof Error ? err.message.replace(/([a-zA-Z0-9_-]{20,})/g, '[REDACTED]') : 'Provider error';

      // Record failure in operational log
      await prisma.aIUsageLog.create({
        data: {
          provider: active.provider,
          model: active.modelId,
          analysisId: params.analysisId,
          userId: params.userId,
          isGuest: params.isGuest,
          durationMs,
          status: 'FAILED',
          errorMessage: sanitizedError,
        },
      });

      throw new Error(`AI extraction failed: ${sanitizedError}`);
    }
  }

  /**
   * Tests an AI provider connection safely using non-sensitive test prompt.
   */
  static async testConnection(
    provider: 'OPENAI' | 'GEMINI',
    apiKey: string,
    modelId: string
  ): Promise<ConnectionTestResult> {
    const providerInstance = this.getProvider(provider);
    const result = await providerInstance.validateConnection({ apiKey, modelId });

    // Update test status in database
    await prisma.aIProviderConfig.updateMany({
      where: { provider },
      data: {
        lastTestedAt: result.testedAt,
        lastTestStatus: result.success ? 'SUCCESS' : 'FAILED',
        lastTestMessage: result.message,
      },
    });

    return result;
  }
}
