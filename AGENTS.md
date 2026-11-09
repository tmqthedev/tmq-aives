# AGENTS.md

This file is the working contract for every coding agent in `swd392_team7_product`. Read it before editing. The user's current instructions and an approved task plan take precedence over this file; use the code and migrations to verify facts that can change.

## How to work in this repo

1. State the task boundary and inspect the affected route, controller, service, repository, UI, and tests before editing. Do not infer production behavior from a mock test.
2. Keep unrelated edits intact. Use an isolated worktree for overlapping tasks; do not commit secrets, generated plans, audio recordings, or personal data.
3. Preserve the architecture and security invariants in Section 4. Add a numbered migration for schema changes; never rewrite an applied migration.
4. Run the package-local checks in Section 3. Report exactly which checks passed, failed, or were skipped, and distinguish local results from unobserved staging or production behavior.
5. If an external coding agent is used, give it a bounded file and feature scope. The coordinating agent reviews its diff, tests, privacy boundaries, and integration before accepting the work.

### Approved upgrade contract (2026-11-08)

These are requirements for the current realtime, audio, transcript, and grading upgrade; do not describe them as shipped until implementation and verification finish.

- Realtime covers business changes for `ADMIN`, `LECTURER`, and `STUDENT`: users/subjects, materials, questions/rubrics, exams, interviews, and results. Enforce the same ownership and subject scope as REST. Broadcast only safe invalidation/status data after successful writes, resync on reconnect, and target about two seconds between connected browsers. Admin/lecturer exam monitoring shows aggregate counts, not live answer content.
- Check microphone before creating an interview so the exam timer begins only after a valid voice signal and the student's start action. Let students select supported devices, adjust in-app microphone gain and AI playback volume, inspect the level, and test playback. Microphone readiness is required; speaker failure is a warning because questions remain visible as text.
- Show the known TTS question text with playback status. Do not transcribe TTS audio. Do not show student speech text while recording. After submission, send the server STT result as soon as it is stored, before follow-up processing finishes. Keep a read-only, student-owned question/answer history during and after the interview. Let students flag STT errors for lecturer audio review without changing the original audio or transcript.
- Every newly created or imported question requires explicit lecturer approval with a nonempty reference answer, key points, and rubric. Existing approved questions with complete data remain usable and are marked as legacy; incomplete ones return to review and cannot be selected. Scheduling/opening checks the eligible bank size and Bloom quotas. Edits to approved grading content create a pending revision while the approved version remains in use. Each new interview snapshots the approved version at start; follow-ups, grading, and regrading use that snapshot.
- Approved reference answer and key points define creditable content; rubric defines the score scale; uploaded materials provide context. Unsupported AI evidence is flagged for lecturer review. Existing started interviews are not retroactively changed; legacy items without a complete reference require manual review. Grading progress visible to authorized lecturers/admins shows stage and question index, survives reload, and reveals scores only when the whole grading job finishes. Lecturer approval remains the final grade decision.

---

## 1. Project Overview

**AIVES**: An AI-assisted oral examination (viva) platform for academic courses (SWD392).
- **Core Workflow**:
  1. Lecturers create question banks (manual entry, Excel bulk import, or RAG-assisted generation from uploaded course materials).
  2. Questions are reviewed, approved, and linked to rubrics with weighted criteria.
  3. Exam sessions are scheduled with time limits and assigned topics.
  4. Students take voice-based interviews with the AI interviewer.
  5. The AI transcribes answers, generates follow-up questions dynamically, evaluates performance against rubrics, and suggests grades for lecturer approval.
- **Documentation**: Vietnamese product/design docs in `docs/` (PRD, SRS, SDS, and `e2e-plan-management.md`).
- **Development Roadmap**: Delivered in numbered "Steps". Per-step task plans, features, and reviews are tracked in `.agents/tasks/<step>/`. Commits follow conventional commits prefixed by step (e.g. `feat(step6): ...`, `fix(step6): ...`, `chore(step6): ...`).

---

## 2. Directory Structure

