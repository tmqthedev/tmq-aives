# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

AIVES: an AI-assisted oral exam (viva) platform. Lecturers build a question bank (manual, Excel import, or RAG-generated from uploaded course materials), students answer by voice, and the AI suggests rubric-based grades. Product and design docs, mostly in Vietnamese, are in `docs/` (index: `docs/README.md`; PRD, SRS, SDS, business flows, AWS architecture, `bilingual-real-ai.md`, E2E plans and reports). The plan is delivered in numbered "Steps" (currently Step 13). Per-step task tracking (plan, features, reviews) lives in `.agents/tasks/<step>/`, and commits are prefixed `feat(stepN)` / `fix(stepN)` / `docs(stepN)` / `chore(stepN)`.

Top-level parts:
- `backend/`: Express 5 API (CommonJS, Node 20). This is where most of the work happens.
- `frontend/`: React 19 + Vite + react-router SPA (ESM, plain JSX, no TypeScript). VI/EN UI strings in `src/i18n/`.
- `lambda/`: container images for the STT Lambda (`lambda/stt/`, PhoWhisper/Whisper) and the TTS Lambda (`lambda/tts/`, Kokoro-82M). The old Transcribe/Polly handlers were removed in Step 11.
- `infrastructure/terraform/`: AWS infra: EC2 t4g.small + Docker (backend + pgvector), CloudFront, S3, DynamoDB, ECR, STT and TTS Lambdas, SSM, OIDC deploy role (Step 11).
- `docker-compose.prod.yml` + `scripts/` + `Makefile`: prod stack on EC2, SSM env fetch, pg_dump backups, aws-stop/start, db-restore.
- `docker-compose.yml` + `nginx/`: the local stack. `docker-compose.test.yml`: offline (mock-AI) override for smoke tests only.

## Commands

Backend (run from `backend/`):
```bash
npm start                 # node src/server.js (rejects mock AI config, see below)
npm test                  # node test/runTests.js unit: node:test over test/*Service.test.js ONLY
npm run test:e2e          # node test/runTests.js e2e: Jest + supertest, test/**/*.e2e.test.js (runInBand)
npm run test:all
node test/runTests.js e2e test/materials.e2e.test.js -t "uploads"  # single e2e file / test name
npm run create-admin -- --email admin@aives.local --password secret123   # needs real DB
node src/cli/verifyRealAi.js --create-test-fixtures  # billed real-AI smoke test (VI + EN), see docs/bilingual-real-ai.md
```
- Two test runners split by filename. Unit tests use `node:test` + `node:assert/strict` and **must be named `*Service.test.js`**, or `npm test` won't pick them up. E2E suites use Jest and must be named `*.e2e.test.js`.
- `test/runTests.js` forces `AWS_MOCK_MODE=true` and every `*_PROVIDER=mock` for the child process. The env defaults are now real providers, so a bare `node --test <file>` or `npx jest <file>` runs without those mocks; set them yourself (or go through `runTests.js`) when running a single file.
- Jest maps `uuid` (ESM-only v13) to `test/helpers/uuidStub.js`.
- The Postgres-backed suites (`migrations`, `jobQueue`, `step4`, `examSessions`, `interviewEngine` e2e) self-skip unless `TEST_DATABASE_URL` is set. To run them: `docker compose up -d postgres`, then `TEST_DATABASE_URL=postgres://aives:aives@localhost:5432/aives npm run test:e2e` (in PowerShell: `$env:TEST_DATABASE_URL='...'`).

Frontend (run from `frontend/`): `npm run dev`, `npm run build`, `npm run lint` (oxlint), `npm test` (`node --test test/*.test.js`: plain `node:test` suites for pure modules only, `test/language.test.js` and `test/audioDevices.test.js`; no component or browser tests).

Full local stack (from the repo root): `docker compose up`. It runs pgvector Postgres, the backend, DynamoDB Local, MinIO, Mailpit, nginx, and the real STT/TTS models as Lambda RIE containers (`stt`, `tts`; function name `function`). LLM and embeddings call Bedrock, so export temporary AWS credentials into the shell first (steps in `docs/bilingual-real-ai.md`). The app is at http://localhost:8080, Mailpit at :8025 and the MinIO console at :9001. `docker compose config` validates the file without starting anything. Offline smoke test without AWS: `docker compose -f docker-compose.yml -f docker-compose.test.yml up -d --build postgres backend minio nginx`.

