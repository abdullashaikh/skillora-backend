import { z } from 'zod';

function resolveSkillName(obj: Record<string, unknown>): string {
  const candidates = [
    obj.name,
    obj.skill,
    obj.skillName,
    obj.skill_name,
    obj.title,
    obj.technology,
    obj.tech,
    obj.keyword,
    obj.item,
    obj.label,
    obj.value,
  ];

  for (const cand of candidates) {
    if (typeof cand === 'string' && cand.trim().length > 0) {
      return cand.trim();
    }
    if (typeof cand === 'number') {
      return String(cand).trim();
    }
  }

  // Fallback to evidence if short and no name is found
  if (typeof obj.evidence === 'string' && obj.evidence.trim().length > 0 && obj.evidence.trim().length <= 60) {
    return obj.evidence.trim();
  }
  if (Array.isArray(obj.evidence) && obj.evidence.length > 0) {
    const first = obj.evidence[0];
    if (typeof first === 'string' && first.trim().length > 0 && first.trim().length <= 60) {
      return first.trim();
    }
  }

  return '';
}

function resolveEvidence(obj: Record<string, unknown>, fallbackName: string): string | null {
  if (obj.evidence !== null && obj.evidence !== undefined) {
    if (Array.isArray(obj.evidence)) {
      const joined = obj.evidence
        .map((x) => (typeof x === 'string' ? x.trim() : typeof x === 'object' ? JSON.stringify(x) : String(x)))
        .filter(Boolean)
        .join('; ');
      return joined.trim() || null;
    }
    if (typeof obj.evidence === 'string') {
      return obj.evidence.trim() || null;
    }
    return String(obj.evidence).trim() || null;
  }
  return fallbackName || null;
}

function resolveSourceSection(obj: Record<string, unknown>): 'skills' | 'experience' | 'projects' | 'education' | 'other' {
  const raw =
    (typeof obj.sourceSection === 'string' && obj.sourceSection) ||
    (typeof obj.section === 'string' && obj.section) ||
    (typeof obj.source === 'string' && obj.source) ||
    '';

  if (raw) {
    const lower = raw.toLowerCase().trim();
    if (lower.includes('skill')) return 'skills';
    if (lower.includes('exp') || lower.includes('work') || lower.includes('job') || lower.includes('employ')) return 'experience';
    if (lower.includes('project')) return 'projects';
    if (lower.includes('edu') || lower.includes('academic') || lower.includes('degree') || lower.includes('school')) return 'education';
    return 'other';
  }
  return 'skills';
}

function resolveConfidence(obj: Record<string, unknown>): number {
  const raw = obj.confidence ?? obj.score;
  if (typeof raw === 'number') {
    return raw;
  }
  if (typeof raw === 'string') {
    const num = parseFloat(raw);
    return isNaN(num) ? 1.0 : num;
  }
  return 1.0;
}

function normalizeRawSkills(val: unknown): unknown[] {
  const results: unknown[] = [];

  const addItem = (item: unknown) => {
    if (!item) return;

    if (typeof item === 'string') {
      const trimmed = item.trim();
      if (trimmed.length > 0) {
        results.push({
          name: trimmed,
          evidence: trimmed,
          sourceSection: 'skills',
          confidence: 0.9,
        });
      }
      return;
    }

    if (typeof item === 'object') {
      const obj = item as Record<string, unknown>;

      // Check if this object is a category container (e.g. { category: "Frontend", skills: ["React", "Vue"] })
      const nested = obj.skills || obj.items || obj.list || obj.technologies;
      if (Array.isArray(nested)) {
        nested.forEach(addItem);
        return;
      }

      const name = resolveSkillName(obj);
      // Only include if a non-empty name could be resolved!
      // This filters out empty/invalid candidate objects so they never crash the entire analysis
      if (name.length > 0) {
        results.push({
          name,
          evidence: resolveEvidence(obj, name),
          sourceSection: resolveSourceSection(obj),
          confidence: resolveConfidence(obj),
        });
      }
    }
  };

  if (Array.isArray(val)) {
    val.forEach(addItem);
  } else if (val && typeof val === 'object') {
    for (const key of Object.keys(val)) {
      const sub = (val as Record<string, unknown>)[key];
      if (Array.isArray(sub)) {
        sub.forEach(addItem);
      } else {
        addItem(sub);
      }
    }
  }

  return results;
}

