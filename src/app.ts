import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { authMiddleware } from './lib/auth/session.js';
import { securityHeadersMiddleware } from './lib/security/headers.js';
import { generalApiRateLimiter } from './lib/security/rate-limiter.js';
import authRoutes from './routes/auth.routes.js';
import resumeRoutes from './routes/resume.routes.js';
import adminRoutes from './routes/admin.routes.js';
import qaAdminRoutes from './routes/qa-admin.routes.js';
import { questionsRouter, technologiesRouter } from './routes/qa-public.routes.js';

const app = express();

const allowedOrigins = [
  process.env.CLIENT_URL || 'http://localhost:3000',
  process.env.ADMIN_URL || 'http://localhost:3001',
];

// Security Headers (OWASP)
app.use(securityHeadersMiddleware);

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (like mobile apps, curl, server-to-server)
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      // Strictly block unknown origins in production
      if (process.env.NODE_ENV === 'production') {
        return callback(new Error(`Origin ${origin} is not allowed by CORS.`));
      }
      // Permissive during local development and test mode
      return callback(null, true);
    },
    credentials: true,
  })
);

app.use(cookieParser());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Global authentication & guest session resolver
app.use(authMiddleware);

// Global rate limiting on API paths
app.use('/api', generalApiRateLimiter);

// Health check
app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', service: 'skilled-resume-backend', time: new Date() });
});

// Mount Routes
app.use('/api/auth', authRoutes);
app.use('/api/resumes', resumeRoutes);
app.use('/api/resume-analyses', resumeRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/admin', qaAdminRoutes);
app.use('/api/questions', questionsRouter);
app.use('/api/technologies', technologiesRouter);

// Global Error Handler
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const message = err instanceof Error ? err.message : 'Internal server error';
  console.error('[Backend Error]:', err);
  res.status(500).json({ error: message });
});

export default app;
