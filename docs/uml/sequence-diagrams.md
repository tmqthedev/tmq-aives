# UML Sequence Diagrams

Tên lifeline là lớp/module thật trong repo; tên message là hàm, endpoint hoặc sự kiện Socket.IO thật. `alt` / `opt` / `loop` là combined fragment của UML.

Nguồn: `frontend/src/pages/`, `frontend/src/components/exam/DeviceCheckModal.jsx`, `frontend/src/contexts/AuthContext.jsx`, `frontend/src/services/authApi.js`, `backend/src/realtime/interviewSocket.js`, `backend/src/services/` (auth, admin, material, questionGeneration, question, examSession, examLaunch, interview, grading), `backend/src/jobs/`, `backend/src/server.js`.

## 1. Bắt đầu hoặc tiếp tục phiên thi

```mermaid
sequenceDiagram
  autonumber
  actor St as Student
  participant UI as SPA (Dashboard → VivaSession)
  participant API as interviewRoutes / InterviewController
  participant IS as InterviewService
  participant DB as Postgres (repositories)
  participant TTS as ttsAdapter (Lambda Kokoro)
  participant S3 as S3 audio (tts-cache)
  participant SC as SessionContextStore (DynamoDB)

  St->>UI: bấm Bắt đầu / Tiếp tục thi
  UI->>UI: DeviceCheckModal: getUserMedia, đo mức âm, phát âm thanh thử
  alt chưa đạt hoặc huỷ
    UI-->>St: giải thích lỗi micro / loa, chưa gọi API
  end
  St->>UI: Bắt đầu thi (micro đủ 600 ms tiếng nói, đã nghe âm thanh thử)
  UI->>API: POST /api/interviews {examSessionId}
  API->>IS: startOrResume(user, examSessionId, clientIp)
  IS->>DB: examSessionRepository.findById
  IS->>DB: vivaInterviewRepository.findByExamAndStudent
  alt đã có interview
    IS->>IS: _resume(interview, exam)
    IS-->>API: toStudentInterviewView(state)
  else lần đầu
    IS->>DB: isStudentOnRoster
    Note over IS: kiểm tra OPEN, roster, opens_at,<br/>deadline_at = min(now + session_time_limit_sec, closes_at)
    IS->>DB: _loadQuestionBank(topic, language) [APPROVED]
    IS-)TTS: _warmSttInBackground(language)
    rect rgb(245,245,245)
      Note over IS,DB: withTransaction
      IS->>DB: _lockExam (SELECT ... FOR UPDATE)
      IS->>IS: _pickMainQuestions → pickBalancedQuestions
      IS->>TTS: _prepareMainTurn → synthesize(câu 1)
      TTS->>S3: get/put tts-cache/<sha256>.wav
      TTS-->>IS: audioKey | ttsError
      IS->>DB: vivaInterviewRepository.create(IN_PROGRESS)
      IS->>DB: assignedQuestionRepository.createMany
      IS->>DB: rubricRepository.setLocked(true)
      IS->>DB: qaTurnRepository.create(MAIN, ASKED)
      IS->>DB: assignedQuestionRepository.markAsked
    end
    opt ttsError
      IS->>DB: processing_failure (stage TTS)
    end
    IS->>SC: put(context)
    IS-->>API: toStudentInterviewView + assertStudentSafe
  end
  API-->>UI: 200 {interview, currentTurn}
  UI->>UI: markDeviceCheckPassed(id) (sessionStorage), chuyển tới /student/viva?interviewId=<id>
  UI->>API: Socket.IO interview:join
  API-->>UI: interview:state
  alt tab đã qua kiểm tra thiết bị
    UI->>API: interview:ready
  else mở trực tiếp / tab khác
    UI->>St: bước kiểm tra micro tại chỗ
    St->>UI: bắt đầu
    UI->>API: interview:ready
  end
  API-->>UI: question:new (hoặc interview:completed)
```

## 2. Một lượt trả lời (Socket.IO)