## Architecture

### Environment-driven, never `if (local)`
Local and production run the same code and differ only by env values (see `.env.example`, read in `backend/src/config/env.js`). Do not add environment-name branches. The key switches:
- `DB_MOCK_MODE` (default `true`; `.env.example` and compose set `false`): when true, uses `InMemoryDatabase` (JSON-file persisted to `backend/mock-database.json`). When false, uses `PgDatabase` and numbered migrations auto-run at startup.
- `AWS_MOCK_MODE` (default `false` since Step 13): when true, in-memory S3/DynamoDB/Lambda (`services/awsClients.js`), and it forces mock embedding and LLM adapters regardless of provider settings.
- `EMBEDDING_PROVIDER` / `LLM_PROVIDER` (`bedrock`, default; `mock` for tests): Titan Embed Text v2 and Nova Pro. Factories are in `src/embedding/embeddingAdapter.js` and `src/llm/llmAdapter.js`. `TTS_PROVIDER` (`kokoro` default | `google` | `mock`) and `STT_PROVIDER` (`lambda` default | `mock`) follow the same pattern (`src/tts/ttsAdapter.js`, `src/stt/sttAdapter.js`).
- **Real AI is mandatory at runtime (Step 13).** When `server.js` runs as the entrypoint it calls `config/validateAiConfig.js` first; `AWS_MOCK_MODE=true`, any `mock` provider, or missing model/function names fail startup with `AI_CONFIG_INVALID`. Mocks are deterministic and are only reachable through the test harness (`test/runTests.js`, `docker-compose.test.yml` + `test/startServer.js`) or `createApp` DI. Never relax the validator to make something run locally.

### Routing
Every backend router is mounted under `/api` (`/api/auth`, `/api/admin`, `/api/questions`, `/api/rubrics`, `/api/materials`, `/api/question-generation-jobs`, `/api/exam-sessions`, `/api/me`, `/api/interviews`, grading routes directly under `/api`, and `GET /api/tts/:filename`); only `/health` is at the root. Socket.IO serves the `/interview` namespace (`src/realtime/interviewSocket.js`). In the compose stack nginx serves the built SPA and proxies `/api/` to the backend, and the Vite dev server proxies `/api` too, so the frontend is always same-origin (`apiBaseUrl` defaults to `/api`). `/api/topics` requires a signed-in LECTURER or ADMIN. The old `/api/evaluations` and `/api/lecturer` scaffolds were removed; lecturer review goes through the grading routes.

### Backend layering and DI
Requests flow route → controller → service → repository (raw SQL via `db.query` / `db.withTransaction`). All wiring happens in `createApp(overrides)` in `src/app.js`. **Every dependency can be replaced through `overrides`**, and that's how tests inject fakes. When you add a feature, wire it there with the same `overrides.x || new X(...)` pattern.

`src/server.js` adds the parts that only exist with a real DB: it runs migrations, then starts `JobQueue` and registers handlers using `app.jobContext`.

### Mock DB limits
`InMemoryDatabase` (`src/db/createDatabase.js`) pattern-matches a fixed set of SQL strings, and only for the legacy question/rubric/topic tables. It throws `Unsupported in-memory SQL` for anything else. Auth, admin, materials, background jobs and generation need real Postgres at runtime. Their tests inject in-memory fake repositories through `createApp` overrides (see `test/materials.e2e.test.js`) rather than extending `InMemoryDatabase`. E2E suites use `test/helpers/createTestContext.js`, which points the mock DB at a temp file so the real `mock-database.json` is never touched, and mints auth cookies with `authCookie(role)`.

### Database & migrations
`backend/db/migrations/NNN_name.sql` are applied in numeric order by `src/db/migrationRunner.js`, which is idempotent and tracks applied versions. Add a new numbered file rather than editing applied ones. Postgres uses `pgvector`: `material_chunk` has an HNSW index, and question embeddings are indexed for near-duplicate detection (cosine ≥ 0.9 warns, exact normalized-content duplicates are blocked). `db/schema.sql` is a reference snapshot. `mapDbError` translates PG error codes (23505/23503) into HTTP errors.

