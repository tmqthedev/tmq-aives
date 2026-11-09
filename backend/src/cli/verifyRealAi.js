// Explicit integration smoke test. Creates ONLY marked synthetic fixtures.
// Run on the deployed host: docker exec aives-backend node src/cli/verifyRealAi.js --create-test-fixtures
const assert = require('node:assert/strict');
const JSZip = require('jszip');
const env = require('../config/env');
const { validateAiConfig } = require('../config/validateAiConfig');
const { createDatabase } = require('../db/createDatabase');
const { createApp } = require('../app');
const { makeIngestMaterialHandler, makeGenerateQuestionsHandler } = require('../jobs/handlers');
const { RubricRepository } = require('../repositories/rubricRepository');
const { CourseMaterialRepository } = require('../repositories/courseMaterialRepository');
const { QuestionService } = require('../services/questionService');
const { SubjectScope } = require('../services/subjectScope');
const { SubjectRepository } = require('../repositories/subjectRepository');
const { approveSyntheticSmokeQuestions } = require('./syntheticSmokeQuestions');

const notes = {
  VI: 'TCP cung cấp truyền dữ liệu tin cậy bằng số thứ tự, xác nhận ACK và truyền lại. Số thứ tự giúp bên nhận sắp xếp dữ liệu và nhận biết dữ liệu bị thiếu. Bên nhận gửi ACK để xác nhận dữ liệu đã nhận. Khi quá thời gian chờ ACK, bên gửi truyền lại dữ liệu. Bắt tay ba bước SYN, SYN-ACK, ACK thiết lập kết nối trước khi trao đổi dữ liệu. Điều khiển luồng dùng cửa sổ nhận để tránh làm quá tải bên nhận.',
  EN: 'TCP provides reliable delivery using sequence numbers, acknowledgements and retransmission. Sequence numbers let the receiver reorder data and detect missing bytes. The receiver sends ACK messages to confirm received data. If an ACK does not arrive before the timeout, the sender retransmits the missing data. The three-way handshake uses SYN, SYN-ACK and ACK to establish a connection before data transfer. Flow control uses the receive window to avoid overwhelming the receiver.',
};