export const ExtractedSkillSchema = z.preprocess((raw) => {
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    return {
      name: trimmed,
      evidence: trimmed,
      sourceSection: 'skills',
      confidence: 0.9,
    };
  }
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    const name = resolveSkillName(obj);
    const evidence = resolveEvidence(obj, name);
    const sourceSection = resolveSourceSection(obj);
    const confidence = resolveConfidence(obj);

    return {
      name: name || (typeof obj.name === 'string' ? obj.name : ''),
      evidence,
      sourceSection,
      confidence,
    };
  }
  return raw;
}, z.object({
  name: z.string().min(1).max(150),
  evidence: z.string().nullable().default(null),
  sourceSection: z.enum(['skills', 'experience', 'projects', 'education', 'other']).default('skills'),
  confidence: z.number().min(0).max(1).default(1.0),
}));

export const ExtractedExperienceSchema = z.object({
  jobTitle: z.preprocess((val) => (val != null ? String(val).trim() : null), z.string().nullable().default(null)),
  company: z.preprocess((val) => (val != null ? String(val).trim() : null), z.string().nullable().default(null)),
  startDate: z.preprocess((val) => {
    if (val === null || val === undefined) return null;
    if (typeof val === 'number') return String(val);
    if (typeof val === 'string') return val.trim() || null;
    return String(val);
  }, z.string().nullable().default(null)),
  endDate: z.preprocess((val) => {
    if (val === null || val === undefined) return null;
    if (typeof val === 'number') return String(val);
    if (typeof val === 'string') return val.trim() || null;
    return String(val);
  }, z.string().nullable().default(null)),
  isCurrent: z.preprocess((val) => {
    if (typeof val === 'boolean') return val;
    if (typeof val === 'string') {
      const lower = val.toLowerCase().trim();
      return lower === 'true' || lower === 'yes' || lower === 'current' || lower === 'present';
    }
    if (typeof val === 'number') return val === 1;
    return false;
  }, z.boolean().default(false)),
  responsibilities: z.preprocess((val) => {
    if (Array.isArray(val)) return val.map((x) => (typeof x === 'object' ? JSON.stringify(x) : String(x).trim())).filter(Boolean);
    if (typeof val === 'string' && val.trim()) {
      return val.split(/\r?\n|•|- /).map((s) => s.trim()).filter(Boolean);
    }
    return [];
  }, z.array(z.string()).default([])),
  achievements: z.preprocess((val) => {
    if (Array.isArray(val)) return val.map((x) => (typeof x === 'object' ? JSON.stringify(x) : String(x).trim())).filter(Boolean);
    if (typeof val === 'string' && val.trim()) {
      return val.split(/\r?\n|•|- /).map((s) => s.trim()).filter(Boolean);
    }
    return [];
  }, z.array(z.string()).default([])),
});

export const ExtractedProjectSchema = z.object({
  name: z.preprocess((val) => (val != null ? String(val).trim() : null), z.string().nullable().default(null)),
  description: z.preprocess((val) => {
    if (Array.isArray(val)) return val.map((x) => String(x).trim()).filter(Boolean).join(' ');
    if (val != null) return String(val).trim();
    return null;
  }, z.string().nullable().default(null)),
  technologies: z.preprocess((val) => {
    if (Array.isArray(val)) return val.map((x) => (typeof x === 'object' ? JSON.stringify(x) : String(x).trim())).filter(Boolean);
    if (typeof val === 'string' && val.trim()) {
      return val.split(/[,;\n]/).map((s) => s.trim()).filter(Boolean);
    }
    return [];
  }, z.array(z.string()).default([])),
  outcomes: z.preprocess((val) => {
    if (Array.isArray(val)) return val.map((x) => (typeof x === 'object' ? JSON.stringify(x) : String(x).trim())).filter(Boolean);
    if (typeof val === 'string' && val.trim()) {
      return val.split(/\r?\n|•|- /).map((s) => s.trim()).filter(Boolean);
    }
    return [];
  }, z.array(z.string()).default([])),
});