```text
swd392_team7_product/
├── backend/                   # Express 5 REST API (CommonJS, Node 20)
│   ├── src/
│   │   ├── app.js             # createApp(overrides) DI container
│   │   ├── server.js          # DB migrations & job queue runtime entry
│   │   ├── auth/              # JWT token management, cookie handling
│   │   ├── config/            # env.js configuration loader
│   │   ├── controllers/       # HTTP request handlers
│   │   ├── db/                # Migration runner, PgDatabase, InMemoryDatabase
│   │   ├── domain/            # Domain entities, statuses, transitions
│   │   ├── embedding/         # Embedding adapter (Titan / mock)
│   │   ├── ingest/            # Document parsing (PDF/DOCX/PPTX) & text chunking
│   │   ├── interview/         # Pure interview engine logic & student safe view
│   │   ├── jobs/              # JobQueue & background handlers
│   │   ├── llm/               # LLM adapter (Nova / mock) & prompt builders
│   │   ├── middleware/        # Auth, role check, CSRF, error handling
│   │   ├── repositories/      # Data access layer (Postgres / in-memory fakes)
│   │   ├── routes/            # Express routers mounted under /api
│   │   ├── services/          # Business logic services
│   │   ├── stt/               # STT adapter (Lambda / mock)
│   │   ├── realtime/          # Socket.IO /interview namespace
│   │   ├── cli/               # createAdmin, verifyRealAi
│   │   └── tts/               # TTS adapter (Kokoro Lambda / Google / mock)
│   ├── db/migrations/         # Numbered SQL migrations; inspect the latest number before adding one
│   └── test/                  # Test suites (unit & e2e) + helpers/
├── frontend/                  # React 19 + Vite SPA (ESM, JSX, Tailwind/Vanilla CSS)
│   ├── src/
│   │   ├── components/        # Reusable UI components & layouts (ui/ primitives)
│   │   ├── contexts/          # AuthContext
│   │   ├── features/auth/     # Login page
│   │   ├── i18n/              # VI/EN dictionaries, t(), LanguageSwitcher (Step 13)
│   │   ├── pages/             # Route pages (Admin, Lecturer, Student)
│   │   └── services/          # API client modules
├── lambda/                    # STT (PhoWhisper/Whisper) and TTS (Kokoro-82M) Lambda container images
├── infrastructure/terraform/  # AWS cloud infrastructure
├── docker-compose.yml         # Local stack (pgvector, DynamoDB Local, MinIO, Mailpit, Nginx, STT/TTS RIE)
├── docker-compose.test.yml    # Offline mock-AI override, test harness only
├── nginx/                     # Reverse proxy & static serving config
└── .agents/                   # Agent task tracking, reviews & plans
```

---

## 3. Essential Commands & Workflows

### Backend (`cd backend`)
- **Start server**: `npm start` (runs `node src/server.js`)
- **Unit tests**: `npm test` (`node test/runTests.js unit`: `node:test` + `node:assert/strict`). **Crucial: Unit test files MUST be named `*Service.test.js`** in `backend/test/` to be detected.
- **E2E tests**: `npm run test:e2e` (`node test/runTests.js e2e`: Jest + supertest with `--runInBand`). **E2E test files MUST be named `*.e2e.test.js`**.
  - Run single E2E suite / test: `node test/runTests.js e2e test/materials.e2e.test.js -t "uploads"`
- `test/runTests.js` forces `AWS_MOCK_MODE=true` and all `*_PROVIDER=mock`. Env defaults are real providers since Step 13, so set those variables yourself if you run `node --test <file>` or `npx jest <file>` directly.
- **Real-AI smoke test** (billed): `node src/cli/verifyRealAi.js --create-test-fixtures` — see `docs/bilingual-real-ai.md`.
- **All tests**: `npm run test:all`
- **Create Admin User**: `npm run create-admin -- --email admin@aives.local --password secret123` (requires active Postgres).
- **Postgres E2E Tests**: Tests requiring Postgres (`migrations`, `jobQueue`, `step4`, `examSessions`, `interviewEngine`) auto-skip if `TEST_DATABASE_URL` is unset.
  - Start DB: `docker compose up -d postgres`
  - Run with DB (PowerShell): `$env:TEST_DATABASE_URL='postgres://aives:aives@localhost:5432/aives'; npm run test:e2e`

### Frontend (`cd frontend`)
- **Dev Server**: `npm run dev` (runs Vite dev server with proxy to `/api`)
- **Lint**: `npm run lint` (runs `oxlint`)
- **Build**: `npm run build`
- **Preview**: `npm run preview`

