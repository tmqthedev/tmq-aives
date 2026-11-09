# AIVES - Software Design Specification (SDS)
### Đặc tả Thiết kế Phần mềm theo Chuẩn IEEE Std 1016-2009

**Tên hệ thống**: AIVES (AI-assisted Viva Examination System)  
**Mã học phần / Đồ án**: SWD392 — Software Architecture and Design  
**Tác giả**: @tmqthedev & Antigravity AI Pair Programmer  
**Ngày cập nhật**: 05/11/2026 · Phiên bản: 2.3 (Step 14: quản trị đầy đủ, audit log, ngân hàng câu hỏi theo luồng; #63–#69: trang lỗi HTTP, tự làm mới phiên, kiểm tra thiết bị âm thanh, chấm 0 câu không trả lời)

---

## 1. GIỚI THIỆU & NGUYÊN TẮC THIẾT KẾ (INTRODUCTION & DESIGN PRINCIPLES)

### 1.1. Mục đích tài liệu (Purpose)
Tài liệu này đặc tả chi tiết kiến trúc giải pháp, thiết kế phân tầng, cấu trúc dữ liệu vật lý, giao diện phần mềm và các luồng xử lý kỹ thuật của hệ thống **AIVES**, tuân thủ tiêu chuẩn kỹ thuật quốc tế **IEEE Std 1016-2009** (*Standard for Information Technology — Systems Design — Software Design Descriptions*).

### 1.2. Các nguyên tắc kiến trúc cốt lõi (Architectural Principles)
1. **Kiến trúc Hybrid Serverless kết hợp Container (Hybrid Cloud Architecture)**:
   - Các tác vụ đòi hỏi kết nối liên tục, độ trễ thấp và lưu trữ trạng thái (REST API, Socket.IO, Interview Engine, Transactional Database) được container hóa và chạy trên máy chủ EC2 t4g.small (ARM64 Graviton).
   - Các tác vụ tính toán nặng nề về AI và xử lý âm thanh không liên tục (STT với PhoWhisper, TTS với Kokoro-82M) được ủy quyền xử lý cho AWS Lambda Serverless (x86_64, 3008 MB RAM) nhằm tối ưu hóa chi phí điện toán.
2. **Kiến trúc phân tầng nghiêm ngặt (Strict Layered Architecture)**:
   - Request Lifecycle tuân thủ tuần tự một chiều:
     $$\text{Client} \longrightarrow \text{Route} \longrightarrow \text{Controller} \longrightarrow \text{Service} \longrightarrow \text{Repository} \longrightarrow \text{Database}$$
   - Tuyệt đối không viết câu lệnh SQL trong Service hay Controller; không đặt logic nghiệp vụ trong Controller hay Repository.
3. **Cơ chế Dependency Injection (DI) linh hoạt**:
   - Khởi tạo ứng dụng qua hàm `createApp(overrides)` trong `backend/src/app.js`. Mọi Service, Repository, Database Connection hoặc Cloud Adapter đều có thể được thay thế dễ dàng thông qua tham số `overrides`, tạo điều kiện lý tưởng cho việc kiểm thử tự động (Unit & E2E Testing).
4. **Tính độc lập với môi trường thực thi (Environment Parity)**:
   - Mã nguồn không chứa các nhánh rẽ điều kiện theo tên môi trường (`if (local)` hay `if (prod)`). Local và production chỉ khác nhau ở giá trị biến môi trường (`DB_MOCK_MODE`, `AWS_MOCK_MODE`, `STT_PROVIDER`, `TTS_PROVIDER`, `LLM_PROVIDER`, `EMBEDDING_PROVIDER`, các endpoint `*_ENDPOINT`).
   - Từ Step 13, entrypoint `npm start` (`server.js`) gọi `validateAiConfig` trước khi mở database/listener: `AWS_MOCK_MODE=true` hoặc bất kỳ provider `mock` nào làm khởi động thất bại với `AI_CONFIG_INVALID`. Local Docker cũng dùng AI thật (STT/TTS chạy bằng Lambda RIE, LLM/embedding gọi Bedrock). Adapter mock chỉ còn dùng trong harness kiểm thử (`test/runTests.js`) và DI qua `createApp(overrides)`. Chi tiết: [bilingual-real-ai.md](bilingual-real-ai.md).
6. **Song ngữ Việt–Anh (Step 13)**:
   - Ngôn ngữ giao diện (VI mặc định / EN) do người dùng chọn, lưu ở `localStorage` khóa `aives.uiLanguage`; chuỗi UI nằm trong `frontend/src/i18n/{vi,en}.json`.
   - Ngôn ngữ kỳ thi (`exam_session.language`: `VI` | `EN`) độc lập với ngôn ngữ UI và được truyền tới STT, TTS, sinh câu hỏi phụ và chấm điểm.
5. **Nguyên tắc Phòng vệ theo Chiều sâu (Defense-in-Depth & Student Safety)**:
   - Áp dụng cơ chế Data Masking nghiêm ngặt (`toStudentInterviewView`, `toStudentResultView`) với các hàm quét bảo mật đệ quy (`assertStudentSafe`, `assertStudentResultSafe`), đảm bảo không có bất kỳ thông tin nội bộ nào (đáp án, rationale, prompt, rubric) bị rò rỉ cho thí sinh.

---

## 2. KIẾN TRÚC TRIỂN KHAI HẠ TẦNG ĐÁM MÂY (DEPLOYMENT ARCHITECTURE)

Sơ đồ UML deployment tương ứng: [uml/deployment-diagram.drawio](uml/deployment-diagram.drawio) ([PNG](uml/png/deployment-diagram.png)).

Hệ thống được triển khai trên vùng `ap-southeast-1` (Singapore) của Amazon Web Services (AWS):

```
                                [ Trình duyệt Người dùng ]
                                            │
                                            ▼  HTTPS (443) / WSS
                      ┌───────────────────────────────────────────┐
                      │    Amazon CloudFront CDN (*.cloudfront.net)│
                      └───────┬───────────────────────────┬───────┘
                              │                           │
          (Behavior: Default *)                 (Behavior: /api/*, /socket.io/*)
                              │                           │
                              ▼                           ▼
                 ┌─────────────────────────┐  ┌─────────────────────────────────────────┐
                 │ Amazon S3 (Web Static)  │  │ AWS VPC (10.30.0.0/16 - Public Subnet)  │
                 │ React 19 + Vite Dist    │  │ ┌─────────────────────────────────────┐ │
                 │ OAC Security Policy     │  │ │ EC2 t4g.small (Amazon Linux 2023)   │ │
                 └─────────────────────────┘  │ │ SG: Port 80 chỉ mở cho CloudFront   │ │
                                              │ │                                     │ │
                                              │ │ ┌─────────────────────────────────┐ │ │
                                              │ │ │ Docker Engine                   │ │ │
                                              │ │ │  ├─ backend (Node 20, Exp 5)    │ │ │
                                              │ │ │  └─ postgres (pgvector pg16)    │ │ │
                                              │ │ └──────────────────┬──────────────┘ │ │
                                              │ └────────────────────┼────────────────┘ │
                                              └──────────────────────┼──────────────────┘
                                                                     │
                     ┌──────────────────────┬────────────────────────┴─────────┬──────────────────────┐
                     ▼                      ▼                                   ▼                      ▼
           ┌───────────────────┐  ┌───────────────────┐               ┌───────────────────┐  ┌───────────────────┐
           │ Amazon S3 Buckets │  │  Amazon DynamoDB  │               │ AWS Lambda x86_64 │  │  Amazon Bedrock   │
           │ - aives-prod-audio│  │ SessionContext    │               │ (3008 MB RAM)     │  │ - Nova Pro (LLM)  │
           │ - aives-prod-mat  │  │ (TTL expiresAt)   │               │ - STT: PhoWhisper │  │ - Titan Text V2   │
           │ - aives-prod-back │  └───────────────────┘               │ - TTS: Kokoro-82M │  │   (Embedding)     │
           └───────────────────┘                                      └───────────────────┘  └───────────────────┘
```

### 2.1. Phân tích các thành phần hạ tầng
- **Amazon CloudFront**: Phân phối nội dung tĩnh, tích hợp CloudFront Function thực hiện SPA URL Rewriting (điều hướng request về `/index.html`), đồng thời đóng vai trò Reverse Proxy chuyển tiếp WebSocket và API động về EC2.
- **Amazon EC2 `t4g.small`**: Chạy kiến trúc vi xử lý ARM64 Graviton tiết kiệm điện năng và chi phí. Vận hành container backend Node.js và PostgreSQL. Quản trị bảo mật hoàn toàn thông qua AWS SSM Session Manager, không mở cổng SSH 22.
- **PostgreSQL 16 + pgvector**: Cơ sở dữ liệu chính, gắn với volume EBS `gp3` 10 GB có cờ chống xóa nhầm (`prevent_destroy = true`).
- **AWS Lambda STT (`aives-prod-stt`)**: Container image x86_64 chạy mô hình PhoWhisper-small (tiếng Việt) và Whisper small (tiếng Anh) dạng CTranslate2 int8, cấp phát 3008 MB RAM.
- **AWS Lambda TTS (`aives-prod-tts`)**: Container image x86_64 chạy ONNX Kokoro-82M (giọng `diem_trinh` và `af_heart`), cấp phát 3008 MB RAM. File âm thanh tổng hợp được tự động lưu trữ trong S3 `tts-cache/<sha256>.wav`.
- **Amazon Bedrock**: Cung cấp dịch vụ mô hình ngôn ngữ lớn Nova Pro và tạo vector embedding Titan Text Embeddings V2.
- **Amazon DynamoDB**: Lưu trữ vi mô trạng thái phiên thi thời gian thực (`SessionContext`), hỗ trợ dọn rác tự động bằng TTL.

---

## 3. THIẾT KẾ CẤU TRÚC MÃ NGUỒN (SOURCE CODE ORGANIZATION)

Sơ đồ lớp thiết kế (UML) của backend: [uml/design-class-diagram.md](uml/design-class-diagram.md).

### 3.1. Phân rã cấu trúc Backend (`backend/src/`)

```text
backend/src/
├── app.js               # Container cấu hình DI createApp(overrides), middleware, route mounts
├── server.js            # Entry point vận hành: migration runner, in-database job queue, HTTP socket server
├── auth/                # Xử lý JWT, mã hóa scrypt, quản lý cookie httpOnly
├── cli/                 # createAdmin.js, verifyRealAi.js (smoke test AI thật Việt–Anh)
├── config/              # env.js, validateAiConfig.js (chặn mock khi chạy thật), logger pino
├── controllers/         # Bộ tiếp nhận HTTP request, trích xuất DTO và gọi Service
├── db/                  # PgDatabase pool, InMemoryDatabase (legacy), migrationRunner.js, mapDbError.js
├── domain/              # questionStatus, examSessionStatus, interviewStatus, scoringRules
├── embedding/           # Adapter tạo vector: Titan Text Embeddings V2 & Mock adapter (chỉ kiểm thử)
├── ingest/              # Document parser (PDF/DOCX/PPTX) & text chunker (~500 từ, chồng lấn 50 từ)
├── interview/           # Logic thuần: decideNextStep, followUpDecision, pickBalancedQuestions,
│                        # groundingValidator, rationaleBuilder, sessionContextStore, studentView, studentResultView
├── jobs/                # JobQueue (SKIP LOCKED) & handlers: SEND_EMAIL, INGEST_MATERIAL, GENERATE_QUESTIONS,
│                        # GRADE_INTERVIEW, KEEP_WARM, PREPARE_EXAM_AUDIO, EXPIRE_INTERVIEWS
├── llm/                 # Adapter Bedrock Nova Pro & prompt builders (sinh câu hỏi, hỏi phụ, chấm điểm)
├── middleware/          # auth.js (requireAuth, requireRole), csrf.js (verifyOrigin)
├── realtime/            # interviewSocket.js: Socket.IO namespace /interview, gom audio chunk
├── repositories/        # Tầng truy xuất dữ liệu raw SQL (20 file repository, gồm auditLogRepository)
├── routes/              # Express routers gắn dưới tiền tố /api
├── services/            # Tầng nghiệp vụ (16 file, gồm awsClients, subjectScope, speechSignals)
├── stt/                 # Adapter nhận dạng giọng nói: Lambda PhoWhisper/Whisper & Mock (chỉ kiểm thử)
└── tts/                 # Adapter tổng hợp giọng nói: Lambda Kokoro-82M, Google (tùy chọn) & Mock (chỉ kiểm thử)
```

Ghi chú: phạm vi môn học được kiểm tra trong tầng service, vì phần lớn route chỉ biết môn học sau khi đọc bản ghi: `services/subjectScope.js` (câu hỏi, rubric, chủ đề, kỳ thi), cùng các kiểm tra riêng trong `materialService`, `questionGenerationService` và `gradingService` (kết quả và audio từng lượt).

### 3.2. Phân rã cấu trúc Frontend (`frontend/src/`)

```text
frontend/src/
├── assets/              # Static icons, styles, logo
├── components/          # Modal.jsx (render qua portal), UI primitive trong components/ui/ (gồm UserPicker),
│                        # exam/DeviceCheckModal.jsx (kiểm tra micro + loa trước khi thi)
├── config/              # api.js (apiBaseUrl), lecturerFlow.js (thứ tự 7 bước của giảng viên)
├── contexts/            # AuthContext (nạp phiên qua /api/auth/me, làm mới phiên mỗi 10 phút khi đã đăng nhập)
├── features/auth/       # Trang đăng nhập
├── i18n/                # vi.json, en.json, core.js, useLocale, LanguageSwitcher (Step 13)
├── pages/               # Trang ứng dụng theo vai trò:
│   ├── admin/           # Users, Subjects, ExamSchedule, AuditLog
│   ├── lecturer/        # Dashboard, Sessions, ExamSessions, Topics, Questions, Rubrics, Materials,
│   │                    # PendingReview, EvaluationReview
│   └── student/         # Dashboard, VivaSession (phòng thi /student/viva?interviewId=…), Results, ResultDetail
├── routes/              # AppRoutes.jsx định tuyến bảo vệ theo vai trò, ErrorBoundary, route `*` → 404
├── services/            # API client wrappers (authApi: apiRequest/authedFetch/refreshSession, gradingApi, interviewSocket, v.v.)
└── shared/              # components/ErrorPage (ErrorPage + ErrorBoundary), utils/httpStatus.js (ROLE_HOME, httpStatusOf),
                         # utils/audioDevices.js (chọn micro, mức âm, mã lỗi micro, cờ đã kiểm tra thiết bị)
frontend/test/               # node:test (`npm test`): language.test.js (i18n), audioDevices.test.js (hàm thuần trong audioDevices.js)
```

- **Phiên đăng nhập**: mọi lời gọi API đi qua `authedFetch`; gặp `401` thì gọi `POST /api/auth/refresh` một lần (các lời gọi đồng thời dùng chung một promise refresh, vì refresh token xoay vòng) rồi gửi lại. Không áp dụng cho các endpoint `/auth/login|refresh|logout|forgot-password|reset-password|set-password`. `AuthContext` làm mới phiên mỗi 10 phút khi đã đăng nhập để thẻ `<audio>` và bắt tay Socket.IO (không tự thử lại được) có cookie còn hạn; phòng thi tự refresh một lần khi bắt tay socket bị từ chối với `AUTHENTICATION_REQUIRED`/`INVALID_TOKEN`.
- **Trang lỗi**: `ErrorPage` hiển thị trang theo mã HTTP (400, 401, 403, 404, 409, 500, 503; 502/504 → 503) với nút quay lại, về trang chủ theo vai trò hoặc đăng nhập, và *Thử lại* khi trang truyền `onRetry`. `ProtectedRoute` hiển thị 403 trong khung ứng dụng khi người dùng mở khu vực của vai trò khác; mỗi khu vực vai trò và cấp ứng dụng có route `*` → 404 và một `ErrorBoundary` (reset khi đổi đường dẫn). Trang chi tiết kết quả (giảng viên, sinh viên) chọn trang lỗi theo `httpStatusOf(err)`.
- **Kiểm tra thiết bị**: Dashboard sinh viên mở `DeviceCheckModal` trước `POST /api/interviews`; chỉ khi micro ghi nhận đủ 600 ms tiếng nói và thí sinh xác nhận đã nghe âm thanh thử thì mới tạo/khôi phục phiên, ghi cờ `aives.deviceCheck.<interviewId>` vào `sessionStorage` và chuyển tới phòng thi. Phòng thi thấy cờ thì gửi `interview:ready` ngay, không thì hiển thị bước kiểm tra micro tại chỗ. Micro đã chọn được nhớ ở `localStorage` (`aives.micDeviceId`) và được dùng khi ghi âm câu trả lời (`openMicStream`, mất thiết bị thì về micro mặc định).

Phòng thi dùng `MediaRecorder` (`audio/webm;codecs=opus` khi trình duyệt hỗ trợ), phát `audio:chunk` mỗi 1 giây qua Socket.IO và gửi `answer:end` sau khi `dataavailable` cuối đã được phát.

---

## 4. THIẾT KẾ CƠ SỞ DỮ LIỆU VẬT LÝ (PHYSICAL DATABASE DESIGN)

Sơ đồ lớp miền (UML) đầy đủ thuộc tính và enum: [uml/class-diagram.drawio](uml/class-diagram.drawio) ([PNG](flow-class-diagram.png)).

Hệ thống cơ sở dữ liệu bao gồm **28 bảng nghiệp vụ** và **1 bảng quản lý migration**, được kiến tạo và tiến hóa tuần tự qua **23 file migration** (`backend/db/migrations/001_...` đến `023_...`).

### 4.1. Sơ đồ Quan hệ Thực thể Vật lý (Physical ERD - Mermaid)

Bản draw.io đủ 29 bảng và mọi cột, kiểm tra tự động với migrations: [uml/erd.drawio](uml/erd.drawio) ([PNG](uml/png/erd.png)).

```mermaid
erDiagram
  app_user ||--o{ auth_session : "has"
  app_user ||--o{ password_token : "owns"
  app_user ||--o{ subject_lecturer : "assigned"
  app_user ||--o{ subject_student : "enrolled"
  app_user ||--o{ exam_session_student : "takes"
  app_user ||--o{ exam_session_examiner : "grades"
  app_user ||--o{ score_adjustment : "adjusts"

  subject ||--o{ subject_lecturer : "has"
  subject ||--o{ subject_student : "has"
  subject ||--o{ topic : "contains"
  subject ||--o{ rubric : "defines"
  subject ||--o{ exam_session : "hosts"

  topic ||--o{ course_material : "references"
  topic ||--o{ question : "categorizes"
  topic ||--o{ question_generation_job : "requests"
  topic ||--o{ exam_session : "tested_in"

  course_material ||--o{ material_chunk : "split_into"
  material_chunk ||--o{ question_source_ref : "cited_by"

  rubric ||--o{ rubric_criterion : "consists_of"
  rubric_criterion ||--o{ performance_level : "levels"
  rubric ||--o{ question : "evaluates_with"

  question ||--o{ question_source_ref : "has_sources"
  question ||--o{ assigned_question : "assigned_to"

  exam_session ||--o{ exam_session_student : "roster"
  exam_session ||--o{ exam_session_examiner : "examiners"
  exam_session ||--o{ viva_interview : "conducts"

  viva_interview ||--o{ assigned_question : "questions"
  viva_interview ||--o{ qa_turn : "turns"
  viva_interview ||--o{ transcript : "records"
  viva_interview ||--o| viva_result : "yields"
  viva_interview ||--o{ processing_failure : "logs"

  assigned_question ||--o{ qa_turn : "interaction"
  assigned_question ||--o| question_evaluation : "evaluated"

  viva_result ||--o{ question_evaluation : "details"
  question_evaluation ||--o{ criterion_score : "scores"
  criterion_score ||--o{ score_adjustment : "audit"

  background_job {
    int background_job_id PK
    varchar type
    jsonb payload
    varchar status
    int attempts
    timestamptz run_after
  }
```

### 4.2. Danh mục Bảng Dữ liệu & Các Trường Cốt lõi (Data Dictionary)

| Phân hệ | Tên Bảng | Khóa chính | Khóa ngoại & Ràng buộc chính | Mục đích lưu trữ & Ý nghĩa |
| :--- | :--- | :--- | :--- | :--- |
| **Tài khoản** | `app_user` | `app_user_id` | `email` (UK), `code` (UK) | Danh mục tài khoản người dùng (`ADMIN`, `LECTURER`, `STUDENT`), trạng thái `ACTIVE` / `LOCKED` / `DELETED` (xóa mềm, migration 027) và dấu thời gian. |
| **Tài khoản** | `admin_audit_log` | `admin_audit_log_id` | `actor_id` $\rightarrow$ `app_user` | Nhật ký thao tác của Admin, chỉ định danh: `action`, `entity_type`, `entity_id`, `created_at` (migration 026). |
| **Tài khoản** | `auth_session` | `auth_session_id` | `user_id` $\rightarrow$ `app_user` | Phiên làm việc JWT, mã băm sha256 của refresh token, IP và User Agent. |
| **Tài khoản** | `password_token`| `password_token_id` | `user_id` $\rightarrow$ `app_user` | Mã băm sha256 của token thiết lập (`SET`) hoặc đặt lại (`RESET`) mật khẩu một lần. |
| **Môn học** | `subject` | `subject_id` | `code` (UK) | Danh mục môn học (`SWD392`, v.v.). `status` ACTIVE/ARCHIVED (migration 025): môn đã có dữ liệu không xoá được (`409 SUBJECT_IN_USE`) mà được lưu trữ; môn ARCHIVED bị ẩn khỏi ô chọn và không tạo được kỳ thi mới. |
| **Môn học** | `subject_lecturer`| `subject_lecturer_id`| `(subject_id, lecturer_id)` (UK) | Phân công giảng viên phụ trách bộ môn. |
| **Môn học** | `subject_student` | `subject_student_id` | `(subject_id, student_id)` (UK) | Danh sách sinh viên chính thức ghi danh theo môn học (Migration 020). |
| **Chủ đề** | `topic` | `topic_id` | `subject_id` $\rightarrow$ `subject` | Chủ đề thi trực thuộc môn học. |
| **Học liệu** | `course_material` | `course_material_id` | `subject_id`, `topic_id`, `uploaded_by` | Học liệu giảng dạy tải lên S3 (PDF, DOCX, PPTX $\le 50$ MB). |
| **Học liệu** | `material_chunk` | `material_chunk_id` | `material_id` $\rightarrow$ `course_material`, `subject_id` | Đoạn văn bản ~500 từ và vector embedding 1024 chiều (Titan Text V2) có chỉ mục HNSW. |
| **Ngân hàng** | `rubric` | `rubric_id` | `subject_id` $\rightarrow$ `subject` | Tên hiển thị `name` (tùy chọn, migration 028), cờ khóa cứng `is_locked` và số hiệu phiên bản `version`. |
| **Ngân hàng** | `rubric_criterion`| `rubric_criterion_id` | `rubric_id` $\rightarrow$ `rubric` | Tiêu chí chi tiết, trọng số `weight_percent`, điểm tối đa và thứ tự `order_index` (Migration 022). |
| **Ngân hàng** | `performance_level`| `performance_level_id` | `criterion_id` $\rightarrow$ `rubric_criterion` | Các mức độ hoàn thành Rubric kèm khoảng điểm `[min_score, max_score]` và mô tả. |
| **Ngân hàng** | `question` | `question_id` | `topic_id`, `rubric_id` | Ngân hàng câu hỏi: mức Bloom, ngôn ngữ `vi`/`en` (chuẩn hóa, migration 024), đáp án tham khảo, ý chính JSONB, vector embedding 1024-dim, trạng thái. Rubric phải cùng môn với chủ đề. |
| **Ngân hàng** | `question_source_ref`| `question_source_ref_id` | `question_id`, `chunk_id` | Liên kết trích dẫn đối soát nguồn tài liệu cho câu hỏi do AI sinh. |
| **Ngân hàng** | `question_generation_job`| `question_generation_job_id` | `topic_id` $\rightarrow$ `topic`, `rubric_id` $\rightarrow$ `rubric` | Quản lý tiến trình tác vụ AI sinh câu hỏi theo lô; `rubric_id` (tùy chọn, migration 029) được gắn cho mọi câu sinh ra. |
| **Kỳ thi** | `exam_session` | `exam_session_id` | `topic_id`, `subject_id` | Cấu hình kỳ thi: số câu, giới hạn hỏi xoáy, thời gian, khung giờ mở/đóng, trạng thái, `warm_status`. `language` được suy ra từ ngôn ngữ các câu đã duyệt của chủ đề (không do người dùng chọn). |
| **Kỳ thi** | `exam_session_student`| `exam_session_student_id` | `(exam_session_id, student_id)` (UK) | Roster danh sách thí sinh đủ điều kiện dự thi của kỳ thi. |
| **Kỳ thi** | `exam_session_examiner`| `exam_session_examiner_id` | `(exam_session_id, lecturer_id)` (UK) | Danh sách ban giám khảo được phân công chấm thi. |
| **Phỏng vấn**| `viva_interview` | `viva_interview_id` | `(exam_session_id, student_id)` (UK)| Phiên thi vấn đáp của từng thí sinh, trạng thái, thời hạn `deadline_at`, lý do kết thúc. |
| **Phỏng vấn**| `assigned_question` | `assigned_question_id`| `interview_id`, `question_id` | Bộ câu hỏi chính được hệ thống chọn riêng cho thí sinh theo phân bổ Bloom. |
| **Phỏng vấn**| `qa_turn` | `qa_turn_id` | `interview_id`, `assigned_question_id`| Từng lượt hỏi đáp (câu hỏi, audio TTS, câu trả lời, audio STT, độ trễ, WPM, số lần ngập ngừng). |
| **Phỏng vấn**| `transcript` | `transcript_id` | `interview_id` $\rightarrow$ `viva_interview` | Bản ghi toàn văn transcript của toàn bộ buổi phỏng vấn. |
| **Phỏng vấn**| `processing_failure`| `processing_failure_id` | `interview_id`, `turn_id` | Nhật ký ghi nhận các lỗi xử lý âm thanh/AI để phục vụ kiểm toán và khắc phục. |
| **Chấm điểm**| `viva_result` | `viva_result_id` | `interview_id` (UK) | Kết quả tổng kết điểm thi: trạng thái (`PENDING`, `AI_SCORING`, `AI_SUGGESTED`, `FLAGGED`, `FINALIZED`), điểm AI và điểm chốt. |
| **Chấm điểm**| `question_evaluation`| `question_evaluation_id`| `result_id`, `assigned_question_id` | Chi tiết đánh giá từng câu hỏi chính: điểm mạnh, điểm yếu, ý thiếu JSONB, độ tin cậy. |
| **Chấm điểm**| `criterion_score` | `criterion_score_id`| `evaluation_id`, `criterion_id` | Điểm thành phần từng tiêu chí Rubric, minh chứng `evidence` trích xuất từ transcript. |
| **Chấm điểm**| `score_adjustment` | `score_adjustment_id` | `criterion_score_id` $\rightarrow$ `criterion_score`| Lịch sử điều chỉnh điểm của Giám khảo: điểm cũ, điểm mới, lý do và người sửa. |
| **Hệ thống** | `background_job` | `background_job_id` | Check constraint `type` | Hàng đợi công việc nền chạy bằng SQL (`SKIP LOCKED`): `SEND_EMAIL`, `INGEST_MATERIAL`, `GENERATE_QUESTIONS`, `GRADE_INTERVIEW`, `KEEP_WARM`, `PREPARE_EXAM_AUDIO`, `EXPIRE_INTERVIEWS` (migration 023). |

---

## 5. THIẾT KẾ CÁC MÁY TRẠNG THÁI CỐT LÕI (STATE MACHINE DESIGN)

Bản UML state machine (kèm sự kiện, guard, action, và thêm QATurn, CourseMaterial, QuestionGenerationJob, BackgroundJob): [uml/state-machines.md](uml/state-machines.md).

### 5.1. Máy trạng thái Vòng đời Câu hỏi (Question Lifecycle)

Nguồn: `backend/src/domain/questionStatus.js`. Câu hỏi do RAG sinh được tạo ở `PENDING_REVIEW`. Chuyển sang `APPROVED` bắt buộc gắn Rubric; `REJECTED` bắt buộc lý do. Chỉ câu `APPROVED` được đưa vào kỳ thi.

| Từ | Được chuyển sang |
| :--- | :--- |
| `DRAFT` | `PENDING_REVIEW`, `APPROVED`, `ARCHIVED` |
| `PENDING_REVIEW` | `APPROVED`, `REJECTED`, `DRAFT` |
| `APPROVED` | `ARCHIVED`, `PENDING_REVIEW` (đưa về duyệt lại khi sửa nội dung) |
| `REJECTED` | `DRAFT`, `ARCHIVED` |
| `ARCHIVED` | (kết thúc) |

```
  DRAFT ──submit──▶ PENDING_REVIEW ◀── (RAG sinh)
    │  ▲               │      │  │
    │  └───────────────┘      │  └─reject──▶ REJECTED ──▶ DRAFT / ARCHIVED
    │ approve                 │ approve
    ▼                         ▼
  APPROVED ◀──────────────────┘
    │ archive        (APPROVED ──▶ PENDING_REVIEW khi cần duyệt lại)
    ▼
  ARCHIVED
```

### 5.2. Máy trạng thái Kỳ thi & Lịch thi (Exam Session Lifecycle)

```
        ┌──────────────┐
        │    DRAFT     │
        └──────┬───────┘
               │ schedule (đủ câu approved, đúng Bloom)
               ▼
        ┌──────────────┐
        │  SCHEDULED   │
        └──────┬───────┘
               │
      ┌────────┴────────┐
      │ unschedule      │ start (chỉ Admin, kích hoạt warm-up & pre-audio)
      ▼                 ▼
┌──────────────┐  ┌──────────────┐
│    DRAFT     │  │     OPEN     │
└──────────────┘  └──────┬───────┘
                         │ close (Admin hoặc Giảng viên)
                         ▼
                  ┌──────────────┐
                  │    CLOSED    │
                  └──────────────┘
```

Khi đóng sớm, `closes_at` được kéo về thời điểm đóng, nên `KEEP_WARM` tự dừng ở lần chạy kế tiếp (nó chỉ chạy khi kỳ thi `OPEN` và chưa qua `closes_at`). Đóng kỳ thi không kết thúc các phiên thi đang làm: `deadline_at` của từng phiên đã được tính và lưu khi bắt đầu, phiên kết thúc khi trả lời hết câu hoặc khi `EXPIRE_INTERVIEWS` quét quá hạn.

### 5.3. Máy trạng thái Phiên thi Vấn đáp (Viva Interview Lifecycle)

```
               ┌──────────────┐
               │ NOT_STARTED  │
               └──────┬───────┘
                      │ device check passed → POST /api/interviews
                      ▼
               ┌──────────────┐
       ┌──────▶│ IN_PROGRESS  │◀──────┐
       │       └──────┬───────┘       │
       │              │ network drop  │ reconnection (resume)
       │              ▼               │
       │       ┌──────────────┐       │
       │       │    PAUSED    │───────┘
       │       └──────────────┘
       │
       │ all questions answered (QUESTIONS_EXHAUSTED)
       │ OR deadline expired (DEADLINE_REACHED, gồm auto-sweep)
       ▼
┌──────────────┐
│  COMPLETED   │ ──▶ [ Tạo viva_result PENDING + Job GRADE_INTERVIEW ]
└──────────────┘
```

`TERMINATED` có trong `domain/interviewStatus.js` và CHECK constraint nhưng hiện không có luồng nào ghi trạng thái này; mọi phiên kết thúc đều là `COMPLETED` kèm `end_reason`.

### 5.4. Máy trạng thái Đánh giá & Chốt điểm (Viva Result Lifecycle)

```
                 [ Phiên thi COMPLETED ]
                            │
                            ▼
                     ┌──────────────┐
                     │   PENDING    │
                     └──────┬───────┘
                            │ enqueue GRADE_INTERVIEW
                            ▼
                     ┌──────────────┐
                     │  AI_SCORING  │
                     └──────┬───────┘
                            │
              ┌─────────────┴─────────────┐
              │ score ok                  │ có cờ (xem dưới)
              ▼                           ▼
       ┌──────────────┐            ┌──────────────┐
       │ AI_SUGGESTED │            │   FLAGGED    │
       └──────┬───────┘            └──────┬───────┘
              │                           │
              └─────────────┬─────────────┘
                            │ Examiner reviews, adjusts & finalizes
                            ▼
                     ┌──────────────┐
                     │  FINALIZED   │
                     └──────┬───────┘
                            │ reopen ──▶ FLAGGED (nếu còn flag_reason) hoặc AI_SUGGESTED
                            │ regrade ──▶ AI_SCORING (chấm lại bằng AI)
```

Câu chính không có câu trả lời (`isUnansweredQuestion` trong `domain/scoringRules.js`: mọi lượt rỗng, chỉ dấu câu, nhãn STT trong ngoặc hoặc âm ngập ngừng, hoặc câu chưa được hỏi trước hạn) được `GradingService` chấm 0 cho câu và mọi tiêu chí mà **không gọi LLM** (`model_id = rule:no-answer`, `confidence = 1`, `ai_level_id = null`, nhận xét theo ngôn ngữ kỳ thi); câu đó vẫn tính 0 vào trung bình và tự nó không gây cờ.

Điều kiện `FLAGGED` (`domain/scoringRules.js`): LLM lỗi hoặc trả sai schema; có lượt `FAILED`; hoặc một câu có `flag_reason` (độ tin cậy < 0.6, thiếu tiêu chí). Bài bị cờ vẫn hiển thị điểm AI cho giám khảo kèm banner cảnh báo và lý do.

---

## 6. THIẾT KẾ CHI TIẾT TƯƠNG TÁC THỜI GIAN THỰC (REALTIME SEQUENCE DESIGN)

Bản UML sequence (11 luồng: phiên thi, lượt trả lời, chấm điểm, đăng nhập, quên mật khẩu, tạo user, ingest tài liệu, sinh câu hỏi, duyệt câu hỏi, mở kỳ thi, quét bài quá hạn): [uml/sequence-diagrams.md](uml/sequence-diagrams.md); luồng hoạt động: [uml/activity-diagrams.md](uml/activity-diagrams.md).

Sơ đồ tuần tự thể hiện một lượt hỏi đáp phỏng vấn hoàn chỉnh trong phòng thi:

```
Sinh viên (Client)        Backend Socket.IO         AWS Lambda STT/TTS      Amazon Bedrock Nova Pro
      │                           │                          │                         │
      │ 1. question:new           │                          │                         │
      │◀──────────────────────────│ (Audio URL từ S3 Cache)  │                         │
      │                           │                          │                         │
      │ 2. Phát âm thanh câu hỏi   │                          │                         │
      │ 3. question:played        │                          │                         │
      │──────────────────────────▶│ Bắt đầu think_timer     │                         │
      │                           │ Bắt đầu answer_timer    │                         │
      │                           │                          │                         │
      │ 4. Sinh viên trả lời      │                          │                         │
      │    answer:start           │                          │                         │
      │    audio:chunk (webm/opus,│                          │                         │
      │    mỗi 1 giây)            │                          │                         │
      │══════════════════════════▶│ Gom audio trong bộ nhớ   │                         │
      │                           │                          │                         │
      │ 5. answer:end / Hết giờ   │                          │                         │
      │──────────────────────────▶│ Ghi audio câu trả lời S3 │                         │
      │                           │ 6. Invoke STT (Sync,     │                         │
      │                           │    retry 1 lần)          │                         │
      │                           │─────────────────────────▶│                         │
      │                           │◀─────────────────────────│                         │
      │                           │    (Transcript đoạn)     │                         │
      │                           │                          │                         │
      │                           │ 7. decideFollowUp        │                         │
      │                           │───────────────────────────────────────────────────▶│
      │                           │◀───────────────────────────────────────────────────│
      │                           │    ({ action: FOLLOW_UP, question, rationale })    │
      │                           │                          │                         │
      │                           │ 8. Invoke TTS (Kokoro)   │                         │
      │                           │─────────────────────────▶│                         │
      │                           │◀─────────────────────────│                         │
      │                           │    (WAV audio -> S3)     │                         │
      │                           │                          │                         │
      │ 9. question:new (xoáy)    │                          │                         │
      │◀──────────────────────────│                          │                         │
```

Lỗi giọng nói: STT lỗi sau hai lần gọi trả `turn:retry` (`STT_FAILED`), giữ câu hiện tại và hạn giờ đã lưu, không ghi câu trả lời rỗng. TTS lỗi thì trình duyệt dùng Web Speech (`vi-VN`/`en-US` theo kỳ thi). Hạn giờ từng lượt (`answer_deadline_at`) do máy chủ tính khi nhận `question:played` (thời gian suy nghĩ + thời gian trả lời, không vượt `deadline_at` của phiên); trình duyệt đếm ngược theo hạn đó và tự gửi `answer:end` khi hết giờ.

---

## 7. KIẾN TRÚC AN NINH & BẢO MẬT (SECURITY ARCHITECTURE)

1. **Xác thực và Quản lý Phiên (Authentication & Session)**:
   - Sử dụng cặp token HMAC JWT ký bảo mật bằng `JWT_SECRET` (tối thiểu 32 ký tự ngẫu nhiên).
   - Lưu trữ trong Cookie với đầy đủ các thuộc tính bảo vệ: `httpOnly` (chống XSS đánh cắp token), `Secure` (chỉ truyền qua HTTPS trên CloudFront) và `SameSite=Lax`.
   - Cơ chế Refresh Token Rotation: Mỗi lần làm mới phiên, token cũ bị thu hồi ngay lập tức; phát hiện và chặn đứng tấn công phát lại token cũ (Replay Attack). Vì vậy SPA gộp các yêu cầu refresh đồng thời thành một lần gọi (`refreshSession` trong `services/authApi.js`), xem mục 3.2.
2. **Bảo vệ Chống Giả mạo Yêu cầu Chéo trang (CSRF Protection)**:
   - Middleware `verifyOrigin` đối soát bắt buộc header `Origin` của các request thay đổi trạng thái (`POST`, `PUT`, `PATCH`, `DELETE`) với biến môi trường `APP_BASE_URL`.
3. **Phân quyền Đa tầng (Multi-tier Authorization)**:
   - **Tầng 1 (Role Guard)**: Phân quyền theo vai trò `ADMIN`, `LECTURER`, `STUDENT`.
   - **Tầng 2 (Subject Scope Guard)**: Giảng viên chỉ được thao tác trên dữ liệu thuộc các môn học mình được gán trong `subject_lecturer`. Kiểm tra nằm trong tầng service (`services/subjectScope.js`); bản ghi không có môn học được coi là không giới hạn phạm vi.
   - **Tầng 3 (Examiner Guard)**: Giảng viên chỉ được chỉnh sửa điểm hoặc chốt điểm khi có tên trong danh sách ban giám khảo của kỳ thi (`exam_session_examiner`) hoặc là người tạo kỳ thi (`created_by`).
4. **Bộ lọc An toàn Thí sinh (Student Safety Masking)**:
   - Toàn bộ dữ liệu trả về cho sinh viên trong lúc thi và khi xem kết quả bắt buộc phải đi qua các hàm biến đổi allowlist chuyên biệt (`toStudentInterviewView`, `toStudentResultView`) và được kiểm định đệ quy qua `assertStudentSafe()`.
   - Bất kỳ sự hiện diện nào của các trường nhạy cảm như `rationale`, `key_points`, `evidence`, `ai_justification` hay `prompt` đều kích hoạt ném lỗi bảo mật `STUDENT_VIEW_LEAK`.
5. **Bảo vệ Bề mặt Tấn công Máy chủ**:
   - Loại bỏ toàn bộ các endpoint thử nghiệm hoặc legacy không có xác thực (`/api/audio/*`).
   - Kiểm tra và thanh lọc tham số đầu vào (Sanitization): Ngăn chặn Path Traversal tại endpoint âm thanh tĩnh `/api/tts/:filename` bằng biểu thức chính quy nghiêm ngặt.
   - Chống SQL Injection 100% thông qua Parameterized Queries của thư viện `pg`.