export const ExtractedEducationSchema = z.object({
  degree: z.preprocess((val) => (val != null ? String(val).trim() : null), z.string().nullable().default(null)),
  institution: z.preprocess((val) => (val != null ? String(val).trim() : null), z.string().nullable().default(null)),
  fieldOfStudy: z.preprocess((val) => (val != null ? String(val).trim() : null), z.string().nullable().default(null)),
  graduationYear: z.preprocess((val) => {
    if (val === null || val === undefined) return null;
    if (typeof val === 'number') return String(val);
    if (typeof val === 'string') return val.trim() || null;
    return String(val);
  }, z.string().nullable().default(null)),
});

export const ExtractedCertificationSchema = z.preprocess((raw) => {
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    return { name: trimmed, issuer: null, year: null };
  }
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    const name =
      (typeof obj.name === 'string' && obj.name.trim()) ||
      (typeof obj.certification === 'string' && obj.certification.trim()) ||
      (typeof obj.certificationName === 'string' && obj.certificationName.trim()) ||
      (typeof obj.title === 'string' && obj.title.trim()) ||
      '';
    const issuer = obj.issuer != null ? String(obj.issuer).trim() : null;
    let year: string | null = null;
    if (obj.year != null) {
      year = String(obj.year).trim() || null;
    }
    return { name, issuer, year };
  }
  return raw;
}, z.object({
  name: z.string().min(1),
  issuer: z.string().nullable().default(null),
  year: z.string().nullable().default(null),
}));

export const StructuredResumeExtractionSchema = z.object({
  schemaVersion: z.string().default('1.0'),
  summary: z.preprocess((val) => {
    if (Array.isArray(val)) return val.map((x) => String(x).trim()).filter(Boolean).join(' ');
    if (typeof val === 'string') return val.trim() || null;
    return null;
  }, z.string().nullable().default(null)),
  skills: z
    .preprocess((val) => normalizeRawSkills(val), z.array(ExtractedSkillSchema))
    .default([]),
  experience: z.preprocess((val) => (Array.isArray(val) ? val : []), z.array(ExtractedExperienceSchema)).default([]),
  projects: z.preprocess((val) => (Array.isArray(val) ? val : []), z.array(ExtractedProjectSchema)).default([]),
  education: z.preprocess((val) => (Array.isArray(val) ? val : []), z.array(ExtractedEducationSchema)).default([]),
  certifications: z
    .preprocess((val) => {
      if (Array.isArray(val)) {
        return val
          .map((item) => {
            if (typeof item === 'string') {
              return { name: item.trim(), issuer: null, year: null };
            }
            if (item && typeof item === 'object') {
              const obj = item as Record<string, unknown>;
              const name =
                (typeof obj.name === 'string' && obj.name.trim()) ||
                (typeof obj.certification === 'string' && obj.certification.trim()) ||
                (typeof obj.certificationName === 'string' && obj.certificationName.trim()) ||
                (typeof obj.title === 'string' && obj.title.trim()) ||
                '';
              const issuer = obj.issuer != null ? String(obj.issuer).trim() : null;
              const year = obj.year != null ? String(obj.year).trim() : null;
              return { name, issuer, year };
            }
            return item;
          })
          .filter((item) => item && typeof item === 'object' && Boolean((item as Record<string, unknown>).name));
      }
      return [];
    }, z.array(ExtractedCertificationSchema))
    .default([]),
  sectionsPresent: z.preprocess((val) => {
    if (Array.isArray(val)) return val.map((x) => String(x).trim()).filter(Boolean);
    if (typeof val === 'string' && val.trim()) return [val.trim()];
    return [];
  }, z.array(z.string()).default([])),
  warnings: z.preprocess((val) => {
    if (Array.isArray(val)) return val.map((x) => String(x).trim()).filter(Boolean);
    if (typeof val === 'string' && val.trim()) return [val.trim()];
    return [];
  }, z.array(z.string()).default([])),
  suggestedImprovements: z.preprocess((val) => {
    if (Array.isArray(val)) return val.map((x) => String(x).trim()).filter(Boolean);
    if (typeof val === 'string' && val.trim()) return [val.trim()];
    return [];
  }, z.array(z.string()).default([])),
});