```mermaid
sequenceDiagram
  autonumber
  actor St as Student
  participant UI as SPA (VivaSession, MediaRecorder)
  participant WS as interviewSocket (/interview)
  participant IS as InterviewService
  participant DB as Postgres
  participant S3 as S3 audio
  participant STT as sttAdapter (Lambda PhoWhisper / Whisper)
  participant LLM as llmAdapter (Bedrock Nova Pro)
  participant TTS as ttsAdapter (Lambda Kokoro)
  participant SC as SessionContextStore

  UI->>UI: phát audio câu hỏi (lỗi → Web Speech)
  UI->>WS: question:played {turnId}
  WS->>IS: markQuestionPlayed
  IS->>DB: transitionStatus(ASKED → ANSWERING, answer_deadline_at)
  IS->>SC: update(currentTurnId, answerDeadlineAt)
  WS-->>UI: interview:state
  St->>UI: nói
  UI->>WS: answer:start
  loop mỗi 1 s
    UI->>WS: audio:chunk
  end
  UI->>WS: answer:end
  WS-->>UI: turn:processing
  WS->>IS: submitAnswer(audio, contentType, timedOut, signals)
  IS->>DB: transitionStatus(ASKED|ANSWERING → PROCESSING)
  alt audio rỗng / hỏng và retry_count < 1
    IS->>DB: processing_failure (AUDIO_INPUT), turn → ANSWERING
    IS-->>WS: view + retryPrompt
    WS-->>UI: turn:retry
  else có audio
    loop tối đa 3 lần
      IS->>S3: putObject(interviews/<id>/turns/<turn>/answer.webm)
    end
    loop tối đa 2 lần
      IS->>STT: transcribe(audio, language, hints = key_points)
    end
    alt STT lỗi cả 2 lần
      IS->>DB: processing_failure (STT), turn về trạng thái cũ, retry_count + 1
      IS-->>WS: 502 STT_FAILED
      WS-->>UI: turn:retry
    end
  end
  IS->>DB: qaTurnRepository.update(ANSWERED, answer_text, confidence, timed_out, signals)
  opt còn hạn, câu trả lời không rỗng, còn lượt follow-up
    IS->>LLM: decideFollowUp(question, rubric, sourceChunks, history)
    Note right of LLM: lỗi / timeout / JSON sai → thử lại 1 lần,<br/>lần 2 lỗi → processing_failure (FOLLOW_UP_LLM)
    LLM-->>IS: {next_action, follow_up_question, covered_key_points, rationale}
  end
  IS->>IS: decideNextStep(now, deadlineAt, answerText, caps, llmDecision)
  alt END_SESSION hoặc hết câu chính
    IS->>DB: _endInterview (COMPLETED, UNANSWERED, transcript, viva_result PENDING)
    IS->>DB: enqueueJob(GRADE_INTERVIEW)
    WS-->>UI: interview:completed
  else ASK_FOLLOW_UP
    IS->>IS: validateGrounding, buildFollowUpRationale
    IS->>TTS: synthesize(follow_up_question)
    IS->>DB: qa_turn FOLLOW_UP ASKED, current_follow_up_count + 1
    WS-->>UI: question:new
  else NEXT_MAIN
    IS->>TTS: _prepareMainTurn (cache hit sau PREPARE_EXAM_AUDIO)
    IS->>DB: qa_turn MAIN ASKED, markAsked, current_question_index + 1
    WS-->>UI: question:new
  end
  IS->>SC: update(context, coveredKeyPoints)
  WS-->>UI: interview:state
  Note over WS,UI: lỗi khác trong answer:end → turn:error {message, code}
```

## 3. Chấm điểm nền và giảng viên chốt

```mermaid
sequenceDiagram
  autonumber
  participant Q as JobQueue
  participant H as GRADE_INTERVIEW handler
  participant GS as GradingService
  participant DB as Postgres (vivaResultRepository)
  participant LLM as llmAdapter.gradeQuestion
  actor Lec as Lecturer
  participant UI as SPA (lecturer grading)
  participant API as gradingRoutes

  Q->>DB: claimNext (FOR UPDATE SKIP LOCKED)
  Q->>H: handler(job)
  H->>GS: gradeInterview({interviewId})
  GS->>DB: viva_result → AI_SCORING
  GS->>DB: interview, assigned questions, qa_turn
  loop mỗi assigned question
    GS->>DB: rubric_criterion + performance_level
    alt isUnansweredQuestion(turns)
      GS->>GS: noAnswerEvaluation: 0 điểm, model_id rule:no-answer (không gọi LLM)
    else có nội dung trả lời
      GS->>LLM: gradeQuestion(mainQuestion, history, rubricCriteria, language)
      alt lỗi tạm thời
        GS-->>H: throw
        H-->>Q: throw → markFailed / backoff
      else lỗi khác
        GS->>GS: đánh giá rỗng + flag_reason
      else thành công
        GS->>GS: lọc criterion/level sai, calculateQuestionScore
      end
    end
  end
  GS->>DB: saveEvaluationsAndCriteria
  GS->>GS: calculateVivaTotalScore, detectFlagReason
  GS->>DB: viva_result → AI_SUGGESTED | FLAGGED
  H-->>Q: ok → markDone

  Lec->>UI: mở kết quả kỳ thi
  UI->>API: GET /api/exam-sessions/:id/results, GET /api/results/:id
  API->>GS: listSessionResults / getResultDetail (_assertSessionAccess)
  opt sửa điểm
    UI->>API: PUT /api/criterion-scores/:id {newScore, reason}
    API->>GS: adjustCriterionScore
    GS->>DB: insertScoreAdjustment, updateCriterionScore, updateEvaluationScore, final_total_score
  end
  UI->>API: POST /api/results/:id/finalize
  API->>GS: finalizeResult
  GS->>DB: status FINALIZED, finalized_by, finalized_at
  API-->>UI: 200
```

