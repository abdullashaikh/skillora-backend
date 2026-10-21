import { StructuredResumeExtraction } from '../ai/types.js';
import { NormalizedSkillResult } from './skill-normalizer.js';

export interface QualityWeights {
  sectionCompleteness: number;      // default 25
  readabilityParsability: number;   // default 20
  experienceDescriptions: number;   // default 25
  achievementsEvidence: number;     // default 20
  skillsClarity: number;            // default 10
}

export interface JobMatchWeights {
  skillCoverage: number;            // default 40
  experienceEvidence: number;       // default 25
  projectRelevance: number;         // default 20
  keywordsSynonyms: number;         // default 10
  educationCertifications: number;  // default 5
}

export interface DimensionScore {
  name: string;
  score: number;       // 0 - 100
  weight: number;      // percentage (e.g. 25)
  weightedScore: number;
  explanation: string;
  recommendations: string[];
}

export interface ScoringReport {
  qualityScore: number; // 0 - 100
  qualityDimensions: DimensionScore[];
  jobMatchScore: number | null; // 0 - 100 or null if no job description
  jobMatchDimensions?: DimensionScore[];
  matchedSkills?: string[];
  missingSkills?: string[]; // "Not found in resume"
  improvementSuggestions: string[];
  disclaimer: string;
}

const ACTION_VERBS = [
  'developed', 'built', 'created', 'designed', 'implemented', 'led', 'architected',
  'engineered', 'optimized', 'reduced', 'increased', 'delivered', 'managed',
  'deployed', 'launched', 'automated', 'streamlined', 'improved', 'scaled',
  'refactored', 'mentored', 'analyzed', 'configured', 'integrated',
];

const QUANTIFIABLE_PATTERNS = [
  /\b\d+%\b/,                   // percentages (e.g. 25%)
  /\$\s*\d+[\d,.]*[kKmMbB]?\b/,  // dollar amounts ($50k, $1.2M)
  /\b\d+\s*(?:users|clients|customers|requests|transactions|ms|seconds|minutes|hours|days|teams|engineers)\b/i,
  /\b(?:increased|reduced|decreased|accelerated|boosted|saved|grew|doubled|tripled)\s+(?:by\s+)?\d+/i,
];

/**
 * Validates that scoring weights sum strictly to 100%.
 */
export function validateWeights(weights: Record<string, number>): boolean {
  const sum = Object.values(weights).reduce((acc, val) => acc + val, 0);
  return Math.abs(sum - 100) < 0.01;
}

