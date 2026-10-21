import { describe, it, expect } from 'vitest';
import {
  ScoringEngine,
  validateWeights,
  QualityWeights,
  JobMatchWeights,
} from '../lib/scoring/scoring-engine';
import { StructuredResumeExtraction } from '../lib/ai/types';
import { NormalizedSkillResult } from '../lib/scoring/skill-normalizer';

describe('Deterministic Scoring Engine', () => {
  const sampleData: StructuredResumeExtraction = {
    schemaVersion: '1.0',
    summary:
      'Experienced Full-Stack Software Engineer with 5+ years of designing scalable systems, microservices, and web platforms.',
    skills: [],
    experience: [
      {
        jobTitle: 'Senior Software Engineer',
        company: 'CloudScale',
        startDate: '2022',
        endDate: 'Present',
        isCurrent: true,
        responsibilities: [
          'Architected and delivered resilient React and TypeScript frontend applications.',
          'Optimized PostgreSQL queries reducing latency by 45%.',
        ],
        achievements: [
          'Scaled application throughput by 40% and mentored 4 junior engineers.',
          'Reduced cloud infrastructure cost by $50,000 annually.',
        ],
      },
    ],
    projects: [
      {
        name: 'Real-Time Event Streamer',
        description: 'Distributed WebSocket processing pipeline.',
        technologies: ['TypeScript', 'Node.js', 'PostgreSQL', 'Docker'],
        outcomes: ['Handled 10,000 events per second with 99.99% uptime.'],
      },
    ],
    education: [
      {
        degree: 'Bachelor of Science',
        institution: 'University of Washington',
        fieldOfStudy: 'Computer Science',
        graduationYear: '2020',
      },
    ],
    certifications: [
      {
        name: 'AWS Solutions Architect',
        issuer: 'Amazon Web Services',
        year: '2023',
      },
    ],
    sectionsPresent: ['summary', 'experience', 'projects', 'education', 'skills'],
    warnings: [],
    suggestedImprovements: [],
  };

  const sampleSkills: NormalizedSkillResult[] = [
    {
      skillId: '1',
      canonicalName: 'TypeScript',
      category: 'Programming Languages',
      rawName: 'TypeScript',
      evidence: 'Used TypeScript for frontend and backend.',
      sourceSection: 'skills',
      confidence: 1.0,
      isExplicit: true,
    },
    {
      skillId: '2',
      canonicalName: 'React',
      category: 'Frameworks & Libraries',
      rawName: 'React',
      evidence: 'Built React apps.',
      sourceSection: 'skills',
      confidence: 1.0,
      isExplicit: true,
    },
    {
      skillId: '3',
      canonicalName: 'Node.js',
      category: 'Frameworks & Libraries',
      rawName: 'Node.js',
      evidence: 'Distributed microservices.',
      sourceSection: 'experience',
      confidence: 1.0,
      isExplicit: false,
    },
    {
      skillId: '4',
      canonicalName: 'PostgreSQL',
      category: 'Databases & Storage',
      rawName: 'PostgreSQL',
      evidence: 'Optimized queries.',
      sourceSection: 'experience',
      confidence: 1.0,
      isExplicit: false,
    },
    {
      skillId: '5',
      canonicalName: 'Docker',
      category: 'Cloud & DevOps',
      rawName: 'Docker',
      evidence: 'Containerized pipeline.',
      sourceSection: 'projects',
      confidence: 1.0,
      isExplicit: false,
    },
  ];

  it('should validate that scoring weights sum strictly to 100%', () => {
    const validWeights = { a: 25, b: 25, c: 25, d: 25 };
    expect(validateWeights(validWeights)).toBe(true);

    const invalidWeights = { a: 25, b: 25, c: 25, d: 30 }; // 105%
    expect(validateWeights(invalidWeights)).toBe(false);
  });

  it('should calculate deterministic Resume Quality Score within bounded range (0 to 100)', () => {
    const report1 = ScoringEngine.calculateQualityScore(sampleData, sampleSkills);
    const report2 = ScoringEngine.calculateQualityScore(sampleData, sampleSkills);

    expect(report1.totalScore).toBeGreaterThanOrEqual(0);
    expect(report1.totalScore).toBeLessThanOrEqual(100);

    // Strict determinism for identical inputs
    expect(report1.totalScore).toBe(report2.totalScore);
    expect(report1.dimensions.length).toBe(5);
  });

  it('should calculate deterministic Job Match Score against target job description', () => {
    const targetJD =
      'Seeking a Full Stack Engineer with strong experience in React, TypeScript, Node.js, and Docker. Experience with PostgreSQL preferred.';

    const matchReport = ScoringEngine.calculateJobMatchScore(sampleData, sampleSkills, targetJD);

    expect(matchReport.totalScore).toBeGreaterThan(60);
    expect(matchReport.matchedSkills).toContain('React');
    expect(matchReport.matchedSkills).toContain('TypeScript');
    expect(matchReport.matchedSkills).toContain('Docker');
    expect(matchReport.matchedSkills).toContain('PostgreSQL');
  });

  it('should identify missing requested skills as "not evidenced in resume"', () => {
    const targetJD =
      'Requires expertise in React, TypeScript, Python, Kubernetes, and Go programming.';

    const matchReport = ScoringEngine.calculateJobMatchScore(sampleData, sampleSkills, targetJD);

    expect(matchReport.missingSkills).toContain('Kubernetes');
    expect(matchReport.missingSkills).toContain('Go');
  });
});
