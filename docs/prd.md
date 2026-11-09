# AIVES - Product Requirements Document (PRD)

**Dự án**: AIVES (AI-assisted Viva Examination System)  
**Tác giả**: @tmqthedev & Antigravity AI Pair Programmer  
**Ngày cập nhật**: 27/10/2026 · Phiên bản: 2.1 (Step 1 → Step 13, gồm UI Việt–Anh và bắt buộc AI thật)

---

## 1. TỔNG QUAN SẢN PHẨM & MỤC TIÊU CHIẾN LƯỢC

### 1.1. Bài toán thực tế
Thi vấn đáp 1-1 (Oral Examination / Viva) là phương pháp đánh giá khách quan và sâu sắc nhất năng lực tư duy, hiểu biết kiến trúc và khả năng phản biện của sinh viên trong các môn chuyên ngành phần mềm (SWD392). Tuy nhiên, phương pháp truyền thống tồn tại các rào cản lớn:
- **Tốn kém thời gian giảng viên**: Một kỳ thi cho 100 sinh viên tiêu tốn 50–70 giờ phỏng vấn trực tiếp.
- **Thiếu nhất quán và công bằng**: Mức độ khó của câu hỏi phụ thuộc cảm tính giảng viên; thang điểm đánh giá có thể biến thiên theo thời gian.
- **Rò rỉ câu hỏi**: Sinh viên thi trước thường tiết lộ câu hỏi cho sinh viên thi sau.

### 1.2. Mục tiêu sản phẩm AIVES
AIVES giải quyết các bài toán trên bằng mô hình thi vấn đáp tự động hóa kết hợp AI với sự giám sát tối cao của con người (**Human-in-the-Loop**):
1. **Giải phóng thời gian cho giảng viên**: Giảng viên không cần trực tiếp ngồi hỏi từng sinh viên; chỉ cần chuẩn bị học liệu, duyệt ngân hàng câu hỏi, cấu hình kỳ thi và thẩm định kết quả chấm điểm.
2. **Đánh giá nhất quán và minh bạch**: Mọi thí sinh được phỏng vấn theo cùng một cấu hình chuẩn, cùng phân bổ Bloom và chấm điểm theo Rubric với tiêu chí, trọng số và mức đánh giá rõ ràng.
3. **Phỏng vấn sâu và thích ứng (Adaptive Viva)**: AI lắng nghe câu trả lời qua giọng nói theo thời gian thực và đặt câu hỏi hỏi xoáy (follow-up) khi câu trả lời thiếu ý, mơ hồ hoặc mâu thuẫn trong giới hạn thời gian quy định.
4. **Quyền quyết định thuộc về Giảng viên**: AI chỉ đưa ra điểm gợi ý kèm minh chứng trích xuất từ transcript. Chỉ giảng viên được phân công làm giám khảo mới có quyền điều chỉnh điểm và chốt điểm chính thức.
5. **Tối ưu chi phí vận hành**: Kiến trúc chạy mượt mà trên môi trường máy chủ cục bộ (Local Docker Compose) và vận hành trên đám mây AWS với chi phí siêu thấp (~$18–23/tháng).

---

## 2. VAI TRÒ NGƯỜI DÙNG (USER PERSONAS)

