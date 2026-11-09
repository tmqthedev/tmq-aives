# UML Activity Diagrams

Bốn luồng nghiệp vụ chính, theo đúng thứ tự kiểm tra trong code. Ba luồng đầu tương ứng ba workflow trong [workflow-definition.docx](../workflow-definition.docx); luồng RAG là phần sinh câu hỏi bằng AI (Step 4). Mỗi khung (partition) là một bên tham gia; mã lỗi là `code` mà API trả về.

Ký hiệu UML: chấm đen = initial node, vòng tròn có viền = activity final, hình thoi = decision/merge, thanh đen = fork/join, hình chữ nhật bo góc = action.

## 1. Tạo câu hỏi và gắn rubric

Nguồn: `QuestionService.createQuestion`, `approve`; `RubricService.createRubric`; `frontend/src/pages/lecturer/`.

```mermaid
flowchart TB
  subgraph L["Lecturer (SPA)"]
    s((" ")):::start --> a1(["Chọn môn / topic, mở ngân hàng câu hỏi"])
    a1 --> d0{"Rubric phù hợp<br/>đã có?"}
    d0 -- "chưa" --> a2(["Tạo rubric: tiêu chí, weightPercent,<br/>performance level"])
    d0 -- "có" --> a3(["Nhập câu hỏi: content, bloom_level,<br/>language, reference_answer, key_points, rubric"])
    a2 --> a3
    e1(["Sửa thông tin"]) --> a3
    w1(["Xem cảnh báo trùng gần<br/>(vẫn đã lưu)"])
    ok(["Thấy câu hỏi trong ngân hàng"])
  end
  subgraph R["RubricService"]
    r1{"tổng weightPercent = 100,<br/>tên tiêu chí không trùng?"}
    r1 -- "không" --> rE["400 VALIDATION_ERROR /<br/>409 DUPLICATE_DATA"]
    r1 -- "có" --> r2(["Lưu rubric + criteria + levels"])
  end
  subgraph Q["QuestionService"]
    q1{"payload hợp lệ?<br/>(_validateCreatePayload)"}
    q2{"có quyền với topic?<br/>(subjectScope)"}
    q3{"rubric cùng subject<br/>với topic?"}
    q4{"trùng nội dung chuẩn hoá<br/>lower(trim(content))?"}
    q5(["Embed content (Titan v2)"])
    q6{"cosine >= 0.9 với câu<br/>cùng subject?"}
    q7(["Thêm warning NEAR_DUPLICATE"])
    q8{"có rubric_id?"}
    q9(["status = APPROVED"])
    q10(["status = DRAFT"])
    q11(["Lưu question"])
  end
  a2 --> r1
  r2 --> a3
  rE --> e1
  a3 -- "POST /api/questions" --> q1
  q1 -- "không" --> x1["400 VALIDATION_ERROR"] --> e1
  q1 -- "có" --> q2
  q2 -- "không" --> x2["403 / 404"] --> f1(((" "))):::stop
  q2 -- "có" --> q3
  q3 -- "không" --> x3["409 RUBRIC_SUBJECT_MISMATCH"] --> e1
  q3 -- "có" --> q4
  q4 -- "có" --> x4["409 DUPLICATE_QUESTION"] --> e1
  q4 -- "không" --> q5 --> q6
  q6 -- "có" --> q7 --> q8
  q6 -- "không" --> q8
  q8 -- "có" --> q9 --> q11
  q8 -- "không" --> q10 --> q11
  q11 -- "201 {question, warnings}" --> mw{"warnings rỗng?"}
  mw -- "không" --> w1 --> ok
  mw -- "có" --> ok
  ok --> f2(((" "))):::stop

  classDef start fill:#000,stroke:#000,color:#000
  classDef stop fill:#000,stroke:#000,stroke-width:4px,color:#000
```

Câu `DRAFT` (chưa có rubric) chỉ chuyển sang `APPROVED` qua `POST /api/questions/:id/approve` sau khi gắn rubric; thiếu rubric trả `409 RUBRIC_REQUIRED`. Chỉ câu `APPROVED` vào được kỳ thi.

## 2. Tải tài liệu và sinh câu hỏi bằng RAG

Nguồn: `MaterialService.upload`, handler `INGEST_MATERIAL` và `GENERATE_QUESTIONS` (`jobs/handlers.js`), `QuestionGenerationService.createJob` / `persistDrafts`.

