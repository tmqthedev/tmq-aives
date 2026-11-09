const request = require('supertest');
const pino = require('pino');
const { createApp } = require('../src/app');
const { InMemoryDatabase } = require('../src/db/createDatabase');
const { ACCESS_COOKIE } = require('../src/auth/cookieNames');
const { createRevisionContext } = require('./helpers/questionRevisionFakes');

describe('lecturer revision REST API with real service and transactional fakes', () => {
  let ctx;
  let app;
  let cookie;
  beforeEach(() => {
    ctx = createRevisionContext();
    app = createApp({ database: new InMemoryDatabase({ persist: false }), questionService: ctx.service,
      env: { awsMockMode: true, dbMockMode: true, appBaseUrl: 'http://localhost:5173' },
      logger: pino({ level: 'silent' }),
    });
    cookie = (role = 'LECTURER', sub = 7) => `${ACCESS_COOKIE}=${app.authContext.tokenService.signAccess({ role, sub }).token}`;
  });
  function save(body, auth = cookie()) {
    return request(app).put('/api/questions/1/revision').set('Origin', 'http://localhost:5173').set('Cookie', auth).send(body);
  }
  function publish(body, auth = cookie()) {
    return request(app).post('/api/questions/1/revision/publish').set('Origin', 'http://localhost:5173').set('Cookie', auth).send(body);
  }
  test('all revision endpoints require authentication and lecturer role; students receive no knowledge', async () => {
    for (const [method, path] of [['get', '/api/questions/1/revision'], ['put', '/api/questions/1/revision'], ['post', '/api/questions/1/revision/publish']]) {
      const noAuth = await request(app)[method](path).set('Origin', 'http://localhost:5173');
      expect(noAuth.status).toBe(401);
      for (const role of ['STUDENT', 'ADMIN']) {
        const response = await request(app)[method](path).set('Origin', 'http://localhost:5173').set('Cookie', cookie(role));
        expect(response.status).toBe(403);
        expect(JSON.stringify(response.body)).not.toContain('Original answer');
        expect(response.body.content).toBeUndefined();
      }
    }
  });
  test('assigned lecturer can save/view/update and explicitly publish; active version stays unchanged before review', async () => {
    expect((await request(app).get('/api/questions/1/revision').set('Cookie', cookie())).body).toBeNull();
    const created = await save({ patch: { referenceAnswer: 'Reviewed new answer' }, expectedVersion: 0, reviewedBy: 999 });
    expect(created.status).toBe(200);
    expect(created.body.version).toBe(1);
    expect(ctx.state().active.reference_answer).toBe('Original answer');
    // Unrelated persisted fields never enter the revision response DTO.
    ctx.state().revision.content.private_future_field = 'PRIVATE';
    ctx.state().revision.private_review_metadata = 'PRIVATE';
    const read = await request(app).get('/api/questions/1/revision').set('Cookie', cookie());
    expect(read.status).toBe(200);
    expect(JSON.stringify(read.body)).not.toContain('PRIVATE');
    const updated = await save({ patch: { keyPoints: ['Reviewed point'] }, revisionId: created.body.id, expectedVersion: 1 });
    expect(updated.body.version).toBe(2);
    // Test corruption above must not become publishable input; discard it before review.
    delete ctx.state().revision.content.private_future_field;
    const result = await publish({ revisionId: created.body.id, expectedVersion: 2, reviewedBy: 999 });
    expect(result.status).toBe(200);
    expect(result.body.question.referenceAnswer).toBe('Reviewed new answer');
    expect(ctx.state().active.reviewed_by).toBe(7);
    expect(ctx.state().revision.status).toBe('PUBLISHED');
  });
  test('subject scope denies read/save/publish without disclosing or changing knowledge', async () => {
    const outsider = cookie('LECTURER', 8);
    expect((await request(app).get('/api/questions/1/revision').set('Cookie', outsider)).status).toBe(403);
    expect((await save({ patch: { content: 'No access' }, expectedVersion: 0 }, outsider)).status).toBe(403);
    expect((await publish({ revisionId: 1, expectedVersion: 1 }, outsider)).status).toBe(403);
    expect(ctx.state().revision).toBeNull();
  });
  test('stale identity/version conflicts and incomplete reviews cannot publish', async () => {
    const created = await save({ patch: { referenceAnswer: '' }, expectedVersion: 0 });
    expect((await save({ patch: { content: 'Stale' }, expectedVersion: 0 })).status).toBe(409);
    expect((await publish({ revisionId: created.body.id + 1, expectedVersion: 1 })).body.code).toBe('REVISION_CONFLICT');
    expect((await publish({ revisionId: created.body.id, expectedVersion: 2 })).body.code).toBe('REVISION_CONFLICT');
    expect((await publish({ revisionId: created.body.id, expectedVersion: 1 })).body.code).toBe('QUESTION_INCOMPLETE');
    expect(ctx.state().active.reference_answer).toBe('Original answer');
  });
  test('validates identifiers/concurrency fields, rejects unsafe fields and enforces CSRF', async () => {
    expect((await request(app).get('/api/questions/0/revision').set('Cookie', cookie())).status).toBe(400);
    expect((await save({ patch: { content: 'Draft' }, expectedVersion: '0' })).status).toBe(400);
    expect((await save({ patch: { status: 'APPROVED' }, expectedVersion: 0 })).status).toBe(400);
    await save({ patch: { content: 'Draft' }, expectedVersion: 0 });
    expect((await save({ patch: { content: 'Next' }, expectedVersion: 1 })).status).toBe(400);
    expect((await publish({ expectedVersion: 1 })).status).toBe(400);
    const csrf = await request(app).put('/api/questions/1/revision').set('Origin', 'https://untrusted.invalid').set('Cookie', cookie()).send({});
    expect(csrf.status).toBe(403);
    expect(csrf.body.code).toBe('FORBIDDEN_ORIGIN');
  });
  test('existing active PUT guard remains enforced', async () => {
    const response = await request(app).put('/api/questions/1').set('Origin', 'http://localhost:5173').set('Cookie', cookie()).send({ referenceAnswer: 'Bypass' });
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('QUESTION_REVISION_REQUIRED');
    expect(ctx.state().active.reference_answer).toBe('Original answer');
  });
});