| Vai trò | Nhu cầu chính | AIVES hỗ trợ giải quyết |
| :--- | :--- | :--- |
| **Quản trị viên (Admin)** | Tạo tài khoản cho toàn trường nhanh chóng, phân công giảng viên bộ môn, ghi danh sinh viên theo môn học, điều phối lịch thi tập trung. | - Import sinh viên hàng loạt từ Excel (All-or-Nothing).<br>- Tự động gửi link thiết lập mật khẩu một lần qua email.<br>- Gán giảng viên vào môn (`subject_lecturer`) và ghi danh sinh viên (`subject_student`).<br>- Bảng điều phối lịch thi (`/admin/exam-schedule`) để Khởi động (`OPEN`), Đóng (`CLOSED`) và Làm nóng tài nguyên (`Re-warm`). |
| **Giảng viên (Lecturer)** | Soạn câu hỏi nhanh theo mức độ tư duy Bloom, quản lý chủ đề thi (Topic), tổ chức kỳ thi không mất thời gian ngồi hỏi, chấm bài nhanh và công bằng. | - Tải tài liệu giáo trình (PDF, DOCX, PPTX) và dùng AI RAG sinh câu hỏi kèm trích dẫn nguồn.<br>- Giao diện quản lý Chủ đề thi (`/lecturer/topics`) và Ngân hàng câu hỏi/Rubric theo môn học.<br>- Lên lịch kỳ thi với bảng chọn sinh viên/giảng viên trực quan.<br>- Màn hình thẩm định kết quả (`EvaluationReview`): nghe lại audio, xem minh chứng AI trích xuất, điều chỉnh điểm có lý do và chốt điểm. |
| **Sinh viên (Student)** | Biết rõ lịch thi của mình, tham gia thi trong môi trường công bằng, giọng đọc tự nhiên, không mất bài khi rớt mạng, xem kết quả minh bạch. | - Xem danh sách kỳ thi được phép tham gia (`/student/dashboard`).<br>- Kiểm tra micro và loa/tai nghe trước khi thi (đồng hồ chỉ chạy sau khi kiểm tra đạt), giao diện hiển thị câu hỏi dạng chữ và phát âm thanh TTS tự nhiên.<br>- Đồng hồ đếm ngược server-authoritative, thi tiếp từ lượt đang dở khi gặp sự cố mạng/F5.<br>- Xem bảng điểm chi tiết từng câu và từng tiêu chí Rubric sau khi kỳ thi đã được chốt điểm (`/student/results`). |

---

## 3. PHẠM VI BẢN PHÁT HÀNH HIỆN TẠI (RELEASE SCOPE)