### Local Multi-Container Stack (Root)
- **Start All**: `docker compose up` (or `-d` for daemon). Needs temporary AWS credentials in the shell for Bedrock; STT/TTS run locally as Lambda RIE containers.
  - Web App: `http://localhost:8080`
  - Mailpit Web UI (captured emails): `http://localhost:8025`
  - MinIO S3 Console: `http://localhost:9001`
- **Validate Compose**: `docker compose config`

---

## 4. Architecture Principles & Rules

### Environment-Driven Configuration (NEVER `if (local)`)
Code MUST NOT branch on environment names (`process.env.NODE_ENV === 'local'`). Instead, use explicit functional feature flags loaded in `backend/src/config/env.js`:
- `DB_MOCK_MODE` (default `true`; compose and `.env.example` set `false`): If `true`, uses `InMemoryDatabase` (persisted to `backend/mock-database.json` for basic legacy tables). If `false`, connects to `PgDatabase` and runs SQL migrations on startup.
- `AWS_MOCK_MODE` (default `false`): In-memory S3/DynamoDB/Lambda clients (`services/awsClients.js`) when `true`; also forces mock embedding and LLM adapters.
- `EMBEDDING_PROVIDER` (`bedrock` default | `mock`): Titan Embed Text v2.
- `LLM_PROVIDER` (`bedrock` default | `mock`): Nova Pro.
- `TTS_PROVIDER` (`kokoro` default | `google` | `mock`) & `STT_PROVIDER` (`lambda` default | `mock`): Speech adapters.
- **Real AI is mandatory at runtime (Step 13)**: `server.js` runs `config/validateAiConfig.js` before starting and fails with `AI_CONFIG_INVALID` on `AWS_MOCK_MODE=true` or any `mock` provider. Mock adapters are only for the test harness and `createApp` DI. Do not weaken this check.

### Backend Layering & Dependency Injection (DI)
- Request lifecycle: **Route -> Controller -> Service -> Repository** (raw SQL via `db.query` / `db.withTransaction`).
- Application container: `createApp(overrides)` in `src/app.js`.
- **Every dependency can be overridden via `overrides`**: This is how test suites inject fakes and mock databases without altering production code.
- Always follow the pattern `overrides.x || new X(...)` when introducing new services or repositories.
- `src/server.js` initializes migration runner, job queue listeners, and server sockets.

### Database & Migrations
- Migration files are located in `backend/db/migrations/NNN_<description>.sql`.
- Applied sequentially and tracked in `schema_migrations` table by `src/db/migrationRunner.js`.
- **Never edit an already applied migration file.** Always create a new numbered `.sql` migration file for schema changes.
- Uses `pgvector` for vector embeddings: `material_chunk` uses HNSW indexing.
- Question duplicate detection: cosine similarity $\ge 0.9$ warns of near-duplicates; exact normalized content duplicate is blocked.
- Database error mapping: Use `mapDbError` to convert Postgres error codes (e.g. `23505` unique violation, `23503` foreign key violation) into standard HTTP application errors.

### Background Jobs
- In-database queue backed by `background_job` table using `FOR UPDATE SKIP LOCKED` (`src/jobs/jobQueue.js`).
- Job handlers registered in `src/jobs/handlers.js`:
  - `SEND_EMAIL`: Account setup and password reset emails.
  - `INGEST_MATERIAL`: Parse document (PDF/PPTX/DOCX), chunk text, compute embeddings, store in `material_chunk`.
  - `GENERATE_QUESTIONS`: Retrieve relevant material chunks, query LLM, validate citations and grounding, save questions with status `PENDING_REVIEW`.
  - `GRADE_INTERVIEW`: Score completed viva interview against rubric criteria.
  - `KEEP_WARM`: Ping STT/TTS Lambdas every 5 minutes while an exam is OPEN (self re-enqueues).
  - `PREPARE_EXAM_AUDIO`: Pre-synthesize question audio into S3 `tts-cache/` when an exam starts.
  - `EXPIRE_INTERVIEWS`: Every 60 s, end interviews past `deadline_at` + grace as COMPLETED / `DEADLINE_REACHED` (self re-enqueues).
  - A new job type needs a migration widening the `background_job.type` CHECK constraint.
- **Queue Error Convention**:
  - *Transient failures* (e.g. network timeout, rate limit): **Throw error** to let `JobQueue` retry with exponential backoff up to `JOB_MAX_ATTEMPTS`.
  - *Terminal content failures* (e.g. corrupt file, invalid schema): Update entity status to `FAILED`, log error, and return normally without throwing.