## 4. Đăng nhập và làm mới phiên (refresh token xoay vòng)

`AuthService.login` / `refresh` (`backend/src/services/authService.js`). Token nằm trong cookie httpOnly (access 15 phút, refresh 7 ngày). SPA gọi `/auth/me` khi tải trang và tự làm mới phiên qua `refreshSession` (`frontend/src/services/authApi.js`): khi một lời gọi API nhận `401` (`authedFetch`, trừ các endpoint login/refresh/logout/forgot/reset/set-password), mỗi 10 phút khi đã đăng nhập (`AuthContext`), và khi bắt tay Socket.IO phòng thi bị từ chối. Các `401` đồng thời dùng chung một lần refresh.

```mermaid
sequenceDiagram
  autonumber
  actor U as User
  participant UI as SPA (features/auth/login, AuthContext)
  participant API as authRoutes / AuthController
  participant AS as AuthService
  participant UR as AppUserRepository
  participant SR as AuthSessionRepository
  participant TS as TokenService (JWT)
  U->>UI: nhập email hoặc mã + mật khẩu
  UI->>API: POST /api/auth/login
  API->>AS: login(identifier, password, ip, userAgent)
  AS->>UR: findByEmailOrCode(identifier)
  alt không có user hoặc status DELETED
    AS-->>API: 401 INVALID_CREDENTIALS
  else locked_until còn hạn hoặc status LOCKED
    AS-->>API: 423 ACCOUNT_LOCKED
  else sai mật khẩu
    AS->>UR: registerLoginFailure (đếm và khoá nguyên tử)
    AS-->>API: 401 INVALID_CREDENTIALS
  else đúng mật khẩu
    AS->>UR: update(failed_login_count 0, last_login_at)
    AS->>TS: signAccess, signRefresh
    AS->>SR: create(sha256(refresh), expiresAt, ip, userAgent)
    AS-->>API: user + accessToken + refreshToken
    API-->>UI: 200, Set-Cookie access + refresh (httpOnly)
    UI->>API: GET /api/auth/me
    API-->>UI: user (role → /admin, /lecturer, /student)
  end
  Note over UI,API: Làm mới phiên (authedFetch nhận 401, hoặc timer 10 phút)
  UI->>API: POST /api/auth/refresh (cookie refresh)
  API->>AS: refresh(refreshToken)
  AS->>TS: verify(type refresh)
  AS->>SR: findActiveByHash(sha256)
  AS->>UR: findById(sub), phải ACTIVE
  AS->>SR: revoke(hash)
  alt revoke không khớp dòng nào (token đã dùng lại)
    AS-->>API: 401 UNAUTHORIZED
  else
    AS->>TS: signAccess, signRefresh
    AS->>SR: create(phiên mới)
    API-->>UI: 200, Set-Cookie cặp token mới
    opt refresh do 401
      UI->>API: gửi lại yêu cầu ban đầu (một lần)
    end
  end
```

## 5. Quên mật khẩu và gửi email nền

`AuthService.forgotPassword` / `resetPassword`, handler `SEND_EMAIL` (`backend/src/jobs/handlers.js`). Phản hồi luôn giống nhau để không lộ tài khoản có tồn tại hay không. Luồng đặt mật khẩu lần đầu (`set-password`, purpose `SET`) đi y hệt.