| Nhóm chức năng | Tình trạng hiện tại | Mô tả chi tiết |
| :--- | :---: | :--- |
| **1. Ngân hàng câu hỏi & Rubric** | ✅ **Hoàn chỉnh** | - Tạo thủ công, import Excel theo mẫu, AI sinh bằng RAG từ học liệu.<br>- 4 mức độ Bloom (`REMEMBER`, `UNDERSTAND`, `APPLY`, `ANALYZE`).<br>- Phát hiện câu hỏi trùng lặp tuyệt đối (chặn cứng) và cảnh báo tương đồng Cosine $\ge 0.9$.<br>- Rubric đa mức đánh giá, khóa khi kỳ thi mở, hỗ trợ nhân bản (clone), bảo toàn thứ tự tiêu chí. |
| **2. Quản lý Chủ đề & Học liệu** | ✅ **Hoàn chỉnh** | - Quản lý Chủ đề thi (`/lecturer/topics`) gắn với môn học, kiểm tra toàn vẹn khóa ngoại khi xóa.<br>- Upload giáo trình/slide PDF, DOCX, PPTX $\le 50$ MB; phân đoạn thông minh ~500 từ và sinh vector Titan Embeddings V2 1024 chiều. |
| **3. Quản trị Kỳ thi & Lịch thi** | ✅ **Hoàn chỉnh** | - Cấu hình số câu chính, giới hạn hỏi xoáy, thời gian suy nghĩ, thời gian trả lời, phân bổ Bloom.<br>- Chọn danh sách sinh viên từ dữ liệu ghi danh môn học và chọn ban giám khảo từ giảng viên bộ môn.<br>- Giảng viên gửi lịch (`SCHEDULED`); Admin xem bảng lịch thi toàn trường và bấm Khởi động (`OPEN`).<br>- Cơ chế làm nóng Lambda tự động (`KEEP_WARM`) và tổng hợp sẵn âm thanh câu hỏi (`PREPARE_EXAM_AUDIO`). |
| **4. Lõi Phỏng vấn AI Thời gian thực** | ✅ **Hoàn chỉnh** | - Tương tác Socket.IO phòng thi, ghi âm `MediaRecorder` (webm/opus) gửi theo gói 1 giây.<br>- Giọng đọc TTS Kokoro-82M và nhận dạng giọng nói STT PhoWhisper/Whisper trên AWS Lambda.<br>- Quyết định hỏi xoáy thích ứng (Bedrock Nova Pro) dưới 40 từ, không gợi ý đáp án.<br>- Khôi phục phiên thi sau rớt mạng từ DynamoDB Context Store.<br>- Tự động quét và kết thúc các phiên thi bị bỏ dở sau hạn chót (`EXPIRE_INTERVIEWS`). |
| **5. Chấm điểm & Thẩm định Kết quả** | ✅ **Hoàn chỉnh** | - AI tự động chấm theo Rubric ngay sau khi phiên thi kết thúc; gắn cờ `FLAGGED` nếu độ tin cậy thấp.<br>- Giám khảo nghe lại audio, xem rationale, điều chỉnh điểm có lý do (ghi vết lịch sử) và chốt điểm `FINALIZED`.<br>- Phân quyền chấm nghiêm ngặt: chỉ Giám khảo được phân công hoặc người tạo kỳ thi mới có quyền ghi. |
| **6. Xem Kết quả Sinh viên** | ✅ **Hoàn chỉnh** | - Giao diện danh sách và chi tiết kết quả cho sinh viên (`/student/results`).<br>- Áp dụng bộ lọc an toàn tuyệt đối (Student Safety View Mask), chỉ hiển thị khi bài thi đã `FINALIZED`, không lộ rationale nội bộ. |
| **7. Quản trị Hệ thống & Người dùng** | ✅ **Hoàn chỉnh** | - Quản lý tài khoản Admin/Lecturer/Student, khóa/mở khóa tài khoản, gửi lại link kích hoạt.<br>- Quản lý môn học, phân công giảng viên (`subject_lecturer`) và ghi danh sinh viên (`subject_student`). |
| **8. Song ngữ Việt–Anh & AI thật (Step 13)** | ✅ **Hoàn chỉnh** | - Giao diện tiếng Việt (mặc định) và tiếng Anh, đổi tại trang đăng nhập và thanh trên cùng.<br>- Ngôn ngữ kỳ thi `VI`/`EN` áp dụng cho STT, TTS, hỏi phụ và chấm điểm; ngôn ngữ nội dung chọn riêng khi tạo/sinh câu hỏi.<br>- Ứng dụng từ chối khởi động với provider mock; lệnh `verifyRealAi.js` kiểm chứng toàn bộ chuỗi AI thật. Xem [bilingual-real-ai.md](bilingual-real-ai.md). |

*Lưu ý ngoài phạm vi bản phát hành*: Nhận dạng chữ từ file PDF scan (OCR), cộng trực tiếp tín hiệu ngập ngừng vào điểm số, đăng nhập SSO bên thứ ba (Google OAuth).

---

## 4. DANH MỤC TÍNH NĂNG & USER STORIES (P0 / P1)