async function main() {
  if (!process.argv.includes('--create-test-fixtures')) throw new Error('Pass --create-test-fixtures to authorize synthetic integration data.');
  validateAiConfig(env);
  if (env.dbMockMode) throw new Error('This smoke test requires PostgreSQL.');
  const db = createDatabase(env);
  const run = `AI-SMOKE-${Date.now()}`;
  const report = { run, providers: { stt: env.sttProvider, tts: env.ttsProvider, llm: env.llmProvider, embedding: env.embeddingProvider }, cases: [] };
  // Jobs are dispatched synchronously below so this test cannot race the live queue.
  // All model, speech, storage, context and database dependencies remain real.
  const app = createApp({ database: db, enqueueJob: async () => ({}) });
  const deps = app.jobContext;
  if (process.env.AI_SMOKE_DEBUG === 'true') {
    const generate = deps.llmAdapter.generateQuestions.bind(deps.llmAdapter);
    deps.llmAdapter.generateQuestions = async input => {
      const drafts = await generate(input);
      console.log(JSON.stringify({ stage: 'synthetic-generation-debug', chunks: input.chunks, drafts }));
      return drafts;
    };
    const decide = deps.llmAdapter.decideFollowUp.bind(deps.llmAdapter);
    deps.llmAdapter.decideFollowUp = async input => {
      const decision = await decide(input);
      console.log(JSON.stringify({ stage: 'synthetic-follow-up-debug', language: input.language,
        decision }));
      return decision;
    };
  }
  const engine = app.interviewContext.interviewService;
  const rubricRepo = new RubricRepository(db);
  const materials = new CourseMaterialRepository(db);
  const questionService = new QuestionService({
    repository: deps.questionRepository, rubricRepository: rubricRepo,
    topicRepository: deps.topicRepository, db,
    subjectScope: new SubjectScope({ subjectRepository: new SubjectRepository(db) }),
  });
  try {
    if (env.storageBucketAutoCreate) await deps.awsClients.ensureBuckets([env.audioBucket, env.materialsBucket]);
    const lecturer = (await db.query(`INSERT INTO app_user (email, full_name, role, status)
      VALUES ($1, $2, 'LECTURER', 'ACTIVE') RETURNING app_user_id`, [`${run.toLowerCase()}-lecturer@example.invalid`, `[TEST] ${run} Lecturer`])).rows[0].app_user_id;
    const student = (await db.query(`INSERT INTO app_user (email, full_name, role, status)
      VALUES ($1, $2, 'STUDENT', 'ACTIVE') RETURNING app_user_id`, [`${run.toLowerCase()}-student@example.invalid`, `[TEST] ${run} Student`])).rows[0].app_user_id;
    report.lecturerId = lecturer;
    report.studentId = student;
    const subjectId = (await db.query('INSERT INTO subject (code, name) VALUES ($1, $2) RETURNING subject_id', [run, `[TEST] ${run}`])).rows[0].subject_id;
    report.subjectId = subjectId;
    await db.query('INSERT INTO subject_lecturer (subject_id, lecturer_id) VALUES ($1, $2)', [subjectId, lecturer]);
    const rubric = await rubricRepo.create({ maxScore: 10, subjectId, createdBy: lecturer,
      criteria: [{ name: 'Technical accuracy', weightPercent: 70, description: 'Correct use of TCP concepts.',
        performanceLevels: [
          { label: 'Partial', minScore: 0, maxScore: 5, description: 'Some TCP concepts are missing.', orderNo: 1 },
          { label: 'Strong', minScore: 5, maxScore: 10, description: 'TCP concepts are accurate.', orderNo: 2 },
        ] },
      { name: 'Clarity', weightPercent: 30, description: 'Clear and structured explanation.',
        performanceLevels: [
          { label: 'Partial', minScore: 0, maxScore: 5, description: 'Explanation is difficult to follow.', orderNo: 1 },
          { label: 'Strong', minScore: 5, maxScore: 10, description: 'Explanation is easy to follow.', orderNo: 2 },
        ] }] });

    for (const language of (process.argv.includes('--vi-only') ? ['VI'] : ['VI', 'EN'])) {
      const entry = { language };
      report.cases.push(entry);
      console.log(JSON.stringify({ stage: 'start', run, language }));
      const windowBytes = Number(run.split('-').at(-1)) % 1000000 + (language === 'VI' ? 4000 : 8000);
      const scenario = language === 'VI'
        ? `Trong tình huống này, cửa sổ nhận TCP có kích thước ${windowBytes} byte. ${notes.VI}`
        : `In this scenario, the TCP receive window is ${windowBytes} bytes. ${notes.EN}`;
      const topicId = (await db.query('INSERT INTO topic (name, subject_id) VALUES ($1, $2) RETURNING topic_id',
        [language === 'VI' ? `[TEST] TCP với cửa sổ nhận ${windowBytes} byte` : `[TEST] TCP with a ${windowBytes}-byte receive window`, subjectId])).rows[0].topic_id;
      // A synthetic course document goes through the same parser, embedding,
      // retrieval, generation and grounding validation as an uploaded PPTX.
      const zip = new JSZip();
      zip.file('ppt/slides/slide1.xml', `<?xml version="1.0"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><a:p><a:r><a:t>${scenario}</a:t></a:r></a:p></p:spTree></p:cSld></p:sld>`);
      const buffer = await zip.generateAsync({ type: 'nodebuffer' });
      const key = `smoke/${run}/${language}/notes.pptx`;
      const mimeType = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
      await deps.awsClients.putObject({ bucket: env.materialsBucket, key, body: buffer, contentType: mimeType });
      const material = await materials.create({ subjectId, topicId, title: `[TEST] ${run} ${language}`, fileKey: key,
        mimeType, sizeBytes: buffer.length, status: 'UPLOADED', uploadedBy: lecturer });
      entry.materialId = material.course_material_id;
      await makeIngestMaterialHandler(deps)({ payload: { materialId: entry.materialId } });
      assert.equal((await materials.findById(entry.materialId)).status, 'READY');
      const generated = await deps.questionGenerationJobRepository.create({ topicId, materialIds: [entry.materialId],
        requestedCount: 1, bloomDistribution: { UNDERSTAND: 1 }, language: language.toLowerCase(), status: 'PENDING', requestedBy: lecturer });
      let job;
      for (let attempt = 0; attempt < 3; attempt++) {
        await makeGenerateQuestionsHandler(deps)({ payload: { jobId: generated.question_generation_job_id } });
        job = await deps.questionGenerationJobRepository.findById(generated.question_generation_job_id);
        if (job.generated_count > 0) break;
      }
      assert.equal(job.status, 'COMPLETED');
      assert.ok(job.generated_count >= 1, `No grounded ${language} question survived generation`);
      entry.generatedCount = job.generated_count;
      entry.approvedQuestionIds = await approveSyntheticSmokeQuestions({
        db, questionService, run, jobId: generated.question_generation_job_id,
        topicId, lecturerId: lecturer, rubricId: rubric.rubric_id, scenario,
      });
      const exam = await deps.examSessionRepository.create({ subjectId, topicId, title: `[TEST] ${run} ${language}`,
        language, mainQuestionCount: 1, maxFollowUpsPerQuestion: 1, answerTimeLimitSec: 120,
        thinkTimeSec: 0, sessionTimeLimitSec: 1800, status: 'OPEN', createdBy: lecturer,
        opensAt: new Date(Date.now() - 1000), closesAt: new Date(Date.now() + 1800000) });
      entry.examId = exam.exam_session_id;
      await deps.examSessionRepository.addStudent(entry.examId, student);
      const user = { id: student, role: 'STUDENT' };
      const warm = await Promise.all([
        app.interviewContext.sttAdapter.warmUp(language),
        app.interviewContext.ttsAdapter.warmUp(language),
      ]);
      assert.ok(warm.every(probe => probe.ok), 'Real speech models did not warm successfully');
      let view = await engine.startOrResume({ user, examSessionId: entry.examId });
      entry.interviewId = view.interviewId;
      let turns = 0;
      while (view.status === 'IN_PROGRESS' && turns < 3) {
        assert.equal(view.language, language);
        assert.ok(view.currentTurn.audioKey, 'Real question TTS must produce audio');
        await engine.markQuestionPlayed({ user, interviewId: view.interviewId, turnId: view.currentTurn.turnId });
        const answerText = turns === 0
          ? (language === 'VI' ? 'TCP giúp truyền dữ liệu tin cậy.' : 'TCP uses sequence numbers to reorder data.')
          : scenario;
        const answer = await app.interviewContext.ttsAdapter.synthesize({ text: answerText, language });
        const audio = await deps.awsClients.getObject({ bucket: env.audioBucket, key: answer.audioKey });
        assert.ok(audio.length > 1024);
        view = await engine.submitAnswer({ user, interviewId: view.interviewId, turnId: view.currentTurn.turnId, audio, contentType: 'audio/wav' });
        turns++;
      }
      assert.equal(view.status, 'COMPLETED');
      entry.turns = turns;
      const saved = (await db.query('SELECT turn_type, answer_text FROM qa_turn WHERE interview_id = $1', [entry.interviewId])).rows;
      assert.ok(saved.every(row => row.answer_text?.trim().length > 0), 'STT must recognize every synthetic answer');
      entry.followUps = saved.filter(row => row.turn_type === 'FOLLOW_UP').length;
      await app.gradingContext.gradingService.gradeInterview({ interviewId: entry.interviewId });
      const result = await app.gradingContext.vivaResultRepository.findByInterviewId(entry.interviewId);
      entry.gradingStatus = result.status;
      entry.aiScore = result.ai_total_score;
      assert.ok(['AI_SUGGESTED', 'FLAGGED'].includes(result.status), 'Real AI grading did not complete');
      console.log(JSON.stringify({ stage: 'case-complete', ...entry }));
    }
    console.log(JSON.stringify({ stage: 'complete', ...report }));
  } catch (error) {
    console.error(JSON.stringify({ stage: 'failed', ...report, code: error.code, message: error.message }));
    process.exitCode = 1;
  } finally {
    // Keep marked fixtures for review, but do not leave a synthetic exam open.
    for (const entry of report.cases) if (entry.examId) {
      await db.query("UPDATE exam_session SET status = 'CLOSED' WHERE exam_session_id = $1", [entry.examId]);
    }
    await db.end();
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