export class ScoringEngine {
  /**
   * Calculates deterministic Resume Quality Score (0 - 100).
   */
  static calculateQualityScore(
    data: StructuredResumeExtraction,
    skills: NormalizedSkillResult[],
    weights: QualityWeights = {
      sectionCompleteness: 25,
      readabilityParsability: 20,
      experienceDescriptions: 25,
      achievementsEvidence: 20,
      skillsClarity: 10,
    }
  ): { totalScore: number; dimensions: DimensionScore[]; suggestions: string[] } {
    const dimensions: DimensionScore[] = [];
    const suggestions: string[] = [];

    // 1. Section Completeness (Weight: 25%)
    let completenessPoints = 0;
    const completenessRecs: string[] = [];

    if (data.summary && data.summary.trim().length > 30) completenessPoints += 20;
    else completenessRecs.push('Add a concise 2-3 sentence professional summary at the top.');

    if (data.experience && data.experience.length > 0) completenessPoints += 30;
    else completenessRecs.push('Include detailed work experience or relevant internships.');

    if (data.education && data.education.length > 0) completenessPoints += 20;
    else completenessRecs.push('Add an education section with degree and institution.');

    if (skills.length >= 4) completenessPoints += 20;
    else completenessRecs.push('Include a clearly categorized technical skills section with at least 5 key skills.');

    if (data.projects && data.projects.length > 0) completenessPoints += 10;
    else completenessRecs.push('Add notable projects to demonstrate hands-on experience.');

    completenessPoints = Math.min(100, completenessPoints);
    dimensions.push({
      name: 'Section Completeness',
      score: completenessPoints,
      weight: weights.sectionCompleteness,
      weightedScore: Math.round((completenessPoints * weights.sectionCompleteness) / 100),
      explanation: `Evaluates presence of core sections (Summary, Experience, Education, Skills, Projects). Scored ${completenessPoints}/100.`,
      recommendations: completenessRecs,
    });

    // 2. Readability & Parsability (Weight: 20%)
    let readabilityPoints = 100;
    const readabilityRecs: string[] = [];

    if (data.warnings && data.warnings.length > 0) {
      readabilityPoints -= Math.min(40, data.warnings.length * 15);
      readabilityRecs.push(...data.warnings.map((w) => `Address parser alert: ${w}`));
    }

    const allBullets = [
      ...data.experience.flatMap((e) => [...e.responsibilities, ...e.achievements]),
      ...data.projects.flatMap((p) => p.outcomes),
    ];

    if (allBullets.length < 3) {
      readabilityPoints -= 25;
      readabilityRecs.push('Break descriptions down into distinct bullet points for faster reading.');
    } else {
      const avgLength = allBullets.reduce((sum, b) => sum + b.length, 0) / allBullets.length;
      if (avgLength < 25) {
        readabilityPoints -= 15;
        readabilityRecs.push('Expand brief bullet points with context and technology stack used.');
      } else if (avgLength > 280) {
        readabilityPoints -= 15;
        readabilityRecs.push('Condense lengthy paragraphs into punchy, focused bullet points.');
      }
    }

    readabilityPoints = Math.max(20, Math.min(100, readabilityPoints));
    dimensions.push({
      name: 'Readability & Parsability',
      score: readabilityPoints,
      weight: weights.readabilityParsability,
      weightedScore: Math.round((readabilityPoints * weights.readabilityParsability) / 100),
      explanation: `Measures structure clarity, formatting consistency, and bullet length. Scored ${readabilityPoints}/100.`,
      recommendations: readabilityRecs,
    });

    // 3. Experience & Project Descriptions (Weight: 25%)
    let experiencePoints = 0;
    const experienceRecs: string[] = [];

    if (data.experience.length >= 2) experiencePoints += 40;
    else if (data.experience.length === 1) experiencePoints += 25;
    else experienceRecs.push('Provide at least 1-2 detailed work or practical experience entries.');

    // Check for strong action verbs
    let actionVerbMatches = 0;
    const bulletText = allBullets.join(' ').toLowerCase();
    for (const verb of ACTION_VERBS) {
      if (bulletText.includes(verb)) actionVerbMatches++;
    }

    if (actionVerbMatches >= 5) experiencePoints += 30;
    else if (actionVerbMatches >= 2) experiencePoints += 15;
    else experienceRecs.push('Start bullet points with strong action verbs (e.g., Developed, Engineered, Optimized, Delivered).');

    // Projects depth
    if (data.projects.length >= 2) experiencePoints += 30;
    else if (data.projects.length === 1) experiencePoints += 20;
    else experienceRecs.push('Add at least two technical projects showcasing modern frameworks and tools.');

    experiencePoints = Math.min(100, experiencePoints);
    dimensions.push({
      name: 'Experience & Project Descriptions',
      score: experiencePoints,
      weight: weights.experienceDescriptions,
      weightedScore: Math.round((experiencePoints * weights.experienceDescriptions) / 100),
      explanation: `Evaluates depth of work history, action verbs, and technical project coverage. Scored ${experiencePoints}/100.`,
      recommendations: experienceRecs,
    });

    // 4. Evidence of Achievements & Outcomes (Weight: 20%)
    let achievementPoints = 0;
    const achievementRecs: string[] = [];

    let quantifiedMatches = 0;
    for (const bullet of allBullets) {
      for (const pattern of QUANTIFIABLE_PATTERNS) {
        if (pattern.test(bullet)) {
          quantifiedMatches++;
          break;
        }
      }
    }

    const explicitAchievementsCount = data.experience.reduce((sum, e) => sum + e.achievements.length, 0);

    if (quantifiedMatches >= 4 || explicitAchievementsCount >= 3) {
      achievementPoints = 95;
    } else if (quantifiedMatches >= 2 || explicitAchievementsCount >= 1) {
      achievementPoints = 70;
      achievementRecs.push('Add more quantified metrics (e.g. percentages, performance boosts, cost reductions) to your work outcomes.');
    } else {
      achievementPoints = 40;
      achievementRecs.push('Ground your accomplishments with concrete numbers, percentages, or measurable impacts.');
    }

    dimensions.push({
      name: 'Achievements & Measurable Outcomes',
      score: achievementPoints,
      weight: weights.achievementsEvidence,
      weightedScore: Math.round((achievementPoints * weights.achievementsEvidence) / 100),
      explanation: `Assesses presence of quantified outcomes, performance gains, and measurable achievements. Scored ${achievementPoints}/100.`,
      recommendations: achievementRecs,
    });

    // 5. Skills-Section Clarity (Weight: 10%)
    let skillsPoints = 0;
    const skillsRecs: string[] = [];

    if (skills.length >= 10) skillsPoints += 50;
    else if (skills.length >= 5) skillsPoints += 35;
    else {
      skillsPoints += skills.length * 7;
      skillsRecs.push('Broaden your skills section to include core languages, frameworks, and databases you actively use.');
    }

    // Category diversity
    const categories = new Set(skills.map((s) => s.category));
    if (categories.size >= 3) skillsPoints += 50;
    else if (categories.size >= 2) skillsPoints += 30;
    else skillsRecs.push('Organize skills into distinct categories like Languages, Frameworks, Cloud, and Databases.');

    skillsPoints = Math.min(100, skillsPoints);
    dimensions.push({
      name: 'Skills Clarity & Coverage',
      score: skillsPoints,
      weight: weights.skillsClarity,
      weightedScore: Math.round((skillsPoints * weights.skillsClarity) / 100),
      explanation: `Checks technical breadth, taxonomy mapping, and categorization. Scored ${skillsPoints}/100.`,
      recommendations: skillsRecs,
    });

    // Total Quality Score calculation
    const totalScore = Math.min(
      100,
      Math.max(
        0,
        dimensions.reduce((acc, dim) => acc + dim.weightedScore, 0)
      )
    );

    // Aggregate unique suggestions
    for (const dim of dimensions) {
      for (const rec of dim.recommendations) {
        if (!suggestions.includes(rec)) suggestions.push(rec);
      }
    }

    return { totalScore, dimensions, suggestions };
  }

