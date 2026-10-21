import { prisma } from '../db.js';
import { ExtractedSkill } from '../ai/types.js';

export interface NormalizedSkillResult {
  skillId: string | null;
  canonicalName: string;
  category: string;
  rawName: string;
  evidence: string | null;
  sourceSection: 'skills' | 'experience' | 'projects' | 'education' | 'other';
  confidence: number;
  isExplicit: boolean;
}

export function cleanStringForMatching(str: string): string {
  return str
    .toLowerCase()
    .trim()
    .replace(/\+\+/g, 'plusplus')
    .replace(/#/g, 'sharp')
    .replace(/\.net/g, 'dotnet')
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Normalizes extracted raw skills against the canonical skills database.
 * Deduplicates repeated mentions while aggregating evidence.
 */
export async function normalizeSkills(
  extractedSkills: ExtractedSkill[]
): Promise<NormalizedSkillResult[]> {
  if (!extractedSkills || extractedSkills.length === 0) {
    return [];
  }

  // Fetch all active canonical skills
  const dbSkills = await prisma.skill.findMany({
    where: { isActive: true },
  });

  // Build lookup index: normalized name -> Skill, alias -> Skill
  const canonicalMap = new Map<string, typeof dbSkills[0]>();

  for (const skill of dbSkills) {
    canonicalMap.set(cleanStringForMatching(skill.canonicalName), skill);
    canonicalMap.set(skill.normalizedName, skill);

    try {
      const aliases: string[] = JSON.parse(skill.aliases);
      for (const alias of aliases) {
        canonicalMap.set(cleanStringForMatching(alias), skill);
      }
    } catch {
      // ignore JSON parse error in individual skill
    }
  }

  // Deduplication map keyed by canonical name
  const deduplicated = new Map<string, NormalizedSkillResult>();

  for (const item of extractedSkills) {
    const rawClean = cleanStringForMatching(item.name);
    if (!rawClean) continue;

    const matchedSkill = canonicalMap.get(rawClean);

    const canonicalName = matchedSkill ? matchedSkill.canonicalName : item.name.trim();
    const category = matchedSkill ? matchedSkill.category : 'General / Other';
    const skillId = matchedSkill ? matchedSkill.id : null;
    const isExplicit = item.sourceSection === 'skills';

    const existing = deduplicated.get(canonicalName.toLowerCase());

    if (existing) {
      // Merge evidence and choose higher confidence
      if (!existing.evidence && item.evidence) {
        existing.evidence = item.evidence;
      } else if (existing.evidence && item.evidence && !existing.evidence.includes(item.evidence)) {
        existing.evidence = `${existing.evidence} | ${item.evidence}`.slice(0, 500);
      }
      existing.confidence = Math.max(existing.confidence, item.confidence);
      if (isExplicit) existing.isExplicit = true;
    } else {
      deduplicated.set(canonicalName.toLowerCase(), {
        skillId,
        canonicalName,
        category,
        rawName: item.name,
        evidence: item.evidence ? item.evidence.slice(0, 500) : null,
        sourceSection: item.sourceSection,
        confidence: item.confidence,
        isExplicit,
      });
    }
  }

  return Array.from(deduplicated.values());
}