```mermaid
sequenceDiagram
  autonumber
  actor U as User
  participant UI as SPA (ForgotPassword, SetPassword mode RESET)
  participant API as authRoutes / AuthController
  participant AS as AuthService
  participant UR as AppUserRepository
  participant PT as PasswordTokenRepository
  participant BJ as BackgroundJobRepository
  participant Q as JobQueue
  participant ES as EmailService (SMTP / Mailpit)
  participant SR as AuthSessionRepository
  U->>UI: nhập email hoặc mã
  UI->>API: POST /api/auth/forgot-password
  API->>AS: forgotPassword(identifier)
  AS->>UR: findByEmailOrCode
  opt tìm thấy user chưa DELETED
    AS->>PT: invalidateActiveForUser(user, RESET)
    AS->>PT: create(sha256(token), RESET, expiresAt)
    AS->>BJ: enqueue SEND_EMAIL (to, template RESET_PASSWORD, link)
  end
  API-->>UI: 200 ok (giống nhau mọi trường hợp)
  Q->>BJ: claim job (FOR UPDATE SKIP LOCKED)
  Q->>ES: sendMail(to, subject, html, text)
  alt gửi lỗi
    Q->>BJ: retry với backoff
  else gửi được
    Q->>BJ: DONE
  end
  U->>UI: mở link /reset-password?token=...
  UI->>API: POST /api/auth/reset-password
  API->>AS: resetPassword(token, password)
  AS->>AS: assertStrong(password)
  AS->>PT: findActiveByHash(sha256, RESET)
  AS->>PT: markUsed (chỉ khi used_at IS NULL)
  alt không còn token hợp lệ
    AS-->>API: 400 INVALID_TOKEN
  else
    AS->>UR: update(password_hash, xoá khoá đăng nhập)
    AS->>SR: revokeAllForUser
    API-->>UI: 200, đăng nhập lại
  end
```

## 6. Admin tạo người dùng

`AdminController.createUser` → `AdminService.createUser` (`backend/src/services/adminService.js`). Không có mật khẩu trong email, chỉ có link đặt mật khẩu một lần. Ghi audit sau khi ghi thành công, ngoài transaction.

```mermaid
sequenceDiagram
  autonumber
  actor A as Admin
  participant UI as SPA (admin/Users)
  participant API as adminRoutes / AdminController
  participant AD as AdminService
  participant UR as AppUserRepository
  participant PT as PasswordTokenRepository
  participant BJ as BackgroundJobRepository
  participant AL as AdminAuditLogRepository
  A->>UI: nhập mã, email, họ tên, vai trò
  UI->>API: POST /api/admin/users
  API->>AD: createUser(code, email, fullName, role)
  alt role STUDENT mà thiếu mã
    AD-->>API: 400 CODE_REQUIRED
  end
  AD->>UR: findByEmail, findByCode
  alt trùng
    AD-->>API: 409 EMAIL_TAKEN hoặc CODE_TAKEN
  else
    AD->>UR: create(password_hash null, status ACTIVE)
    AD->>PT: invalidateActiveForUser(SET), create(SET, expiresAt)
    AD->>BJ: enqueue SEND_EMAIL (SET_PASSWORD, link /set-password)
    AD-->>API: safe user
    API->>AL: record(actor, USER_CREATE, USER, id)
    API-->>UI: 201 user
  end
```

## 7. Tải tài liệu môn học và ingest (RAG)

`MaterialService.upload` và handler `INGEST_MATERIAL`. Lỗi nội dung (không parse được, không có lớp chữ) đánh dấu `FAILED` và không retry. Lỗi tạm thời (S3, embedding) ném ra để hàng đợi retry.

```mermaid
sequenceDiagram
  autonumber
  actor L as Lecturer
  participant UI as SPA (lecturer/Materials)
  participant API as materialRoutes / MaterialController
  participant MS as MaterialService
  participant S3 as S3 materials bucket
  participant CM as CourseMaterialRepository
  participant Q as JobQueue
  participant H as INGEST_MATERIAL handler
  participant P as parseDocument + chunkText
  participant EMB as embeddingAdapter (Titan v2)
  participant MC as MaterialChunkRepository
  L->>UI: chọn file PDF, DOCX hoặc PPTX
  UI->>API: POST /api/materials (multipart)
  API->>MS: upload(user, subjectId, topicId, file)
  MS->>MS: kiểm tra loại file, topic cùng môn, phạm vi môn
  MS->>S3: putObject(materials/subject/uuid/title)
  MS->>CM: create(status UPLOADED)
  MS->>Q: enqueueJob INGEST_MATERIAL(materialId)
  API-->>UI: 201 material
  Q->>H: chạy job
  H->>CM: updateStatus PROCESSING
  H->>S3: getObject(file_key)
  H->>P: parse(mime, buffer)
  alt parse lỗi hoặc không có lớp chữ
    H->>CM: updateStatus FAILED + lý do
  else
    H->>P: chunkSegments
    loop mỗi chunk
      H->>EMB: embed(content)
    end
    H->>MC: transaction deleteByMaterial, insertMany
    H->>CM: setPageCount, updateStatus READY
  end
  UI->>API: GET /api/materials (polling trạng thái)
```

