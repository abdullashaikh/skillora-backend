import { prisma } from '../db.js';
import { ContentSyncService } from './content-sync-service.js';
import { TechnologyService } from './technology-service.js';
import { SourceStatus } from './types.js';

export class ContentScheduler {
  private static isRunning = false;

  /**
   * Scans all active sources where synchronization is due (nextSyncAt <= now)
   * and runs incremental sync jobs sequentially.
   */
  public static async runMonthlySync(): Promise<{
    processedSources: number;
    results: Array<{ sourceId: string; sourceName: string; status: string; error?: string }>;
  }> {
    if (this.isRunning) {
      throw new Error('Monthly sync is already in progress.');
    }

    this.isRunning = true;
    const now = new Date();

    try {
      const dueSources = await prisma.contentSource.findMany({
        where: {
          isActive: true,
          status: { notIn: [SourceStatus.COLLECTING, SourceStatus.PARSING, SourceStatus.DISABLED] },
          OR: [
            { nextSyncAt: { lte: now } },
            { nextSyncAt: null },
          ],
        },
        take: 10, // Controlled batch size
      });

      const results: Array<{ sourceId: string; sourceName: string; status: string; error?: string }> = [];

      for (const source of dueSources) {
        try {
          await ContentSyncService.syncSource(source.id, 'SCHEDULED_SYNC');
          results.push({
            sourceId: source.id,
            sourceName: source.name,
            status: 'SUCCESS',
          });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : 'Sync failed';
          results.push({
            sourceId: source.id,
            sourceName: source.name,
            status: 'FAILED',
            error: msg,
          });
        }
      }

      return {
        processedSources: dueSources.length,
        results,
      };
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Workflow triggered when a new technology is added:
   * 1. Register canonical name & aliases
   * 2. Check existing content sources for relevant technology coverage
   * 3. Queue collection job if active source exists
   * 4. Otherwise create a ContentCoverageTask for admin
   */
  public static async onNewTechnologyAdded(params: {
    canonicalName: string;
    category: string;
    aliases?: string[];
  }) {
    const tech = await TechnologyService.registerTechnology(
      params.canonicalName,
      params.category,
      params.aliases || []
    );

    // Check if any active sources are mapped to this technology
    const sourcesWithTech = await prisma.contentSourceTechnology.findMany({
      where: {
        skillId: tech.id,
        source: { isActive: true },
      },
      include: { source: true },
    });

    if (sourcesWithTech.length > 0) {
      // Trigger collection job for first ready source
      const readySource = sourcesWithTech.find((s) => s.source.status === SourceStatus.READY);
      if (readySource) {
        ContentSyncService.syncSource(readySource.sourceId, 'NEW_SKILL_COLLECTION').catch(() => {});
      }
      return {
        tech,
        hasSource: true,
        sourceCount: sourcesWithTech.length,
        message: `Registered technology "${tech.canonicalName}". Existing active source found; initiated collection.`,
      };
    }

    // No source configured -> Ensure ContentCoverageTask exists
    await TechnologyService.checkAndCreateCoverageTask(tech.id);

    return {
      tech,
      hasSource: false,
      sourceCount: 0,
      message: `Registered technology "${tech.canonicalName}". No active sources found. A coverage task has been created in the admin dashboard.`,
    };
  }
}
