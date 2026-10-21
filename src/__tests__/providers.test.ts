import { describe, it, expect, vi } from 'vitest';
import { OpenAIResumeProvider } from '../lib/ai/openai-provider';
import { GeminiResumeProvider } from '../lib/ai/gemini-provider';
import { StructuredResumeExtractionSchema } from '../lib/ai/types';

describe('Pluggable AI Provider Architecture', () => {
  const sampleExtractionOutput = {
    schemaVersion: '1.0',
    summary: 'Senior Software Engineer with 5 years experience.',
    skills: [
      {
        name: 'TypeScript',
        evidence: 'Built microservices using TypeScript.',
        sourceSection: 'skills',
        confidence: 0.98,
      },
      {
        name: 'React',
        evidence: 'Developed responsive UI.',
        sourceSection: 'skills',
        confidence: 0.95,
      },
    ],
    experience: [
      {
        jobTitle: 'Senior Software Engineer',
        company: 'CloudScale',
        startDate: '2022',
        endDate: 'Present',
        isCurrent: true,
        responsibilities: ['Architected frontend.'],
        achievements: ['Increased performance by 40%.'],
      },
    ],
    projects: [
      {
        name: 'Analytics Platform',
        description: 'Real-time metrics.',
        technologies: ['TypeScript', 'Docker'],
        outcomes: ['Sub-second latency.'],
      },
    ],
    education: [
      {
        degree: 'BS in Computer Science',
        institution: 'University of Washington',
        fieldOfStudy: 'Computer Science',
        graduationYear: '2020',
      },
    ],
    certifications: [
      {
        name: 'AWS Solutions Architect',
        issuer: 'AWS',
        year: '2023',
      },
    ],
    sectionsPresent: ['summary', 'skills', 'experience', 'projects', 'education', 'certifications'],
    warnings: [],
    suggestedImprovements: ['Add more quantified metrics to project descriptions.'],
  };

  it('OpenAI provider metadata should return allowed models and defaults', () => {
    const provider = new OpenAIResumeProvider();
    const meta = provider.getProviderMetadata();
    expect(meta.provider).toBe('OPENAI');
    expect(meta.supportedModels).toContain('gpt-5-nano');
    expect(meta.supportedModels).toContain('gpt-4o-mini');
    expect(meta.supportedModels).toContain('gpt-4o');
    expect(meta.defaultModel).toBe('gpt-5-nano');
  });

  it('Gemini provider metadata should return allowed models and defaults', () => {
    const provider = new GeminiResumeProvider();
    const meta = provider.getProviderMetadata();
    expect(meta.provider).toBe('GEMINI');
    expect(meta.supportedModels).toContain('gemini-2.5-flash');
    expect(meta.supportedModels).toContain('gemini-2.5-pro');
    expect(meta.defaultModel).toBe('gemini-2.5-flash');
  });

  it('both OpenAI and Gemini extraction structures must conform to the unified Zod schema', () => {
    const parsed = StructuredResumeExtractionSchema.parse(sampleExtractionOutput);

    expect(parsed.schemaVersion).toBe('1.0');
    expect(parsed.skills.length).toBe(2);
    expect(parsed.skills[0].name).toBe('TypeScript');
    expect(parsed.experience[0].company).toBe('CloudScale');
    expect(parsed.projects[0].technologies).toContain('Docker');
    expect(parsed.education[0].institution).toBe('University of Washington');
  });
});
