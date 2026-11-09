/**
 * AIVES - Critical CRUD E2E tests (Jest + Supertest)
 *
 * Kiểm chứng đầy đủ vòng đời Create -> Read -> Update -> Delete cho 3 resource:
 *   Topic (/topics), Rubric (/rubrics), Question (/questions)
 * gồm happy path + các case critical:
 *   - validation (400), not found (404), invalid id (400)
 *   - ràng buộc nghiệp vụ / toàn vẹn dữ liệu (409: duplicate, đang được tham chiếu)
 *   - bảo mật: không cho ghi đè khóa chính / cột ngoài whitelist qua PATCH
 *   - dữ liệu persist đúng vào file JSON test và DB gốc không bị đụng tới
 *
 * Các test trong file chạy TUẦN TỰ và chia sẻ state (ID) với nhau.
 */
const request = require('supertest');
const { createTestContext } = require('./helpers/createTestContext');

const VALID_CRITERIA = [
  { name: 'Accuracy', weightPercent: 60, description: 'Correctness of the answer' },
  { name: 'Clarity', weightPercent: 40 },
];

describe('AIVES - Critical CRUD E2E', () => {
  let t;
  let app;

  const ids = {
    topic: null,        // topic sẽ được question tham chiếu
    spareTopic: null,   // topic không bị tham chiếu -> xoá được
    rubric: null,       // rubric sẽ được question tham chiếu
    spareRubric: null,  // rubric không bị tham chiếu -> xoá được
    question: null,
    otherQuestion: null,
  };

  let lecturerCookie;
  let studentCookie;

  const api = () => request(app);
  // /questions and /rubrics write/lifecycle routes are guarded by
  // requireAuth + requireRole('LECTURER') from Step 2/3. These helpers attach a
  // signed LECTURER access cookie so the suite exercises the authorized path.
  const lec = (req) => req.set('Cookie', lecturerCookie);

  beforeAll(() => {
    t = createTestContext('aives-crud-');
    ({ app, lecturerCookie, studentCookie } = t);
  });

  afterAll(async () => {
    if (t) await t.cleanup();
  });

  // ===========================================================================
  // TOPIC
  // ===========================================================================
  describe('Topic CRUD', () => {
    test('legacy routes require a signed-in LECTURER/ADMIN (401 anonymous, 403 student)', async () => {
      for (const url of ['/api/topics']) {
        expect((await api().get(url)).status).toBe(401);
        expect((await api().get(url).set('Cookie', studentCookie)).status).toBe(403);
      }
      expect((await api().post('/api/topics').send({ name: 'anon' })).status).toBe(401);
    });

    test('C: POST /topics -> 201 với topic_id tự tăng', async () => {
      const res = await lec(api().post('/api/topics')).send({ name: '  OOP Fundamentals  ', course_id: 'SWD392' });

      expect(res.status).toBe(201);
      expect(res.body).toEqual({ topic_id: expect.any(Number), name: 'OOP Fundamentals', course_id: 'SWD392', subject_id: null });
      ids.topic = res.body.topic_id;

      const res2 = await lec(api().post('/api/topics')).send({ name: 'Design Patterns' });
      expect(res2.status).toBe(201);
      expect(res2.body.topic_id).toBe(ids.topic + 1);
      expect(res2.body.course_id).toBeNull();
      ids.spareTopic = res2.body.topic_id;
    });

    test.each([
      ['thiếu name', { course_id: 'SWD392' }],
      ['name rỗng', { name: '   ' }],
      ['name không phải string', { name: 123 }],
    ])('C: POST /topics %s -> 400', async (_label, body) => {
      const res = await lec(api().post('/api/topics')).send(body);
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/name is required/i);
    });

    test('C: POST /topics với subject_id không hợp lệ -> 400', async () => {
      const res = await lec(api().post('/api/topics')).send({ name: 'Bad subject', subject_id: 'abc' });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/subject_id/);
    });

    test('C: POST /topics không có body -> 400 (không được crash 500)', async () => {
      const res = await lec(api().post('/api/topics'));
      expect(res.status).toBe(400);
    });

    test('R: GET /topics trả danh sách đã sắp xếp theo id', async () => {
      const res = await lec(api().get('/api/topics'));
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.map((x) => x.topic_id)).toEqual([ids.topic, ids.spareTopic]);
    });

    test('R: GET /topics/:id -> 200', async () => {
      const res = await lec(api().get(`/api/topics/${ids.topic}`));
      expect(res.status).toBe(200);
      expect(res.body.name).toBe('OOP Fundamentals');
    });

    test('R: GET /topics/:id không tồn tại -> 404', async () => {
      const res = await lec(api().get('/api/topics/9999'));
      expect(res.status).toBe(404);
      expect(res.body.message).toBe('Topic not found');
    });

    test.each(['abc', '0', '-1', '1.5'])('R: GET /topics/%s (id không hợp lệ) -> 400', async (badId) => {
      const res = await lec(api().get(`/api/topics/${badId}`));
      expect(res.status).toBe(400);
    });

    test('U: PATCH /topics/:id cập nhật name & course_id -> 200', async () => {
      const res = await lec(api()
        .patch(`/api/topics/${ids.topic}`))
        .send({ name: 'OOP Fundamentals (Java)', course_id: 'PRO192' });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ topic_id: ids.topic, name: 'OOP Fundamentals (Java)', course_id: 'PRO192', subject_id: null });

      const check = await lec(api().get(`/api/topics/${ids.topic}`));
      expect(check.body.name).toBe('OOP Fundamentals (Java)');
    });

    test('U [critical]: PATCH không được ghi đè topic_id (khoá chính)', async () => {
      const res = await lec(api().patch(`/api/topics/${ids.topic}`)).send({ name: 'OOP', topic_id: 777 });
      expect(res.status).toBe(200);
      expect(res.body.topic_id).toBe(ids.topic);
      expect((await lec(api().get('/api/topics/777'))).status).toBe(404);
    });

    test('U [critical]: PATCH với key lạ / SQL injection trong tên cột bị từ chối', async () => {
      const res = await lec(api()
        .patch(`/api/topics/${ids.topic}`))
        .send({ 'name = name; DROP TABLE topic; --': 'x' });
      expect(res.status).toBe(400);

      const check = await lec(api().get(`/api/topics/${ids.topic}`));
      expect(check.status).toBe(200);
      expect(check.body.name).toBe('OOP');
    });

    test('U: PATCH name rỗng -> 400, body rỗng -> 400, id không tồn tại -> 404', async () => {
      expect((await lec(api().patch(`/api/topics/${ids.topic}`)).send({ name: '' })).status).toBe(400);
      expect((await lec(api().patch(`/api/topics/${ids.topic}`)).send({})).status).toBe(400);
      expect((await lec(api().patch('/api/topics/9999')).send({ name: 'x' })).status).toBe(404);
    });
  });

  // ===========================================================================
  // RUBRIC
  // ===========================================================================
  describe('Rubric CRUD', () => {
    test('C: POST /rubrics -> 201 kèm criteria (shape mới có version/isLocked/performanceLevels)', async () => {
      const res = await lec(api().post('/api/rubrics')).send({ maxScore: 10, criteria: VALID_CRITERIA });

      expect(res.status).toBe(201);
      expect(res.body).toEqual({
        id: expect.any(Number),
        name: null,
        maxScore: 10,
        subjectId: null,
        version: 1,
        isLocked: false,
        criteria: [
          {
            id: expect.any(Number), name: 'Accuracy', weightPercent: 60, description: 'Correctness of the answer', orderIndex: 1, performanceLevels: [],
          },
          {
            id: expect.any(Number), name: 'Clarity', weightPercent: 40, description: null, orderIndex: 2, performanceLevels: [],
          },
        ],
      });
      ids.rubric = res.body.id;

      const spare = await lec(api().post('/api/rubrics')).send({ maxScore: 5, criteria: [{ name: 'Overall', weightPercent: 100 }] });
      expect(spare.status).toBe(201);
      ids.spareRubric = spare.body.id;
    });

    test('C [auth]: POST /rubrics không đăng nhập -> 401, STUDENT -> 403', async () => {
      expect((await api().post('/api/rubrics').send({ maxScore: 5, criteria: [{ name: 'X', weightPercent: 100 }] })).status).toBe(401);
      expect((await api().post('/api/rubrics').set('Cookie', studentCookie)
        .send({ maxScore: 5, criteria: [{ name: 'X', weightPercent: 100 }] })).status).toBe(403);
    });

    test.each([
      ['tổng weight != 100', 400, { maxScore: 10, criteria: [{ name: 'A', weightPercent: 50 }, { name: 'B', weightPercent: 40 }] }],
      ['maxScore <= 0', 400, { maxScore: 0, criteria: [{ name: 'A', weightPercent: 100 }] }],
      ['criteria rỗng', 400, { maxScore: 10, criteria: [] }],
      ['weight > 100', 400, { maxScore: 10, criteria: [{ name: 'A', weightPercent: 150 }] }],
      ['criterion thiếu name', 400, { maxScore: 10, criteria: [{ weightPercent: 100 }] }],
      ['trùng tên criterion (case-insensitive)', 409, { maxScore: 10, criteria: [{ name: 'Logic', weightPercent: 50 }, { name: ' logic ', weightPercent: 50 }] }],
    ])('C: POST /rubrics %s -> %i', async (_label, expected, body) => {
      const before = (await lec(api().get('/api/rubrics'))).body.length;
      const res = await lec(api().post('/api/rubrics')).send(body);
      expect(res.status).toBe(expected);
      // Không được tạo rubric "mồ côi" khi validate fail
      expect((await lec(api().get('/api/rubrics'))).body.length).toBe(before);
    });

    test('R: GET /rubrics và GET /rubrics/:id', async () => {
      const list = await lec(api().get('/api/rubrics'));
      expect(list.status).toBe(200);
      expect(list.body.map((r) => r.id)).toEqual([ids.rubric, ids.spareRubric]);

      const one = await lec(api().get(`/api/rubrics/${ids.rubric}`));
      expect(one.status).toBe(200);
      expect(one.body.criteria).toHaveLength(2);
    });

    test('R: GET /rubrics/:id không tồn tại -> 404, id sai -> 400', async () => {
      expect((await lec(api().get('/api/rubrics/9999'))).status).toBe(404);
      expect((await lec(api().get('/api/rubrics/abc'))).status).toBe(400);
    });

    test('U: PUT /rubrics/:id thay maxScore và toàn bộ criteria -> 200', async () => {
      const res = await lec(api().put(`/api/rubrics/${ids.rubric}`))
        .send({
          maxScore: 20,
          criteria: [
            { name: 'Accuracy', weightPercent: 50 },
            { name: 'Clarity', weightPercent: 30 },
            { name: 'Depth', weightPercent: 20 },
          ],
        });

      expect(res.status).toBe(200);
      expect(res.body.maxScore).toBe(20);
      expect(res.body.criteria.map((c) => c.name)).toEqual(['Accuracy', 'Clarity', 'Depth']);
      expect(res.body.criteria.reduce((s, c) => s + c.weightPercent, 0)).toBe(100);

      // Criteria cũ phải bị xoá, không còn sót trong DB
      const persisted = await t.db.readPersisted();
      expect(persisted.rubricCriteria.filter(([, c]) => c.rubric_id === ids.rubric)).toHaveLength(3);
    });

    test('U: PUT chỉ maxScore giữ nguyên criteria', async () => {
      const res = await lec(api().put(`/api/rubrics/${ids.rubric}`)).send({ maxScore: 10 });
      expect(res.status).toBe(200);
      expect(res.body.maxScore).toBe(10);
      expect(res.body.criteria).toHaveLength(3);
    });

    test('U: PUT lỗi -> 400 (weight sai / criterion id của rubric khác / body rỗng), 404 khi không tồn tại', async () => {
      expect((await lec(api().put(`/api/rubrics/${ids.rubric}`)).send({ criteria: [{ name: 'A', weightPercent: 10 }] })).status).toBe(400);

      const spare = await lec(api().get(`/api/rubrics/${ids.spareRubric}`));
      const foreignCriterionId = spare.body.criteria[0].id;
      const res = await lec(api().put(`/api/rubrics/${ids.rubric}`))
        .send({ criteria: [{ id: foreignCriterionId, name: 'Hijack', weightPercent: 100 }] });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/criterion reference/i);

      expect((await lec(api().put(`/api/rubrics/${ids.rubric}`)).send({})).status).toBe(400);
      expect((await lec(api().put('/api/rubrics/9999')).send({ maxScore: 5 })).status).toBe(404);
    });

    test('U [new]: POST /rubrics/:id/clone sao chép criteria và bump version, is_locked=false', async () => {
      const clone = await lec(api().post(`/api/rubrics/${ids.rubric}/clone`));
      expect(clone.status).toBe(201);
      expect(clone.body.id).not.toBe(ids.rubric);
      expect(clone.body.version).toBe(2);
      expect(clone.body.isLocked).toBe(false);
      expect(clone.body.criteria.map((c) => c.name)).toEqual(['Accuracy', 'Clarity', 'Depth']);
      // Dọn dẹp bản clone để không ảnh hưởng các assert đếm phía sau.
      expect((await lec(api().delete(`/api/rubrics/${clone.body.id}`))).status).toBe(200);
    });
  });

  // ===========================================================================
  // QUESTION
  // ===========================================================================
  describe('Question CRUD', () => {
    // A question can only be approved with a reference answer, key points and a
    // rubric. The offline mock DB does not round-trip those columns on INSERT,
    // so they are set with a PUT (while the question is still unapproved).
    const completeAndApprove = async (id) => {
      const put = await lec(api().put(`/api/questions/${id}`)).send({
        rubricId: ids.rubric,
        referenceAnswer: 'Reference answer.',
        keyPoints: ['Key point one'],
      });
      expect(put.status).toBe(200);
      return lec(api().post(`/api/questions/${id}/approve`));
    };

    test('C: POST /questions -> 201 (envelope { question, warnings }), không tự APPROVED: PENDING_REVIEW khi đủ topic+rubric', async () => {
      const res = await lec(api().post('/api/questions')).send({
        topicId: ids.topic,
        rubricId: ids.rubric,
        content: 'What is polymorphism?',
        language: 'en',
        bloomLevel: 'UNDERSTAND',
      });

      expect(res.status).toBe(201);
      expect(Array.isArray(res.body.warnings)).toBe(true);
      // NOTE: the offline in-memory DB only round-trips topic/rubric/content/
      // status, so source/bloom are not asserted here (they are covered by the
      // fake-repo unit tests, which persist every column).
      expect(res.body.question).toEqual(
        expect.objectContaining({
          id: expect.any(Number),
          topicId: ids.topic,
          rubricId: ids.rubric,
          content: 'What is polymorphism?',
          status: 'PENDING_REVIEW',
        }),
      );
      ids.question = res.body.question.id;

      // Thiếu rubric => mặc định DRAFT.
      const other = await lec(api().post('/api/questions')).send({
        topicId: ids.topic,
        content: 'What is encapsulation?',
        language: 'en',
      });
      expect(other.status).toBe(201);
      expect(other.body.question.rubricId).toBeNull();
      expect(other.body.question.status).toBe('DRAFT');
      ids.otherQuestion = other.body.question.id;
    });

    test('H3: STUDENT không đọc được ngân hàng câu hỏi hay rubric (lộ đáp án) -> 403', async () => {
      for (const url of ['/api/questions', '/api/questions/1', '/api/questions/1/sources', '/api/rubrics', '/api/rubrics/1']) {
        const res = await api().get(url).set('Cookie', studentCookie);
        expect(res.status).toBe(403);
      }
    });

    test('C [auth]: POST /questions không đăng nhập -> 401, STUDENT -> 403', async () => {
      expect((await api().post('/api/questions').send({ topicId: ids.topic, content: 'nope', language: 'en' })).status).toBe(401);
      expect((await api().post('/api/questions').set('Cookie', studentCookie)
        .send({ topicId: ids.topic, content: 'nope', language: 'en' })).status).toBe(403);
    });

    test.each([
      ['trùng nội dung (case/space-insensitive)', 409, () => ({ topicId: ids.topic, content: '  WHAT IS POLYMORPHISM?  ', language: 'en' })],
      ['status không hợp lệ', 400, () => ({ topicId: ids.topic, content: 'Q status', language: 'en', status: 'Published' })],
      ['thiếu content', 400, () => ({ topicId: ids.topic, language: 'en' })],
      ['topicId không phải số nguyên dương', 400, () => ({ topicId: 'abc', content: 'Q x', language: 'en' })],
      ['bloom không hợp lệ', 400, () => ({ topicId: ids.topic, content: 'Q bloom', language: 'en', bloomLevel: 'CREATE' })],
    ])('C: POST /questions %s -> %i', async (_label, expected, makeBody) => {
      const before = (await lec(api().get('/api/questions'))).body.length;
      const res = await lec(api().post('/api/questions')).send(makeBody());
      expect(res.status).toBe(expected);
      expect((await lec(api().get('/api/questions'))).body.length).toBe(before);
    });

    test('R: GET /questions, GET /questions/:id, lọc theo status, 404, id sai 400', async () => {
      const list = await lec(api().get('/api/questions'));
      expect(list.status).toBe(200);
      expect(list.body.map((q) => q.id)).toEqual([ids.question, ids.otherQuestion]);

      // Lọc theo status mới.
      const pending = await lec(api().get('/api/questions').query({ status: 'PENDING_REVIEW' }));
      expect(pending.status).toBe(200);
      expect(pending.body.every((q) => q.status === 'PENDING_REVIEW')).toBe(true);
      expect(pending.body.some((q) => q.id === ids.question)).toBe(true);
      // Nothing is auto-approved, so the APPROVED filter is empty here.
      const approved = await lec(api().get('/api/questions').query({ status: 'APPROVED' }));
      expect(approved.status).toBe(200);
      expect(approved.body).toEqual([]);

      // Lọc theo topicId
      const byTopic = await lec(api().get('/api/questions').query({ topicId: ids.topic }));
      expect(byTopic.status).toBe(200);
      expect(byTopic.body.every((q) => q.topicId === ids.topic)).toBe(true);
      const byOtherTopic = await lec(api().get('/api/questions').query({ topicId: 99999 }));
      expect(byOtherTopic.status).toBe(200);
      expect(byOtherTopic.body).toEqual([]);

      const one = await lec(api().get(`/api/questions/${ids.question}`));
      expect(one.status).toBe(200);
      expect(one.body.content).toBe('What is polymorphism?');

      expect((await lec(api().get('/api/questions/9999'))).status).toBe(404);
      expect((await lec(api().get('/api/questions/xyz'))).status).toBe(400);
    });

    test('U: PUT /questions/:id cập nhật content/rubric -> 200, status không đổi', async () => {
      const res = await lec(api().put(`/api/questions/${ids.otherQuestion}`))
        .send({ content: 'Explain encapsulation with an example.', rubricId: ids.rubric });

      expect(res.status).toBe(200);
      expect(res.body).toEqual(
        expect.objectContaining({
          id: ids.otherQuestion,
          content: 'Explain encapsulation with an example.',
          status: 'DRAFT',
          rubricId: ids.rubric,
        }),
      );
    });

    test('H1: create/update không thể bỏ qua state machine hay rubric', async () => {
      // Tạo thẳng APPROVED -> 400 (phải đi qua /approve).
      const direct = await lec(api().post('/api/questions')).send({
        topicId: ids.topic, content: 'H1 direct approved', language: 'en', status: 'APPROVED',
      });
      expect(direct.status).toBe(400);

      // PUT status=APPROVED trên câu DRAFT không rubric -> 400, vẫn DRAFT.
      const made = await lec(api().post('/api/questions')).send({
        topicId: ids.topic, content: 'H1 lifecycle probe', language: 'en',
      });
      const id = made.body.question.id;
      const viaPut = await lec(api().put(`/api/questions/${id}`)).send({ status: 'APPROVED' });
      expect(viaPut.status).toBe(400);
      expect((await lec(api().get(`/api/questions/${id}`))).body.status).toBe('DRAFT');

      // ARCHIVED là trạng thái cuối: không thể "hồi sinh" bằng PUT.
      expect((await completeAndApprove(id)).status).toBe(200);
      expect((await lec(api().post(`/api/questions/${id}/archive`))).status).toBe(200);
      expect((await lec(api().put(`/api/questions/${id}`)).send({ status: 'DRAFT' })).status).toBe(409);
      expect((await lec(api().put(`/api/questions/${id}`)).send({ status: 'APPROVED' })).status).toBe(400);

      // Câu APPROVED không được gỡ rubric.
      const keep = await lec(api().post('/api/questions')).send({
        topicId: ids.topic, rubricId: ids.rubric, content: 'H1 keeps rubric', language: 'en',
      });
      expect(keep.body.question.status).toBe('PENDING_REVIEW');
      expect((await completeAndApprove(keep.body.question.id)).status).toBe(200);
      const strip = await lec(api().put(`/api/questions/${keep.body.question.id}`)).send({ rubricId: null });
      expect(strip.status).toBe(409);
      // Approved content (including its rubric) is protected: changing it needs a revision.
      expect(strip.body.code).toBe('QUESTION_REVISION_REQUIRED');

      await lec(api().delete(`/api/questions/${id}`));
      await lec(api().delete(`/api/questions/${keep.body.question.id}`));
    });

    test('U: PUT giữ nguyên content của chính nó không bị coi là duplicate', async () => {
      const res = await lec(api().put(`/api/questions/${ids.question}`)).send({ content: 'What is polymorphism?' });
      expect(res.status).toBe(200);
    });

    test('U: PUT rubricId=null để gỡ rubric khỏi câu hỏi', async () => {
      const res = await lec(api().put(`/api/questions/${ids.otherQuestion}`)).send({ rubricId: null });
      expect(res.status).toBe(200);
      expect(res.body.rubricId).toBeNull();
      // Khôi phục rubric cho các bước ràng buộc tham chiếu phía sau.
      await lec(api().put(`/api/questions/${ids.otherQuestion}`)).send({ rubricId: ids.rubric });
    });

    test('U: PUT lỗi -> 409 trùng câu khác, 400 body rỗng/status sai/FK sai, 404 không tồn tại', async () => {
      expect((await lec(api().put(`/api/questions/${ids.otherQuestion}`)).send({ content: 'what is POLYMORPHISM?' })).status).toBe(409);
      expect((await lec(api().put(`/api/questions/${ids.question}`)).send({})).status).toBe(400);
      expect((await lec(api().put(`/api/questions/${ids.question}`)).send({ status: 'Published' })).status).toBe(400);
      expect((await lec(api().put(`/api/questions/${ids.question}`)).send({ topicId: 9999 })).status).toBe(400);
      expect((await lec(api().put('/api/questions/9999')).send({ status: 'DRAFT' })).status).toBe(404);
    });

    test('U [new lifecycle]: approve cần rubric, reject cần reason, transition sai -> 409', async () => {
      // Tạo một câu DRAFT không rubric để kiểm chứng approve yêu cầu rubric.
      const draft = await lec(api().post('/api/questions')).send({
        topicId: ids.topic, content: 'Lifecycle draft without rubric', language: 'en',
      });
      const draftId = draft.body.question.id;

      // approve khi chưa có rubric -> 409 RUBRIC_REQUIRED
      const approveNoRubric = await lec(api().post(`/api/questions/${draftId}/approve`));
      expect(approveNoRubric.status).toBe(409);
      expect(approveNoRubric.body.code).toBe('RUBRIC_REQUIRED');

      // Có rubric nhưng thiếu đáp án tham chiếu/key points -> 409 QUESTION_INCOMPLETE
      await lec(api().put(`/api/questions/${draftId}`)).send({ rubricId: ids.rubric });
      const approveIncomplete = await lec(api().post(`/api/questions/${draftId}/approve`));
      expect(approveIncomplete.status).toBe(409);
      expect(approveIncomplete.body.code).toBe('QUESTION_INCOMPLETE');

      // Đủ rubric + đáp án + key points rồi approve -> APPROVED
      const approved = await completeAndApprove(draftId);
      expect(approved.status).toBe(200);
      expect(approved.body.status).toBe('APPROVED');

      // APPROVED -> REJECTED là transition không hợp lệ -> 409 INVALID_TRANSITION
      const badReject = await lec(api().post(`/api/questions/${draftId}/reject`)).send({ reason: 'x' });
      expect(badReject.status).toBe(409);
      expect(badReject.body.code).toBe('INVALID_TRANSITION');

      // Approved content is protected: editing it needs a revision.
      const editApproved = await lec(api().put(`/api/questions/${draftId}`)).send({ content: 'Changed' });
      expect(editApproved.status).toBe(409);
      expect(editApproved.body.code).toBe('QUESTION_REVISION_REQUIRED');

      // Câu PENDING_REVIEW riêng để test reject thiếu reason.
      const pendingRes = await lec(api().post('/api/questions')).send({
        topicId: ids.topic, rubricId: ids.rubric, content: 'Lifecycle pending question', language: 'en',
      });
      expect(pendingRes.body.question.status).toBe('PENDING_REVIEW');
      const pendingId = pendingRes.body.question.id;
      const rejectNoReason = await lec(api().post(`/api/questions/${pendingId}/reject`)).send({});
      expect(rejectNoReason.status).toBe(400);
      expect(rejectNoReason.body.code).toBe('REASON_REQUIRED');

      const rejected = await lec(api().post(`/api/questions/${pendingId}/reject`)).send({ reason: 'Too broad' });
      expect(rejected.status).toBe(200);
      expect(rejected.body.status).toBe('REJECTED');
      expect(rejected.body.reviewNote).toBe('Too broad');

      // Dọn dẹp câu lifecycle để không ảnh hưởng assert đếm phía sau.
      expect((await lec(api().delete(`/api/questions/${draftId}`))).status).toBe(200);
      expect((await lec(api().delete(`/api/questions/${pendingId}`))).status).toBe(200);
    });
  });

  // ===========================================================================
  // DELETE + toàn vẹn tham chiếu
  // ===========================================================================
  describe('Delete & referential integrity', () => {
    test('D [critical]: không xoá được Topic đang có Question -> 409', async () => {
      const res = await lec(api().delete(`/api/topics/${ids.topic}`));
      expect(res.status).toBe(409);
      expect((await lec(api().get(`/api/topics/${ids.topic}`))).status).toBe(200);
    });

    test('D [critical]: không xoá được Rubric đang gán cho Question -> 409', async () => {
      const res = await lec(api().delete(`/api/rubrics/${ids.rubric}`));
      expect(res.status).toBe(409);
      expect(res.body.message).toMatch(/assigned to questions/i);
      expect((await lec(api().get(`/api/rubrics/${ids.rubric}`))).status).toBe(200);
    });

    test('D: xoá Topic / Rubric không bị tham chiếu -> thành công, rồi 404', async () => {
      expect((await lec(api().delete(`/api/topics/${ids.spareTopic}`))).status).toBe(204);
      expect((await lec(api().get(`/api/topics/${ids.spareTopic}`))).status).toBe(404);

      const delRubric = await lec(api().delete(`/api/rubrics/${ids.spareRubric}`));
      expect(delRubric.status).toBe(200);
      expect(delRubric.body.id).toBe(ids.spareRubric);
      expect((await lec(api().get(`/api/rubrics/${ids.spareRubric}`))).status).toBe(404);

      // Criteria của rubric bị xoá phải bị cascade
      const persisted = await t.db.readPersisted();
      expect(persisted.rubricCriteria.filter(([, c]) => c.rubric_id === ids.spareRubric)).toHaveLength(0);
    });

    test('D: DELETE /questions/:id -> 200 trả bản ghi đã xoá, sau đó 404', async () => {
      const res = await lec(api().delete(`/api/questions/${ids.question}`));
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(ids.question);
      expect((await lec(api().get(`/api/questions/${ids.question}`))).status).toBe(404);
      expect((await lec(api().delete(`/api/questions/${ids.question}`))).status).toBe(404);

      expect((await lec(api().delete(`/api/questions/${ids.otherQuestion}`))).status).toBe(200);
      expect((await lec(api().get('/api/questions'))).body).toHaveLength(0);
    });

    test('D: sau khi gỡ hết Question, Rubric và Topic đã xoá được', async () => {
      expect((await lec(api().delete(`/api/rubrics/${ids.rubric}`))).status).toBe(200);
      expect((await lec(api().delete(`/api/topics/${ids.topic}`))).status).toBe(204);

      expect((await lec(api().get('/api/topics'))).body).toEqual([]);
      expect((await lec(api().get('/api/rubrics'))).body).toEqual([]);
    });

    test('D: xoá với id không hợp lệ -> 400, không tồn tại -> 404', async () => {
      expect((await lec(api().delete('/api/topics/abc'))).status).toBe(400);
      expect((await lec(api().delete('/api/topics/9999'))).status).toBe(404);
      expect((await lec(api().delete('/api/rubrics/9999'))).status).toBe(404);
    });
  });

  // ===========================================================================
  // Persistence & isolation
  // ===========================================================================
  describe('Persistence & isolation', () => {
    test('File JSON test phản ánh đúng trạng thái cuối (rỗng) và ID counter không bị reset', async () => {
      const data = await t.db.readPersisted();
      expect(data.topics).toEqual([]);
      expect(data.rubrics).toEqual([]);
      expect(data.rubricCriteria).toEqual([]);
      expect(data.questions).toEqual([]);
      // ID không được tái sử dụng sau khi xoá
      expect(data.nextTopicId).toBeGreaterThan(ids.spareTopic);
      expect(data.nextQuestionId).toBeGreaterThan(ids.otherQuestion);
    });

    test('Tạo mới sau khi xoá không tái sử dụng ID cũ', async () => {
      const res = await lec(api().post('/api/topics')).send({ name: 'Fresh topic' });
      expect(res.status).toBe(201);
      expect(res.body.topic_id).toBeGreaterThan(ids.spareTopic);
    });

    test('File mock-database.json gốc không bị thay đổi', () => {
      expect(t.originalDbUnchanged()).toBe(true);
    });
  });
});
