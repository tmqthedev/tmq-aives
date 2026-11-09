const test = require('node:test');
const assert = require('node:assert/strict');
const { MaterialService } = require('../src/services/materialService');

const silentLogger = {
  info() {}, warn() {}, error() {},
};

const PDF_MIME = 'application/pdf';

function pdfFile(overrides = {}) {
  return {
    originalname: 'lecture.pdf',
    mimetype: PDF_MIME,
    buffer: Buffer.from('pdf-bytes'),
    size: 9,
    ...overrides,
  };
}

function makeService(overrides = {}) {
  const spies = {
    put: [],
    deletes: [],
    created: [],
    enqueued: [],
    events: [],
  };

  const courseMaterialRepository = {
    materials: new Map(),
    async create(payload) {
      const id = (this.materials.size + 1);
      const row = { course_material_id: id, ...payload, subject_id: payload.subjectId };
      this.materials.set(id, row);
      spies.created.push(payload);
      return row;
    },
    async findById(id) { return this.materials.get(Number(id)) || overrides.existing || null; },
    async listBySubject(subjectId) {
      return [...this.materials.values()].filter((m) => m.subject_id === subjectId);
    },
    async countCitingQuestions() { return overrides.citing ?? 0; },
    async deleteById(id) { this.materials.delete(Number(id)); return { course_material_id: id }; },
  };

  const subjectRepository = {
    async listSubjectIdsForLecturer() { return overrides.lecturerSubjects ?? [42]; },
  };
  const topicRepository = {
    async getById(id) {
      if (overrides.topic === 'missing') return null;
      return overrides.topic || { topic_id: id, subject_id: 42 };
    },
  };
  const awsClients = {
    async putObject(args) {
      if (overrides.putThrows) throw new Error('S3 put failed');
      spies.put.push(args);
      return { bucket: args.bucket, key: args.key };
    },
    async deleteObject(args) {
      if (overrides.deleteThrows) {
        const err = new Error(overrides.deleteThrows);
        err.code = overrides.deleteThrows;
        throw err;
      }
      spies.deletes.push(args);
      return args;
    },
  };
  const enqueueJob = async (type, payload) => { spies.enqueued.push({ type, payload }); };
  const realtimeBus = overrides.realtimeBus || {
    publish: (entity, payload) => spies.events.push({ entity, ...payload }),
  };

  const service = new MaterialService({
    courseMaterialRepository,
    subjectRepository,
    topicRepository,
    awsClients,
    enqueueJob,
    env: { materialsBucket: 'test-bucket' },
    realtimeBus,
    logger: silentLogger,
  });

  return {
    service, spies, courseMaterialRepository,
  };
}

const lecturer = { id: 5, role: 'LECTURER' };
const admin = { id: 1, role: 'ADMIN' };

test('upload stores to S3, creates the row, and enqueues INGEST_MATERIAL', async () => {
  const { service, spies } = makeService();
  const material = await service.upload({ user: lecturer, subjectId: 42, file: pdfFile() });

  assert.equal(spies.put.length, 1);
  assert.ok(spies.put[0].key.startsWith('materials/42/'));
  assert.equal(spies.created.length, 1);
  assert.equal(spies.enqueued.length, 1);
  assert.equal(spies.enqueued[0].type, 'INGEST_MATERIAL');
  assert.deepEqual(spies.enqueued[0].payload, { materialId: material.course_material_id });
  assert.deepEqual(spies.events, [{ entity: 'material', action: 'created', materialId: 1, subjectId: 42 }]);
});

test('material deletion publishes only after repository deletion succeeds', async () => {
  const { service, spies } = makeService();
  await service.upload({ user: lecturer, subjectId: 42, file: pdfFile() });
  await service.delete({ user: lecturer, materialId: 1 });
  assert.deepEqual(spies.events.map(({ entity, action, materialId, subjectId }) => ({ entity, action, materialId, subjectId })), [
    { entity: 'material', action: 'created', materialId: 1, subjectId: 42 },
    { entity: 'material', action: 'deleted', materialId: 1, subjectId: 42 },
  ]);
});

test('subjectId <= 0 returns 400 VALIDATION_ERROR before any S3 put or DB write', async () => {
  const { service, spies } = makeService();
  await assert.rejects(
    () => service.upload({ user: lecturer, subjectId: 0, file: pdfFile() }),
    (error) => {
      assert.equal(error.statusCode, 400);
      assert.equal(error.code, 'VALIDATION_ERROR');
      return true;
    },
  );
  assert.equal(spies.put.length, 0);
  assert.equal(spies.created.length, 0);
  assert.equal(spies.enqueued.length, 0);
});

