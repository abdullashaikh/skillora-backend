import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import app from '../app.js';

describe('Express REST API Endpoints', () => {
  it('GET /health returns status ok', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.service).toBe('skilled-resume-backend');
  });

  it('GET /api/admin/ai-config returns 403 for unauthorized guests', async () => {
    const res = await request(app).get('/api/admin/ai-config');
    expect(res.status).toBe(403);
    expect(res.body.error).toContain('Administrator access required');
  });

  it('GET /api/auth/me returns guest context when no token is present', async () => {
    const res = await request(app).get('/api/auth/me');
    expect(res.status).toBe(200);
    expect(res.body.user).toBeNull();
    expect(res.body.isGuest).toBe(true);
    expect(res.body.guestSessionId).toBeDefined();
  });
});
