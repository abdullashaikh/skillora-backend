import { Router, Request, Response } from 'express';
import { QuestionBankService } from '../lib/qa/question-bank-service.js';

export const questionsRouter = Router();
export const technologiesRouter = Router();

// ==========================================
// Public Question Bank Routes (/api/questions)
// ==========================================

// GET /api/questions
questionsRouter.get('/', async (req: Request, res: Response) => {
  try {
    const result = await QuestionBankService.getPublishedQuestions({
      technologyId: req.query.technologyId as string,
      topic: req.query.topic as string,
      difficulty: req.query.difficulty as any,
      questionType: req.query.questionType as any,
      search: req.query.search as string,
      page: parseInt((req.query.page as string) || '1', 10),
      limit: parseInt((req.query.limit as string) || '10', 10),
    });
    return res.json(result);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Failed to query questions';
    return res.status(500).json({ error: msg });
  }
});

// GET /api/questions/:id
questionsRouter.get('/:id', async (req: Request, res: Response) => {
  try {
    const question = await QuestionBankService.getPublishedQuestionById(req.params.id);
    if (!question) {
      return res.status(404).json({ error: 'Question not found or not published.' });
    }
    return res.json({ question });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Failed to retrieve question';
    return res.status(500).json({ error: msg });
  }
});

// ==========================================
// Public Technologies Routes (/api/technologies)
// ==========================================

// GET /api/technologies
technologiesRouter.get('/', async (_req: Request, res: Response) => {
  try {
    const technologies = await QuestionBankService.getAvailableTechnologies();
    return res.json({ technologies });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Failed to fetch technologies';
    return res.status(500).json({ error: msg });
  }
});

// GET /api/technologies/:id/topics
technologiesRouter.get('/:id/topics', async (req: Request, res: Response) => {
  try {
    const topics = await QuestionBankService.getTopicsForTechnology(req.params.id);
    return res.json({ topics });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Failed to fetch topics';
    return res.status(500).json({ error: msg });
  }
});