## 8. Sinh câu hỏi bằng AI từ tài liệu

`QuestionGenerationService.createJob` / `persistDrafts` và handler `GENERATE_QUESTIONS`. Câu hỏi sinh ra luôn ở trạng thái `PENDING_REVIEW`, giảng viên duyệt sau.

```mermaid
sequenceDiagram
  autonumber
  actor L as Lecturer
  participant UI as SPA (lecturer/Questions)
  participant API as questionGenerationRoutes
  participant GS as QuestionGenerationService
  participant JR as QuestionGenerationJobRepository
  participant Q as JobQueue
  participant H as GENERATE_QUESTIONS handler
  participant EMB as embeddingAdapter (Titan v2)
  participant MC as MaterialChunkRepository (pgvector)
  participant LLM as llmAdapter (Nova Pro)
  participant QR as QuestionRepository + QuestionSourceRefRepository
  L->>UI: chọn topic, tài liệu READY, số câu, phân bố Bloom, rubric
  UI->>API: POST /api/question-generation-jobs
  API->>GS: createJob(...)
  GS->>GS: tài liệu READY cùng môn, rubric cùng môn
  GS->>JR: create(status PENDING)
  GS->>Q: enqueueJob GENERATE_QUESTIONS(jobId), maxAttempts 3
  API-->>UI: 201 job
  Q->>H: chạy job
  H->>JR: updateStatus RUNNING
  H->>QR: deleteUnreviewedByGenerationJob (lần chạy lại bắt đầu sạch)
  H->>EMB: embed(topic.name)
  H->>MC: findNearestForTopic(materialIds, vector) → tập R
  H->>LLM: generateQuestions(language, topic, bloom, count, chunks)
  loop mỗi bản nháp
    H->>GS: kiểm tra hình dạng, 3 đến 5 key point
    H->>GS: trích dẫn phải nằm trong R và excerpt khớp chunk
    H->>QR: findByNormalizedContent (trùng y hệt thì bỏ)
    H->>EMB: embed(content)
    H->>QR: cosine ≥ 0.9 thì ghi cảnh báo near-duplicate vào rationale
    H->>QR: transaction create PENDING_REVIEW + source refs
  end
  alt thành công
    H->>JR: setGeneratedCount, COMPLETED
  else lỗi
    H->>JR: RUNNING nếu còn lượt retry, FAILED ở lượt cuối
    H-->>Q: ném lỗi để retry
  end
  UI->>API: GET /api/question-generation-jobs/:id (polling)
```

## 9. Tạo câu hỏi thủ công và duyệt

`QuestionService.createQuestion` / `approve`. Trùng nội dung chuẩn hoá thì chặn, gần trùng chỉ cảnh báo.

```mermaid
sequenceDiagram
  autonumber
  actor L as Lecturer
  participant UI as SPA (lecturer/Questions, PendingReview)
  participant API as questionRoutes / QuestionController
  participant QS as QuestionService
  participant RR as RubricRepository
  participant QR as QuestionRepository
  participant EMB as embeddingAdapter
  L->>UI: nhập câu hỏi, Bloom, key point, rubric
  UI->>API: POST /api/questions
  API->>QS: createQuestion(payload, user)
  QS->>QS: _assertTopicAccess (subjectScope)
  QS->>RR: rubric phải cùng môn với topic
  alt khác môn
    QS-->>API: 400 RUBRIC_SUBJECT_MISMATCH
  end
  QS->>QR: findByNormalizedContent
  alt trùng
    QS-->>API: 409 DUPLICATE_QUESTION
  else
    QS->>EMB: embed(content)
    QS->>QR: so cosine với câu cùng môn (≥ 0.9 thì cảnh báo)
    QS->>QR: create(language chuẩn hoá vi hoặc en)
    API-->>UI: 201 question + warnings
  end
  L->>UI: Duyệt
  UI->>API: POST /api/questions/:id/approve
  API->>QS: approve(id, reviewedBy)
  alt chưa gắn rubric
    QS-->>API: 409 RUBRIC_REQUIRED
  else
    QS->>QR: updateStatusFields(APPROVED, reviewed_by, reviewed_at)
    API-->>UI: 200
  end
```