  /**
   * Calculates deterministic Job Match Score (0 - 100) based on target job description.
   */
  static calculateJobMatchScore(
    data: StructuredResumeExtraction,
    skills: NormalizedSkillResult[],
    jobDescription: string,
    weights: JobMatchWeights = {
      skillCoverage: 40,
      experienceEvidence: 25,
      projectRelevance: 20,
      keywordsSynonyms: 10,
      educationCertifications: 5,
    }
  ): {
    totalScore: number;
    dimensions: DimensionScore[];
    matchedSkills: string[];
    missingSkills: string[];
  } {
    const dimensions: DimensionScore[] = [];
    const jdLower = jobDescription.toLowerCase();

    // 1. Skill Coverage (Weight: 40%)
    const matchedSkills: string[] = [];
    const missingSkills: string[] = [];

    // Extract target candidate skills from job description by checking candidate skills against JD
    for (const skill of skills) {
      const skillName = skill.canonicalName.toLowerCase();
      if (jdLower.includes(skillName) || jdLower.includes(skill.rawName.toLowerCase())) {
        matchedSkills.push(skill.canonicalName);
      }
    }

    // Common technical target keywords in job descriptions
    const commonTargetKeywords = [
      'react', 'next.js', 'typescript', 'javascript', 'node.js', 'python', 'java',
      'docker', 'kubernetes', 'aws', 'gcp', 'sql', 'postgresql', 'mongodb', 'graphql',
      'rest api', 'ci/cd', 'agile', 'git', 'c++', 'c#', 'go', 'spring boot', 'microservices'
    ];

    const jdMentionedKeywords = commonTargetKeywords.filter((kw) => jdLower.includes(kw));

    for (const kw of jdMentionedKeywords) {
      const foundInCandidate = skills.some(
        (s) => s.canonicalName.toLowerCase().includes(kw) || s.rawName.toLowerCase().includes(kw)
      );
      if (!foundInCandidate) {
        // Capitalize for display
        const displayKw = kw.charAt(0).toUpperCase() + kw.slice(1);
        if (!missingSkills.includes(displayKw)) {
          missingSkills.push(displayKw);
        }
      }
    }

    let skillCoverageScore = 70; // baseline
    if (jdMentionedKeywords.length > 0) {
      const matchRatio = matchedSkills.length / Math.max(1, jdMentionedKeywords.length);
      skillCoverageScore = Math.min(100, Math.round(matchRatio * 100));
    } else if (matchedSkills.length >= 5) {
      skillCoverageScore = 90;
    }

    const skillRecs: string[] = [];
    if (missingSkills.length > 0) {
      skillRecs.push(`Skills requested in job description not explicitly evidenced in resume: ${missingSkills.slice(0, 5).join(', ')}.`);
    }

    dimensions.push({
      name: 'Required Skill Coverage',
      score: skillCoverageScore,
      weight: weights.skillCoverage,
      weightedScore: Math.round((skillCoverageScore * weights.skillCoverage) / 100),
      explanation: `Matches candidate skills against requirements in the target job description. Scored ${skillCoverageScore}/100.`,
      recommendations: skillRecs,
    });

    // 2. Experience Relevance (Weight: 25%)
    let expPoints = 50;
    const allExpBullets = data.experience.flatMap((e) => [...e.responsibilities, ...e.achievements]).join(' ').toLowerCase();

    let matchedExpTerms = 0;
    for (const kw of jdMentionedKeywords) {
      if (allExpBullets.includes(kw)) matchedExpTerms++;
    }

    if (jdMentionedKeywords.length > 0) {
      expPoints = Math.min(100, Math.round((matchedExpTerms / Math.max(1, jdMentionedKeywords.length)) * 100));
    } else {
      expPoints = data.experience.length >= 2 ? 85 : 65;
    }

    dimensions.push({
      name: 'Relevant Experience Evidence',
      score: expPoints,
      weight: weights.experienceEvidence,
      weightedScore: Math.round((expPoints * weights.experienceEvidence) / 100),
      explanation: `Checks how frequently target domain technologies appear in work experience responsibilities. Scored ${expPoints}/100.`,
      recommendations: expPoints < 75 ? ['Explicitly highlight target job responsibilities and technical tools inside your work experience bullets.'] : [],
    });

    // 3. Project Relevance (Weight: 20%)
    let projectPoints = 50;
    const allProjectText = data.projects.flatMap((p) => [...p.technologies, p.description || '', ...p.outcomes]).join(' ').toLowerCase();

    let matchedProjectTerms = 0;
    for (const kw of jdMentionedKeywords) {
      if (allProjectText.includes(kw)) matchedProjectTerms++;
    }

    if (data.projects.length === 0) {
      projectPoints = 30;
    } else {
      projectPoints = Math.min(100, 50 + matchedProjectTerms * 15);
    }

    dimensions.push({
      name: 'Project Relevance',
      score: projectPoints,
      weight: weights.projectRelevance,
      weightedScore: Math.round((projectPoints * weights.projectRelevance) / 100),
      explanation: `Evaluates alignment of technical projects with target role stack. Scored ${projectPoints}/100.`,
      recommendations: projectPoints < 70 ? ['Add or adjust project descriptions to spotlight technologies highlighted in the job description.'] : [],
    });

    // 4. Keyword & Synonym Alignment (Weight: 10%)
    let keywordPoints = Math.min(100, Math.max(40, matchedSkills.length * 12));
    dimensions.push({
      name: 'Keywords & Domain Synonyms',
      score: keywordPoints,
      weight: weights.keywordsSynonyms,
      weightedScore: Math.round((keywordPoints * weights.keywordsSynonyms) / 100),
      explanation: `Evaluates presence of domain vocabulary and technology synonyms. Scored ${keywordPoints}/100.`,
      recommendations: [],
    });

    // 5. Education & Certifications (Weight: 5%)
    let eduPoints = 70;
    if (data.certifications.length > 0) eduPoints += 20;
    if (data.education.length > 0) eduPoints += 10;
    eduPoints = Math.min(100, eduPoints);

    dimensions.push({
      name: 'Education & Certifications',
      score: eduPoints,
      weight: weights.educationCertifications,
      weightedScore: Math.round((eduPoints * weights.educationCertifications) / 100),
      explanation: `Checks educational background and relevant technical certifications. Scored ${eduPoints}/100.`,
      recommendations: [],
    });

    const totalScore = Math.min(
      100,
      Math.max(
        0,
        dimensions.reduce((acc, dim) => acc + dim.weightedScore, 0)
      )
    );

    return {
      totalScore,
      dimensions,
      matchedSkills,
      missingSkills,
    };
  }
}
