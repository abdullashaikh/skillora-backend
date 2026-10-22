import crypto from 'crypto';
import { safeFetchUrl } from './url-validator.js';
import { ContentParserService } from './content-parser-service.js';
import { LicenseSnapshot, RawExtractedQuestion } from './types.js';

export interface GitHubTargetInfo {
  isSingleFile: boolean;
  owner: string;
  repo: string;
  branch: string;
  path: string;
  rawUrl: string;
}

export interface GitHubCollectedDocument {
  documentUrl: string;
  sourcePath: string;
  sourceRevision: string;
  contentHash: string;
  rawContent: string;
  license: LicenseSnapshot;
  questions: RawExtractedQuestion[];
  errors: string[];
}

export interface GitHubInspectionResult {
  isValid: boolean;
  isSingleFile: boolean;
  owner: string;
  repo: string;
  branch: string;
  path?: string;
  license: LicenseSnapshot;
  fileCount: number;
  sampleFiles: string[];
  error?: string;
}

export class GitHubSourceAdapter {
  /**
   * Parses and validates a GitHub repository or file URL.
   */
  public static parseGitHubUrl(inputUrl: string): GitHubTargetInfo {
    const trimmed = inputUrl.trim();
    let urlObj: URL;
    try {
      urlObj = new URL(trimmed);
    } catch {
      throw new Error(`Invalid GitHub URL: "${inputUrl}"`);
    }

    if (!['github.com', 'raw.githubusercontent.com'].includes(urlObj.hostname.toLowerCase())) {
      throw new Error(`URL is not a recognized GitHub host: "${urlObj.hostname}"`);
    }

    const segments = urlObj.pathname.split('/').filter(Boolean);
    if (segments.length < 2) {
      throw new Error('GitHub URL must include at least an owner and repository name.');
    }

    const owner = segments[0];
    const repo = segments[1].replace(/\.git$/i, '');

    // Raw URL format: raw.githubusercontent.com/{owner}/{repo}/{branch}/{path...}
    if (urlObj.hostname.toLowerCase() === 'raw.githubusercontent.com') {
      const branch = segments[2] || 'main';
      const path = segments.slice(3).join('/');
      return {
        isSingleFile: true,
        owner,
        repo,
        branch,
        path,
        rawUrl: trimmed,
      };
    }

    // github.com/{owner}/{repo}/blob/{branch}/{path...}
    if (segments[2] === 'blob') {
      const branch = segments[3] || 'main';
      const path = segments.slice(4).join('/');
      const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}`;
      return {
        isSingleFile: true,
        owner,
        repo,
        branch,
        path,
        rawUrl,
      };
    }

    // github.com/{owner}/{repo}/tree/{branch}/{path...}
    if (segments[2] === 'tree') {
      const branch = segments[3] || 'main';
      const path = segments.slice(4).join('/');
      return {
        isSingleFile: false,
        owner,
        repo,
        branch,
        path,
        rawUrl: trimmed,
      };
    }

    // Default repository root: github.com/{owner}/{repo}
    return {
      isSingleFile: false,
      owner,
      repo,
      branch: 'main', // Default branch fallback
      path: '',
      rawUrl: trimmed,
    };
  }

  /**
   * Helper headers for GitHub API / raw content requests, using optional server token.
   */
  private static getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'User-Agent': 'SkilledResume-QABot/2.0',
      Accept: 'application/vnd.github.v3+json, text/plain, */*',
    };

    const token = process.env.GITHUB_TOKEN;
    if (token && token.trim().length > 10) {
      headers['Authorization'] = `token ${token.trim()}`;
    }

    return headers;
  }

  /**
   * Resolves repository default branch (e.g. master vs main) via GitHub API.
   */
  private static async resolveDefaultBranch(owner: string, repo: string): Promise<string> {
    try {
      const repoApiUrl = `https://api.github.com/repos/${owner}/${repo}`;
      const res = await safeFetchUrl(repoApiUrl, {
        customHeaders: this.getHeaders(),
        timeoutMs: 8000,
      });
      if (res.status === 200) {
        const json = JSON.parse(res.text);
        if (json.default_branch) return json.default_branch;
      }
    } catch {
      // Fallback if rate limited
    }
    return 'main';
  }

  /**
   * Inspects repository license using GitHub license API or checks common license files.
   */
  public static async fetchLicense(owner: string, repo: string, branch = 'main'): Promise<LicenseSnapshot> {
    const apiUrl = `https://api.github.com/repos/${owner}/${repo}/license`;
    const defaultAttribution = `Source: https://github.com/${owner}/${repo}`;

    try {
      const response = await safeFetchUrl(apiUrl, {
        customHeaders: this.getHeaders(),
        timeoutMs: 8000,
      });

      if (response.status === 200) {
        const json = JSON.parse(response.text);
        const spdxId = json.license?.spdx_id || json.license?.key?.toUpperCase() || 'UNKNOWN';
        const isRedistributable = ['MIT', 'APACHE-2.0', 'BSD-2-CLAUSE', 'BSD-3-CLAUSE', 'CC-BY-4.0', 'CC0-1.0', 'ISC', 'UNLICENSE'].includes(spdxId);

        return {
          licenseId: spdxId,
          licenseName: json.license?.name || spdxId,
          licenseUrl: json.html_url || `https://github.com/${owner}/${repo}`,
          attributionText: defaultAttribution,
          originalSourceUrl: `https://github.com/${owner}/${repo}`,
          retrievedAt: new Date().toISOString(),
          isRedistributable,
        };
      }
    } catch {
      // API call failed or rate-limited; fallback to checking raw LICENSE file
      try {
        const rawLicenseUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/LICENSE`;
        const rawRes = await safeFetchUrl(rawLicenseUrl, { timeoutMs: 5000 });
        if (rawRes.status === 200) {
          const txt = rawRes.text.toUpperCase();
          let detectedSpdx = 'UNKNOWN';
          if (txt.includes('MIT LICENSE') || txt.includes('PERMISSION IS HEREBY GRANTED')) detectedSpdx = 'MIT';
          else if (txt.includes('APACHE LICENSE')) detectedSpdx = 'APACHE-2.0';
          else if (txt.includes('BERKELEY SOFTWARE DISTRIBUTION') || txt.includes('BSD')) detectedSpdx = 'BSD-3-CLAUSE';
          else if (txt.includes('CREATIVE COMMONS')) detectedSpdx = 'CC-BY-4.0';

          if (detectedSpdx !== 'UNKNOWN') {
            return {
              licenseId: detectedSpdx,
              licenseName: `${detectedSpdx} License`,
              licenseUrl: `https://github.com/${owner}/${repo}/blob/${branch}/LICENSE`,
              attributionText: defaultAttribution,
              originalSourceUrl: `https://github.com/${owner}/${repo}`,
              retrievedAt: new Date().toISOString(),
              isRedistributable: true,
            };
          }
        }
      } catch {}
    }

    return {
      licenseId: 'UNVERIFIED',
      licenseName: 'Unverified GitHub License',
      attributionText: defaultAttribution,
      originalSourceUrl: `https://github.com/${owner}/${repo}`,
      retrievedAt: new Date().toISOString(),
      isRedistributable: false,
      notes: 'License not explicitly detected via GitHub API or LICENSE file. Review required before publication.',
    };
  }

  /**
   * Pre-flight inspection of a GitHub target to detect owner, repo, branch, license, and question file count.
   */
  public static async inspectTarget(url: string): Promise<GitHubInspectionResult> {
    const target = this.parseGitHubUrl(url);
    const activeBranch = target.branch !== 'main' || url.includes('/tree/') || url.includes('/blob/')
      ? target.branch
      : await this.resolveDefaultBranch(target.owner, target.repo);

    const license = await this.fetchLicense(target.owner, target.repo, activeBranch);

    if (target.isSingleFile) {
      return {
        isValid: true,
        isSingleFile: true,
        owner: target.owner,
        repo: target.repo,
        branch: target.branch,
        path: target.path,
        license,
        fileCount: 1,
        sampleFiles: [target.path],
      };
    }

    // Repository: count supported files via trees API
    let fileCount = 0;
    let sampleFiles: string[] = [];

    const branchesToTry = [activeBranch, activeBranch === 'main' ? 'master' : 'main'];
    for (const b of branchesToTry) {
      if (fileCount > 0) break;
      const treeApiUrl = `https://api.github.com/repos/${target.owner}/${target.repo}/git/trees/${b}?recursive=1`;
      try {
        const treeRes = await safeFetchUrl(treeApiUrl, {
          customHeaders: this.getHeaders(),
          timeoutMs: 8000,
        });
        if (treeRes.status === 200) {
          const json = JSON.parse(treeRes.text);
          if (Array.isArray(json.tree)) {
            const supportedExtensions = ['.md', '.markdown', '.mdx', '.json', '.csv'];
            const ignoredPatterns = ['node_modules', '.github', '.git', 'license', 'contributing', 'code_of_conduct', 'security.md'];
            const filtered = json.tree.filter((node: any) => {
              if (node.type !== 'blob') return false;
              if (node.size && node.size > 2 * 1024 * 1024) return false; // skip files > 2MB
              const p = node.path.toLowerCase();
              if (ignoredPatterns.some((pat) => p.includes(pat))) return false;
              return supportedExtensions.some((ext) => p.endsWith(ext));
            });
            fileCount = filtered.length;
            sampleFiles = filtered.slice(0, 5).map((n: any) => n.path);
          }
        }
      } catch {
        // try fallback branch
      }
    }

    if (fileCount === 0) {
      fileCount = 1;
      sampleFiles = ['README.md'];
    }

    return {
      isValid: true,
      isSingleFile: false,
      owner: target.owner,
      repo: target.repo,
      branch: activeBranch,
      license,
      fileCount,
      sampleFiles,
    };
  }

  /**
   * Collects content from a GitHub single file or repository tree.
   */
  public static async collect(
    url: string,
    options: {
      maxFiles?: number;
      topicRestrictions?: string[];
      knownRevision?: string;
    } = {}
  ): Promise<GitHubCollectedDocument[]> {
    const target = this.parseGitHubUrl(url);
    const maxFiles = options.maxFiles || 15;
    const license = await this.fetchLicense(target.owner, target.repo);

    const collected: GitHubCollectedDocument[] = [];

    // Case 1: Single file URL
    if (target.isSingleFile) {
      const fetchResult = await safeFetchUrl(target.rawUrl, {
        customHeaders: this.getHeaders(),
      });

      const content = fetchResult.text;
      const contentHash = crypto.createHash('sha256').update(content, 'utf8').digest('hex');

      // Skip if unchanged
      if (options.knownRevision && options.knownRevision === contentHash) {
        return [];
      }

      const parseResult = ContentParserService.parse(content, {
        filename: target.path,
        sourceUrl: target.rawUrl,
      });

      collected.push({
        documentUrl: target.rawUrl,
        sourcePath: target.path,
        sourceRevision: contentHash,
        contentHash,
        rawContent: content,
        license,
        questions: parseResult.questions,
        errors: parseResult.errors,
      });

      return collected;
    }

    // Case 2: Repository or Directory
    // Resolve default branch if not specified in URL
    let activeBranch = target.branch;
    if (!url.includes('/tree/') && !url.includes('/blob/')) {
      activeBranch = await this.resolveDefaultBranch(target.owner, target.repo);
    }

    let fileEntries: Array<{ path: string; url: string; sha: string; size?: number }> = [];

    // Attempt to discover files via GitHub Trees API
    const branchesToTry = [activeBranch, activeBranch === 'main' ? 'master' : 'main'];
    let treeSuccess = false;

    for (const b of branchesToTry) {
      if (treeSuccess) break;
      const treeApiUrl = `https://api.github.com/repos/${target.owner}/${target.repo}/git/trees/${b}?recursive=1`;

      try {
        const treeRes = await safeFetchUrl(treeApiUrl, {
          customHeaders: this.getHeaders(),
          timeoutMs: 10000,
        });

        if (treeRes.status === 200) {
          const json = JSON.parse(treeRes.text);
          if (Array.isArray(json.tree)) {
            activeBranch = b;
            treeSuccess = true;
            const supportedExtensions = ['.md', '.markdown', '.mdx', '.json', '.csv', '.txt'];
            const ignoredPatterns = ['node_modules', '.github', '.git', 'license', 'contributing', 'code_of_conduct', 'security.md'];

            fileEntries = json.tree
              .filter((node: any) => {
                if (node.type !== 'blob') return false;
                if (node.size && node.size > 2 * 1024 * 1024) return false; // skip files > 2MB
                const p = node.path.toLowerCase();
                if (ignoredPatterns.some((pat) => p.includes(pat))) return false;
                return supportedExtensions.some((ext) => p.endsWith(ext));
              })
              .map((node: any) => ({
                path: node.path,
                url: `https://raw.githubusercontent.com/${target.owner}/${target.repo}/${b}/${node.path}`,
                sha: node.sha,
                size: node.size,
              }));

            // Prioritize root README.md and files containing interview, questions, faq, quiz, or core tech names
            fileEntries.sort((a, bEntry) => {
              const pA = a.path.toLowerCase();
              const pB = bEntry.path.toLowerCase();
              const score = (p: string) => {
                if (p === 'readme.md') return 100;
                if (p.includes('i18n/')) return 1;
                if (p.includes('blog/')) return 15;
                if (p.includes('companies/')) return 40;
                if (p.includes('interview') || p.includes('question') || p.includes('quiz') || p.includes('faq')) return 90;
                if (p.endsWith('readme.md')) return 50;
                return 20;
              };
              return score(pB) - score(pA);
            });
          }
        }
      } catch {
        // Try next branch or fallback
      }
    }

    if (!treeSuccess || fileEntries.length === 0) {
      // If Trees API fails (e.g. rate limit), try common question paths across branches
      for (const b of branchesToTry) {
        const commonPaths = ['README.md', 'questions.md', 'interview-questions.md', 'data.json'];
        for (const p of commonPaths) {
          fileEntries.push({
            path: p,
            url: `https://raw.githubusercontent.com/${target.owner}/${target.repo}/${b}/${p}`,
            sha: 'fallback',
          });
        }
      }
    }

    // Filter by permitted path prefix if configured
    if (target.path) {
      fileEntries = fileEntries.filter((f) => f.path.startsWith(target.path));
    }

    // Limit maximum files to prevent runaway ingestion
    const limitedEntries = fileEntries.slice(0, maxFiles);

    for (const entry of limitedEntries) {
      try {
        const fileRes = await safeFetchUrl(entry.url, {
          customHeaders: this.getHeaders(),
          timeoutMs: 8000,
        });

        const content = fileRes.text;
        const contentHash = crypto.createHash('sha256').update(content, 'utf8').digest('hex');

        // Check if revision matches known revision
        if (options.knownRevision && (options.knownRevision === entry.sha || options.knownRevision === contentHash)) {
          continue;
        }

        const parseResult = ContentParserService.parse(content, {
          filename: entry.path,
          sourceUrl: entry.url,
        });

        if (parseResult.questions.length > 0) {
          collected.push({
            documentUrl: entry.url,
            sourcePath: entry.path,
            sourceRevision: entry.sha || contentHash,
            contentHash,
            rawContent: content,
            license,
            questions: parseResult.questions,
            errors: parseResult.errors,
          });
        }
      } catch (err: unknown) {
        // Individual file fetch failed; skip or record error
      }
    }

    return collected;
  }
}
