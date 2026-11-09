# Step 14: nhật ký kiểm thử và kế hoạch thực thi

File duy nhất ghi toàn bộ những gì phát hiện được khi kiểm thử tay trên prod từ ngày 30/10/2026: lỗi, yêu cầu, quyết định, đính chính, giải thích và lộ trình thực thi. File này thay cho `notes.md` và `plan.md` trước đây. **Mọi lỗi mới đều ghi tiếp vào đây.**

Ký hiệu trạng thái: 🔴 cần quyết định · 🟡 đang làm hoặc chờ deploy · 🟢 đã xong trên prod · ⚪ chỉ để giải thích

---

## 1. Trạng thái và môi trường

| Thành phần | Trạng thái |
|---|---|
| Prod | `https://d36ezmiqpl9miu.cloudfront.net`, EC2 `i-0797c55ad243db382`. Đang chạy `31cbe2e` (#55–#60, migration 024–029), deploy 30/10 |
| PR đang mở | Không có. Đang chờ chủ dự án kiểm thử tay toàn bộ |
| Local | Docker 29.8.2 và Postgres local đang chạy (sau khi khởi động lại máy ngày 29/10, vì WSL bị treo) |
| Công cụ | `gh` đăng nhập `tmqthedev`; AWS CLI còn hiệu lực, `ap-southeast-1`, **đang dùng tài khoản root**; terminal không có quyền Administrator |
| Quyền | Hệ thống phân quyền tự động chặn `git push --force` và các lệnh SSM vào EC2 prod |

---

## 2. Quyết định đã chốt

| # | Câu hỏi | Quyết định (30/10/2026) |
|---|---|---|
| Q1 | Môn học đã có dữ liệu thì xử lý thế nào? | Thêm trạng thái **Lưu trữ** (`ACTIVE`/`ARCHIVED`). Môn chưa có dữ liệu vẫn xoá cứng được |
| Q2 | Đổi role của giảng viên đang làm giám khảo kỳ thi SCHEDULED/OPEN? | Mặc định theo đề xuất, chưa hỏi lại: **chặn**, và liệt kê các kỳ thi liên quan |
| Q3 | Có cho tạo ADMIN từ giao diện không? | **Có**, kèm hộp thoại xác nhận và ghi log. Không được tự hạ quyền mình hoặc hạ admin cuối cùng |
| Q4 | Có chạy lại E2E F1→F10 trên prod không? | Có, sau khi kiểm thử tay xong. Cần các biến `E2E_*` (mục 8) |
| Q5 | Admin xoá user và phiên thi theo cách nào? | User: **xoá mềm** (status `DELETED`). Phiên thi: chỉ xoá được khi còn DRAFT/SCHEDULED và chưa có lượt thi. Log **chỉ lưu id**: người thực hiện, hành động, loại đối tượng, id đối tượng, thời điểm |
| Q6 | Có chạy migration 024 (gán ngôn ngữ `vi`/`en` cho câu hỏi) trên prod không? | **Đồng ý**, deploy PR #55 |

---

## 3. Lỗi và yêu cầu từ kiểm thử

### 3.1. Lỗi

| # | Lỗi | Nguyên nhân | Sửa ở | Trạng thái |
|---|---|---|---|---|
| T1 | Materials: ô chọn môn hiện "Subject 1"; môn chưa có topic thì không hiện | Danh sách môn được suy ra từ `subject_id` của các topic | #55: lấy môn từ `/exam-sessions/options` | 🟡 |
| T2 | Modal: lớp phủ chỉ phủ vùng nội dung, hộp thoại lệch xuống dưới | Animation `.animate-fade-in` giữ lại `transform`, nên phần tử đó thành containing block của `position: fixed` | #55: render Modal qua portal | 🟡 |
| T3 | Approve câu hỏi trả 409 mà giao diện không báo gì | Câu AI sinh không có rubric (`RUBRIC_REQUIRED`); banner lỗi nằm ở đầu trang, ngoài tầm nhìn | #55: hộp thoại "Gắn rubric và duyệt", banner tự cuộn tới | 🟡 |
| T4 | Không gắn được rubric; "Add Question" luôn thất bại | Form không có ô Topic và Rubric, trong khi API bắt buộc `topicId` | #55: thêm ô Topic (bắt buộc) và Rubric | 🟡 |
| T5 | Bấm Manage ở Exam sessions bị `ReferenceError: setCodesText` | Gọi hai state chưa khai báo; lint chưa bật rule `no-undef` | #55: xoá hai dòng, bật `no-undef` | 🟡 |
| T6 | Phải chọn ngôn ngữ thi riêng, dễ lệch với bộ câu hỏi | Ngôn ngữ thi là trường độc lập; nhiều câu có `language = NULL` | #55: ngôn ngữ thi suy ra từ bộ câu hỏi (mục 7.7) | 🟡 |

### 3.2. Yêu cầu UX

| # | Yêu cầu | Sửa ở | Trạng thái |
|---|---|---|---|
| U1 | Sắp xếp tab giảng viên theo luồng làm việc | #55: nhóm Ngân hàng câu hỏi (1–5) và Kỳ thi (6–7) | 🟡 |
| U2 | Xong một bước thì dẫn sang bước tiếp theo | #55: thanh `WorkflowNext`. Điều kiện "xong" chưa tách theo môn → mục H | 🟡 |
| U3 | Sau khi tạo phiên thi không có hướng dẫn | #55: checklist 6 bước trong panel Manage | 🟡 |
| U4 | Bắt buộc nhập thông tin cần thiết | #55 làm một phần; phần còn lại ở mục G | 🟡 |
| U5 | Admin CRUD Users, Subjects, Exam Schedule, có ghi log id | Mục F | 🔴→🟡 Bước 3, 4 |
| U6 | Môn học không xoá được | Mục A | Bước 2 |
| U7 | Thông báo lỗi chưa rõ (trùng mã môn) | Mục B | Bước 2 |
| U8 | Nút "Add User" có chọn role | Mục C | Bước 3 |
| U9 | Lọc và phân trang khi có nhiều user | Mục D | Bước 5 |
| U10 | Xem ai đã được phân công ở từng mục | Mục E | Bước 5 |

---

## 4. Hạng mục công việc

Số migration: `024` đã dùng cho ngôn ngữ câu hỏi (#55). Các migration mới lần lượt là `025`, `026`, …

### A. Xoá và lưu trữ môn học
- [x] A1. Thêm `subjectRepository.countDependents(id)`: đếm topic, tài liệu, rubric và kỳ thi của môn.
- [x] A2. `deleteSubject` trả `409 SUBJECT_IN_USE`, kèm `details` là số lượng từng loại. Không dùng cascade.
- [x] A3. Migration `subject.status` ACTIVE/ARCHIVED, cùng endpoint archive và unarchive. Môn ARCHIVED bị ẩn khỏi các ô chọn và không tạo được kỳ thi mới.
- [x] A4. UI: hộp thoại xác nhận khi xoá; nếu môn đang có dữ liệu thì đề xuất Lưu trữ.

### B. Thông báo lỗi rõ ràng
- [x] B1. `mapDbError`: lỗi 23505 phân loại theo tên constraint, ví dụ `subject_code_key` → `SUBJECT_CODE_TAKEN`.
- [x] B2. Kiểm tra trùng mã môn trước khi tạo hoặc sửa, trả `409 SUBJECT_CODE_TAKEN` kèm `field: 'code'`.
- [x] B3. Frontend dùng một helper chung đổi mã lỗi sang câu VI/EN, hiện lỗi ngay dưới ô nhập.
- [ ] B4. Mọi mã lỗi đều có bản dịch trong `vi.json` và `en.json`.

### C. Nút Add User
- [x] C1. `POST /api/admin/users` nhận `role` (STUDENT/LECTURER/ADMIN), dùng lại `_createPasswordlessUser`.
- [x] C2. STUDENT bắt buộc có `code`; giữ nguyên các lỗi `EMAIL_TAKEN`, `CODE_TAKEN`.
- [x] C3. Đổi role, với các chặn: không tự hạ quyền mình; không hạ admin cuối cùng; giảng viên đang làm giám khảo kỳ thi SCHEDULED/OPEN → `409 ROLE_CHANGE_BLOCKED`.
- [x] C4. UI: nút "Add user" có ô chọn role; chọn ADMIN thì hiện hộp thoại xác nhận.

### D. Lọc và phân trang user
- [x] D1. `GET /api/admin/users?role=&status=&q=&subjectId=&page=&pageSize=`, trả `{users,total,page,pageSize}`.
- [x] D2. Trang Users: thanh lọc và phân trang.
- [x] D3. Component `UserPicker` dùng chung (tìm kiếm, lọc, phân trang, chip đã chọn). Dùng cho phân công giảng viên, ghi danh sinh viên, chọn giám khảo và thí sinh.
- [ ] D4. Ô chọn phía giảng viên vẫn chỉ hiện người trong môn của mình.

### E. Xem phân công
- [x] E1. Danh sách môn có số giảng viên và số sinh viên; thêm `GET /api/admin/subjects/:id/lecturers`.
- [x] E2. Trang Subjects: panel chi tiết danh sách người được phân công, có nút gỡ.
- [x] E3. `GET /api/admin/users/:id/assignments`: user đang dạy, làm giám khảo hoặc ghi danh môn nào.
- [ ] E4. Exam sessions: hiện danh sách giám khảo và thí sinh ngay trong panel.

### F. Admin CRUD đầy đủ và audit log
- [x] F1. `DELETE /api/admin/users/:id` là xoá mềm (status `DELETED`). Không xoá chính mình hoặc admin cuối cùng. User DELETED không đăng nhập được.
- [x] F2. (#58; UI chưa có form sửa, chỉ có API) Admin tạo, sửa và xoá phiên thi. Chỉ xoá được phiên DRAFT/SCHEDULED chưa có lượt thi; ngược lại trả `409 SESSION_IN_USE`.
- [x] F3. Bảng `admin_audit_log (actor_id, action, entity_type, entity_id, created_at)`, ghi trong cùng transaction với thao tác. Không lưu nội dung. Thêm `GET /api/admin/audit-log`.
- [x] F4. (#58) UI: các nút xoá có hộp thoại xác nhận; trang Audit log cho admin.
- [x] F5. Test cho từng chặn và cho mỗi dòng audit được ghi.

### G. Thông tin bắt buộc
- [x] G1. Đánh dấu `*` và `required` trên mọi form. Đã làm cho phiên thi (Subject, Topic) và câu hỏi (Topic) trong #55.
- [x] G2. Chặn trước các thao tác thiếu điều kiện. Đã làm trong #55: kỳ thi cần bộ câu hỏi một ngôn ngữ; duyệt câu hỏi cần rubric.
- [x] G3. Phía server validate với mã lỗi riêng (xem B).

### H. Hoàn thiện ngân hàng câu hỏi (việc còn lại của T3, T4, U2)
- [x] H1. Khi tạo hoặc sửa câu hỏi, kiểm tra rubric cùng môn với topic, dùng lại `_assertRubricInSubject`.
- [x] H2. Job `GENERATE_QUESTIONS` nhận thêm `rubricId` (tuỳ chọn); modal Generate có ô chọn rubric.
- [x] H3. Thêm cột `rubric.name` (migration).
- [x] H4. Dashboard có bảng tiến độ theo từng môn, để chỉ báo "xong" của U2 tính đúng theo môn.

---

## 5. Lộ trình thực thi

| Bước | Nội dung | Mục | Trạng thái |
|---|---|---|---|
| 0 | Gộp log vào file này | — | 🟢 |
| 1 | Merge và deploy #55 (có migration 024); smoke test prod; bạn kiểm thử lại trên trình duyệt | T1–T6, U1–U4 | 🟢 deploy xong; chờ bạn kiểm thử |
| 2 | PR: thông báo lỗi rõ ràng và lưu trữ môn học | B, A | 🟢 #56 (migration 025) |
| 3 | PR: audit log, Add User, đổi role, xoá mềm user | F3, C, F1 | 🟢 #57 (migration 026, 027) |
| 4 | PR: admin CRUD phiên thi và trang Audit log | F2, F4 | 🟢 #58 |
| 5 | PR: lọc, phân trang user, `UserPicker`, xem phân công | D, E | 🟢 #59 |
| 6 | PR: hoàn thiện ngân hàng câu hỏi và các trường bắt buộc còn lại | H, G | 🟢 #60 (migration 028, 029) |
| 7 | E2E trên prod: thêm các ca mới vào runner, chạy F1→F10, cập nhật `docs/e2e-execution-report.md` | — | Cần mục 8 |

Mỗi PR được kiểm tra theo cùng quy trình trước khi merge và deploy:
- `npm test`;
- `npm run test:e2e` với `TEST_DATABASE_URL`;
- frontend: build và lint;
- CI qua đủ 5 job.

Sau deploy: smoke test prod, bạn kiểm thử, rồi ghi kết quả vào đây.

---

## 6. Đính chính

| # | Đã nói | Thực tế |
|---|---|---|
| 6.1 | `CLAUDE.md` ghi mock DB hỗ trợ bảng `evaluation` | Sai từ khi #54 gỡ phần này. Đã sửa trong #55 |
| 6.2 | "`/api/evaluations` trả 500 trên Postgres" | Suy luận từ việc thiếu bảng, chưa quan sát thực tế. Route đã gỡ, prod giờ trả 404 |
| 6.3 | Lần kiểm tra đầu thấy `/api/evaluations` trả 401, suýt coi là kết quả sau deploy | Lúc đó deploy chưa xong. Kiểm tra lại thì đúng là 404 |
| 6.4 | "Docker engine_ready=True" (trước khi khởi động lại máy) | Sai: WSL đang treo, vòng kiểm tra coi đầu ra rỗng là thành công |
| 6.5 | "SQL của `getTurnAudioKey` chưa chạy trên Postgres thật" | Đã chạy e2e với Postgres local sau đó, SQL đúng |
| 6.6 | "Môn chưa có dữ liệu thì xoá được" | Suy luận từ schema, chưa thử thực tế. Bạn xác nhận giúp khi kiểm thử |
| 6.7 | Test `listOverdueActive` fail | Lỗi do test bị ảnh hưởng bởi dữ liệu local cũ, không phải lỗi code. Đã sửa test (#54) |
| 6.9 | (PR #57) Unit test qua hết nhưng `appUserRepository.list({ role })` mất ký tự `$` trong placeholder SQL, nên lỗi trên Postgres | Phát hiện nhờ chạy SQL thật trên Postgres local; đã sửa và thêm `adminRepositories.e2e.test.js` để chặn lỗi tương tự |
| 6.10 | (PR #57) Ghi audit "trong cùng transaction" như kế hoạch | Thực tế ghi **sau** khi thao tác thành công, không cùng transaction. Nếu ghi audit lỗi thì request báo lỗi dù thay đổi đã được lưu |
| 6.11 | (#59) "Assign lecturers" ở trang Subjects mở ra với danh sách trống | Lưu sẽ **thay toàn bộ** phân công, nên tick một giảng viên là xoá mất những người khác. Đã sửa: hộp thoại nạp sẵn các giảng viên hiện tại |
| 6.12 | (bước 6) Dashboard giảng viên hiển thị số liệu | Đó là số **giả viết cứng** (24, 12, 156). Đã thay bằng tiến độ thật theo từng môn |
| 6.8 | Câu hỏi 4 đã có rubric mà approve vẫn 409 | Có thể do câu đó đã APPROVED (`INVALID_TRANSITION`). Chưa xác minh |

---

## 7. Giải thích

### 7.1. Merge và deploy #53, #54
- #53 squash merge thành `97026ec`.
- Với #54, force-push bị chặn nên mình merge `main` vào branch thay vì rebase. Các xung đột chỉ là hình thức: nội dung trên `main` giống hệt commit docs trong branch.
- CI qua cả 5 job, merge thành `04f8ffe`. Cả hai lần deploy đều thành công.

### 7.2. Kiểm tra nhanh prod sau deploy `04f8ffe` (chưa đăng nhập)
- `/api/evaluations` và `/api/lecturer/sessions`: từ 401 thành **404**.
- `/api/turns/1/audio`, `/api/topics`, `/api/auth/me`: vẫn 401.
- SPA: 200.
- `/health` qua CloudFront trả về trang SPA, nên muốn kiểm tra health thật phải gọi qua SSM.

### 7.3. Vì sao môn học không xoá được
Các bảng `topic`, `course_material`, `material_chunk`, `rubric` và `exam_session` tham chiếu `subject` mà không có cascade. Khi môn có dữ liệu, Postgres báo lỗi 23503, `mapDbError` chuyển thành `409 RESOURCE_IN_USE`, còn giao diện chỉ hiện "Could not delete the subject.".

### 7.4. Vì sao lỗi trùng mã môn không rõ
Trùng mã làm Postgres báo lỗi 23505, được trả về là `409 DUPLICATE_DATA` "Duplicate data conflict.". Form chỉ xử lý lỗi 400, nên mọi lỗi khác đều hiện câu chung.

### 7.5. Vì sao danh sách user khó dùng
`GET /api/admin/users` trả toàn bộ user, không phân trang hay tìm kiếm. Hộp thoại phân công liệt kê mọi giảng viên.

### 7.6. Các lỗi T1–T5 (chi tiết)
- **T1:** `Materials.jsx` hiển thị `"Subject" + id`.
- **T2:** `fadeIn` dùng `forwards` nên giữ `transform: translateY(0)`; containing block của overlay `position: fixed` vì thế bị đổi sang khung trang.
- **T3, T4:** form câu hỏi thiếu ô topic và rubric; câu AI sinh không có rubric.
- **T5:** `openDetails` gọi `setCodesText` và `setExaminerText`, sót lại từ commit `817b504`.

### 7.7. Ngôn ngữ thi được suy ra từ bộ câu hỏi (#55)
- `domain/questionLanguage.js` chuẩn hoá ngôn ngữ câu hỏi thành `vi`/`en` mỗi khi lưu. Nếu thiếu, hệ thống tự nhận diện: có chữ tiếng Việt có dấu thì là `vi`, ngược lại `en`. Migration 024 áp dụng cho các câu cũ.
- Ngôn ngữ kỳ thi lấy từ các câu đã duyệt của topic, tính khi tạo phiên và tính lại khi schedule và start:
  - bộ câu hỏi rỗng → `409 NO_APPROVED_QUESTIONS`;
  - trộn hai ngôn ngữ → `409 MIXED_LANGUAGE_BANK`, kèm số câu mỗi ngôn ngữ.
- Lúc chọn câu cho thí sinh và lúc tạo audio trước chỉ dùng câu đúng ngôn ngữ thi.
- Giao diện: ô ngôn ngữ chỉ để xem; nút Create bị khoá kèm lý do.
- Kiểm thử: unit 544 qua; e2e với Postgres 149 qua, bỏ qua 3.

---

### 7.8. Các sửa lỗi sau buổi demo (#63–#69, 04–05/11)

Tất cả đã merge vào `main`; tài liệu được đồng bộ trong PR `docs/step14-sync-fixes`.

| PR | Nội dung |
|---|---|
| #63 | Trang thẩm định (`EvaluationReview`) bị trắng khi danh sách JSONB (ý chính, minh chứng, nguồn) là đối tượng: nay luôn quy về chuỗi. Thêm trang lỗi theo mã HTTP (`shared/components/ErrorPage`, `ErrorBoundary`), route `*` → 404, khu vực vai trò khác → 403 thay vì chuyển hướng im lặng |
| #64 | Chip độ trễ trên trang thẩm định đọc sai trường (`speech_latency_ms`); sửa thành `response_latency_ms` |
| #65 | Phiên hết hạn sau 15 phút: `authedFetch` tự refresh một lần khi gặp 401 (dùng chung một lần refresh); `AuthContext` refresh mỗi 10 phút; phòng thi refresh rồi kết nối lại khi bắt tay socket bị từ chối |
| #66 | `scripts/cleanup-test-data.mjs` chạy độc lập (không import `e2e-business-flows.mjs` nữa) |
| #67 | `rubricRepository` cập nhật `name`/`max_score` thiếu dấu `$` trong placeholder SQL; thêm unit test |
| #68 | Câu không có câu trả lời (rỗng, `[silence]`, chỉ "ờ/ừm") được chấm 0 mà không gọi LLM (`rule:no-answer`); prompt chấm cấm cho điểm phần chỉ có trong đáp án mẫu |
| #69 | Hộp thoại kiểm tra micro và loa trước khi bắt đầu/tiếp tục thi (`DeviceCheckModal`); phiên chỉ được tạo sau khi kiểm tra đạt. Thêm `frontend/test/audioDevices.test.js` |

---

## 8. Việc bạn cần làm

- [ ] Kiểm thử lại trên trình duyệt sau khi #55 được deploy: T1–T6, U1–U4.
- [ ] Để chạy E2E trên prod, đặt các biến này trong terminal (không gửi mật khẩu qua chat) và cho phép các lệnh `node scripts/aws-ssm.js ...`:
  ```powershell
  $env:BASE_URL='https://d36ezmiqpl9miu.cloudfront.net'
  $env:E2E_ALLOW_PRODUCTION='YES'
  $env:E2E_SSM_INSTANCE_ID='i-0797c55ad243db382'
  $env:E2E_ADMIN_IDENTIFIER='...'; $env:E2E_ADMIN_PASSWORD='...'
  $env:E2E_USER_PASSWORD='...';   $env:E2E_TEST_EMAIL_BASE='...@gmail.com'
  ```
- [ ] Bảo mật: chuyển AWS CLI sang IAM user thay vì root; đổi admin password, `JWT_SECRET` và Gmail app password.

---

## 9. Nhật ký

| Thời điểm | Sự kiện |
|---|---|
| 30/10 | Deploy `97026ec` (#53) và `04f8ffe` (#54) |
| 30/10 | Mở #55; ghi nhận T1–T6, U1–U5 |
| 30/10 | Chốt Q1, Q3, Q5, Q6; gộp log vào file này |
| 30/10 | Deploy #55 (`764f4ba`). Merge #56 (lưu trữ môn, mã lỗi rõ ràng) và #57 (Add User, xoá mềm, audit log). Mở #58 |
| 30/10 | Merge #58 (admin tạo/xoá kỳ thi, trang Audit log). Mở #59 (lọc/phân trang user, UserPicker, xem phân công) và PR bước 6 (ngân hàng câu hỏi, Dashboard thật, migration 028–029) |
| 30/10 | Merge và deploy #59, #60 (`31cbe2e`). Cập nhật tài liệu SRS 2.2, SDS 2.2, business flows, CLAUDE.md, AGENTS.md |
| 30/10 | Máy chỉ có 8 GB RAM: lệnh build frontend bị OOM khi Docker đang chạy. Phải tắt Docker Desktop thì mới build được |
| 04–05/11 | Merge #63–#69 (trang lỗi HTTP, chip độ trễ, tự làm mới phiên, script dọn TEST_, SQL rubric, chấm 0 câu không trả lời, kiểm tra thiết bị âm thanh) |
| 05/11 | Đồng bộ SRS, SDS, business flows, PRD, UML, CLAUDE.md, AGENTS.md với #63–#69. Gỡ phần trùng lặp trong file này (bản cũ của mục 1–6 bị chèn giữa hàng 6.9) |
