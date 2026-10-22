import crypto from 'crypto';
import * as cheerio from 'cheerio';
import { safeFetchUrl } from './url-validator.js';
import { parseHTMLQA } from './parsers/html-parser.js';
import { LicenseSnapshot, RawExtractedQuestion, WebsiteParserConfig } from './types.js';

export interface WebsiteCollectedPage {
  pageUrl: string;
  sourceRevision: string;
  contentHash: string;
  rawContent: string;
  license: LicenseSnapshot;
  questions: RawExtractedQuestion[];
  errors: string[];
}

export class WebsiteSourceAdapter {
  /**
   * Fetches and parses a single or paginated series of web pages within configured limits.
   */
  public static async collect(
    startUrl: string,
    config: WebsiteParserConfig = {},
    customLicense?: Partial<LicenseSnapshot>
  ): Promise<WebsiteCollectedPage[]> {
    const maxPages = Math.min(config.maxPages || 5, 20);
    const visitedUrls = new Set<string>();
    const pagesToVisit: string[] = [startUrl];
    const results: WebsiteCollectedPage[] = [];

    const defaultLicense: LicenseSnapshot = {
      licenseId: customLicense?.licenseId || 'UNVERIFIED',
      licenseName: customLicense?.licenseName || 'Public Web Source',
      licenseUrl: customLicense?.licenseUrl || startUrl,
      attributionText: customLicense?.attributionText || `Source: ${startUrl}`,
      originalSourceUrl: startUrl,
      retrievedAt: new Date().toISOString(),
      isRedistributable: customLicense?.isRedistributable ?? false,
      notes: customLicense?.notes,
    };

    const startUrlObj = new URL(startUrl);
    const allowedHostname = startUrlObj.hostname.toLowerCase();

    while (pagesToVisit.length > 0 && results.length < maxPages) {
      const currentUrl = pagesToVisit.shift()!;
      if (visitedUrls.has(currentUrl)) continue;
      visitedUrls.add(currentUrl);

      // Verify domain stays within same host to prevent crawling unrelated domains
      try {
        const currentUrlObj = new URL(currentUrl);
        if (currentUrlObj.hostname.toLowerCase() !== allowedHostname) {
          continue;
        }
      } catch {
        continue;
      }

      try {
        const fetchResult = await safeFetchUrl(currentUrl, {
          timeoutMs: 10000,
          maxSizeBytes: 2 * 1024 * 1024,
        });

        const rawContent = fetchResult.text;
        const contentHash = crypto.createHash('sha256').update(rawContent, 'utf8').digest('hex');

        // Extract questions
        const questions = parseHTMLQA(rawContent, config, 'General', currentUrl);

        results.push({
          pageUrl: currentUrl,
          sourceRevision: contentHash,
          contentHash,
          rawContent,
          license: {
            ...defaultLicense,
            originalSourceUrl: currentUrl,
          },
          questions,
          errors: questions.length === 0 ? ['No recognizable question and answer patterns found on page.'] : [],
        });

        // Find pagination link if paginationSelector is configured and we haven't reached maxPages
        if (config.paginationSelector && results.length < maxPages) {
          const $ = cheerio.load(rawContent);
          const nextLinkEl = $(config.paginationSelector).first();
          let nextHref = nextLinkEl.attr('href');

          if (nextHref) {
            // Resolve relative link
            const resolvedNext = new URL(nextHref, currentUrl).toString();
            if (!visitedUrls.has(resolvedNext)) {
              pagesToVisit.push(resolvedNext);
            }
          }
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Fetch failed';
        results.push({
          pageUrl: currentUrl,
          sourceRevision: '',
          contentHash: '',
          rawContent: '',
          license: defaultLicense,
          questions: [],
          errors: [`Failed to fetch website: ${msg}`],
        });
      }
    }

    return results;
  }
}