test('missing subjectId also 400s before any write', async () => {
  const { service, spies } = makeService();
  await assert.rejects(
    () => service.upload({ user: lecturer, file: pdfFile() }),
    (error) => { assert.equal(error.statusCode, 400); return true; },
  );
  assert.equal(spies.put.length, 0);
});

test('unsupported file type returns 400 UNSUPPORTED_TYPE', async () => {
  const { service, spies } = makeService();
  await assert.rejects(
    () => service.upload({
      user: lecturer,
      subjectId: 42,
      file: pdfFile({ mimetype: 'image/png', originalname: 'x.png' }),
    }),
    (error) => {
      assert.equal(error.statusCode, 400);
      assert.equal(error.code, 'UNSUPPORTED_TYPE');
      return true;
    },
  );
  assert.equal(spies.put.length, 0);
});

test('out-of-scope lecturer is denied with 403 (no S3 put)', async () => {
  const { service, spies } = makeService({ lecturerSubjects: [99] });
  await assert.rejects(
    () => service.upload({ user: lecturer, subjectId: 42, file: pdfFile() }),
    (error) => {
      assert.equal(error.statusCode, 403);
      assert.equal(error.code, 'FORBIDDEN');
      return true;
    },
  );
  assert.equal(spies.put.length, 0);
});

test('ADMIN bypasses the subject-scope check', async () => {
  const { service, spies } = makeService({ lecturerSubjects: [] });
  await service.upload({ user: admin, subjectId: 42, file: pdfFile() });
  assert.equal(spies.put.length, 1);
});

test('unknown topicId returns 404 TOPIC_NOT_FOUND', async () => {
  const { service } = makeService({ topic: 'missing' });
  await assert.rejects(
    () => service.upload({
      user: lecturer, subjectId: 42, topicId: 999, file: pdfFile(),
    }),
    (error) => {
      assert.equal(error.statusCode, 404);
      assert.equal(error.code, 'TOPIC_NOT_FOUND');
      return true;
    },
  );
});

test('S3 put failure returns 502 STORAGE_ERROR and does not create a row', async () => {
  const { service, spies } = makeService({ putThrows: true });
  await assert.rejects(
    () => service.upload({ user: lecturer, subjectId: 42, file: pdfFile() }),
    (error) => {
      assert.equal(error.statusCode, 502);
      assert.equal(error.code, 'STORAGE_ERROR');
      return true;
    },
  );
  assert.equal(spies.created.length, 0);
  assert.equal(spies.enqueued.length, 0);
});

test('delete 409 MATERIAL_IN_USE when cited, and deleteObject is NOT called', async () => {
  const existing = {
    course_material_id: 3, subject_id: 42, file_key: 'materials/42/x/f.pdf',
  };
  const { service, spies } = makeService({ existing, citing: 2 });
  await assert.rejects(
    () => service.delete({ user: lecturer, materialId: 3 }),
    (error) => {
      assert.equal(error.statusCode, 409);
      assert.equal(error.code, 'MATERIAL_IN_USE');
      return true;
    },
  );
  assert.equal(spies.deletes.length, 0);
});

test('delete out-of-scope returns 403', async () => {
  const existing = { course_material_id: 3, subject_id: 42, file_key: 'k' };
  const { service } = makeService({ existing, lecturerSubjects: [99] });
  await assert.rejects(
    () => service.delete({ user: lecturer, materialId: 3 }),
    (error) => { assert.equal(error.statusCode, 403); return true; },
  );
});

test('delete missing material returns 404', async () => {
  const { service } = makeService({ existing: null });
  await assert.rejects(
    () => service.delete({ user: lecturer, materialId: 1234 }),
    (error) => { assert.equal(error.statusCode, 404); return true; },
  );
});

test('delete swallows a NoSuchKey from storage and still removes the row', async () => {
  const existing = { course_material_id: 3, subject_id: 42, file_key: 'k' };
  const { service } = makeService({ existing, deleteThrows: 'NoSuchKey' });
  const result = await service.delete({ user: lecturer, materialId: 3 });
  assert.equal(result.course_material_id, 3);
});