| ID | Vai trò | Mong muốn của người dùng (User Story) | Tiêu chí chấp nhận (Acceptance Criteria) | Ưu tiên |
| :--- | :--- | :--- | :--- | :---: |
| **US-01** | Người dùng | Đăng nhập bằng Email hoặc Mã tài khoản và Mật khẩu | Đăng nhập thành công cấp cookie `httpOnly` an toàn; điều hướng đúng trang theo vai trò; sai 5 lần liên tiếp trong 15 phút thì tài khoản bị khóa tạm thời 15 phút. | **P0** |
| **US-02** | Người dùng | Đặt lại mật khẩu khi quên | Nhận liên kết qua email; liên kết chỉ dùng một lần và hết hạn sau 30 phút; phản hồi API an toàn chống dò quét tài khoản (Enumeration-safe). | **P1** |
| **US-03** | Quản trị viên | Import danh sách sinh viên hàng loạt từ Excel | Hỗ trợ file `.xlsx`; xử lý theo cơ chế All-or-Nothing (1 dòng lỗi thì rollback toàn bộ và báo chi tiết số dòng); tự động gửi email đặt mật khẩu hạn 72 giờ cho từng tài khoản mới. | **P0** |
| **US-04** | Quản trị viên | Tạo môn học, gán giảng viên và ghi danh sinh viên | Giảng viên chỉ được thao tác trên dữ liệu môn được gán; Sinh viên được ghi danh vào môn học để xuất hiện trong danh sách tạo kỳ thi. | **P0** |
| **US-05** | Giảng viên | Quản lý Chủ đề thi (Topic) theo môn học | Xem danh sách chủ đề theo môn, tạo mới, chỉnh sửa, xem số lượng câu hỏi đã duyệt; xóa chủ đề an toàn (bắt lỗi 409 nếu đang có câu hỏi/tài liệu liên kết). | **P0** |
| **US-06** | Giảng viên | Tải tài liệu học liệu (PDF, DOCX, PPTX) của môn học | Chấp nhận file có lớp chữ đến 50 MB; hệ thống tự động phân đoạn văn bản và tạo vector embedding 1024 chiều lưu vào CSDL; hiển thị trạng thái xử lý rõ ràng. | **P0** |
| **US-07** | Giảng viên | Cho AI sinh câu hỏi từ tài liệu học liệu theo chủ đề | Chọn tài liệu, số câu, phân bổ Bloom; AI sinh câu hỏi kèm đáp án tham khảo, ý chính bắt buộc, trích dẫn nguồn (grounding) và giải thích mục đích; tự động loại câu bịa nguồn. | **P0** |
| **US-08** | Giảng viên | Thẩm định và duyệt câu hỏi AI sinh | Hiển thị câu hỏi cạnh đoạn trích dẫn nguồn; cho phép Duyệt (bắt buộc gắn Rubric), Sửa rồi duyệt, Từ chối (bắt buộc ghi lý do) hoặc duyệt hàng loạt theo Rubric chung. | **P0** |
| **US-09** | Giảng viên | Tạo Rubric đánh giá đa mức | Tổng trọng số các tiêu chí chuẩn 100%; mỗi tiêu chí có các mức hoàn thành kèm khoảng điểm và mô tả chi tiết; Rubric đã dùng trong kỳ thi thì bị khóa (muốn sửa phải nhân bản). | **P0** |
| **US-10** | Giảng viên | Thiết lập kỳ thi với danh sách SV và Giám khảo theo môn | Chọn môn học $\rightarrow$ chọn sinh viên đã ghi danh môn và chọn giảng viên bộ môn qua bảng Checkbox trực quan; cấu hình số câu chính, giới hạn hỏi xoáy, thời gian suy nghĩ/trả lời và phân bổ Bloom; cảnh báo sớm nếu chủ đề thiếu câu hỏi đã duyệt. | **P0** |
| **US-11** | Giảng viên | Gửi lịch thi để Quản trị viên kích hoạt | Chỉ gửi lịch được khi kỳ thi có khung giờ hợp lệ, giờ đóng chưa qua và chủ đề có đủ câu hỏi đã duyệt theo tổng số và từng mức Bloom; trạng thái chuyển sang `SCHEDULED`; cho phép rút lịch về `DRAFT` để chỉnh sửa. | **P0** |
| **US-12** | Quản trị viên | Xem Bảng lịch thi toàn trường và Khởi động kỳ thi | Xem danh sách kỳ thi của mọi môn; bấm Khởi động chuyển trạng thái `OPEN`, khóa Rubric liên quan, kích hoạt làm nóng Lambda STT/TTS và tổng hợp sẵn âm thanh câu hỏi chạy ngầm. | **P0** |
| **US-13** | Sinh viên | Xem kỳ thi của mình và tham gia phòng thi giọng nói | Chỉ thấy các kỳ thi có tên mình; kiểm tra micro và loa trước khi bắt đầu (phiên thi chỉ được tạo sau khi kiểm tra đạt); câu hỏi hiển thị dạng chữ và phát âm thanh đọc tự nhiên; đồng hồ đếm ngược server-authoritative; hết giờ tự động nộp bài. | **P0** |
| **US-14** | Sinh viên | Được AI hỏi xoáy thích ứng khi trả lời chưa đủ ý | AI phân tích câu trả lời, hỏi xoáy thích ứng (dưới 40 từ) khi câu trả lời thiếu ý chính, mơ hồ hoặc mâu thuẫn; không hỏi vượt quá hạn mức cấu hình; không tiết lộ đáp án. | **P0** |
| **US-15** | Sinh viên | Thi tiếp khi gặp sự cố mạng hoặc tải lại trang (F5) | Hệ thống khôi phục trạng thái từ DynamoDB/Postgres, đưa thí sinh quay lại đúng câu hỏi và lượt đang làm dở với thời gian còn lại chính xác, không bị cộng thêm giờ. | **P1** |
| **US-16** | Giảng viên | Nhận điểm gợi ý AI có bằng chứng ngay sau khi thi | AI chấm từng tiêu chí Rubric kèm trích dẫn nguyên văn từ câu nói của thí sinh; chỉ rõ điểm mạnh, điểm yếu và ý thiếu; gắn cờ `FLAGGED` bài thi có độ tin cậy thấp. | **P0** |
| **US-17** | Giảng viên | Thẩm định, điều chỉnh điểm và chốt điểm chính thức | Giám khảo nghe lại audio từng lượt trả lời, xem lý do AI đặt câu hỏi; chỉnh điểm bắt buộc ghi lý do (ghi vết lịch sử); chỉ Giám khảo được phân công mới có quyền chốt điểm. | **P0** |
| **US-18** | Sinh viên | Xem kết quả thi chính thức của mình | Xem bảng điểm tổng kết và điểm chi tiết từng tiêu chí Rubric sau khi bài thi đã được chốt điểm (`FINALIZED`); tuyệt đối không thấy rationale hoặc thông tin nội bộ. | **P0** |
| **US-19** | Hệ thống | Tự động quét và kết thúc các phiên thi bị bỏ dở | Quét định kỳ mỗi 60 giây các phiên thi quá hạn chót (`deadline_at + grace_sec`), tự động đóng phiên với lý do `DEADLINE_REACHED`, tạo kết quả và kích hoạt chấm điểm tự động. | **P0** |