### Background jobs
There is no Step Functions or SQS. Jobs are rows in a Postgres `background_job` table, claimed with `FOR UPDATE SKIP LOCKED`, and retried with exponential backoff up to `JOB_MAX_ATTEMPTS` (`src/jobs/jobQueue.js`). Request-time services never hold a queue handle. They receive an `enqueueJob(type, payload)` port backed by `BackgroundJobRepository`. Handlers live in `src/jobs/handlers.js` (`SEND_EMAIL`, `INGEST_MATERIAL`, `GENERATE_QUESTIONS`, `GRADE_INTERVIEW`, `KEEP_WARM`, `PREPARE_EXAM_AUDIO`, `EXPIRE_INTERVIEWS`). A new job type also needs a migration that widens the `background_job.type` CHECK constraint (see `023_background_job_expire_interviews.sql`). `KEEP_WARM` and `EXPIRE_INTERVIEWS` re-enqueue themselves with `runAfter`. Convention: **throw for transient failures** so the queue retries. For terminal content failures, mark the entity `FAILED` and return normally.

### RAG pipeline (Step 4)
1. Material upload (PDF/PPTX/DOCX, text layer required, no OCR) goes to S3, and an `INGEST_MATERIAL` job is enqueued.
2. The ingest job runs `ingest/parseDocument` → `ingest/chunkText` → embed → `material_chunk`.
3. Question generation enqueues `GENERATE_QUESTIONS`, which retrieves chunks, calls the LLM, validates grounding, and persists questions as `PENDING_REVIEW` with source refs (`question_source_ref`).
4. Lecturers then approve, edit or reject them.

Question lifecycle rules are in `src/domain/questionStatus.js`. Only approved questions can enter exams.

### Interview engine (Steps 6–13)
`services/interviewService.js` is the engine. Its public methods (`startOrResume`, `getCurrentState`, `markQuestionPlayed`, `appendPartialTranscript`, `submitAnswer`, `expireOverdueInterviews`) are exposed over REST (`/api/interviews`, incl. multipart answer upload) and Socket.IO (`/interview` namespace: `interview:join`, `interview:ready`, `question:played`, `answer:start`, `audio:chunk`, `answer:end`; server emits `interview:state`, `question:new`, `turn:processing`, `turn:retry`, `turn:error`, `interview:completed`). The browser records with `MediaRecorder` (webm/opus, 1 s chunks).
- Modules: `interview/*` (pure pieces: `decideNextStep`, `followUpDecision`, `groundingValidator`, `rationaleBuilder`, `studentView`, `studentResultView`, `pickQuestions`, `pickBalancedQuestions`, `sessionContextStore`), `domain/interviewStatus.js`, `stt/*`, `tts/*`, `services/speechSignals.js`, `llm/followUpPrompt.js` + `decideFollowUp` on the LLM adapters.
- Start: per-student pick of `main_question_count` APPROVED questions via `pickBalancedQuestions` (same Bloom mix for every candidate, avoids overlap with recent candidates, prefers least-used; `random` is injectable), stored as `assigned_question.order_no`; their rubrics are locked. `deadline_at = started_at + exam_session.session_time_limit_sec`, capped at `closes_at`, computed once and persisted. Resume is allowed after the exam is CLOSED; new starts are not.
- Exam language (`exam_session.language`, `VI` | `EN`) is **derived, never chosen**: `domain/questionLanguage.js` normalizes every question to `vi`/`en` (detected from the content when missing; migration 024 backfilled old rows), and `examSessionService` sets the exam language from the topic's APPROVED bank on create and again on schedule/start. An empty bank is `409 NO_APPROVED_QUESTIONS`, a mixed bank `409 MIXED_LANGUAGE_BANK`. The interview pick and audio pre-generation only use questions in the exam language. The language is passed to STT, TTS, follow-up generation and grading, independent of the UI language.
- STT failure after two calls returns `STT_FAILED` (`turn:retry`) and keeps the current turn and deadline; empty/corrupt audio gets one re-record. TTS failure falls back to browser Web Speech.
- Closing an exam does not end running interviews. `EXPIRE_INTERVIEWS` ends overdue ones as COMPLETED / `DEADLINE_REACHED`. `TERMINATED` exists in the status table but nothing writes it.
- Decision order after each answer (do not reorder): (1) session deadline passed → end; (2) empty answer → next main question; (3) the LLM proposes a follow-up AND `max_follow_ups_per_question` is not reached → follow-up; (4) otherwise next main question, and when none remain → end. The LLM is retried once on error/timeout/invalid JSON; a second failure moves on to the next main question and writes a `processing_failure` row. The exam never stops because of a provider.
- On end: COMPLETED, transcript persisted, `viva_result` PENDING created, `GRADE_INTERVIEW` enqueued. Grading (`services/gradingService.js`, `domain/scoringRules.js`) moves the result PENDING → AI_SCORING → AI_SUGGESTED | FLAGGED. A main question with no answer (`isUnansweredQuestion`: every turn, follow-ups included, is empty, punctuation, a bracketed STT tag like `[silence]` or only filler sounds, or it was never asked before the deadline) scores 0 on every criterion **without calling the LLM** (`model_id = 'rule:no-answer'`, `confidence = 1`, feedback in the exam language) and still counts as 0 in the mean; one substantive turn sends the question to the LLM. Then examiners adjust (reason required, audited in `score_adjustment`) and FINALIZE; reopen returns to FLAGGED/AI_SUGGESTED, regrade to AI_SCORING. Students only see FINALIZED results through `toStudentResultView` + `assertStudentResultSafe`.
- Postgres is the source of truth. The DynamoDB SessionContext (`clients.sessionStore`, item key `interview#<id>`, TTL attribute `expiresAt`) holds current turn, deadlines, partial transcript segments and covered key points; it is rebuilt from Postgres when missing. The service keeps no in-memory state.
- Rationale (why a question was asked, grounded citations) is snapshotted into `qa_turn.rationale` and is lecturer-only. Every engine return goes through `toStudentInterviewView` (explicit allowlist) plus `assertStudentSafe`. Never return DB rows to students.
- Env vars: `STT_PROVIDER`, `STT_TIMEOUT_MS`, `TTS_TIMEOUT_MS`, `AUDIO_LAMBDA_FUNCTION_NAME`, `TTS_LAMBDA_FUNCTION_NAME`, `LAMBDA_ENDPOINT` / `TTS_LAMBDA_ENDPOINT` (local RIE), `SESSION_TABLE_AUTO_CREATE` (create the DynamoDB table + TTL at startup; local only), `SESSION_CONTEXT_TTL_GRACE_SEC`, `FOLLOW_UP_LLM_TIMEOUT_MS`, `INTERVIEW_SWEEP_INTERVAL_SEC`, `INTERVIEW_SWEEP_GRACE_SEC`. `DYNAMODB_ENDPOINT` and `S3_ENDPOINT` (with separate `S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY` for MinIO) are honored by the real clients.
- Engine unit tests use the in-memory fakes in `test/helpers/interviewFakes.js` (`buildWorld`); `test/interviewEngine.e2e.test.js` covers the real SQL and self-skips without Postgres.

