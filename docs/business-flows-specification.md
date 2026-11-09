# AIVES: Đặc tả Luồng Nghiệp vụ (Business Flows Specification)
### Đặc tả Chi tiết 10 Luồng Nghiệp vụ Cốt lõi F1 → F10 & Phụ lục Kỹ thuật

**Tên hệ thống**: AIVES (AI-assisted Viva Examination System)  
**Tác giả**: @tmqthedev & Antigravity AI Pair Programmer  
**Ngày cập nhật**: 05/11/2026 · Phiên bản: 2.1 (Step 1 → Step 14; bổ sung #63–#69: tự làm mới phiên, kiểm tra thiết bị âm thanh trước khi thi, chấm 0 câu không trả lời, trang lỗi HTTP)

---

## MỤC LỤC TỔNG QUAN

1. [F1: Đăng nhập, Đặt & Đổi mật khẩu, Khoá tài khoản](#f1-đăng-nhập-đặt--đổi-mật-khẩu-khoá-tài-khoản)
2. [F2: Admin - Quản trị Tài khoản Người dùng & Import Excel](#f2-admin---quản-trị-tài-khoản-người-dùng--import-excel)
3. [F3: Admin - Môn học, Phân công Giảng viên & Ghi danh Sinh viên](#f3-admin---môn-học-phân-công-giảng-viên--ghi-danh-sinh-viên)
4. [F4: Giảng viên - Quản lý Chủ đề thi (Topics) trong Môn học](#f4-giảng-viên---quản-lý-chủ-đề-thi-topics-trong-môn-học)
5. [F5: Giảng viên - Quản lý Học liệu Giảng dạy (Upload & Ingest)](#f5-giảng-viên---quản-lý-học-liệu-giảng-dạy-upload--ingest)
6. [F6: Giảng viên - Ngân hàng Câu hỏi & Quản lý Rubric](#f6-giảng-viên---ngân-hàng-câu-hỏi--quản-lý-rubric)
7. [F7: Giảng viên - Thiết lập Cấu hình & Lên lịch Kỳ thi](#f7-giảng-viên---thiết-lập-cấu-hình--lên-lịch-kỳ-thi)
8. [F8: Admin - Điều phối Lịch thi & Kích hoạt Tài nguyên](#f8-admin---điều-phối-lịch-thi--kích-hoạt-tài-nguyên)
9. [F9: Sinh viên - Thi Vấn đáp Giọng nói Trực tiếp với AI](#f9-sinh-viên---thi-vấn-đáp-giọng-nói-trực-tiếp-với-ai)
10. [F10: Chấm điểm Gợi ý AI, Thẩm định & Tra cứu Kết quả](#f10-chấm-điểm-gợi-ý-ai-thẩm-định--tra-cứu-kết-quả)
11. [Phụ lục A: Ma trận Phân quyền Role × Endpoint Toàn hệ thống](#phụ-lục-a-ma-trận-phân-quyền-role--endpoint-toàn-hệ-thống)
12. [Phụ lục B: Bảng Mã lỗi Chuẩn hóa Toàn hệ thống](#phụ-lục-b-bảng-mã-lỗi-chuẩn-hóa-toàn-hệ-thống)

---

## F1: Đăng nhập, Đặt & Đổi mật khẩu, Khoá tài khoản

### 1. Tác nhân (Actor)
- Tất cả người dùng hệ thống: `ADMIN`, `LECTURER`, `STUDENT`.

### 2. Tiền điều kiện (Preconditions)
- Tài khoản đã tồn tại trong bảng `app_user`, trạng thái `ACTIVE` (hoặc `must_change_password = true` khi mới khởi tạo).

### 3. Trình tự các bước thực hiện (UI $\rightarrow$ API)
1. **Đăng nhập hệ thống**:
   - Người dùng nhập Email hoặc Mã tài khoản (`code`) cùng Mật khẩu tại trang Login.
   - Frontend gửi: `POST /api/auth/login` với `{ email|code, password }`.
   - Backend xác thực mã băm `scrypt`, khởi tạo bản ghi trong `auth_session`, trả về HTTP 200 kèm Set-Cookie:
     * `access_token`: JWT hạn 15 phút, cờ `httpOnly; Secure; SameSite=Lax`.
     * `refresh_token`: JWT hạn 7 ngày, cờ `httpOnly; Secure; SameSite=Lax`.
   - Frontend gọi `GET /api/auth/me` để nạp thông tin người dùng vào `AuthContext` và điều hướng về Dashboard theo vai trò.
2. **Thiết lập mật khẩu lần đầu (Account Setup)**:
   - Người dùng nhấp vào liên kết kích hoạt trong email: `/set-password?token=...`.
   - Frontend gửi: `POST /api/auth/set-password` với `{ token, password }`.
   - Backend đối soát mã băm sha256 của token với bảng `password_token` (purpose `SET`, `used_at IS NULL`), mã hóa mật khẩu mới bằng `scrypt`, gán `must_change_password = false`, đánh dấu token đã dùng.
3. **Quên & Đặt lại mật khẩu (Forgot/Reset Password)**:
   - Người dùng nhập email tại `/forgot-password` $\rightarrow$ Frontend gửi `POST /api/auth/forgot-password` với `{ email }`.
   - Backend phản hồi luôn trả về HTTP `200 { ok: true }` (Enumeration-safe). Nếu email tồn tại, hệ thống tạo bản ghi token `RESET` (hạn 30 phút) và đẩy tác vụ nền `SEND_EMAIL`.
   - Người dùng nhấp vào link email $\rightarrow$ Frontend gửi: `POST /api/auth/reset-password` với `{ token, password }`.
   - Backend cập nhật mật khẩu mới, đánh dấu token đã dùng và thu hồi toàn bộ phiên đăng nhập hiện tại trong `auth_session`.
4. **Tự làm mới phiên (Silent Refresh)**:
   - Mọi lời gọi API của SPA đi qua `authedFetch` (`services/authApi.js`): gặp `401` thì gọi `POST /api/auth/refresh` một lần rồi gửi lại yêu cầu. Các `401` đồng thời dùng chung một lần refresh, vì refresh token xoay vòng và token cũ gửi lại bị từ chối. Các endpoint `/auth/login`, `/auth/refresh`, `/auth/logout`, `/auth/forgot-password`, `/auth/reset-password`, `/auth/set-password` không tự refresh: `401` của chúng là câu trả lời thật.
   - Khi đã đăng nhập, `AuthContext` làm mới phiên mỗi 10 phút, để các yêu cầu không tự thử lại được (thẻ `<audio>` phát audio câu trả lời và TTS, bắt tay Socket.IO) luôn có access cookie còn hạn.
   - Bắt tay Socket.IO phòng thi bị từ chối với `AUTHENTICATION_REQUIRED` / `INVALID_TOKEN`: phòng thi làm mới phiên một lần rồi kết nối lại; refresh thất bại mới hiển thị lỗi.
5. **Đổi mật khẩu trong phiên (Change Password)**:
   - Người dùng đã đăng nhập vào màn hình cá nhân $\rightarrow$ Gửi: `PUT /api/auth/password` với `{ currentPassword, newPassword }`.
   - Backend đối soát mật khẩu hiện tại, cập nhật mật khẩu mới và thu hồi toàn bộ các phiên làm việc khác.

### 4. Máy trạng thái & Chuyển trạng thái
- Tài khoản: `ACTIVE` $\longrightarrow$ `LOCKED` (sau 5 lần nhập sai mật khẩu liên tiếp trong cửa sổ 15 phút).
- Tự động mở khóa trở lại `ACTIVE` sau 15 phút hoặc khi được Quản trị viên mở khóa thủ công.

### 5. Luật nghiệp vụ (Business Rules - BR)
- **BR-F1.1**: Đăng nhập hỗ trợ đồng thời cả Email và Mã tài khoản (`code`).
- **BR-F1.2**: Mật khẩu bắt buộc có độ dài tối thiểu 8 ký tự. Tuyệt đối không lưu trữ hoặc gửi mật khẩu dạng văn bản thuần (plaintext) trong email hay nhật ký log.
- **BR-F1.3 (Enumeration Defense)**: Yêu cầu quên mật khẩu luôn trả về HTTP 200 bất kể email có tồn tại trong hệ thống hay không.
- **BR-F1.4 (Single-use Token)**: Mã token `SET` và `RESET` chỉ được sử dụng duy nhất một lần.
- **BR-F1.5 (CSRF Defense)**: Mọi yêu cầu thay đổi dữ liệu (`POST`, `PUT`, `PATCH`, `DELETE`) bắt buộc phải có header `Origin` khớp với `APP_BASE_URL`.

### 6. Mã lỗi có thể gặp
| HTTP | Code | Nguyên nhân kỹ thuật | Thông báo hiển thị trên giao diện |
| :---: | :--- | :--- | :--- |
| **401** | `INVALID_CREDENTIALS` | Sai email/mã hoặc sai mật khẩu | Tên đăng nhập hoặc mật khẩu không chính xác. |
| **423** | `LOCKED` | Đăng nhập sai quá 5 lần liên tiếp trong 15 phút | Tài khoản tạm thời bị khoá do nhập sai quá nhiều lần. Vui lòng thử lại sau 15 phút. |
| **400** | `INVALID_TOKEN` | Token liên kết hết hạn hoặc đã được sử dụng | Liên kết không hợp lệ hoặc đã hết hạn. |
| **403** | `FORBIDDEN_ORIGIN` | Thiếu hoặc sai header Origin (CSRF) | Yêu cầu bị từ chối do chính sách bảo mật CSRF. |

---

## F2: Admin - Quản trị Tài khoản Người dùng & Import Excel

### 1. Tác nhân (Actor)
- `ADMIN`.

### 2. Tiền điều kiện (Preconditions)
- Đã đăng nhập vai trò `ADMIN`.

### 3. Trình tự các bước thực hiện (UI $\rightarrow$ API)
1. **Thêm người dùng (Add User)**:
   - Admin vào trang *Users* (`/admin/users`) $\rightarrow$ Chọn *Add user*, chọn vai trò `STUDENT` / `LECTURER` / `ADMIN`, nhập `email`, `code` (bắt buộc với sinh viên) và `fullName`. Chọn `ADMIN` phải xác nhận.
   - Frontend gửi: `POST /api/admin/users` với `{ code, email, fullName, role }`. Backend tạo `app_user` (`status='ACTIVE'`), sinh token `SET` và đẩy `SEND_EMAIL` gửi link kích hoạt.
2. **Import Sinh viên hàng loạt từ tệp Excel**:
   - Admin tải lên tệp `.xlsx` theo mẫu chuẩn (các cột: Code, Full Name, Email).
   - Frontend gửi: `POST /api/admin/users/import` với nội dung tệp nhị phân (`application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`).
   - Backend thẩm định toàn diện tệp: kiểm tra trùng lặp trong tệp và trong CSDL. Nếu 100% hợp lệ, hệ thống tạo toàn bộ tài khoản `STUDENT` và gửi email kích hoạt; nếu có lỗi, từ chối toàn bộ (All-or-Nothing) và trả về danh sách chi tiết các dòng bị lỗi.
3. **Quản trị trạng thái tài khoản**:
   - Khóa tài khoản: `POST /api/admin/users/:id/lock` $\rightarrow$ Chuyển `status='LOCKED'`.
   - Mở khóa tài khoản: `POST /api/admin/users/:id/unlock` $\rightarrow$ Xóa `locked_until`, reset `failed_login_count = 0`, chuyển `status='ACTIVE'`.
   - Gửi lại link kích hoạt: `POST /api/admin/users/:id/resend-setup` $\rightarrow$ Sinh token mới và gửi email.
   - Đổi vai trò: chọn vai trò mới ngay trên dòng $\rightarrow$ `PUT /api/admin/users/:id` với `{ role }`. Các phân công môn học cũ bị gỡ.
   - Xóa (mềm): `DELETE /api/admin/users/:id` $\rightarrow$ `status='DELETED'`, thu hồi link và phiên, ẩn khỏi danh sách; lịch sử thi giữ nguyên.
4. **Tìm kiếm, lọc & xem phân công**:
   - Thanh lọc trên trang Users: tìm theo mã/tên/email, lọc theo vai trò, trạng thái, môn học; phân trang phía máy chủ (`GET /api/admin/users?q=&role=&status=&subjectId=&page=&pageSize=`).
   - Nút *Assignments* trên mỗi dòng: `GET /api/admin/users/:id/assignments` (môn đang dạy/ghi danh, kỳ thi làm giám khảo/thí sinh).

### 4. Luật nghiệp vụ (BR)
- **BR-F2.1**: Mã người dùng (`code`) và `email` phải là duy nhất trên toàn hệ thống.
- **BR-F2.2 (All-or-Nothing Import)**: Không ghi bất kỳ dòng nào vào CSDL nếu tệp Excel có dòng bị lỗi.
- **BR-F2.3**: Không được đổi vai trò hoặc xóa chính mình, `ADMIN` đang hoạt động cuối cùng, hoặc người đang là giám khảo/thí sinh của kỳ thi `SCHEDULED`/`OPEN`.
- **BR-F2.4**: Tài khoản `DELETED` không đăng nhập được và không nhận email đặt lại mật khẩu; phản hồi giống tài khoản không tồn tại.
- **BR-F2.5**: Mọi thao tác ghi của Admin được ghi vào `admin_audit_log` (chỉ id), xem ở `/admin/audit-log`.

### 5. Mã lỗi có thể gặp
| HTTP | Code | Nguyên nhân kỹ thuật | Thông báo hiển thị trên giao diện |
| :---: | :--- | :--- | :--- |
| **409** | `EMAIL_TAKEN` | Email đã tồn tại trong hệ thống | Email này đã được sử dụng bởi tài khoản khác. |
| **409** | `CODE_TAKEN` | Mã người dùng đã tồn tại | Mã người dùng này đã tồn tại trong hệ thống. |
| **400** | `CODE_REQUIRED` | Tạo/đổi sang sinh viên mà thiếu mã | Sinh viên bắt buộc phải có mã. |
| **409** | `CANNOT_MODIFY_SELF` | Admin đổi vai trò/xóa chính mình | Bạn không thể đổi vai trò hoặc xoá chính tài khoản của mình. |
| **409** | `LAST_ADMIN` | Đổi vai trò/xóa admin hoạt động cuối cùng | Không thể đổi vai trò hoặc xoá admin đang hoạt động cuối cùng. |
| **409** | `USER_IN_OPEN_EXAM` | Người dùng đang trong kỳ thi SCHEDULED/OPEN | Người dùng đang là giám khảo hoặc thí sinh của kỳ thi đã lên lịch/đang mở (kèm danh sách). |
| **422** | `VALIDATION_ERROR` | Tệp Excel có dòng sai format/trùng lặp | Tệp import chứa dữ liệu không hợp lệ. Vui lòng kiểm tra danh sách lỗi. |

---

## F3: Admin - Môn học, Phân công Giảng viên & Ghi danh Sinh viên

### 1. Tác nhân (Actor)
- `ADMIN`.

### 2. Tiền điều kiện (Preconditions)
- Đã đăng nhập vai trò `ADMIN`.

### 3. Trình tự các bước thực hiện (UI $\rightarrow$ API)
1. **Quản lý Môn học**:
   - Thêm môn: `POST /api/admin/subjects` với `{ code, name }`.
   - Cập nhật môn: `PUT /api/admin/subjects/:id`.
   - Xóa môn: `DELETE /api/admin/subjects/:id` (có xác nhận). Chỉ môn chưa có dữ liệu mới bị xóa; nếu môn đã có chủ đề, tài liệu, rubric hoặc kỳ thi thì trả `409 SUBJECT_IN_USE` kèm số lượng và giao diện đề xuất Lưu trữ.
   - Lưu trữ / bỏ lưu trữ: `POST /api/admin/subjects/:id/archive` / `unarchive`.
   - Danh sách môn hiển thị số giảng viên, số sinh viên và trạng thái.
2. **Phân công Giảng viên phụ trách môn**:
   - Admin chọn môn $\rightarrow$ hộp thoại nạp sẵn giảng viên đang được phân công (`GET /api/admin/subjects/:id/lecturers`) $\rightarrow$ tìm và chọn thêm/bỏ qua bộ chọn có tìm kiếm, phân trang $\rightarrow$ Gửi: `PUT /api/admin/subjects/:id/lecturers` với `{ lecturerIds: [...] }` (thay toàn bộ tập phân công).
   - Backend cập nhật toàn diện bảng quan hệ `subject_lecturer` trong một transaction.
3. **Ghi danh Sinh viên vào môn học**:
   - Admin chọn môn $\rightarrow$ Chọn tab "Ghi danh Sinh viên" $\rightarrow$ Nhập danh sách mã sinh viên hoặc chọn danh sách ID.
   - Frontend gửi: `PUT /api/admin/subjects/:id/students` với `{ codes: [...] }` hoặc `{ studentIds: [...] }`.
   - Backend thẩm định: Toàn bộ sinh viên phải là `STUDENT ACTIVE`. Cập nhật bảng `subject_student` (Migration 020) theo cơ chế All-or-Nothing.

### 4. Luật nghiệp vụ (BR)
- **BR-F3.1**: Sinh viên bắt buộc phải có tên trong `subject_student` của môn học mới đủ điều kiện được thêm vào danh sách thi (Roster) của kỳ thi thuộc môn đó.
- **BR-F3.3**: Môn `ARCHIVED` bị ẩn khỏi các ô chọn của giảng viên và không tạo được kỳ thi mới (`409 SUBJECT_ARCHIVED`); kết quả thi cũ vẫn xem được.
- **BR-F3.2**: Giảng viên bắt buộc phải có tên trong `subject_lecturer` của môn học mới có quyền quản lý chủ đề, học liệu, câu hỏi, kỳ thi hoặc được gán làm giám khảo chấm thi của môn đó.

### 5. Mã lỗi có thể gặp
| HTTP | Code | Nguyên nhân kỹ thuật | Thông báo hiển thị trên giao diện |
| :---: | :--- | :--- | :--- |
| **409** | `SUBJECT_CODE_TAKEN` | Mã môn học đã tồn tại (không phân biệt hoa thường) | Mã môn học đã tồn tại (hiển thị dưới ô Mã). |
| **409** | `SUBJECT_IN_USE` | Xóa môn đã có chủ đề/tài liệu/rubric/kỳ thi | Môn học vẫn còn dữ liệu, hãy lưu trữ thay vì xoá (kèm số lượng). |
| **422** | `VALIDATION_ERROR` | Danh sách sinh viên chứa mã không tồn tại | Danh sách sinh viên chứa mã không hợp lệ hoặc tài khoản bị khóa. |

---

## F4: Giảng viên - Quản lý Chủ đề thi (Topics) trong Môn học

### 1. Tác nhân (Actor)
- `LECTURER` (phụ trách môn) hoặc `ADMIN`.

### 2. Tiền điều kiện (Preconditions)
- Giảng viên đã được gán vào môn học trong `subject_lecturer`.

### 3. Trình tự các bước thực hiện (UI $\rightarrow$ API)
1. **Xem danh sách Chủ đề thi**:
   - Giảng viên truy cập `/lecturer/topics`.
   - Frontend gọi đồng thời `GET /api/topics` và `GET /api/exam-sessions/options` để nạp danh sách môn học được phân công và thống kê số lượng câu hỏi đã duyệt (`approved`) theo từng mức Bloom.
   - Hỗ trợ lọc theo môn học hoặc tìm kiếm theo tên chủ đề.
2. **Tạo mới / Chỉnh sửa Chủ đề thi**:
   - Giảng viên nhấn *Add Topic*, nhập tên chủ đề, chọn môn học phụ trách $\rightarrow$ Gửi: `POST /api/topics` với `{ name, subject_id, course_id }`.
   - Chỉnh sửa chủ đề: Gửi `PATCH /api/topics/:id` với `{ name, subject_id }`.
3. **Xóa Chủ đề thi**:
   - Giảng viên nhấn *Delete Topic* $\rightarrow$ Modal cảnh báo hiển thị $\rightarrow$ Gửi: `DELETE /api/topics/:id`.
   - Nếu chủ đề đang có câu hỏi, tài liệu học liệu hoặc kỳ thi liên kết: Backend bắt lỗi toàn vẹn khóa ngoại CSDL và trả về HTTP 409 `RESOURCE_IN_USE`.

### 4. Luật nghiệp vụ (BR)
- **BR-F4.1**: Giảng viên chỉ được xem, tạo, sửa hoặc xóa Chủ đề thuộc môn học mà mình được phân công (kiểm tra trong `TopicService` qua `services/subjectScope.js`).
- **BR-F4.2**: Không thể xóa Chủ đề thi nếu đang có dữ liệu con phụ thuộc trong hệ thống.

### 5. Mã lỗi có thể gặp
| HTTP | Code | Nguyên nhân kỹ thuật | Thông báo hiển thị trên giao diện |
| :---: | :--- | :--- | :--- |
| **403** | `FORBIDDEN` | Môn học nằm ngoài phạm vi phân công của giảng viên | Bạn không có quyền quản lý chủ đề của môn học này. |
| **409** | `RESOURCE_IN_USE` | Chủ đề đang có câu hỏi/tài liệu/kỳ thi liên kết | Không thể xoá chủ đề này vì đang có câu hỏi, tài liệu hoặc kỳ thi liên kết. |

---

## F5: Giảng viên - Quản lý Học liệu Giảng dạy (Upload & Ingest)

### 1. Tác nhân (Actor)
- `LECTURER` (phụ trách môn) hoặc `ADMIN`.

### 2. Tiền điều kiện (Preconditions)
- Giảng viên đã được phân công môn học. Môn học đã có Chủ đề thi.

### 3. Trình tự các bước thực hiện (UI $\rightarrow$ API)
1. **Tải lên Học liệu (Upload Material)**:
   - Giảng viên vào `/lecturer/materials` $\rightarrow$ Chọn môn và chủ đề $\rightarrow$ Chọn tệp tài liệu giảng dạy (PDF, DOCX, PPTX $\le 50$ MB).
   - Frontend gửi: `POST /api/materials` dạng `multipart/form-data` (trường `file`).
   - Backend lưu tệp vào S3 `materials`, tạo bản ghi trong `course_material` với trạng thái `PROCESSING`, đồng thời đẩy tác vụ nền `INGEST_MATERIAL`.
2. **Tiến trình Ingest & Tạo Vector (Tác vụ nền `INGEST_MATERIAL`)**:
   - Trích xuất văn bản từ tệp. Nếu tệp là scan không có lớp chữ $\rightarrow$ Đánh dấu `status='FAILED'` kèm thông báo lỗi rõ ràng.
   - Phân đoạn văn bản (Chunking): Cắt đoạn ~500 từ có độ chồng lấn 50 từ, bảo toàn số trang/slide.
   - Gọi Amazon Bedrock Titan Text Embeddings V2 sinh vector 1024 chiều, lưu vào bảng `material_chunk` có chỉ mục HNSW.
   - Hoàn tất $\rightarrow$ Cập nhật `course_material` sang `READY`.
3. **Xóa Học liệu**:
   - Giảng viên bấm Xóa $\rightarrow$ Gửi: `DELETE /api/materials/:id`. Backend xóa bản ghi và các chunk liên quan.

### 4. Luật nghiệp vụ (BR)
- **BR-F5.1**: Chỉ chấp nhận tệp có định dạng PDF, DOCX, PPTX với dung lượng tối đa 50 MB.
- **BR-F5.2**: Không hỗ trợ OCR; tệp bắt buộc phải có lớp chữ số hóa.

### 5. Mã lỗi có thể gặp
| HTTP | Code | Nguyên nhân kỹ thuật | Thông báo hiển thị trên giao diện |
| :---: | :--- | :--- | :--- |
| **413** | `FILE_TOO_LARGE` | Dung lượng tệp vượt quá 50 MB | Kích thước tệp vượt quá giới hạn cho phép (tối đa 50MB). |
| **400** | `INVALID_FILE_TYPE`| Tệp không đúng định dạng hỗ trợ | Định dạng tệp không được hỗ trợ. Vui lòng chọn PDF, DOCX hoặc PPTX. |

---

## F6: Giảng viên - Ngân hàng Câu hỏi & Quản lý Rubric

### 1. Tác nhân (Actor)
- `LECTURER` (phụ trách môn) hoặc `ADMIN`.

### 2. Tiền điều kiện (Preconditions)
- Đã có môn học, chủ đề thi và học liệu sẵn sàng.

### 3. Trình tự các bước thực hiện (UI $\rightarrow$ API)
1. **Tạo Rubric Đánh giá**:
   - Vào `/lecturer/rubrics` $\rightarrow$ Nhấn *Create Rubric*.
   - Nhập tên Rubric, chọn môn học, thiết lập các tiêu chí (`rubric_criterion` kèm `order_index`), trọng số phần trăm (tổng chuẩn 100%) và các mức đánh giá (`performance_level` kèm khoảng điểm).
   - Gửi: `POST /api/rubrics`.
   - Nhân bản Rubric đã khóa: `POST /api/rubrics/:id/clone` $\rightarrow$ Sinh phiên bản mới (`version = version + 1`, `is_locked = false`).
2. **Soạn câu hỏi thủ công**:
   - Vào `/lecturer/questions` $\rightarrow$ Nhấn *Add Question*.
   - Nhập nội dung câu hỏi, chọn chủ đề (bắt buộc), chọn mức Bloom, ngôn ngữ (`vi`/`en`), đáp án tham khảo, 3–5 ý chính bắt buộc (`key_points`), mục đích đánh giá (`rationale`) và chọn Rubric liên kết (chỉ hiện rubric cùng môn với chủ đề).
   - Gửi: `POST /api/questions`.
   - Backend kiểm tra trùng lặp: Nếu trùng tuyệt đối 100% $\rightarrow$ Trả về HTTP 409 `DUPLICATE_QUESTION`. Nếu độ tương đồng vector Cosine $\ge 0.9$ $\rightarrow$ Trả về HTTP 200 kèm cảnh báo `NEAR_DUPLICATE`.
3. **Yêu cầu AI sinh câu hỏi tự động (RAG)**:
   - Tại trang Questions hoặc Materials $\rightarrow$ Nhấn *Generate by AI*.
   - Chọn chủ đề, chọn danh sách tài liệu, (tùy chọn) Rubric cùng môn sẽ gắn cho mọi câu sinh ra, cấu hình số câu (tối đa 20), phân bổ Bloom và ngôn ngữ.
   - Gửi: `POST /api/question-generation-jobs`.
   - Tác vụ nền `GENERATE_QUESTIONS` chạy ngầm: Tìm kiếm đoạn văn bản gần nhất qua vector HNSW, gọi Bedrock Nova Pro sinh câu hỏi kèm trích dẫn nguồn (`question_source_ref`). Kiểm định trích dẫn nguồn, lưu câu hỏi hợp lệ ở trạng thái `PENDING_REVIEW`.
4. **Thẩm định & Phê duyệt câu hỏi (Pending Review)**:
   - Giảng viên vào `/lecturer/questions/pending-review`.
   - Giao diện hiển thị câu hỏi AI sinh cạnh đoạn trích dẫn nguồn tài liệu.
   - Duyệt câu hỏi đơn lẻ: Gửi `POST /api/questions/:id/approve` kèm `{ rubricId }` $\rightarrow$ Chuyển `APPROVED`.
   - Từ chối câu hỏi: Gửi `POST /api/questions/:id/reject` kèm `{ reason }` $\rightarrow$ Chuyển `REJECTED`.
   - Duyệt lô hàng loạt: Gửi `POST /api/questions/approve-batch` với `{ questionIds: [...], rubricId }`.
   - Ở trang Questions, bấm Duyệt một câu chưa có rubric sẽ mở hộp thoại "Gắn rubric và duyệt" (dùng `approve-batch` cho một câu). Nút Duyệt/Từ chối/Lưu trữ chỉ hiện khi trạng thái cho phép.

### 4. Máy trạng thái Vòng đời Câu hỏi
$$\text{DRAFT} \longrightarrow \text{PENDING\_REVIEW} \longrightarrow \{\text{APPROVED} \mid \text{REJECTED}\} \longrightarrow \text{ARCHIVED}$$

### 5. Luật nghiệp vụ (BR)
- **BR-F6.1**: Chuyển trạng thái sang `APPROVED` bắt buộc phải gắn Rubric; chuyển sang `REJECTED` bắt buộc phải có lý do.
- **BR-F6.2**: Rubric đã được sử dụng trong kỳ thi đã mở (`OPEN`) sẽ bị khóa cứng `is_locked = true` và không thể chỉnh sửa.
- **BR-F6.3**: Chỉ các câu hỏi ở trạng thái `APPROVED` mới đủ điều kiện được đưa vào kỳ thi.
- **BR-F6.4**: Rubric của câu hỏi phải cùng môn với chủ đề (`RUBRIC_SUBJECT_MISMATCH`).
- **BR-F6.5**: Mỗi câu hỏi có ngôn ngữ cố định `vi`/`en`; thiếu thì tự nhận diện theo nội dung khi lưu.
- **BR-F6.6**: Thứ tự làm việc của giảng viên: Chủ đề → Tài liệu → Rubric → Câu hỏi → Chờ duyệt; Dashboard hiển thị tiến độ từng môn (`GET /api/exam-sessions/progress`) và bước cần làm tiếp.

### 6. Mã lỗi có thể gặp
| HTTP | Code | Nguyên nhân kỹ thuật | Thông báo hiển thị trên giao diện |
| :---: | :--- | :--- | :--- |
| **409** | `DUPLICATE_QUESTION` | Câu hỏi bị trùng lặp nội dung 100% | Câu hỏi này đã tồn tại trong ngân hàng câu hỏi. |
| **400** | `RUBRIC_REQUIRED` | Phê duyệt câu hỏi nhưng chưa chọn Rubric | Bắt buộc phải gắn Rubric khi phê duyệt câu hỏi. |
| **409** | `INVALID_TRANSITION` | Chuyển trạng thái vòng đời sai quy tắc | Thao tác chuyển trạng thái không hợp lệ. |
| **400** | `RUBRIC_SUBJECT_MISMATCH` | Rubric thuộc môn khác với chủ đề | Rubric thuộc môn học khác với môn của chủ đề. |

---

## F7: Giảng viên - Thiết lập Cấu hình & Lên lịch Kỳ thi

### 1. Tác nhân (Actor)
- `LECTURER` (phụ trách môn).

### 2. Tiền điều kiện (Preconditions)
- Môn học đã có Chủ đề thi chứa đủ số lượng câu hỏi đã duyệt (`APPROVED`) theo từng mức Bloom.
- Sinh viên đã được ghi danh môn học (`subject_student`) và Giảng viên đã được phân công môn học (`subject_lecturer`).

### 3. Trình tự các bước thực hiện (UI $\rightarrow$ API)
1. **Tải dữ liệu cấu hình kỳ thi (Options)**:
   - Giảng viên vào trang *Exam Sessions* (`/lecturer/exam-sessions`) $\rightarrow$ Bấm *New Exam*.
   - Frontend gửi: `GET /api/exam-sessions/options`.
   - Backend trả về cây dữ liệu theo phạm vi giảng viên: danh sách môn, chủ đề thi kèm thống kê số câu approved theo từng mức Bloom, danh sách sinh viên đã ghi danh môn và danh sách giảng viên phụ trách môn.
2. **Thiết lập Cấu hình Kỳ thi**:
   - Nhập tiêu đề, chọn môn học và chủ đề thi.
   - Cấu hình số câu chính (1–10, mặc định 3), giới hạn hỏi xoáy mỗi câu (0–5, mặc định 2), tổng giới hạn hỏi xoáy thí sinh (0–20), thời gian suy nghĩ, thời gian trả lời (mặc định 120s), khung giờ mở/đóng (`opens_at`, `closes_at`) và phân bổ Bloom.
   - Ngôn ngữ kỳ thi **không chọn**: được suy ra từ các câu đã duyệt của chủ đề và chỉ hiển thị để xem. Chủ đề chưa có câu đã duyệt hoặc trộn hai ngôn ngữ thì nút Tạo bị khóa kèm lý do.
   - Giao diện tự động đối chiếu số câu approved với cấu hình và cảnh báo sớm nếu thiếu câu.
   - Gửi: `POST /api/exam-sessions` $\rightarrow$ Kỳ thi khởi tạo ở trạng thái `DRAFT`.
3. **Chọn Danh sách Thí sinh (Roster) & Ban Giám khảo (Examiners)**:
   - Giảng viên chọn sinh viên dự thi thông qua Bảng Checkbox (dữ liệu từ `subject_student`), hỗ trợ tìm kiếm và nút "Chọn tất cả" $\rightarrow$ Gửi: `PUT /api/exam-sessions/:id/students` với `{ studentIds: [...] }`.
   - Giảng viên chọn ban giám khảo thông qua Bảng Checkbox (dữ liệu từ `subject_lecturer`) $\rightarrow$ Gửi: `PUT /api/exam-sessions/:id/examiners` với `{ lecturerIds: [...] }`.
4. **Gửi Lịch thi (Schedule Exam)**:
   - Giảng viên kiểm tra lại toàn bộ cấu hình $\rightarrow$ Bấm *Submit Schedule*.
   - Frontend gửi: `POST /api/exam-sessions/:id/schedule`.
   - Backend thẩm định: Khung giờ hợp lệ (`closes_at > opens_at` và chưa qua), chủ đề thi có đủ số lượng câu hỏi approved theo tổng số và theo từng mức Bloom $\rightarrow$ Kỳ thi chuyển sang `SCHEDULED`.
   - Nếu cần chỉnh sửa: Giảng viên bấm *Withdraw* $\rightarrow$ Gửi: `POST /api/exam-sessions/:id/unschedule` $\rightarrow$ Quay về `DRAFT`.
5. **Hướng dẫn các bước còn lại**: panel *Manage* của mỗi kỳ thi hiển thị checklist (khung giờ, thí sinh, giám khảo, gửi lịch, chờ admin mở thi, chấm bài) và in đậm bước cần làm tiếp.

### 4. Máy trạng thái Kỳ thi
$$\text{DRAFT} \underset{\text{unschedule}}{\overset{\text{schedule}}{\rightleftharpoons}} \text{SCHEDULED} \xrightarrow{\text{admin start}} \text{OPEN} \xrightarrow{\text{close}} \text{CLOSED}$$

### 5. Luật nghiệp vụ (BR)
- **BR-F7.1**: Giảng viên không có quyền trực tiếp mở kỳ thi sang `OPEN`. Kỳ thi chỉ có thể được mở bởi Quản trị viên thông qua Bảng điều phối lịch thi.
- **BR-F7.2**: Kỳ thi chỉ có thể gửi lịch (`SCHEDULED`) khi ngân hàng có đủ số câu hỏi `APPROVED` thỏa mãn cấu hình số lượng và phân bổ Bloom.
- **BR-F7.3**: Ngôn ngữ kỳ thi được tính khi tạo và tính lại khi gửi lịch và khi admin khởi động; chỉ câu hỏi đúng ngôn ngữ kỳ thi được chọn cho thí sinh và tổng hợp audio.

### 6. Mã lỗi có thể gặp
| HTTP | Code | Nguyên nhân kỹ thuật | Thông báo hiển thị trên giao diện |
| :---: | :--- | :--- | :--- |
| **409** | `NOT_ENOUGH_QUESTIONS`| Chủ đề thiếu câu approved theo Bloom | Không đủ câu hỏi đã duyệt theo mức Bloom đã cấu hình. |
| **409** | `NO_APPROVED_QUESTIONS` | Chủ đề chưa có câu đã duyệt | Chủ đề chưa có câu hỏi nào được duyệt; ngôn ngữ kỳ thi lấy từ các câu đó. |
| **409** | `MIXED_LANGUAGE_BANK` | Chủ đề có cả câu tiếng Việt và tiếng Anh đã duyệt | Mỗi kỳ thi chỉ dùng một ngôn ngữ (kèm số câu mỗi ngôn ngữ). |
| **409** | `SUBJECT_ARCHIVED` | Tạo kỳ thi cho môn đã lưu trữ | Môn học đang được lưu trữ. |
| **422** | `VALIDATION_ERROR` | Thí sinh trong danh sách chưa ghi danh môn | Danh sách thí sinh chứa sinh viên chưa được ghi danh vào môn học này. |
| **400** | `VALIDATION_ERROR` | Giờ đóng thi nhỏ hơn hoặc bằng giờ mở | Khung thời gian thi không hợp lệ. |

---

## F8: Admin - Điều phối Lịch thi & Kích hoạt Tài nguyên

### 1. Tác nhân (Actor)
- `ADMIN`.

### 2. Tiền điều kiện (Preconditions)
- Đã đăng nhập vai trò `ADMIN`. Đã có kỳ thi ở trạng thái `SCHEDULED`.

### 3. Trình tự các bước thực hiện (UI $\rightarrow$ API)
1. **Xem Bảng Điều phối Lịch thi Toàn trường**:
   - Admin truy cập menu *Exam Schedule* (`/admin/exam-schedule`).
   - Frontend gửi: `GET /api/admin/exam-schedule`.
   - Backend trả về danh sách toàn bộ kỳ thi trong trường kèm thông tin: môn học, khung giờ, người tạo, số lượng sinh viên, trạng thái và cờ làm nóng `warm_status`. Hỗ trợ bộ lọc theo môn học, trạng thái và khoảng ngày.
2. **Khởi động Kỳ thi (Start Exam Session)**:
   - Admin tìm kỳ thi đang ở trạng thái `SCHEDULED` $\rightarrow$ Nhấn nút **Khởi động (Start)**.
   - Frontend gửi: `POST /api/admin/exam-sessions/:id/start`.
   - Backend thực thi tuần tự:
     * Trong một transaction: Chuyển trạng thái sang `OPEN`, ghi nhận `started_at`, `started_by`, khóa cứng toàn bộ Rubric liên quan.
     * Chạy bất đồng bộ song song không chặn yêu cầu: Làm nóng (Warm-up) Lambda STT và Lambda TTS theo ngôn ngữ thi; Đẩy tác vụ nền `PREPARE_EXAM_AUDIO` tổng hợp trước toàn bộ câu hỏi đã duyệt vào S3 Cache; Đẩy tác vụ nền `KEEP_WARM` duy trì đánh thức Lambda định kỳ mỗi 5 phút cho đến giờ đóng thi.
   - Giao diện hiển thị tiến độ làm nóng và chuẩn bị âm thanh đạt 100%.
2b. **Tạo / xóa kỳ thi (Admin)**:
   - *New exam*: chọn môn (không hiện môn lưu trữ), chủ đề, tiêu đề, khung giờ, số câu chính $\rightarrow$ `POST /api/admin/exam-sessions`. Kỳ thi ở `DRAFT`; giảng viên của môn hoàn thiện thí sinh, giám khảo rồi gửi lịch. Sửa: `PUT /api/admin/exam-sessions/:id`.
   - *Delete*: chỉ kỳ thi `DRAFT`/`SCHEDULED` chưa có lượt thi $\rightarrow$ `DELETE /api/admin/exam-sessions/:id`; ngược lại `409 SESSION_IN_USE`.
3. **Làm nóng lại Tài nguyên (Re-warm)**:
   - Nếu badge làm nóng báo lỗi do sự cố mạng đám mây: Admin nhấn **Làm nóng lại (Re-warm)** $\rightarrow$ Gửi: `POST /api/admin/exam-sessions/:id/warm`. Kỳ thi vẫn giữ nguyên trạng thái `OPEN`.
4. **Đóng Kỳ thi**:
   - Khi hết thời gian thi hoặc theo lệnh khẩn cấp: Admin hoặc Giảng viên nhấn **Đóng kỳ thi (Close)** $\rightarrow$ Gửi: `POST /api/admin/exam-sessions/:id/close` (hoặc `POST /api/exam-sessions/:id/close`).
   - Backend chuyển kỳ thi sang `CLOSED` và, nếu đóng trước giờ, kéo `closes_at` về thời điểm đóng. Sinh viên không thể bắt đầu phiên mới; chuỗi `KEEP_WARM` tự dừng ở lần chạy kế tiếp. Phiên thi đang làm dở vẫn tiếp tục tới `deadline_at` đã lưu và được `EXPIRE_INTERVIEWS` đóng nếu bị bỏ dở.

### 4. Luật nghiệp vụ (BR)
- **BR-F8.1**: Chỉ Quản trị viên mới có quyền khởi động kỳ thi sang `OPEN`.
- **BR-F8.2**: Khi kỳ thi chuyển sang `OPEN`, toàn bộ Rubric liên quan lập tức bị khóa cứng (`is_locked = true`).
- **BR-F8.3**: Kỳ thi đã có người thi (hoặc đã `OPEN`/`CLOSED`) không được xóa, để giữ lịch sử và kết quả.
- **BR-F8.4**: Khởi động, đóng, làm nóng lại, tạo, sửa và xóa kỳ thi của Admin đều được ghi vào `admin_audit_log`.

---

## F9: Sinh viên - Thi Vấn đáp Giọng nói Trực tiếp với AI

### 1. Tác nhân (Actor)
- `STUDENT`.

### 2. Tiền điều kiện (Preconditions)
- Sinh viên có tên trong danh sách thi (`exam_session_student`).
- Kỳ thi đang ở trạng thái `OPEN` và thời gian hiện tại nằm trong khung giờ `[opens_at, closes_at]`.

### 3. Trình tự các bước thực hiện (UI $\rightarrow$ API)
1. **Kiểm tra Danh sách Kỳ thi của Sinh viên**:
   - Sinh viên đăng nhập vào `/student/dashboard`.
   - Frontend gửi: `GET /api/me/exam-sessions`.
   - Backend trả về danh sách các kỳ thi của sinh viên kèm các cờ điều kiện: `canStart` (kỳ thi `OPEN` và trong giờ thi) hoặc `canResume` (phiên thi đang dang dở).
2. **Kiểm tra Thiết bị Âm thanh trước khi Thi (Device Check)**:
   - Sinh viên bấm *Bắt đầu thi* (hoặc *Tiếp tục thi*) $\rightarrow$ Dashboard mở hộp thoại `DeviceCheckModal`, **chưa** gọi API nào. Đồng hồ thi chưa chạy (khi thi tiếp, hộp thoại báo đồng hồ đã chạy và nhắc kiểm tra nhanh).
   - Trình duyệt thiếu https, `getUserMedia`, `MediaRecorder` hoặc `AudioContext` $\rightarrow$ báo lỗi, chỉ có nút *Hủy*.
   - **Micro**: hộp thoại xin quyền micro ngay khi mở; lỗi được giải thích theo loại (bị chặn quyền, không có micro, micro đang bị ứng dụng khác dùng). Sinh viên có thể chọn micro khác (nhớ ở `localStorage`) và ghi thử 3 giây để nghe lại. Đạt khi thanh mức âm ghi nhận đủ 600 ms tiếng nói.
   - **Loa/tai nghe**: sinh viên bấm phát âm thanh thử và xác nhận *Tôi nghe rõ*; chọn *Tôi không nghe thấy* thì hiển thị hướng dẫn xử lý.
   - Cả hai bước đạt $\rightarrow$ nút *Bắt đầu thi* / *Tiếp tục bài thi* mới bật. Bấm nút: Frontend tạo/khôi phục phiên (bước 3), ghi nhận "đã kiểm tra" cho bài thi đó trong `sessionStorage` của tab, rồi điều hướng tới `/student/viva?interviewId=<id>`. Tạo phiên lỗi thì đóng hộp thoại và hiển thị lỗi trên Dashboard.
   - Trong phòng thi: nếu tab đã qua kiểm tra cho bài thi này, phòng thi gửi `interview:ready` ngay sau `interview:join`; nếu không (mở bằng liên kết trực tiếp, tab khác) thì hiển thị bước kiểm tra micro tại chỗ trước khi bắt đầu. Micro được mở theo thiết bị đã chọn, mất thiết bị thì dùng micro mặc định.
3. **Khởi tạo / Khôi phục Phiên thi**:
   - Frontend gửi: `POST /api/interviews` với `{ examSessionId }`.
   - Backend khởi tạo phiên thi `viva_interview` trạng thái `IN_PROGRESS`, áp dụng thuật toán `pickBalancedQuestions` phân bổ bộ câu hỏi chính cân bằng Bloom, khởi tạo ngữ cảnh tại DynamoDB và kích hoạt kết nối Socket.IO tại namespace `/interview`.
4. **Chu trình Hỏi - Đáp Thời gian thực theo Lượt (QA Turn)**:
   - **Bước 4.1**: Máy chủ phát sự kiện `question:new` kèm nội dung câu hỏi dạng chữ và đường dẫn file âm thanh TTS (đã chuẩn bị sẵn trên S3).
   - **Bước 4.2**: Trình duyệt phát âm thanh câu hỏi $\rightarrow$ Phát xong gửi `question:played` về server.
   - **Bước 4.3**: Máy chủ tính và lưu hạn trả lời của lượt (`answer_deadline_at` = lúc phát xong + `think_time_sec` + `answer_time_limit_sec`, không vượt `deadline_at` của phiên). Trình duyệt đếm ngược thời gian suy nghĩ rồi mở micro và đếm ngược thời gian trả lời.
   - **Bước 4.4**: Trong lúc sinh viên nói, `MediaRecorder` ghi âm (`audio/webm;codecs=opus` khi được hỗ trợ) và gửi qua Socket.IO theo từng gói 1 giây (`answer:start`, `audio:chunk`). Máy chủ gom các gói trong bộ nhớ.
   - **Bước 4.5**: Sinh viên bấm nộp câu trả lời hoặc hết giờ trả lời: trình duyệt gửi `answer:end` sau gói cuối. Máy chủ lưu audio câu trả lời lên S3, gọi Lambda STT cho toàn bộ câu trả lời, tính các tín hiệu phụ (độ trễ, thời lượng nói, WPM, số lần ngập ngừng). Audio rỗng/hỏng được nói lại 1 lần; STT lỗi sau hai lần gọi trả `turn:retry` và giữ nguyên câu hiện tại.
   - **Bước 4.6 (Quyết định của AI)**: Máy chủ gọi Bedrock Nova Pro phân tích câu trả lời đối chiếu với các ý chính:
     * Nếu câu trả lời thiếu ý, mơ hồ hoặc mâu thuẫn VÀ chưa vượt hạn mức hỏi xoáy $\rightarrow$ AI sinh câu hỏi hỏi xoáy thích ứng (dưới 40 từ), gọi Lambda TTS tổng hợp giọng nói và phát `question:new` (câu xoáy).
     * Ngược lại $\rightarrow$ Chuyển sang câu hỏi chính tiếp theo.
5. **Kết thúc Bài thi**:
   - Khi trả lời hết bộ câu hỏi chính hoặc hết thời gian tổng của phiên thi $\rightarrow$ Phiên thi chuyển sang `COMPLETED`, giao diện hiển thị thông báo nộp bài thành công và kích hoạt tác vụ nền chấm điểm `GRADE_INTERVIEW`.
6. **Khôi phục Phiên thi khi Gặp Sự cố Mạng / F5**:
   - Nếu sinh viên bị rớt mạng hoặc tải lại trang: Sinh viên vào lại phòng thi $\rightarrow$ Hệ thống khôi phục trạng thái từ DynamoDB và PostgreSQL, đưa thí sinh quay lại đúng câu hỏi và lượt đang dở với thời gian làm bài còn lại chính xác.
7. **Tự động Quét Quá hạn (Auto-sweep)**:
   - Tác vụ nền `EXPIRE_INTERVIEWS` định kỳ mỗi 60 giây quét các phiên thi quá hạn chót (`deadline_at + 30s`), tự động đóng phiên với lý do `DEADLINE_REACHED` và đẩy vào hàng đợi chấm điểm.

### 4. Luật nghiệp vụ (BR)
- **BR-F9.1**: Tuyệt đối không hiển thị transcript cho thí sinh trong lúc thi và không cho phép ghi âm lại câu trả lời, trừ khi hệ thống lỗi (audio rỗng/hỏng hoặc STT lỗi).
- **BR-F9.4**: Ngôn ngữ kỳ thi (`VI`/`EN`) quyết định model STT, giọng TTS và ngôn ngữ của câu hỏi phụ; ngôn ngữ giao diện của sinh viên không ảnh hưởng.
- **BR-F9.2**: Câu hỏi hỏi xoáy của AI bắt buộc phải dưới 40 từ, đúng trọng tâm và tuyệt đối không tiết lộ đáp án.
- **BR-F9.3**: Sinh viên F5 không được cộng thêm thời gian làm bài.

---

## F10: Chấm điểm Gợi ý AI, Thẩm định & Tra cứu Kết quả

### 1. Tác nhân (Actor)
- `AI System`, `LECTURER` (Giám khảo chấm thi), `ADMIN`, `STUDENT`.

### 2. Tiền điều kiện (Preconditions)
- Phiên thi của sinh viên đã kết thúc (`COMPLETED`, với `end_reason` là `QUESTIONS_EXHAUSTED` hoặc `DEADLINE_REACHED`).

### 3. Trình tự các bước thực hiện (UI $\rightarrow$ API)
1. **AI Chấm điểm Tự động (Tác vụ nền `GRADE_INTERVIEW`)**:
   - Tác vụ nền khởi chạy ngay khi phiên thi kết thúc.
   - LLM Bedrock Nova Pro phân tích toàn văn transcript đối chiếu với Rubric đã khóa của kỳ thi: Xác định mức độ hoàn thành (`performance_level`), chấm điểm từng tiêu chí, trích xuất bằng chứng xác thực (`evidence` trích nguyên văn lời thí sinh), nêu rõ điểm mạnh, điểm yếu và ý còn thiếu.
   - Điểm tổng kết được quy đổi chính xác theo thang điểm 10.
   - **Câu không có câu trả lời** (mọi lượt của câu chính và câu hỏi phụ đều rỗng, chỉ có dấu câu, nhãn STT như `[silence]` hoặc âm ngập ngừng như "ờ", "ừm", "uh"; hoặc câu chưa được hỏi trước khi hết giờ): chấm 0 điểm cho câu và mọi tiêu chí **mà không gọi LLM**, ghi `model_id = rule:no-answer`, `confidence = 1`, ý còn thiếu là toàn bộ ý chính, nhận xét theo ngôn ngữ kỳ thi. Câu này vẫn tính 0 vào điểm trung bình. Chỉ cần một lượt có nội dung thì câu được gửi cho LLM.
   - Prompt chấm điểm yêu cầu LLM chỉ chấm những gì thí sinh thực sự nói (không cho điểm nội dung chỉ có trong đáp án mẫu hay ý chính) và chọn mức thấp nhất cho mọi tiêu chí khi câu trả lời không liên quan (ví dụ "em không biết", nói lạc đề).
   - Nếu AI lỗi/sai schema, có lượt `FAILED`, hoặc một câu có độ tin cậy thấp ($< 0.6$) hay thiếu tiêu chí $\rightarrow$ Gán cờ `FLAGGED` kèm `flag_reason` để giám khảo rà soát kỹ. Nếu thành công $\rightarrow$ Gán `AI_SUGGESTED`.
2. **Giám khảo Thẩm định & Chốt điểm (`EvaluationReview.jsx`)**:
   - Giảng viên truy cập danh sách kết quả kỳ thi: `GET /api/exam-sessions/:id/results`.
   - Mở chi tiết bài thi: `GET /api/results/:id`.
   - Giám khảo nghe lại tệp âm thanh câu trả lời của từng lượt (`GET /api/turns/:id/audio`), xem lời giải thích vì sao AI hỏi câu hỏi đó, xem minh chứng AI trích xuất.
   - Điều chỉnh điểm tiêu chí: Gửi `PUT /api/criterion-scores/:id` kèm `{ score, reason }`. Hệ thống ghi nhận lịch sử vào bảng `score_adjustment`.
   - Chốt điểm chính thức: Giám khảo bấm *Finalize* $\rightarrow$ Gửi: `POST /api/results/:id/finalize` $\rightarrow$ Chuyển trạng thái sang `FINALIZED`.
   - Mở lại thẩm định (chỉ từ `FINALIZED`): Gửi `POST /api/results/:id/reopen` $\rightarrow$ Quay về `FLAGGED` nếu còn câu bị cờ, ngược lại `AI_SUGGESTED`.
   - Chấm lại bằng AI: Gửi `POST /api/results/:id/regrade` $\rightarrow$ Chuyển sang `AI_SCORING` và đẩy lại `GRADE_INTERVIEW`.
3. **Sinh viên Tra cứu Kết quả Thi Chính thức**:
   - Sinh viên đăng nhập vào `/student/results`.
   - Frontend gửi: `GET /api/me/results`. Backend trả về danh sách các bài thi đã được chốt điểm (`FINALIZED`) của chính sinh viên đó.
   - Sinh viên bấm xem chi tiết bài thi: `GET /api/me/results/:id`.
   - Backend thẩm định: Nếu bài thi chưa `FINALIZED` hoặc thuộc về sinh viên khác $\rightarrow$ Trả về HTTP `404 NOT_FOUND`.
   - Nếu hợp lệ: Dữ liệu trả về được lọc qua allowlist nghiêm ngặt tại `studentResultView.js` (gồm điểm tổng kết, điểm từng câu, điểm từng tiêu chí Rubric; tuyệt đối không chứa rationale, prompt, evidence hay feedback nội bộ). Sinh viên xem bảng điểm minh bạch tại `/student/results/:id`.

### 4. Luật nghiệp vụ (BR)
- **BR-F10.1 (Examiner Guard)**: Chỉ có `ADMIN`, người tạo kỳ thi (`created_by`), hoặc giám khảo có tên trong `exam_session_examiner` mới có quyền ghi (chỉnh điểm, finalize, reopen, regrade). Giảng viên khác cùng bộ môn chỉ có quyền xem (Read-only).
- **BR-F10.2 (Score Adjustment Audit)**: Mọi thao tác thay đổi điểm số bắt buộc phải ghi rõ lý do (`reason`) và được lưu vết lịch sử vĩnh viễn.
- **BR-F10.3 (No-answer Rule)**: Câu không có câu trả lời luôn được 0 điểm theo luật, không phụ thuộc LLM; giám khảo vẫn có thể điều chỉnh điểm như mọi câu khác (có lý do).
- **BR-F10.4 (Trang lỗi)**: Mở chi tiết kết quả gặp lỗi API thì hiển thị trang lỗi theo mã HTTP (404 khi không tồn tại hoặc sinh viên mở kết quả chưa chốt, 403 khi ngoài phạm vi, 5xx/409 có nút *Thử lại*). Lỗi trong lúc màn hình thẩm định tự làm mới định kỳ không xóa dữ liệu đang hiển thị.
- **BR-F10.3 (Student Privacy & Isolation)**: Sinh viên chỉ được xem kết quả khi bài thi đã ở trạng thái `FINALIZED`. Khi bài thi bị mở lại (`reopen`), kết quả lập tức bị ẩn khỏi sinh viên.

---

## PHỤ LỤC A: MA TRẬN PHÂN QUYỀN ROLE × ENDPOINT TOÀN HỆ THỐNG

Bảng ma trận quy định chi tiết quyền truy cập của từng vai trò (`ADMIN`, `LECTURER`, `STUDENT`, `PUBLIC`) đối với toàn bộ các route của hệ thống:

| Phương thức & Tuyến đường API | Tiền tố Router | ADMIN | LECTURER | STUDENT | PUBLIC | Ghi chú Ràng buộc & Phạm vi |
| :--- | :--- | :---: | :---: | :---: | :---: | :--- |
| `POST /api/auth/login` | `/api/auth` | ✅ | ✅ | ✅ | ✅ | Xác thực Email/Code + Password |
| `POST /api/auth/logout` | `/api/auth` | ✅ | ✅ | ✅ | ❌ | Thu hồi phiên làm việc (Origin Guard) |
| `POST /api/auth/refresh` | `/api/auth` | ✅ | ✅ | ✅ | ✅ | Xoay vòng Refresh Token Cookie |
| `GET /api/auth/me` | `/api/auth` | ✅ | ✅ | ✅ | ❌ | Lấy thông tin phiên đăng nhập hiện tại |
| `POST /api/auth/forgot-password` | `/api/auth` | ✅ | ✅ | ✅ | ✅ | Gửi link reset (Enumeration-safe) |
| `POST /api/auth/reset-password` | `/api/auth` | ✅ | ✅ | ✅ | ✅ | Đặt lại mật khẩu qua token |
| `POST /api/auth/set-password` | `/api/auth` | ✅ | ✅ | ✅ | ✅ | Thiết lập mật khẩu lần đầu qua token |
| `PUT /api/auth/password` | `/api/auth` | ✅ | ✅ | ✅ | ❌ | Đổi mật khẩu trong phiên (Thu hồi các phiên khác) |
| `GET /api/admin/users` | `/api/admin` | ✅ | ❌ | ❌ | ❌ | Danh sách tài khoản; có `q`/`role`/`status`/`subjectId`/`page` thì tìm kiếm và phân trang phía máy chủ |
| `GET /api/admin/users/:id/assignments` | `/api/admin` | ✅ | ❌ | ❌ | ❌ | Môn đang dạy/ghi danh, kỳ thi làm giám khảo/thí sinh |
| `POST /api/admin/users` | `/api/admin` | ✅ | ❌ | ❌ | ❌ | Thêm người dùng theo vai trò (`STUDENT` cần mã) |
| `POST /api/admin/users/import` | `/api/admin` | ✅ | ❌ | ❌ | ❌ | Import sinh viên Excel All-or-Nothing |
| `PUT /api/admin/users/:id` | `/api/admin` | ✅ | ❌ | ❌ | ❌ | Cập nhật thông tin, đổi vai trò (có chặn tự sửa / admin cuối / đang trong kỳ thi) |
| `DELETE /api/admin/users/:id` | `/api/admin` | ✅ | ❌ | ❌ | ❌ | Xóa mềm (`DELETED`), thu hồi link và phiên |
| `POST /api/admin/users/:id/lock` | `/api/admin` | ✅ | ❌ | ❌ | ❌ | Khóa tài khoản người dùng |
| `POST /api/admin/users/:id/unlock` | `/api/admin` | ✅ | ❌ | ❌ | ❌ | Mở khóa tài khoản người dùng |
| `POST /api/admin/users/:id/resend-setup` | `/api/admin` | ✅ | ❌ | ❌ | ❌ | Gửi lại email kích hoạt |
| `GET /api/admin/subjects` | `/api/admin` | ✅ | ❌ | ❌ | ❌ | Danh sách môn học |
| `POST /api/admin/subjects` | `/api/admin` | ✅ | ❌ | ❌ | ❌ | Tạo môn học mới |
| `PUT /api/admin/subjects/:id` | `/api/admin` | ✅ | ❌ | ❌ | ❌ | Cập nhật môn học |
| `DELETE /api/admin/subjects/:id` | `/api/admin` | ✅ | ❌ | ❌ | ❌ | Xóa môn học chưa có dữ liệu (`SUBJECT_IN_USE`) |
| `POST /api/admin/subjects/:id/archive` | `/api/admin` | ✅ | ❌ | ❌ | ❌ | Lưu trữ môn học |
| `POST /api/admin/subjects/:id/unarchive` | `/api/admin` | ✅ | ❌ | ❌ | ❌ | Bỏ lưu trữ môn học |
| `GET /api/admin/subjects/:id/lecturers` | `/api/admin` | ✅ | ❌ | ❌ | ❌ | Giảng viên đang được phân công |
| `PUT /api/admin/subjects/:id/lecturers`| `/api/admin` | ✅ | ❌ | ❌ | ❌ | Gán giảng viên vào môn (`subject_lecturer`) |
| `GET /api/admin/subjects/:id/students` | `/api/admin` | ✅ | ❌ | ❌ | ❌ | Xem danh sách sinh viên ghi danh môn |
| `PUT /api/admin/subjects/:id/students` | `/api/admin` | ✅ | ❌ | ❌ | ❌ | Ghi danh sinh viên vào môn (`subject_student`) |
| `GET /api/admin/exam-schedule` | `/api/admin` | ✅ | ❌ | ❌ | ❌ | Bảng điều phối lịch thi toàn trường |
| `POST /api/admin/exam-sessions` | `/api/admin` | ✅ | ❌ | ❌ | ❌ | Admin tạo kỳ thi (`DRAFT`) |
| `PUT /api/admin/exam-sessions/:id` | `/api/admin` | ✅ | ❌ | ❌ | ❌ | Admin sửa kỳ thi `DRAFT` |
| `DELETE /api/admin/exam-sessions/:id` | `/api/admin` | ✅ | ❌ | ❌ | ❌ | Xóa kỳ thi chưa có lượt thi (`SESSION_IN_USE`) |
| `GET /api/admin/audit-log` | `/api/admin` | ✅ | ❌ | ❌ | ❌ | Nhật ký thao tác Admin (chỉ id), lọc + phân trang |
| `POST /api/admin/exam-sessions/:id/start` | `/api/admin` | ✅ | ❌ | ❌ | ❌ | Khởi động kỳ thi (`SCHEDULED` $\rightarrow$ `OPEN`) |
| `POST /api/admin/exam-sessions/:id/close` | `/api/admin` | ✅ | ❌ | ❌ | ❌ | Đóng kỳ thi (`OPEN` $\rightarrow$ `CLOSED`) |
| `POST /api/admin/exam-sessions/:id/warm` | `/api/admin` | ✅ | ❌ | ❌ | ❌ | Làm nóng lại tài nguyên Lambda |
| `GET /api/topics` | `/api/topics` | ✅ | ✅ | ❌ | ❌ | Danh sách chủ đề thi (Subject Scoping) |
| `POST /api/topics` | `/api/topics` | ✅ | ✅ | ❌ | ❌ | Tạo chủ đề thi mới (Subject Scoping) |
| `GET /api/topics/:id` | `/api/topics` | ✅ | ✅ | ❌ | ❌ | Chi tiết chủ đề thi |
| `PATCH /api/topics/:id` | `/api/topics` | ✅ | ✅ | ❌ | ❌ | Cập nhật chủ đề thi |
| `DELETE /api/topics/:id` | `/api/topics` | ✅ | ✅ | ❌ | ❌ | Xóa chủ đề thi (Bắt lỗi FK 409) |
| `POST /api/materials` | `/api/materials` | ✅ | ✅ | ❌ | ❌ | Upload học liệu PDF/DOCX/PPTX $\le 50$ MB |
| `GET /api/materials` | `/api/materials` | ✅ | ✅ | ❌ | ❌ | Danh sách học liệu theo môn |
| `DELETE /api/materials/:id` | `/api/materials` | ✅ | ✅ | ❌ | ❌ | Xóa học liệu |
| `POST /api/question-generation-jobs` | `/api/question-generation-jobs` | ✅ | ✅ | ❌ | ❌ | Yêu cầu AI sinh câu hỏi RAG |
| `GET /api/question-generation-jobs/:id` | `/api/question-generation-jobs` | ✅ | ✅ | ❌ | ❌ | Xem tiến độ tác vụ AI sinh câu hỏi |
| `GET /api/questions` | `/api/questions` | ✅ | ✅ | ❌ | ❌ | Ngân hàng câu hỏi (Subject Scoping) |
| `POST /api/questions` | `/api/questions` | ❌ | ✅ | ❌ | ❌ | Tạo câu hỏi mới (Chặn trùng lặp) |
| `GET /api/questions/:id` | `/api/questions` | ✅ | ✅ | ❌ | ❌ | Chi tiết câu hỏi |
| `PUT /api/questions/:id` | `/api/questions` | ❌ | ✅ | ❌ | ❌ | Cập nhật câu hỏi |
| `DELETE /api/questions/:id` | `/api/questions` | ❌ | ✅ | ❌ | ❌ | Xóa câu hỏi |
| `POST /api/questions/:id/approve` | `/api/questions` | ❌ | ✅ | ❌ | ❌ | Phê duyệt câu hỏi (Bắt buộc Rubric) |
| `POST /api/questions/:id/reject` | `/api/questions` | ❌ | ✅ | ❌ | ❌ | Từ chối câu hỏi (Bắt buộc lý do) |
| `POST /api/questions/:id/archive` | `/api/questions` | ❌ | ✅ | ❌ | ❌ | Lưu trữ câu hỏi |
| `POST /api/questions/approve-batch` | `/api/questions` | ❌ | ✅ | ❌ | ❌ | Phê duyệt hàng loạt câu hỏi |
| `POST /api/questions/import` | `/api/questions` | ❌ | ✅ | ❌ | ❌ | Import câu hỏi từ Excel All-or-Nothing |
| `GET /api/rubrics` | `/api/rubrics` | ✅ | ✅ | ❌ | ❌ | Danh sách Rubric theo môn |
| `POST /api/rubrics` | `/api/rubrics` | ❌ | ✅ | ❌ | ❌ | Tạo Rubric đánh giá mới |
| `GET /api/rubrics/:id` | `/api/rubrics` | ✅ | ✅ | ❌ | ❌ | Chi tiết Rubric |
| `PUT /api/rubrics/:id` | `/api/rubrics` | ❌ | ✅ | ❌ | ❌ | Cập nhật Rubric (Chặn nếu đã khóa) |
| `DELETE /api/rubrics/:id` | `/api/rubrics` | ❌ | ✅ | ❌ | ❌ | Xóa Rubric |
| `POST /api/rubrics/:id/clone` | `/api/rubrics` | ❌ | ✅ | ❌ | ❌ | Nhân bản Rubric đã khóa thành bản mới |
| `GET /api/exam-sessions` | `/api/exam-sessions` | ❌ | ✅ | ❌ | ❌ | Danh sách kỳ thi theo phạm vi giảng viên |
| `POST /api/exam-sessions` | `/api/exam-sessions` | ❌ | ✅ | ❌ | ❌ | Tạo kỳ thi mới (`DRAFT`) |
| `GET /api/exam-sessions/options` | `/api/exam-sessions` | ❌ | ✅ | ❌ | ❌ | Dữ liệu cấu hình (Môn ACTIVE, Topic Bloom + ngôn ngữ bộ câu hỏi, SV, GV) |
| `GET /api/exam-sessions/progress` | `/api/exam-sessions` | ❌ | ✅ | ❌ | ❌ | Tiến độ 7 bước theo từng môn cho Dashboard |
| `GET /api/exam-sessions/:id` | `/api/exam-sessions` | ❌ | ✅ | ❌ | ❌ | Chi tiết kỳ thi |
| `PUT /api/exam-sessions/:id` | `/api/exam-sessions` | ❌ | ✅ | ❌ | ❌ | Cập nhật cấu hình kỳ thi |
| `PUT /api/exam-sessions/:id/students` | `/api/exam-sessions` | ❌ | ✅ | ❌ | ❌ | Gán Roster thí sinh (Bắt buộc theo môn) |
| `PUT /api/exam-sessions/:id/examiners`| `/api/exam-sessions` | ❌ | ✅ | ❌ | ❌ | Gán ban giám khảo (Bắt buộc theo môn) |
| `POST /api/exam-sessions/:id/schedule` | `/api/exam-sessions` | ❌ | ✅ | ❌ | ❌ | Gửi lịch thi (`DRAFT` $\rightarrow$ `SCHEDULED`) |
| `POST /api/exam-sessions/:id/unschedule`| `/api/exam-sessions`| ❌ | ✅ | ❌ | ❌ | Rút lịch thi (`SCHEDULED` $\rightarrow$ `DRAFT`) |
| `POST /api/exam-sessions/:id/close` | `/api/exam-sessions` | ❌ | ✅ | ❌ | ❌ | Giảng viên đóng kỳ thi |
| `GET /api/me/exam-sessions` | `/api/me` | ❌ | ❌ | ✅ | ❌ | Danh sách kỳ thi của sinh viên đang đăng nhập |
| `GET /api/me/results` | `/api/me` | ❌ | ❌ | ✅ | ❌ | Danh sách kết quả `FINALIZED` của sinh viên |
| `GET /api/me/results/:id` | `/api/me` | ❌ | ❌ | ✅ | ❌ | Chi tiết điểm `FINALIZED` (Student Safe Masking) |
| `POST /api/interviews` | `/api/interviews` | ❌ | ❌ | ✅ | ❌ | Bắt đầu hoặc tiếp tục phiên thi vấn đáp |
| `GET /api/interviews/:id` | `/api/interviews` | ❌ | ❌ | ✅ | ❌ | Trạng thái hiện tại của phiên thi |
| `POST /api/interviews/:id/turns/:turnId/played` | `/api/interviews` | ❌ | ❌ | ✅ | ❌ | Báo cáo đã phát xong âm thanh câu hỏi |
| `POST /api/interviews/:id/turns/:turnId/answer` | `/api/interviews` | ❌ | ❌ | ✅ | ❌ | Nộp câu trả lời âm thanh của lượt |
| `GET /api/exam-sessions/:id/results` | `/api` | ✅ | ✅ | ❌ | ❌ | Danh sách kết quả thi (Cờ `canGrade`) |
| `GET /api/results/:id` | `/api` | ✅ | ✅ | ❌ | ❌ | Chi tiết bài chấm thẩm định |
| `PUT /api/criterion-scores/:id` | `/api` | ✅ | 🔑 | ❌ | ❌ | Chỉnh sửa điểm (Chỉ Giám khảo phân công) |
| `POST /api/results/:id/finalize` | `/api` | ✅ | 🔑 | ❌ | ❌ | Chốt điểm chính thức (Chỉ Giám khảo phân công) |
| `POST /api/results/:id/reopen` | `/api` | ✅ | 🔑 | ❌ | ❌ | Mở lại bài thi đã chốt (Chỉ Giám khảo phân công)|
| `POST /api/results/:id/regrade` | `/api` | ✅ | 🔑 | ❌ | ❌ | Yêu cầu AI chấm lại (Chỉ Giám khảo phân công) |
| `GET /api/turns/:id/audio` | `/api` | ✅ | ✅ | ❌ | ❌ | Nghe lại audio câu trả lời của thí sinh (giảng viên phải thuộc môn học của kỳ thi) |
| `GET /api/tts/:filename` | `/api/tts` | ✅ | ✅ | ✅ | ❌ | Phát âm thanh câu hỏi (Regex an toàn Path) |

*Ghi chú ký hiệu*:
- ✅: Được phép truy cập.
- ❌: Bị từ chối truy cập (HTTP 401 hoặc 403).
- 🔑: Chỉ Giám khảo có tên trong `exam_session_examiner` hoặc người tạo kỳ thi (`created_by`) mới có quyền thực hiện.

---

## PHỤ LỤC B: BẢNG MÃ LỖI CHUẨN HÓA TOÀN HỆ THỐNG

Toàn bộ các mã lỗi trả về trong thuộc tính `code` của JSON response lỗi HTTP $\ge 400$:

| Mã lỗi (`code`) | HTTP Status | Nguyên nhân nghiệp vụ & Kỹ thuật |
| :--- | :---: | :--- |
| `UNAUTHORIZED` | **401** | Không có phiên làm việc, thiếu hoặc token JWT không hợp lệ/hết hạn. |
| `INVALID_CREDENTIALS` | **401** | Tên đăng nhập (Email/Code) hoặc mật khẩu không chính xác. |
| `FORBIDDEN` | **403** | Người dùng không đủ quyền truy cập tài nguyên (Sai vai trò hoặc ngoài phạm vi môn học). |
| `FORBIDDEN_ORIGIN` | **403** | Vi phạm chính sách bảo mật CSRF (Thiếu hoặc sai header Origin). |
| `ACCOUNT_LOCKED` / `LOCKED` | **423** | Tài khoản bị khóa tạm thời 15 phút do nhập sai mật khẩu quá 5 lần liên tiếp. |
| `NOT_FOUND` | **404** | Tài nguyên không tồn tại, hoặc bài thi của sinh viên chưa ở trạng thái `FINALIZED`. |
| `INVALID_TOKEN` | **400** | Token kích hoạt hoặc đặt lại mật khẩu không hợp lệ, sai loại hoặc đã dùng. |
| `INVALID_FILENAME` | **400** | Tên tệp âm thanh TTS chứa ký tự cấm hoặc vi phạm biểu thức an toàn (chống Path Traversal). |
| `RUBRIC_REQUIRED` | **400** | Phê duyệt câu hỏi nhưng không gắn kèm Rubric đánh giá. |
| `VALIDATION_ERROR` | **400 / 422** | Dữ liệu đầu vào không hợp lệ, vi phạm Schema hoặc lỗi từng dòng khi import Excel. |
| `FILE_TOO_LARGE` | **413** | Tệp tải lên vượt quá dung lượng cho phép tối đa 50 MB. |
| `DUPLICATE_QUESTION` | **409** | Nội dung câu hỏi trùng khớp 100% với câu hỏi đã có trong ngân hàng sau khi chuẩn hóa. |
| `EMAIL_TAKEN` | **409** | Địa chỉ Email đã được sử dụng bởi một tài khoản khác. |
| `CODE_TAKEN` | **409** | Mã người dùng (`code`) đã tồn tại trong hệ thống. |
| `SUBJECT_CODE_TAKEN` | **409** | Mã môn học đã tồn tại trong danh mục môn học. |
| `RESOURCE_IN_USE` | **409** | Không thể xóa tài nguyên (Chủ đề, Rubric, Môn học) do đang có dữ liệu con liên kết. |
| `INVALID_TRANSITION` | **409** | Thao tác chuyển đổi trạng thái vòng đời không hợp lệ theo máy trạng thái quy định. |
| `NOT_ENOUGH_QUESTIONS` | **409** | Số lượng câu hỏi đã duyệt trong chủ đề không đủ để đáp ứng cấu hình kỳ thi theo mức Bloom. |
| `STUDENT_VIEW_LEAK` | **500** | Lỗi bảo mật nội bộ: Phát hiện trường dữ liệu nhạy cảm bị rò rỉ trong View của sinh viên. |
| `INTERNAL_SERVER_ERROR` | **500** | Lỗi xử lý ngoại lệ nội bộ không mong muốn phía máy chủ. |

**Hiển thị lỗi trên giao diện**: trang nhận `code` để chọn thông báo (`i18n/core.js` `errorMessage`). Khi lỗi làm cả trang không dùng được, SPA hiển thị trang lỗi chung theo mã HTTP (`shared/components/ErrorPage`: 400, 401, 403, 404, 409, 500, 503; 502/504 dùng trang 503). Đường dẫn không tồn tại là 404; mở khu vực của vai trò khác là 403 trong khung ứng dụng của người dùng; lỗi render của một trang được `ErrorBoundary` bắt thành trang 500 có nút *Thử lại*.
