import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import app from '../app.js';
import { prisma } from '../lib/db.js';
import { signSessionToken } from '../lib/auth/jwt.js';
import { DifficultyLevel, QuestionType, ReviewStatus } from '../lib/qa/types.js';

describe('QA Question Bank & Admin API Endpoints', () => {
  let adminToken: string;
  let testAdminUser: any;
  let testSkill: any;

  beforeAll(async () => {
    // 1. Get or create test admin user
    testAdminUser = await prisma.user.findFirst({
      where: { role: 'ADMIN', isActive: true },
    });

    if (!testAdminUser) {
      testAdminUser = await prisma.user.create({
        data: {
          email: `test_admin_${Date.now()}@skilledresume.local`,
          name: 'QA Admin Tester',
          role: 'ADMIN',
          isActive: true,
          isEmailVerified: true,
        },
      });
    }

    adminToken = signSessionToken({
      userId: testAdminUser.id,
      email: testAdminUser.email,
      role: 'ADMIN',
    });

    // 2. Get or create test canonical skill
    testSkill = await prisma.skill.findFirst({
      where: { canonicalName: 'JavaScript' },
    });

    if (!testSkill) {
      testSkill = await prisma.skill.create({
        data: {
          canonicalName: 'JavaScript',
          normalizedName: 'javascript',
          category: 'Programming Languages',
          aliases: JSON.stringify(['js', 'ecmascript']),
          isActive: true,
        },
      });
    }
  });

  describe('Security & Admin Guards', () => {
    it('should deny unauthenticated requests to /api/admin/content-sources', async () => {
      const res = await request(app).get('/api/admin/content-sources');
      expect(res.status).toBe(403);
      expect(res.body.error).toContain('Administrator access required');
    });

    it('should deny unauthenticated requests to /api/admin/qa-dashboard/stats', async () => {
      const res = await request(app).get('/api/admin/qa-dashboard/stats');
      expect(res.status).toBe(403);
    });
  });

  describe('Source Registration & Management', () => {
    let createdSourceId: string;

    it('should allow authenticated admin to register a content source', async () => {
      const res = await request(app)
        .post('/api/admin/content-sources')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          name: 'Official JS Interview Questions',
          sourceType: 'GITHUB_REPO',
          url: 'https://github.com/yangshun/front-end-interview-handbook',
          technologyIds: [testSkill.id],
          licenseId: 'MIT',
          attribution: 'Front End Interview Handbook',
        });

      expect(res.status).toBe(201);
      expect(res.body.source).toBeDefined();
      expect(res.body.source.name).toBe('Official JS Interview Questions');
      expect(res.body.source.status).toBe('READY'); // MIT is an approved license
      createdSourceId = res.body.source.id;
    });

    it('should list content sources for admin', async () => {
      const res = await request(app)
        .get('/api/admin/content-sources')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.sources)).toBe(true);
      expect(res.body.sources.some((s: any) => s.id === createdSourceId)).toBe(true);
    });

    it('should update content source metadata', async () => {
      const res = await request(app)
        .patch(`/api/admin/content-sources/${createdSourceId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          adminNotes: 'Updated via automated test suite',
        });

      expect(res.status).toBe(200);
      expect(res.body.source.adminNotes).toBe('Updated via automated test suite');
    });
  });

  describe('Manual Import & Review Workflow', () => {
    let stagedItemId: string;

    it('should preview an uploaded JSON dataset', async () => {
      const sampleData = JSON.stringify([
        {
          question: 'What is the purpose of useEffect dependency array in React?',
          answer: 'The dependency array tells React when to re-run the effect: only when specified dependencies change.',
          technology: 'React',
          topic: 'Hooks',
          difficulty: 'beginner',
        },
      ]);

      const res = await request(app)
        .post('/api/admin/content-imports/preview')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          content: sampleData,
          filename: 'react-questions.json',
          licenseId: 'MIT',
        });

      expect(res.status).toBe(200);
      expect(res.body.totalParsed).toBe(1);
      expect(res.body.validCount).toBe(1);
    });

    it('should import a dataset into staging and list staged items', async () => {
      const sampleData = JSON.stringify([
        {
          question: `What is lexical scoping in JavaScript? [${Date.now()}]`,
          answer: 'Lexical scoping means that variable scope is determined by the position of variables in the source code.',
          technology: 'JavaScript',
          topic: 'Scope',
          difficulty: 'intermediate',
        },
      ]);

      const res = await request(app)
        .post('/api/admin/content-imports/upload')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          content: sampleData,
          filename: 'scope-questions.json',
          licenseId: 'MIT',
          fallbackTechnologyId: testSkill.id,
          autoPublish: false,
        });

      expect(res.status).toBe(201);
      expect(res.body.result.newItemsCount).toBe(1);

      // List staged items
      const stagedRes = await request(app)
        .get('/api/admin/questions/staged?reviewStatus=PENDING')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(stagedRes.status).toBe(200);
      expect(stagedRes.body.items.length).toBeGreaterThan(0);
      stagedItemId = stagedRes.body.items[0].id;
    });

    it('should allow admin to publish a staged item to the Question Bank', async () => {
      const pubRes = await request(app)
        .post(`/api/admin/questions/staged/${stagedItemId}/publish`)
        .set('Authorization', `Bearer ${adminToken}`);

      expect(pubRes.status).toBe(200);
      expect(pubRes.body.question).toBeDefined();
      expect(pubRes.body.question.reviewStatus).toBe('APPROVED');
    });
  });

  describe('Public Question Bank API (Candidate Facing - Zero AI Cost)', () => {
    let publishedQuestionId: string;

    beforeAll(async () => {
      // Ensure at least one published question exists
      const q = await prisma.question.create({
        data: {
          technologyId: testSkill.id,
          topic: 'Closures',
          questionText: 'Explain the difference between let, const, and var in modern JavaScript',
          answerContent: 'var is function scoped and hoisted with undefined. let and const are block scoped and live in TDZ until declared. const cannot be reassigned.',
          difficulty: DifficultyLevel.BEGINNER,
          questionType: QuestionType.SHORT_ANSWER,
          reviewStatus: ReviewStatus.APPROVED,
          contentHash: `hash-test-${Date.now()}`,
          publishedAt: new Date(),
        },
      });
      publishedQuestionId = q.id;
    });

    it('GET /api/questions should return published questions with zero AI calls', async () => {
      const res = await request(app).get('/api/questions');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.questions)).toBe(true);
      expect(res.body.pagination).toBeDefined();
      expect(res.body.questions.length).toBeGreaterThan(0);

      const found = res.body.questions.find((q: any) => q.id === publishedQuestionId);
      expect(found).toBeDefined();
      expect(found.questionText).toContain('let, const, and var');
      expect(found.answerContent).toContain('block scoped');
    });

    it('GET /api/questions with technology and difficulty filters', async () => {
      const res = await request(app)
        .get(`/api/questions?technologyId=${testSkill.id}&difficulty=BEGINNER`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.questions)).toBe(true);
      expect(res.body.questions.every((q: any) => q.difficulty === 'BEGINNER')).toBe(true);
    });

    it('GET /api/questions/:id should return single question detail', async () => {
      const res = await request(app).get(`/api/questions/${publishedQuestionId}`);
      expect(res.status).toBe(200);
      expect(res.body.question.id).toBe(publishedQuestionId);
    });

    it('GET /api/technologies should list technologies that have published questions', async () => {
      const res = await request(app).get('/api/technologies');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.technologies)).toBe(true);
      const jsTech = res.body.technologies.find((t: any) => t.id === testSkill.id);
      expect(jsTech).toBeDefined();
      expect(jsTech.questionCount).toBeGreaterThan(0);
    });

    it('GET /api/technologies/:id/topics should return distinct topics', async () => {
      const res = await request(app).get(`/api/technologies/${testSkill.id}/topics`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.topics)).toBe(true);
      expect(res.body.topics).toContain('Closures');
    });
  });
});
