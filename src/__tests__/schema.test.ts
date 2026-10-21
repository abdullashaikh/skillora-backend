import { describe, it, expect } from 'vitest';
import { StructuredResumeExtractionSchema } from '../lib/ai/types';

describe('Structured Resume Output Schema Validation', () => {
  it('should validate structured output conforming to the required schema', () => {
    const validJson = {
      schemaVersion: '1.0',
      summary: 'Experienced developer',
      skills: [
        {
          name: 'JavaScript',
          evidence: 'Used JavaScript daily.',
          sourceSection: 'skills',
          confidence: 0.95,
        },
      ],
      experience: [
        {
          jobTitle: 'Software Engineer',
          company: 'Acme Corp',
          startDate: '2021',
          endDate: '2023',
          isCurrent: false,
          responsibilities: ['Developed frontend'],
          achievements: ['Increased performance by 20%'],
        },
      ],
      projects: [],
      education: [],
      certifications: [],
      sectionsPresent: ['summary', 'skills', 'experience'],
      warnings: [],
      suggestedImprovements: ['Add more quantified metrics'],
    };

    const parsed = StructuredResumeExtractionSchema.safeParse(validJson);
    expect(parsed.success).toBe(true);
  });

  it('should gracefully handle array evidence, numeric years, and loose LLM formatting', () => {
    const llmOutputWithArrayEvidence = {
      schemaVersion: '1.0',
      summary: ['Passionate full stack engineer.', 'Specializing in cloud systems.'],
      skills: [
        {
          name: 'React',
          evidence: ['React', 'Built scalable web apps using React'],
          sourceSection: 'EXPERIENCE',
          confidence: '0.92',
        },
        {
          name: 'Node.js',
          evidence: null,
          sourceSection: 'skills',
        },
      ],
      experience: [
        {
          jobTitle: 'Senior Dev',
          company: 'Acme',
          startDate: 2020,
          endDate: 2023,
          isCurrent: 'false',
          responsibilities: '• Led team of 5\n• Designed backend architecture',
          achievements: ['Won hackathon'],
        },
      ],
      projects: [
        {
          name: 'AI App',
          description: ['A smart platform', 'for career development'],
          technologies: ['TypeScript', 'Next.js'],
          outcomes: ['10k monthly users'],
        },
      ],
      education: [
        {
          degree: 'B.S. Computer Science',
          institution: 'State University',
          fieldOfStudy: 'Engineering',
          graduationYear: 2022,
        },
      ],
      certifications: [
        {
          name: 'AWS Solutions Architect',
          issuer: 'Amazon',
          year: 2023,
        },
      ],
      sectionsPresent: 'skills, experience, education',
      warnings: [],
      suggestedImprovements: ['Add more metrics'],
    };

    const parsed = StructuredResumeExtractionSchema.safeParse(llmOutputWithArrayEvidence);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    // Verify transforms
    expect(parsed.data.summary).toBe('Passionate full stack engineer. Specializing in cloud systems.');
    expect(parsed.data.skills[0].evidence).toBe('React; Built scalable web apps using React');
    expect(parsed.data.skills[0].sourceSection).toBe('experience');
    expect(parsed.data.skills[0].confidence).toBe(0.92);
    expect(parsed.data.certifications[0].year).toBe('2023');
    expect(parsed.data.education[0].graduationYear).toBe('2022');
    expect(parsed.data.experience[0].startDate).toBe('2020');
    expect(parsed.data.experience[0].isCurrent).toBe(false);
    expect(parsed.data.experience[0].responsibilities).toEqual(['Led team of 5', 'Designed backend architecture']);
  });

  it('should handle alternative skill keys, empty names, and filter empty objects without error', () => {
    const looseJson = {
      schemaVersion: '1.0',
      skills: [
        {
          skill: 'React',
          evidence: 'React frontend',
        },
        {
          skillName: 'TypeScript',
          evidence: 'Typed code',
        },
        {
          technology: 'Docker',
          evidence: 'Containerized services',
        },
        {
          name: '',
          evidence: 'PostgreSQL database',
        },
        {
          name: '', // completely empty, should be filtered out
        },
        {
          category: 'Cloud',
          skills: ['AWS', 'GCP'],
        },
      ],
      certifications: [
        {
          certification: 'Certified Kubernetes Administrator',
          issuer: 'CNCF',
          year: '2024',
        },
      ],
    };

    const parsed = StructuredResumeExtractionSchema.safeParse(looseJson);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    const skillNames = parsed.data.skills.map((s) => s.name);
    expect(skillNames).toContain('React');
    expect(skillNames).toContain('TypeScript');
    expect(skillNames).toContain('Docker');
    expect(skillNames).toContain('PostgreSQL database');
    expect(skillNames).toContain('AWS');
    expect(skillNames).toContain('GCP');
    expect(skillNames).not.toContain('');

    expect(parsed.data.certifications[0].name).toBe('Certified Kubernetes Administrator');
  });

  it('should reject invalid skill confidence values or malformed schemas', () => {
    const invalidJson = {
      schemaVersion: '1.0',
      skills: [
        {
          name: 'Python',
          confidence: 2.5, // Exceeds max 1.0
        },
      ],
    };

    const parsed = StructuredResumeExtractionSchema.safeParse(invalidJson);
    expect(parsed.success).toBe(false);
  });
});