---

## 5. LUỒNG NGHIỆP VỤ ĐẦU - CUỐI (END-TO-END WORKFLOW)

```
[ 1. Quản trị viên ]  ──▶ Tạo Môn học, Gán Giảng viên & Ghi danh Sinh viên qua Excel
                                        │
                                        ▼
[ 2. Giảng viên ]     ──▶ Tạo Topic, Upload Giáo trình (PDF/DOCX/PPTX)
                                        │
                                        ▼
[ 3. RAG Engine ]     ──▶ Chunking ~500 từ, Vector Titan V2, Bedrock Nova Pro sinh câu hỏi
                                        │
                                        ▼
[ 4. Giảng viên ]     ──▶ Thẩm định câu hỏi (đối chiếu đoạn trích nguồn), Duyệt & Gắn Rubric
                                        │
                                        ▼
[ 5. Giảng viên ]     ──▶ Tạo Kỳ thi (Checkbox SV/GV theo môn, phân bổ Bloom), Gửi lịch (SCHEDULED)
                                        │
                                        ▼
[ 6. Quản trị viên ]  ──▶ Bảng Lịch thi ➔ Bấm Khởi động (OPEN)
                                 ├─ Khóa Rubric
                                 ├─ Làm nóng Lambda STT/TTS (KEEP_WARM)
                                 └─ Tổng hợp sẵn audio câu hỏi (PREPARE_EXAM_AUDIO)
                                        │
                                        ▼
[ 7. Sinh viên ]      ──▶ Kiểm tra micro + loa ➔ Vào phòng thi ➔ Nghe câu hỏi (TTS) ➔ Trả lời giọng nói (STT)
                                        │
                                        ├─ AI quyết định hỏi xoáy thích ứng (Nova Pro)
                                        ├─ Tự nộp khi hết giờ đếm ngược
                                        └─ Auto-sweep kết thúc phiên nếu bỏ dở (EXPIRE_INTERVIEWS)
                                        │
                                        ▼
[ 8. AI Chấm điểm ]   ──▶ Đánh giá transcript theo Rubric, trích xuất minh chứng (GRADE_INTERVIEW)
                                        │
                                        ▼
[ 9. Ban Giám khảo ]  ──▶ Nghe lại audio, xem rationale, điều chỉnh điểm có lý do ➔ Chốt (FINALIZED)
                                        │
                                        ▼
[ 10. Sinh viên ]     ──▶ Xem Bảng điểm chi tiết chính thức tại /student/results
```