### Auth
- JWT access and refresh tokens are stored in httpOnly cookies (`src/auth/`). Roles are `ADMIN`, `LECTURER` and `STUDENT`.
- `createAuthMiddleware` exposes `requireAuth` and `requireRole` only. Subject scoping is done in services, because most routes only learn the subject after loading the resource: `services/subjectScope.js` (questions via their topic, rubrics, topics, exam sessions), plus own checks in `materialService`, `questionGenerationService` and `gradingService._assertSessionAccess` (results and turn audio). Rows with no subject are treated as unscoped. Any new lecturer endpoint that returns student data must go through one of these checks.
- CSRF protection is an Origin check (`middleware/csrf.js`): state-changing requests must send an `Origin` that matches `APP_BASE_URL`. The check is skipped only when no origin is configured.
- Errors carry `statusCode` + `code`, and the global handler returns `{ message, code }` so the frontend can branch on `code`.
- Accounts are created by an admin, and users set their password through emailed links. Email is sent via the `SEND_EMAIL` job and captured by Mailpit locally.

### Admin and audit (Step 14)
- Users: `POST /api/admin/users` takes a role (STUDENT needs a code). Role change and delete are soft and guarded (`CANNOT_MODIFY_SELF`, `LAST_ADMIN`, `USER_IN_OPEN_EXAM`); delete sets status `DELETED` (migration 027), revokes links/sessions and hides the user. `GET /api/admin/users` searches/pages server-side when given `q`/`status`/`subjectId`/`page`/`pageSize`; the frontend picker is `components/ui/UserPicker.jsx`.
- Subjects: duplicate code is `409 SUBJECT_CODE_TAKEN`; a subject with content cannot be deleted (`409 SUBJECT_IN_USE` + counts) and is archived instead (`subject.status`, migration 025). Archived subjects are hidden from lecturer pickers and cannot get new exams.
- Exams: admins create/edit/delete via `/api/admin/exam-sessions`; only an unused DRAFT/SCHEDULED exam is deleted (`SESSION_IN_USE`).
- Every successful admin write is recorded in `admin_audit_log` (migration 026, IDs only: actor, action, entity type, entity id) by `AdminController._audit`, after the write (not in its transaction). `GET /api/admin/audit-log`.
- Question bank: a question's rubric must belong to its topic's subject (`RUBRIC_SUBJECT_MISMATCH`); rubrics have an optional `name` (028); a generation job may carry a `rubricId` attached to every draft (029). `GET /api/exam-sessions/progress` feeds the lecturer dashboard (per-subject workflow progress); the lecturer workflow order lives in `frontend/src/config/lecturerFlow.js`.
- Frontend error text: `i18n/core.js` `errorMessage` maps API `code` to a VI/EN message; pages show `err.message`. Add new codes there.