## 10. Lên lịch và mở kỳ thi

`ExamSessionService.scheduleSession` / `startSession`, `ExamLaunchService.launch`, handler `KEEP_WARM` và `PREPARE_EXAM_AUDIO`. Ngôn ngữ kỳ thi được đồng bộ lại từ ngân hàng câu hỏi ở cả hai bước. `launch` chạy sau commit, không chặn phản hồi và không bao giờ ném lỗi.

```mermaid
sequenceDiagram
  autonumber
  actor L as Lecturer
  actor A as Admin
  participant UI as SPA (lecturer/ExamSessions, admin/ExamSchedule)
  participant API as examSessionRoutes / adminRoutes
  participant XS as ExamSessionService
  participant DB as Postgres (exam_session, question, rubric)
  participant EL as ExamLaunchService
  participant STT as sttAdapter
  participant TTS as ttsAdapter
  participant Q as JobQueue
  L->>UI: Lên lịch
  UI->>API: POST /api/exam-sessions/:id/schedule
  API->>XS: scheduleSession
  XS->>DB: _syncLanguage (ngân hàng APPROVED → VI hoặc EN)
  XS->>XS: opens_at < closes_at, closes_at ở tương lai
  XS->>DB: _assertEnoughQuestions
  XS->>DB: transitionStatus DRAFT → SCHEDULED
  API-->>UI: 200
  A->>UI: Bắt đầu
  UI->>API: POST /api/admin/exam-sessions/:id/start
  API->>XS: startSession (chỉ ADMIN)
  XS->>DB: _syncLanguage, kiểm tra cửa sổ thi, đủ câu hỏi
  XS->>DB: transaction SCHEDULED → OPEN, started_at, khoá rubric
  XS-)EL: launch(session) không chờ
  API-->>UI: 200 (admin ghi audit EXAM_START)
  EL->>DB: mergeWarmStatus(audio pending, keepWarm active)
  EL->>Q: enqueue PREPARE_EXAM_AUDIO
  EL->>Q: enqueue KEEP_WARM (runAfter + 5 phút)
  par
    EL->>STT: warmUp(lang)
  and
    EL->>TTS: warmUp(lang)
  end
  EL->>DB: mergeWarmStatus(stt, tts)
  Q->>TTS: PREPARE_EXAM_AUDIO tổng hợp audio cho câu APPROVED, cập nhật audio.done
  loop KEEP_WARM khi exam còn OPEN và chưa tới closes_at
    Q->>EL: warm(session)
    Q->>Q: enqueue KEEP_WARM tiếp theo
  end
  Note over Q: exam CLOSED hoặc quá closes_at thì keepWarm stopped
```

## 11. Quét bài thi quá hạn (EXPIRE_INTERVIEWS)

Handler `EXPIRE_INTERVIEWS` gọi `InterviewService.expireOverdueInterviews`. `server.js` gieo job đầu tiên khi khởi động nếu chưa có job chờ. Đóng kỳ thi không tự kết thúc bài đang làm, chính job này kết thúc bài quá hạn.

```mermaid
sequenceDiagram
  autonumber
  participant SV as server.js
  participant Q as JobQueue
  participant H as EXPIRE_INTERVIEWS handler
  participant IS as InterviewService
  participant DB as Postgres
  participant SC as SessionContextStore (DynamoDB)
  SV->>Q: existsPending EXPIRE_INTERVIEWS, không có thì enqueue
  loop mỗi INTERVIEW_SWEEP_INTERVAL_SEC (mặc định 60 s)
    Q->>H: chạy job
    H->>IS: expireOverdueInterviews(graceSec)
    IS->>DB: listOverdueActive(deadline_at < now - grace, limit 50)
    loop mỗi bài quá hạn
      IS->>DB: transaction completeIfActive(DEADLINE_REACHED)
      IS->>DB: markOpenTurnsUnanswered, upsert transcript, viva_result PENDING
      IS->>Q: enqueue GRADE_INTERVIEW
      IS->>SC: update(status COMPLETED, xoá lượt hiện tại)
      opt lỗi ở một bài
        IS->>DB: processing_failure (stage EXPIRE_SWEEP), sang bài kế
      end
    end
    H->>Q: enqueue EXPIRE_INTERVIEWS(runAfter now + interval)
  end
```