---

## 6. CHỈ SỐ ĐO LƯỜNG THÀNH CÔNG (SUCCESS METRICS)

Cột "Bằng chứng hiện có" chỉ ghi những gì đã được đo trong các lượt E2E trên production ([e2e-execution-report.md](e2e-execution-report.md), 26/10/2026). Chỉ số chưa có phép đo đại diện được ghi là **Chưa đo**; không coi là đạt cho tới khi có số liệu.

| Chỉ số kỹ thuật / nghiệp vụ | Mục tiêu đề ra | Bằng chứng hiện có |
| :--- | :--- | :--- |
| **Độ trễ phản hồi lượt thi (Latency)** | Trung vị $< 3$ giây, p95 $< 6$ giây từ khi thí sinh dứt lời đến khi nhận câu hỏi tiếp | **Chưa đo** trên nhiều lượt. Lượt E2E chỉ ghi tín hiệu của sinh viên (độ trễ bắt đầu nói 1.250 ms), không phải độ trễ của hệ thống. |
| **Độ chính xác nhận dạng giọng nói (STT)** | WER (Word Error Rate) $< 10\%$ trên môi trường phòng thi chuẩn | **Chưa đo WER.** Mẫu tiếng Việt tổng hợp được nhận dạng gần đúng nhưng sai thuật ngữ kỹ thuật ("cách … microservice" → "các … microsoft"); độ tin cậy STT 0,918. Chưa thử micro thật. |
| **Thời gian tổng hợp âm thanh (TTS)** | $< 5$ giây cho một câu hỏi trung bình | **Chưa đo có hệ thống.** Audio câu chính được tạo sẵn bởi `PREPARE_EXAM_AUDIO` và cache ở S3 `tts-cache/`. |
| **Tỷ lệ bảo toàn phiên thi khi có sự cố** | 100% phiên thi được lưu vết transcript và bản ghi chấm | **Đạt trong E2E**: phiên bỏ dở được `EXPIRE_INTERVIEWS` đóng với `DEADLINE_REACHED`, tạo kết quả và chấm xong. F5/rớt mạng thật chưa được thử với giọng nói thật. |
| **Độ tin cậy của điểm chấm gợi ý AI** | Chênh lệch trung bình giữa điểm AI và Giám khảo chốt $< 1.0$ điểm (thang 10) | **Chưa đo**: mới có một bài thi thử được chốt (7,30), chưa đủ mẫu để tính chênh lệch trung bình. |
| **Chi phí vận hành cố định** | Dưới $25/tháng khi hệ thống vận hành liên tục | **Ước tính** trong README → "Deploy lên AWS" → "Chi phí"; chưa đối chiếu hóa đơn thực tế. |
