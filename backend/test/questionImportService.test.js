const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const { QuestionService, IMPORT_HEADERS } = require('../src/services/questionService');

// --- Fakes -------------------------------------------------------------------

class FakeQuestionRepo {
  constructor(existingContents = []) {
    this.rows = new Map();
    this.nextId = 1;
    this.existing = new Set(existingContents.map((c) => c.trim().toLowerCase()));
  }

  async findByNormalizedContent(normalized) {
    if (this.existing.has(normalized)) return { question_id: -1 };
    for (const row of this.rows.values()) {
      if (String(row.content).trim().toLowerCase() === normalized) return { question_id: row.question_id };
    }
    return null;
  }

  async create(payload) {
    const id = this.nextId++;
    const row = {
      question_id: id,
      topic_id: payload.topicId,
      rubric_id: payload.rubricId ?? null,
      content: payload.content,
      status: payload.status,
      bloom_level: payload.bloomLevel ?? null,
      language: payload.language ?? null,
      source: payload.source ?? null,
      reference_answer: payload.referenceAnswer ?? null,
      key_points: payload.keyPoints ?? null,
    };
    this.rows.set(id, row);
    return { ...row };
  }
}

class FakeTopicRepo {
  constructor(byCode = {}) { this.byCode = byCode; }

  async findByCode(code) {
    return this.byCode[code] ? { topic_id: this.byCode[code] } : null;
  }
}

class FakeRubricRepo {
  constructor(byCode = {}) { this.byCode = byCode; }

  async findByCode(code) {
    return this.byCode[code] ? { rubric_id: this.byCode[code] } : null;
  }
}

const stubEmbedding = { async embed() { return [1, 0, 0]; } };

function build({ topics = { T1: 10 }, rubrics = { 5: 5 }, existingContents = [] } = {}) {
  const repository = new FakeQuestionRepo(existingContents);
  const topicRepository = new FakeTopicRepo(topics);
  const rubricRepository = new FakeRubricRepo(rubrics);
  const service = new QuestionService({
    repository, topicRepository, rubricRepository, embeddingAdapter: stubEmbedding,
  });
  return { service, repository };
}

async function buildXlsx(rows, { header = IMPORT_HEADERS } = {}) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Questions');
  ws.addRow(header);
  for (const r of rows) ws.addRow(r);
  const buffer = await wb.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

// Columns: Content, Topic Code, Bloom, Language, Reference Answer, Key Points, Rubric Code

test('buildImportTemplate has exactly the seven headers', async () => {
  const { service } = build();
  const buffer = await service.buildImportTemplate();
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const sheet = wb.worksheets[0];
  const header = [];
  sheet.getRow(1).eachCell((cell) => header.push(String(cell.value)));
  assert.equal(header.length, 7);
  assert.deepEqual(header, IMPORT_HEADERS);
});

test('importQuestions writes every row as source=IMPORT status=PENDING_REVIEW on a valid file', async () => {
  const { service, repository } = build();
  const buffer = await buildXlsx([
    ['What is a stack?', 'T1', 'REMEMBER', 'en', 'A LIFO structure.', 'LIFO|push|pop', '5'],
    ['What is a queue?', 'T1', 'UNDERSTAND', 'en', 'A FIFO structure.', 'FIFO', ''],
  ]);

  const result = await service.importQuestions(buffer);
  assert.equal(result.ok, true);
  assert.equal(result.created.length, 2);
  const rows = [...repository.rows.values()];
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.source, 'IMPORT');
    assert.equal(row.status, 'PENDING_REVIEW');
    assert.equal(row.topic_id, 10);
  }
  // Key points were parsed from the pipe-separated column and the reference
  // answer was stored, ready for a lecturer to review before approval.
  assert.deepEqual(rows[0].key_points, ['LIFO', 'push', 'pop']);
  assert.equal(rows[0].reference_answer, 'A LIFO structure.');
  // Rubric code resolved on the first row, blank on the second.
  assert.equal(rows[0].rubric_id, 5);
  assert.equal(rows[1].rubric_id, null);
});

test('importQuestions keeps a fully complete row in PENDING_REVIEW (never auto-approves)', async () => {
  const { service, repository } = build();
  const buffer = await buildXlsx([
    ['What is a stack?', 'T1', 'REMEMBER', 'en', 'A LIFO structure.', 'LIFO|push|pop', '5'],
  ]);

  const result = await service.importQuestions(buffer);
  assert.equal(result.ok, true);
  const [row] = [...repository.rows.values()];
  assert.equal(row.status, 'PENDING_REVIEW');
  assert.equal(row.rubric_id, 5);
  assert.ok(row.reference_answer);
  assert.ok(row.key_points.length > 0);
});

test('importQuestions performs ZERO writes when any row is invalid and returns per-row errors', async () => {
  const { service, repository } = build();
  const buffer = await buildXlsx([
    ['Valid question?', 'T1', 'REMEMBER', 'en', '', '', ''],
    ['', 'T1', 'REMEMBER', 'en', '', '', ''], // missing content
    ['Bad bloom?', 'T1', 'INVENT', 'en', '', '', ''], // invalid bloom
    ['Unknown topic?', 'NOPE', 'APPLY', 'en', '', '', ''], // topic doesn't resolve
  ]);

  const result = await service.importQuestions(buffer);
  assert.equal(result.ok, false);
  assert.ok(Array.isArray(result.errors));
  assert.equal(result.errors.length, 3);
  // Nothing was written.
  assert.equal(repository.rows.size, 0);

  const rowNumbers = result.errors.map((e) => e.row);
  assert.deepEqual(rowNumbers, [3, 4, 5]); // 1 header + data rows
});

test('importQuestions rejects in-file duplicate content with zero writes', async () => {
  const { service, repository } = build();
  const buffer = await buildXlsx([
    ['Repeated?', 'T1', 'REMEMBER', 'en', '', '', ''],
    ['  repeated? ', 'T1', 'UNDERSTAND', 'en', '', '', ''],
  ]);
  const result = await service.importQuestions(buffer);
  assert.equal(result.ok, false);
  assert.equal(repository.rows.size, 0);
  const dupRow = result.errors.find((e) => e.row === 3);
  assert.ok(dupRow.errors.some((m) => m.toLowerCase().includes('duplicate')));
});

test('importQuestions rejects content that already exists in the DB', async () => {
  const { service, repository } = build({ existingContents: ['already here'] });
  const buffer = await buildXlsx([
    ['Already here', 'T1', 'REMEMBER', 'en', '', '', ''],
  ]);
  const result = await service.importQuestions(buffer);
  assert.equal(result.ok, false);
  assert.equal(repository.rows.size, 0);
  assert.ok(result.errors[0].errors.some((m) => m.toLowerCase().includes('already exists')));
});

test('importQuestions returns an error row for an empty data set', async () => {
  const { service } = build();
  const buffer = await buildXlsx([]);
  const result = await service.importQuestions(buffer);
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].row, 0);
});