```mermaid
flowchart TB
  subgraph L["Lecturer"]
    s((" ")):::start --> u1(["Tải PDF / PPTX / DOCX"])
    g1(["Chọn tài liệu READY, số câu,<br/>bloom_distribution, ngôn ngữ, rubric"])
    rv(["Duyệt từng câu: sửa / approve / reject"])
  end
  subgraph M["MaterialService + JobQueue (INGEST_MATERIAL)"]
    m1(["Lưu file S3 materials,<br/>course_material UPLOADED"])
    m2(["enqueue INGEST_MATERIAL"])
    m3(["status = PROCESSING;<br/>tải file, parseDocument"])
    m4{"parse được và có<br/>lớp text?"}
    m5(["status = FAILED (không OCR)"])
    m6(["chunkText → embed từng chunk"])
    m7{"embed lỗi?"}
    m8(["Lưu material_chunk (vector 1024),<br/>page_count, status = READY"])
  end
  subgraph G["QuestionGenerationService + JobQueue (GENERATE_QUESTIONS)"]
    j1{"mọi tài liệu READY, requestedCount,<br/>bloom, rubric cùng subject?"}
    j2(["question_generation_job PENDING;<br/>enqueue GENERATE_QUESTIONS"])
    j3(["RUNNING; xoá nháp chưa duyệt<br/>của lần chạy trước"])
    j4(["Embed tên topic → top chunk gần nhất<br/>(HNSW cosine) = tập R"])
    j5(["LLM generateQuestions (Nova Pro)"])
    j6{"Từng draft: bloom hợp lệ, 3–5 key points,<br/>citation thuộc R và excerpt khớp chunk?"}
    j7{"trùng nội dung chính xác?"}
    j8(["Lưu question PENDING_REVIEW, source AI,<br/>question_source_ref; ghi warning nếu cosine >= 0.9"])
    j9(["Bỏ draft"])
    j10(["generated_count, COMPLETED<br/>(NO_GROUNDABLE nếu 0 câu)"])
    jx{"lỗi khi chạy?"}
    jy(["còn lượt: giữ RUNNING + error, throw để thử lại;<br/>hết lượt: FAILED"])
  end
  u1 --> m1 --> m2 --> m3 --> m4
  m4 -- "không" --> m5 --> f0(((" "))):::stop
  m4 -- "có" --> m6 --> m7
  m7 -- "có: throw, JobQueue thử lại" --> m3
  m7 -- "không" --> m8 --> g1
  g1 -- "POST /api/question-generation-jobs" --> j1
  j1 -- "không" --> jE["400 VALIDATION_ERROR /<br/>RUBRIC_SUBJECT_MISMATCH / tài liệu chưa READY"] --> g1
  j1 -- "có" --> j2 --> j3 --> j4 --> j5 --> jx
  jx -- "có" --> jy --> f1(((" "))):::stop
  jx -- "không" --> j6
  j6 -- "không" --> j9
  j6 -- "có" --> j7
  j7 -- "có" --> j9
  j7 -- "không" --> j8
  j8 --> j10
  j9 --> j10
  j10 --> rv --> f2(((" "))):::stop

  classDef start fill:#000,stroke:#000,color:#000
  classDef stop fill:#000,stroke:#000,stroke-width:4px,color:#000
```

## 3. Thi vấn đáp với AI (một lượt hỏi đáp)

Nguồn: `InterviewService.startOrResume`, `markQuestionPlayed`, `submitAnswer`, `_endInterview`; `interview/decideNextStep.js`; `realtime/interviewSocket.js`; `frontend/src/pages/student/`, `frontend/src/components/exam/DeviceCheckModal.jsx`, `frontend/src/shared/utils/audioDevices.js`.

Thứ tự quyết định sau mỗi câu trả lời là cố định: (1) quá `deadline_at` → kết thúc; (2) câu trả lời rỗng → câu chính tiếp; (3) LLM đề xuất hỏi thêm VÀ còn lượt follow-up → hỏi thêm; (4) còn lại → câu chính tiếp, hết câu chính → kết thúc.

