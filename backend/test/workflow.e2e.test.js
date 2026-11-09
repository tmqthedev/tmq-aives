const fs = require('fs');
const request = require('supertest');
const { createTestContext } = require('./helpers/createTestContext');

describe('AIVES System - E2E Workflows', () => {
  let t;
  let app;
  let db;
  let testDbPath;
  let testEnv;
  let lecturerCookie;

  const ctx = {
    topicId: null,
    rubricId: null,
    questionId: null,
    sessionId: null,
    objectKey: null,
  };

  beforeAll(() => {
    t = createTestContext('aives-workflow-');
    ({ app, db, testDbPath, testEnv, lecturerCookie } = t);
  });

  afterAll(async () => {
    if (t) await t.cleanup();
  });

  // ---------------------------------------------------------------------------
  // Luồng 1: Giảng viên thiết lập kỳ thi
  // ---------------------------------------------------------------------------
  describe('Luồng 1: Giảng viên thiết lập kỳ thi (Lecturer Exam Setup)', () => {
    test('B1: POST /topics tạo Topic mới -> 201', async () => {
      const res = await request(app)
        .post('/api/topics').set('Cookie', lecturerCookie)
        .send({
          name: 'Node.js Internals & Event Loop',
          course_id: 'SWD392',
        })
        .expect('Content-Type', /json/);

      expect(res.status).toBe(201);
      expect(typeof res.body.topic_id).toBe('number');
      expect(res.body.topic_id).toBeGreaterThan(0);
      expect(res.body.name).toBe('Node.js Internals & Event Loop');
      expect(res.body.course_id).toBe('SWD392');

      ctx.topicId = res.body.topic_id;
    });

    test('B2: POST /rubrics tạo Rubric kèm tiêu chí -> 201', async () => {
      const res = await request(app)
        .post('/api/rubrics').set('Cookie', lecturerCookie)
        .send({
          maxScore: 10,
          criteria: [
            { name: 'Technical Accuracy', weightPercent: 40, description: 'Correct explanation of Event Loop phases' },
            { name: 'Clarity & Structure', weightPercent: 30, description: 'Logical flow and clear terminology' },
            { name: 'Practical Examples', weightPercent: 30, description: 'Real-world scenarios mentioned' },
          ],
        })
        .expect('Content-Type', /json/);

      expect(res.status).toBe(201);
      expect(typeof res.body.id).toBe('number');
      expect(res.body.id).toBeGreaterThan(0);
      expect(res.body.maxScore).toBe(10);
      expect(Array.isArray(res.body.criteria)).toBe(true);
      expect(res.body.criteria).toHaveLength(3);

      ctx.rubricId = res.body.id;
    });

    test('B3: POST /questions tạo Question -> 201', async () => {
      expect(ctx.topicId).not.toBeNull();
      expect(ctx.rubricId).not.toBeNull();

      const res = await request(app)
        .post('/api/questions')
        .set('Cookie', lecturerCookie)
        .send({
          topicId: ctx.topicId,
          rubricId: ctx.rubricId,
          content: 'Explain how the Node.js Event Loop handles asynchronous I/O.',
          language: 'en',
          bloomLevel: 'UNDERSTAND',
        })
        .expect('Content-Type', /json/);

      expect(res.status).toBe(201);
      // Create now returns a { question, warnings } envelope.
      expect(Array.isArray(res.body.warnings)).toBe(true);
      const { question } = res.body;
      expect(typeof question.id).toBe('number');
      expect(question.id).toBeGreaterThan(0);
      expect(question).toEqual(
        expect.objectContaining({
          topicId: ctx.topicId,
          rubricId: ctx.rubricId,
          // Never auto-approved: a lecturer must review it explicitly.
          status: 'PENDING_REVIEW',
          content: expect.any(String),
        }),
      );

      ctx.questionId = question.id;
    });

    test('B3b: POST /questions without a LECTURER session -> 401', async () => {
      const res = await request(app)
        .post('/api/questions')
        .send({ topicId: ctx.topicId, content: 'Unauthorized attempt', language: 'en' });
      expect(res.status).toBe(401);
    });
  });

  // ---------------------------------------------------------------------------
  // Luồng 2: Legacy audio routes removed -> 404
  // ---------------------------------------------------------------------------
  describe('Luồng 2: Legacy audio routes removed -> 404', () => {
    test('B4: POST /api/audio/upload-url trả 404 vì đã gỡ bỏ', async () => {
      const res = await request(app)
        .post('/api/audio/upload-url')
        .send({ contentType: 'audio/webm', candidateId: 'SE150000' });

      expect(res.status).toBe(404);
      ctx.sessionId = '11111111-2222-3333-4444-555555555555';
      ctx.objectKey = `sessions/${ctx.sessionId}/input.webm`;
    });

    test('B5: POST /api/audio/process trả 404 vì đã gỡ bỏ', async () => {
      const res = await request(app)
        .post('/api/audio/process')
        .send({ sessionId: ctx.sessionId, objectKey: ctx.objectKey });

      expect(res.status).toBe(404);
    });

    test('B5b: GET /api/audio/status và result trả 404 vì đã gỡ bỏ', async () => {
      const statusRes = await request(app).get(`/api/audio/status/${ctx.sessionId}`);
      expect(statusRes.status).toBe(404);
      const resultRes = await request(app).get(`/api/audio/result/${ctx.sessionId}`);
      expect(resultRes.status).toBe(404);
    });
  });

  // ---------------------------------------------------------------------------
  // Luồng 3: Legacy evaluation scaffolds removed -> 404
  // (lecturer review now lives in the grading routes, see gradingReview.e2e)
  // ---------------------------------------------------------------------------
  describe('Luồng 3: Legacy evaluation routes removed -> 404', () => {
    test('B6: /api/evaluations và /api/lecturer trả 404 vì đã gỡ bỏ', async () => {
      for (const url of ['/api/evaluations', '/api/lecturer/sessions']) {
        expect((await request(app).get(url).set('Cookie', lecturerCookie)).status).toBe(404);
      }
      const res = await request(app)
        .post('/api/evaluations').set('Cookie', lecturerCookie)
        .send({ session_id: ctx.sessionId, question_id: ctx.questionId, status: 'PENDING' });
      expect(res.status).toBe(404);
    });
  });

  // ---------------------------------------------------------------------------
  // Kiểm chứng cô lập dữ liệu
  // ---------------------------------------------------------------------------
  describe('Data isolation & persistence', () => {
    test('Dữ liệu được ghi vào file JSON test riêng', async () => {
      await db.flush();
      expect(fs.existsSync(testDbPath)).toBe(true);

      const data = JSON.parse(fs.readFileSync(testDbPath, 'utf8'));
      const find = (entries, id) => (entries.find(([key]) => key === id) || [])[1];

      expect(find(data.topics, ctx.topicId)).toEqual(expect.objectContaining({ course_id: 'SWD392' }));
      expect(find(data.rubrics, ctx.rubricId)).toEqual(expect.objectContaining({ max_score: 10 }));
      expect(data.rubricCriteria.filter(([, c]) => c.rubric_id === ctx.rubricId)).toHaveLength(3);
      expect(find(data.questions, ctx.questionId)).toEqual(
        expect.objectContaining({ topic_id: ctx.topicId, rubric_id: ctx.rubricId }),
      );
    });

    test('File mock-database.json gốc không bị thay đổi', () => {
      expect(t.originalDbUnchanged()).toBe(true);
    });
  });
});
