import { execFileSync } from 'node:child_process';

function ssm(command) {
  return execFileSync('node', ['scripts/aws-ssm.js', command], { encoding: 'utf8' });
}

function psql(query) {
  const sanitized = query.replace(/\n/g, ' ').replace(/"/g, '\\"');
  return ssm(`docker exec aives-postgres psql -U aives -d aives -A -t -c "${sanitized}"`);
}

const apply = process.argv.includes('--apply');
if (apply && process.env.E2E_CONFIRM_CLEANUP !== 'YES') {
  throw new Error('Cleanup commit requires E2E_CONFIRM_CLEANUP=YES. Run without --apply first to preview and roll back.');
}

const sqlStatements = [
  `DELETE FROM background_job
   WHERE (type = 'SEND_EMAIL' AND payload->>'to' IN (
            SELECT email FROM app_user WHERE left(code, 5) = 'TEST_'
          ))
      OR (type = 'INGEST_MATERIAL' AND payload->>'materialId' IN (
            SELECT course_material_id::text FROM course_material
            WHERE subject_id IN (SELECT subject_id FROM subject WHERE left(code, 5) = 'TEST_')
          ))
      OR (type = 'GENERATE_QUESTIONS' AND payload->>'jobId' IN (
            SELECT question_generation_job_id::text FROM question_generation_job
            WHERE topic_id IN (
              SELECT topic_id FROM topic
              WHERE left(name, 5) = 'TEST_'
                 OR subject_id IN (SELECT subject_id FROM subject WHERE left(code, 5) = 'TEST_')
            )
          ))
      OR (type = 'GRADE_INTERVIEW' AND payload->>'interviewId' IN (
            SELECT viva_interview_id::text FROM viva_interview
            WHERE exam_session_id IN (
              SELECT exam_session_id FROM exam_session WHERE left(title, 5) = 'TEST_'
            )
          ));`,
  `DELETE FROM score_adjustment
   WHERE criterion_score_id IN (
     SELECT cs.criterion_score_id
     FROM criterion_score cs
     JOIN question_evaluation qe ON cs.evaluation_id = qe.question_evaluation_id
     JOIN viva_result vr ON qe.result_id = vr.viva_result_id
     JOIN viva_interview vi ON vr.interview_id = vi.viva_interview_id
     WHERE vi.exam_session_id IN (SELECT exam_session_id FROM exam_session WHERE left(title, 5) = 'TEST_')
   );`,
  `DELETE FROM criterion_score
   WHERE evaluation_id IN (
     SELECT qe.question_evaluation_id
     FROM question_evaluation qe
     JOIN viva_result vr ON qe.result_id = vr.viva_result_id
     JOIN viva_interview vi ON vr.interview_id = vi.viva_interview_id
     WHERE vi.exam_session_id IN (SELECT exam_session_id FROM exam_session WHERE left(title, 5) = 'TEST_')
   );`,
  `DELETE FROM question_evaluation
   WHERE result_id IN (
     SELECT vr.viva_result_id
     FROM viva_result vr
     JOIN viva_interview vi ON vr.interview_id = vi.viva_interview_id
     WHERE vi.exam_session_id IN (SELECT exam_session_id FROM exam_session WHERE left(title, 5) = 'TEST_')
   );`,
  `DELETE FROM viva_result
   WHERE interview_id IN (
     SELECT viva_interview_id FROM viva_interview
     WHERE exam_session_id IN (SELECT exam_session_id FROM exam_session WHERE left(title, 5) = 'TEST_')
   );`,
  `DELETE FROM transcript
   WHERE interview_id IN (
     SELECT viva_interview_id FROM viva_interview
     WHERE exam_session_id IN (SELECT exam_session_id FROM exam_session WHERE left(title, 5) = 'TEST_')
   );`,
  `DELETE FROM processing_failure
   WHERE interview_id IN (
     SELECT viva_interview_id FROM viva_interview
     WHERE exam_session_id IN (SELECT exam_session_id FROM exam_session WHERE left(title, 5) = 'TEST_')
   );`,
  `DELETE FROM qa_turn
   WHERE interview_id IN (
     SELECT viva_interview_id FROM viva_interview
     WHERE exam_session_id IN (SELECT exam_session_id FROM exam_session WHERE left(title, 5) = 'TEST_')
   );`,
  `DELETE FROM assigned_question
   WHERE interview_id IN (
     SELECT viva_interview_id FROM viva_interview
     WHERE exam_session_id IN (SELECT exam_session_id FROM exam_session WHERE left(title, 5) = 'TEST_')
   );`,
  `DELETE FROM viva_interview
   WHERE exam_session_id IN (SELECT exam_session_id FROM exam_session WHERE left(title, 5) = 'TEST_');`,
  `DELETE FROM exam_session_examiner
   WHERE exam_session_id IN (SELECT exam_session_id FROM exam_session WHERE left(title, 5) = 'TEST_');`,
  `DELETE FROM exam_session_student
   WHERE exam_session_id IN (SELECT exam_session_id FROM exam_session WHERE left(title, 5) = 'TEST_');`,
  `DELETE FROM exam_session WHERE left(title, 5) = 'TEST_';`,
  `DELETE FROM question_source_ref
   WHERE question_id IN (
     SELECT q.question_id FROM question q
     WHERE q.topic_id IN (
       SELECT t.topic_id FROM topic t
       WHERE left(t.name, 5) = 'TEST_'
          OR t.subject_id IN (SELECT subject_id FROM subject WHERE left(code, 5) = 'TEST_')
     )
     OR q.rubric_id IN (
       SELECT r.rubric_id FROM rubric r
       WHERE r.subject_id IN (SELECT subject_id FROM subject WHERE left(code, 5) = 'TEST_')
     )
   );`,
  `DELETE FROM question
   WHERE topic_id IN (
     SELECT t.topic_id FROM topic t
     WHERE left(t.name, 5) = 'TEST_'
        OR t.subject_id IN (SELECT subject_id FROM subject WHERE left(code, 5) = 'TEST_')
   )
   OR rubric_id IN (
     SELECT r.rubric_id FROM rubric r
     WHERE r.subject_id IN (SELECT subject_id FROM subject WHERE left(code, 5) = 'TEST_')
   );`,
  `DELETE FROM question_generation_job
   WHERE topic_id IN (
     SELECT topic_id FROM topic
     WHERE left(name, 5) = 'TEST_'
        OR subject_id IN (SELECT subject_id FROM subject WHERE left(code, 5) = 'TEST_')
   );`,
  `DELETE FROM performance_level
   WHERE criterion_id IN (
     SELECT rubric_criterion_id FROM rubric_criterion
     WHERE rubric_id IN (
       SELECT rubric_id FROM rubric
       WHERE subject_id IN (SELECT subject_id FROM subject WHERE left(code, 5) = 'TEST_')
     )
   );`,
  `DELETE FROM rubric_criterion
   WHERE rubric_id IN (
     SELECT rubric_id FROM rubric
     WHERE subject_id IN (SELECT subject_id FROM subject WHERE left(code, 5) = 'TEST_')
   );`,
  `DELETE FROM rubric
   WHERE subject_id IN (SELECT subject_id FROM subject WHERE left(code, 5) = 'TEST_');`,
  `DELETE FROM material_chunk
   WHERE material_id IN (
     SELECT course_material_id FROM course_material
     WHERE subject_id IN (SELECT subject_id FROM subject WHERE left(code, 5) = 'TEST_')
   );`,
  `DELETE FROM course_material
   WHERE subject_id IN (SELECT subject_id FROM subject WHERE left(code, 5) = 'TEST_');`,
  `DELETE FROM topic
   WHERE left(name, 5) = 'TEST_'
      OR subject_id IN (SELECT subject_id FROM subject WHERE left(code, 5) = 'TEST_');`,
  `DELETE FROM subject_lecturer
   WHERE subject_id IN (SELECT subject_id FROM subject WHERE left(code, 5) = 'TEST_');`,
  `DELETE FROM subject_student
   WHERE subject_id IN (SELECT subject_id FROM subject WHERE left(code, 5) = 'TEST_');`,
  `DELETE FROM subject WHERE left(code, 5) = 'TEST_';`,
  `DELETE FROM password_token
   WHERE user_id IN (SELECT app_user_id FROM app_user WHERE left(code, 5) = 'TEST_');`,
  `DELETE FROM auth_session
   WHERE user_id IN (SELECT app_user_id FROM app_user WHERE left(code, 5) = 'TEST_');`,
  `DELETE FROM app_user WHERE left(code, 5) = 'TEST_';`,
];

const transactionEnd = apply ? 'COMMIT' : 'ROLLBACK';
const sql = `BEGIN; ${sqlStatements.join(' ')} ${transactionEnd};`;

function psqlRows(query) {
  return psql(query).split(/\r?\n/).map((row) => row.trim()).filter(Boolean);
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function readSsmParameter(name) {
  const value = ssm(`aws ssm get-parameter --region ap-southeast-1 --name ${shellQuote(name)} --query Parameter.Value --output text`).trim();
  if (!/^[a-z0-9.-]{3,63}$/i.test(value)) {
    throw new Error(`SSM parameter ${name} did not return a valid S3 bucket name.`);
  }
  return value;
}

function deleteS3Object(bucket, key) {
  ssm(`aws s3api delete-object --region ap-southeast-1 --bucket ${shellQuote(bucket)} --key ${shellQuote(key)}`);
}

function deleteSessionContext(tableName, interviewId) {
  const key = JSON.stringify({ sessionId: { S: `interview#${interviewId}` } });
  ssm(`aws dynamodb delete-item --region ap-southeast-1 --table-name ${shellQuote(tableName)} --key ${shellQuote(key)}`);
}

let materialObjects = [];
let answerAudioObjects = [];
let testInterviewIds = [];
let materialBucket;
let audioBucket;
let sessionTable;

if (apply) {
  const activeTestJobs = Number(psql(`
    SELECT count(*)
    FROM background_job bj
    WHERE bj.status NOT IN ('DONE', 'FAILED')
      AND (
        (bj.type = 'SEND_EMAIL' AND bj.payload->>'to' IN (
          SELECT email FROM app_user WHERE left(code, 5) = 'TEST_'
        ))
        OR (bj.type = 'INGEST_MATERIAL' AND bj.payload->>'materialId' IN (
          SELECT course_material_id::text FROM course_material
          WHERE subject_id IN (SELECT subject_id FROM subject WHERE left(code, 5) = 'TEST_')
        ))
        OR (bj.type = 'GENERATE_QUESTIONS' AND bj.payload->>'jobId' IN (
          SELECT question_generation_job_id::text FROM question_generation_job
          WHERE topic_id IN (
            SELECT topic_id FROM topic
            WHERE left(name, 5) = 'TEST_'
               OR subject_id IN (SELECT subject_id FROM subject WHERE left(code, 5) = 'TEST_')
          )
        ))
        OR (bj.type = 'GRADE_INTERVIEW' AND bj.payload->>'interviewId' IN (
          SELECT viva_interview_id::text FROM viva_interview
          WHERE exam_session_id IN (
            SELECT exam_session_id FROM exam_session WHERE left(title, 5) = 'TEST_'
          )
        ))
      );
  `).trim());
  if (activeTestJobs > 0) {
    throw new Error(`Refusing cleanup while ${activeTestJobs} TEST_ background job(s) are pending or running.`);
  }

  const materialRows = psqlRows(`
    SELECT cm.subject_id || '|' || cm.file_key
    FROM course_material cm
    WHERE cm.subject_id IN (SELECT subject_id FROM subject WHERE left(code, 5) = 'TEST_');
  `);
  materialObjects = materialRows.map((row) => {
    const separator = row.indexOf('|');
    const subjectId = row.slice(0, separator);
    const key = row.slice(separator + 1);
    if (!/^\d+$/.test(subjectId) || !key.startsWith(`materials/${subjectId}/`) || key.includes('..')) {
      throw new Error('Refusing to delete a material object outside its TEST_ subject prefix.');
    }
    return key;
  });

  const audioRows = psqlRows(`
    SELECT vi.viva_interview_id || '|' || qt.answer_audio_key
    FROM qa_turn qt
    JOIN viva_interview vi ON qt.interview_id = vi.viva_interview_id
    WHERE vi.exam_session_id IN (
      SELECT exam_session_id FROM exam_session WHERE left(title, 5) = 'TEST_'
    ) AND qt.answer_audio_key IS NOT NULL;
  `);
  answerAudioObjects = audioRows.map((row) => {
    const separator = row.indexOf('|');
    const interviewId = row.slice(0, separator);
    const key = row.slice(separator + 1);
    if (!/^\d+$/.test(interviewId) || !key.startsWith(`interviews/${interviewId}/`) || !/^interviews\/\d+\/turns\/\d+\/answer\.[a-z0-9]+$/i.test(key)) {
      throw new Error('Refusing to delete an audio object outside its TEST_ interview prefix.');
    }
    return key;
  });

  testInterviewIds = psqlRows(`
    SELECT viva_interview_id
    FROM viva_interview
    WHERE exam_session_id IN (
      SELECT exam_session_id FROM exam_session WHERE left(title, 5) = 'TEST_'
    );
  `).map((id) => {
    if (!/^\d+$/.test(id)) throw new Error('Refusing to delete an invalid TEST_ interview context key.');
    return id;
  });

  if (materialObjects.length > 0) materialBucket = readSsmParameter('/aives/prod/MATERIALS_BUCKET_NAME');
  if (answerAudioObjects.length > 0) audioBucket = readSsmParameter('/aives/prod/AUDIO_BUCKET_NAME');
  if (testInterviewIds.length > 0) sessionTable = readSsmParameter('/aives/prod/SESSION_TABLE_NAME');
}

if (!apply) {
  console.log('Cleanup preview only: all deletes will be rolled back. Pass --apply to commit this TEST_ cleanup.');
}

const sanitized = sql.replace(/\n/g, ' ').replace(/"/g, '\\"');
const out = ssm(`docker exec aives-postgres psql -U aives -d aives -v ON_ERROR_STOP=1 -c "${sanitized}"`);
console.log(out);

if (apply) {
  for (const key of materialObjects) deleteS3Object(materialBucket, key);
  for (const key of answerAudioObjects) deleteS3Object(audioBucket, key);
  for (const interviewId of testInterviewIds) deleteSessionContext(sessionTable, interviewId);
  console.log(`Deleted ${materialObjects.length} TEST_ material object(s), ${answerAudioObjects.length} TEST_ answer audio object(s), and ${testInterviewIds.length} TEST_ session context item(s); TTS cache was not touched.`);
}