### Frontend
- `src/services/*Api.js` wrap `apiRequest` from `authApi.js`, which sends `credentials: 'include'` and throws errors carrying `status`/`code`. The base URL comes from `src/config/api.js`: `VITE_API_BASE_URL` if set, otherwise same-origin `/api`.
- `contexts/AuthContext.jsx` loads the session from `/auth/me`.
- Session refresh (access cookie 15 min, refresh 7 days): every API call goes through `authedFetch` in `authApi.js`, which on a `401` calls `POST /auth/refresh` once and retries; concurrent 401s share one in-flight `refreshSession()` because refresh tokens rotate and a replayed one is refused. The `/auth/login|refresh|logout|forgot-password|reset-password|set-password` paths never refresh. `AuthContext` also refreshes every 10 min while signed in, for requests that cannot retry (`<audio src>` for answer/TTS audio, the socket handshake), and `VivaSession` refreshes once and reconnects when the socket handshake fails with `AUTHENTICATION_REQUIRED`/`INVALID_TOKEN`. Use `authedFetch` (never bare `fetch`) for any new non-`apiRequest` call.
- Error pages: `shared/components/ErrorPage` exports `ErrorPage` (copy per HTTP status 400/401/403/404/409/500/503, 502/504 → 503; back, role home or sign-in, optional `onRetry`) and `ErrorBoundary` (render errors → 500 page, reset on pathname change). `AppRoutes` wraps the app and each role shell in a boundary, adds `*` → 404 routes, and `ProtectedRoute` shows a 403 page inside the user's own shell for another role's area (no silent redirect). Detail pages pick the page from `httpStatusOf(err)` (`shared/utils/httpStatus.js`, also home of `ROLE_HOME`).
- Device check: the student dashboard opens `components/exam/DeviceCheckModal.jsx` before calling `POST /api/interviews`, so a first start's timer only runs after it passes (browser support, mic opens, 600 ms of voice on the level meter, student confirms hearing a test tone; optional mic picker and 3 s record-and-play). On success it marks `aives.deviceCheck.<interviewId>` in `sessionStorage`; `VivaSession` then sends `interview:ready` straight away, otherwise (direct link, other tab) it falls back to its inline mic check. Helpers live in `shared/utils/audioDevices.js` (preferred mic in `localStorage` `aives.micDeviceId`, `openMicStream` falls back to the default mic when the saved one is gone).
- `routes/AppRoutes.jsx` routes per role (`/admin`, `/lecturer`, `/student`) through `ProtectedRoute`. The exam room is `/student/viva?interviewId=<id>`. Shared UI primitives are in `src/components/ui/`.
- i18n (Step 13): Vietnamese is the default UI language; the choice is stored in `localStorage` key `aives.uiLanguage`. User-visible strings go through `t(key)` from `src/i18n/core.js`, which falls back to the key itself when a translation is missing, so add every new key to both `vi.json` and `en.json`. User-authored content (questions, names) is never translated.

## Conventions
- Git worktrees go in `.worktrees/` (gitignored). `jest.config.js` deliberately uses an unanchored `**/test/**` match so tests still run under that dot-directory.
- Never commit `.env` or real secrets. Prod secrets come from SSM / Secrets Manager.