export type StructuredResumeExtraction = z.infer<typeof StructuredResumeExtractionSchema>;
export type ExtractedSkill = z.infer<typeof ExtractedSkillSchema>;
export type ExtractedExperience = z.infer<typeof ExtractedExperienceSchema>;
export type ExtractedProject = z.infer<typeof ExtractedProjectSchema>;
export type ExtractedEducation = z.infer<typeof ExtractedEducationSchema>;
export type ExtractedCertification = z.infer<typeof ExtractedCertificationSchema>;

export interface ExtractionInput {
  sanitizedResumeText: string;
  targetJobDescription?: string;
  systemPrompt: string;
  knownSkillsList?: string[];
}

export interface ExtractionTokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface ExtractionResult {
  data: StructuredResumeExtraction;
  tokenUsage?: ExtractionTokenUsage;
  durationMs: number;
  providerRequestId?: string;
}

export interface ProviderValidationConfig {
  apiKey: string;
  modelId: string;
}

export interface ConnectionTestResult {
  success: boolean;
  message: string;
  latencyMs: number;
  modelTested: string;
  testedAt: Date;
}

export interface ProviderMetadata {
  provider: 'OPENAI' | 'GEMINI';
  displayName: string;
  supportedModels: string[];
  defaultModel: string;
}

export interface ResumeAIProvider {
  getProviderMetadata(): ProviderMetadata;
  validateConnection(config: ProviderValidationConfig): Promise<ConnectionTestResult>;
  extractResumeData(
    input: ExtractionInput,
    config: { apiKey: string; modelId: string }
  ): Promise<ExtractionResult>;
}

/**
 * Standard JSON Schema definition for structured output enforcement
 */
export const JSON_SCHEMA_RESUME_EXTRACTION = {
  type: 'object',
  properties: {
    schemaVersion: { type: 'string', description: 'Version of output schema, e.g. 1.0' },
    summary: { type: ['string', 'null'], description: 'Professional summary statement if present' },
    skills: {
      type: 'array',
      description: 'Extracted technical and professional skills',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Name of the skill' },
          evidence: { type: ['string', 'null'], description: 'Direct concise evidence quote from text' },
          sourceSection: {
            type: 'string',
            enum: ['skills', 'experience', 'projects', 'education', 'other'],
            description: 'Where this skill was found',
          },
          confidence: { type: 'number', description: 'Model confidence heuristic 0.0 to 1.0' },
        },
        required: ['name', 'evidence', 'sourceSection', 'confidence'],
        additionalProperties: false,
      },
    },
    experience: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          jobTitle: { type: ['string', 'null'] },
          company: { type: ['string', 'null'] },
          startDate: { type: ['string', 'null'] },
          endDate: { type: ['string', 'null'] },
          isCurrent: { type: 'boolean' },
          responsibilities: { type: 'array', items: { type: 'string' } },
          achievements: { type: 'array', items: { type: 'string' } },
        },
        required: ['jobTitle', 'company', 'startDate', 'endDate', 'isCurrent', 'responsibilities', 'achievements'],
        additionalProperties: false,
      },
    },
    projects: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: ['string', 'null'] },
          description: { type: ['string', 'null'] },
          technologies: { type: 'array', items: { type: 'string' } },
          outcomes: { type: 'array', items: { type: 'string' } },
        },
        required: ['name', 'description', 'technologies', 'outcomes'],
        additionalProperties: false,
      },
    },
    education: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          degree: { type: ['string', 'null'] },
          institution: { type: ['string', 'null'] },
          fieldOfStudy: { type: ['string', 'null'] },
          graduationYear: { type: ['string', 'null'] },
        },
        required: ['degree', 'institution', 'fieldOfStudy', 'graduationYear'],
        additionalProperties: false,
      },
    },
    certifications: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          issuer: { type: ['string', 'null'] },
          year: { type: ['string', 'null'] },
        },
        required: ['name', 'issuer', 'year'],
        additionalProperties: false,
      },
    },
    sectionsPresent: {
      type: 'array',
      items: { type: 'string' },
    },
    warnings: {
      type: 'array',
      items: { type: 'string' },
    },
    suggestedImprovements: {
      type: 'array',
      items: { type: 'string' },
    },
  },
  required: [
    'schemaVersion',
    'summary',
    'skills',
    'experience',
    'projects',
    'education',
    'certifications',
    'sectionsPresent',
    'warnings',
    'suggestedImprovements',
  ],
  additionalProperties: false,
} as const;