### Authentication & Authorization
- Tokens: JWT Access and Refresh tokens stored in `httpOnly` secure cookies (`src/auth/`).
- Roles: `ADMIN`, `LECTURER`, `STUDENT`.
- Admin (Step 14): Add User by role, guarded role change and soft delete (`DELETED`), subject archive instead of delete, admin exam create/delete, and an IDs-only `admin_audit_log` written by `AdminController._audit`. Server-side user search via `GET /api/admin/users?q=&role=&status=&subjectId=&page=` and the shared `components/ui/UserPicker.jsx`. See the "Admin and audit" section of CLAUDE.md.
- Frontend error text: map API `code` to a VI/EN message in `i18n/core.js` `errorMessage`; pages show `err.message`.
- Subject Scoping: Lecturers are restricted to subjects assigned to them. Enforced in services (`services/subjectScope.js`, plus the material, generation and grading services), not in route middleware.
- CSRF Protection: `middleware/csrf.js` verifies incoming `Origin` against `APP_BASE_URL` on state-changing methods (`POST`, `PUT`, `PATCH`, `DELETE`).
- Error Handling: Errors have `statusCode` and machine-readable `code`. Responses format as `{ message, code }`.

### Interview Engine (Steps 6–13)
- Engine core: `backend/src/services/interviewService.js` and pure submodules in `backend/src/interview/`.
- Transport: REST `/api/interviews` and Socket.IO namespace `/interview` (`src/realtime/interviewSocket.js`). The browser records with `MediaRecorder` (webm/opus, 1 s `audio:chunk`) and ends with `answer:end`.
- Exam language (`VI` | `EN`) is derived from the topic's approved questions (`domain/questionLanguage.js`), never chosen in the UI; it drives STT, TTS, follow-ups and grading, independent of the UI language.
- Closing an exam does not end running interviews; `EXPIRE_INTERVIEWS` does. `TERMINATED` is defined but never written.
- DynamoDB session store (`clients.sessionStore`): Tracks ephemeral turn state, deadlines, transcripts, and TTL (`expiresAt`). Rebuilt from Postgres if missing.
- **Strict Decision Order After Answer**:
  1. Session deadline exceeded -> End interview.
  2. Empty answer -> Move to next main question.
  3. LLM proposes valid follow-up AND follow-up limit not reached -> Ask follow-up question.
  4. Otherwise -> Move to next main question (if none remain -> End interview).
- **Student Safety & Privacy**: Never return internal DB rows, reference answers, key points, or rationale to students. Interview state must pass through `toStudentInterviewView()` and `assertStudentSafe()`. A student transcript endpoint needs its own explicit allowlist and ownership check; do not weaken the existing state guard. Rationale and citations are strictly lecturer-facing.

---

## 5. Coding & Testing Guidelines for Agents

1. **Test-Driven Changes**:
   - When modifying backend services, run `npm test` from `backend/` to ensure no unit regressions.
   - For E2E flows, run `node test/runTests.js e2e test/<suite>.e2e.test.js` (it forces the mock AI env).
2. **Mock DB vs Real Postgres**:
   - `InMemoryDatabase` only handles legacy CRUD SQL queries (`topics`, `rubrics`, `questions`).
   - Do NOT try to implement complex Postgres joins or migrations inside `InMemoryDatabase`. For tests touching newer features (auth, materials, jobs, interviews), inject in-memory fake repositories via `createApp` overrides (see `test/helpers/createTestContext.js` and `test/helpers/interviewFakes.js`).
3. **Frontend Rules**:
   - Always run `npm run lint` in `frontend/` after modifying UI code.
   - Wrap user-visible strings in `t(key)` and add the key to both `src/i18n/vi.json` and `src/i18n/en.json` (missing keys silently fall back to the key text).
   - Avoid synchronous `setState` calls directly inside `useEffect` bodies where possible.
4. **Git & Workspace Management**:
   - Worktrees are placed in `.worktrees/` (ignored by git).
   - Never commit `.env` or plaintext credentials.
   - Before reporting completion, review `git diff --check`, the changed-file list, and any skipped checks. Do not claim a real-AI, Docker, staging, or production result unless that exact environment was exercised.