```mermaid
flowchart TB
  subgraph S["Student (SPA, Socket.IO /interview)"]
    s((" ")):::start --> dc(["Dashboard: Bắt đầu / Tiếp tục thi → DeviceCheckModal"])
    dc --> dk{"trình duyệt hỗ trợ, micro đủ 600 ms tiếng nói,<br/>đã nghe âm thanh thử?"}
    dk -- "không: sửa thiết bị rồi thử lại" --> dc
    dk -- "huỷ" --> f2(((" "))):::stop
    dk -- "có" --> b1(["POST /api/interviews; ghi cờ đã kiểm tra (sessionStorage);<br/>vào /student/viva, interview:join → interview:ready"])
    b2(["Phát audio câu hỏi<br/>(TTS lỗi → Web Speech của trình duyệt)"])
    b3(["Ghi âm MediaRecorder webm/opus,<br/>gửi audio:chunk mỗi 1 s"])
    b4(["answer:end (hoặc hết giờ: tự nộp phần đã nói)"])
    b5(["Ghi âm lại"])
    b6(["Xem màn hình kết thúc"])
  end
  subgraph I["InterviewService"]
    i0{"đã có viva_interview<br/>của sinh viên?"}
    i1{"exam OPEN, có trong roster,<br/>now >= opens_at, deadline > now,<br/>đủ câu APPROVED đúng ngôn ngữ?"}
    i2(["pickBalancedQuestions; tạo VivaInterview IN_PROGRESS,<br/>AssignedQuestion, khoá rubric, QATurn MAIN #1 ASKED"])
    i3(["question:played → ANSWERING,<br/>answer_deadline_at"])
    i4(["submitAnswer: claim turn → PROCESSING"])
    i5{"audio rỗng / hỏng?"}
    i6{"retry_count < 1?"}
    i7(["Lưu S3 audio (thử 3 lần; lỗi → ProcessingFailure AUDIO_STORE, vẫn đi tiếp);<br/>STT Lambda tối đa 2 lần, timeout STT_TIMEOUT_MS"])
    i8{"STT thành công?"}
    i9(["ProcessingFailure(STT); trả turn về trạng thái cũ,<br/>giữ deadline; 502 STT_FAILED → turn:retry"])
    i10(["Lưu ANSWERED: answer_text, confidence,<br/>timed_out, speech signals"])
    d1{"(1) now >= deadline_at?"}
    d2{"(2) answer rỗng?"}
    llm(["LLM decideFollowUp (thử lại 1 lần;<br/>lỗi lần 2 → ProcessingFailure, đi tiếp)"])
    d3{"(3) LLM đề xuất ASK_FOLLOW_UP<br/>và còn lượt (per-question, total)?"}
    fu(["validateGrounding, buildFollowUpRationale, TTS;<br/>tạo QATurn FOLLOW_UP ASKED"])
    d4{"(4) còn câu chính?"}
    mn(["TTS (cache); tạo QATurn MAIN ASKED,<br/>current_question_index + 1"])
    end1(["_endInterview: COMPLETED + end_reason; turn mở → UNANSWERED;<br/>Transcript; VivaResult PENDING; enqueue GRADE_INTERVIEW"])
  end
  b1 --> i0
  i0 -- "có" --> rs(["Resume: trả trạng thái hiện tại"]) --> b2
  i0 -- "không" --> i1
  i1 -- "không" --> ie["409 EXAM_NOT_OPEN / EXAM_NOT_STARTED /<br/>EXAM_CLOSED / NOT_ENOUGH_QUESTIONS, 403 NOT_ON_ROSTER"] --> f0(((" "))):::stop
  i1 -- "có" --> i2 --> b2
  b2 --> i3 --> b3 --> b4 --> i4 --> i5
  i5 -- "có" --> i6
  i6 -- "có" --> b5 --> b3
  i6 -- "không: coi như trả lời rỗng" --> i10
  i5 -- "không" --> i7 --> i8
  i8 -- "không" --> i9 --> b5
  i8 -- "có" --> i10
  i10 --> d1
  d1 -- "có" --> end1
  d1 -- "không" --> d2
  d2 -- "có" --> d4
  d2 -- "không" --> llm --> d3
  d3 -- "có" --> fu --> b2
  d3 -- "không" --> d4
  d4 -- "có" --> mn --> b2
  d4 -- "không" --> end1
  end1 --> b6 --> f1(((" "))):::stop

  classDef start fill:#000,stroke:#000,color:#000
  classDef stop fill:#000,stroke:#000,stroke-width:4px,color:#000
```

Phòng thi mở trực tiếp (không có cờ đã kiểm tra trong tab) hiển thị bước kiểm tra micro tại chỗ trước `interview:ready`. Ngoài luồng trên: việc nền `EXPIRE_INTERVIEWS` chạy mỗi `INTERVIEW_SWEEP_INTERVAL_SEC` và gọi `_endInterview(DEADLINE_REACHED)` cho phiên đã quá `deadline_at + grace`; `pauseInterview` / `resumeInterview` tạm dừng và bù thời gian khi hệ thống lỗi.

## 4. Chấm điểm bằng AI và giảng viên duyệt

Nguồn: `GradingService.gradeInterview`, `adjustCriterionScore`, `finalizeResult`, `reopenResult`, `regradeResult`; `domain/scoringRules.js`.

```mermaid
flowchart TB
  subgraph J["JobQueue + GradingService (GRADE_INTERVIEW)"]
    s((" ")):::start --> g1(["viva_result → AI_SCORING"])
    g1 --> g2(["Tải interview, assigned questions,<br/>qa_turn, rubric criteria + performance levels"])
    g2 --> fk[" "]:::fork
    fk --> na{"Với mỗi câu chính: isUnansweredQuestion?<br/>(mọi lượt rỗng / dấu câu / [nhãn STT] /<br/>âm ngập ngừng, hoặc chưa được hỏi)"}
    na -- "có" --> nz(["0 điểm câu + mọi tiêu chí, không gọi LLM;<br/>model_id rule:no-answer, confidence 1"])
    na -- "không" --> g3(["LLM gradeQuestion<br/>(câu hỏi + lượt follow-up + rubric)"])
    g3 --> g4{"lỗi LLM?"}
    g4 -- "tạm thời (Throttling, timeout, ...)" --> rt(["throw → JobQueue thử lại"]) --> g1
    g4 -- "lỗi khác" --> g5(["Ghi đánh giá rỗng, flag_reason =<br/>AI grading service failure"])
    g4 -- "không" --> g6(["Lọc criterion / level không thuộc rubric;<br/>tiêu chí thiếu → dòng chưa chấm + flag_reason"])
    g6 --> g7(["calculateQuestionScore:<br/>tổng (điểm / max × weight), quy về thang 10"])
    g5 --> jn[" "]:::fork
    g7 --> jn
    nz --> jn
    jn --> g8(["Lưu question_evaluation + criterion_score;<br/>calculateVivaTotalScore = trung bình câu chính"])
    g8 --> g9{"detectFlagReason: LLM lỗi, turn FAILED,<br/>có flag_reason, confidence < 0.6?"}
    g9 -- "có" --> fl(["status = FLAGGED"])
    g9 -- "không" --> sg(["status = AI_SUGGESTED"])
  end
  subgraph L["Lecturer / examiner (phạm vi môn)"]
    v1(["Xem kết quả: transcript, audio lượt,<br/>lý do AI hỏi, nguồn trích dẫn"])
    v2{"Đồng ý điểm AI?"}
    v3(["Sửa điểm tiêu chí + lý do bắt buộc"])
    v4(["Chốt kết quả"])
    v5{"Cần chấm lại?"}
  end
  subgraph G["GradingService (REST)"]
    a1{"kết quả đã FINALIZED?"}
    a2(["ScoreAdjustment; final_score tiêu chí;<br/>tính lại điểm câu và final_total_score"])
    a3(["FINALIZED, finalized_by, finalized_at"])
    a4(["regradeResult: AI_SCORING,<br/>enqueue GRADE_INTERVIEW"])
  end
  subgraph St["Student"]
    sv(["Xem kết quả đã chốt<br/>(toStudentResultView)"])
  end
  fl --> v1
  sg --> v1
  v1 --> v5
  v5 -- "có" --> a4 --> g1
  v5 -- "không" --> v2
  v2 -- "không" --> v3 --> a1
  a1 -- "có" --> ae["400 RESULT_FINALIZED<br/>(reopen trước)"] --> v1
  a1 -- "không" --> a2 --> v1
  v2 -- "có" --> v4 --> a3 --> sv --> f1(((" "))):::stop

  classDef start fill:#000,stroke:#000,color:#000
  classDef stop fill:#000,stroke:#000,stroke-width:4px,color:#000
  classDef fork fill:#000,stroke:#000,color:#000
```

Thanh đen trong sơ đồ 4 là vùng lặp "với mỗi câu chính" (expansion region, chạy tuần tự trong code). Giảng viên có thể `reopenResult` một kết quả `FINALIZED` để sửa tiếp; kết quả quay về `FLAGGED` nếu còn `flag_reason`, ngược lại `AI_SUGGESTED`.
