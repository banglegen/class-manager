# 🌿 CLASS MANAGER v2

Website quản lý thi đua lớp học: đăng nhập, phân quyền, học sinh, tổ, điểm cộng/trừ, vi phạm, xếp loại và xuất Excel/Word.

## 1. Cài đặt Supabase
1. Vào https://supabase.com → **New project**.
2. Mở **SQL Editor → New query**, dán toàn bộ nội dung `supabase/schema.sql` rồi **Run**.
3. Vào **Project Settings → API**, copy `Project URL` và khóa `service_role`.
4. Copy `.env.example` thành `.env` và điền:
```
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJ...
SESSION_SECRET=chuoi-ngau-nhien-dai
ADMIN_PASSWORD=mat-khau-admin-cua-ban
```
> Khóa `service_role` chỉ dùng ở server (`server.js`), tuyệt đối không đưa vào frontend hay GitHub.

## 2. Chạy
Yêu cầu Node.js 18+.

```bash
npm install
npm start
```

Mở http://localhost:3000 (không dùng Live Server / port 5500).
Lần chạy đầu server tự tạo tài khoản admin, tổ, quy tắc, xếp loại và dữ liệu mẫu. Đặt `SEED_DEMO=false` trong `.env` nếu không muốn dữ liệu mẫu học sinh.

## 3. Tài khoản mặc định
- Username: `admin`
- Password: `admin123`

Đổi mật khẩu trong bảng `users` (Supabase) hoặc mở rộng API quản trị trước khi đưa lên Internet.

## 4. Phân quyền
- ADMIN: toàn quyền, quản lý tài khoản.
- CLASS_LEADER: quản lý lớp, học sinh, quy tắc, điểm.
- CLASS_VICE: ghi điểm và xem báo cáo.
- TEAM_LEADER: chỉ xem/ghi điểm cho học sinh thuộc tổ được gán.

## 5. Database
Dữ liệu lưu trên Supabase (PostgreSQL), gồm các bảng: users, teams, students, months, score_rules, score_records, classifications và view `v_month_scores`. Đã bật RLS không policy nên khóa `anon` không truy cập được; chỉ server (service_role) đọc/ghi.

## 6. Xuất file
- Excel: `/export/excel`
- Word: `/export/word`

## 7. Lưu ý bảo mật khi deploy
Đặt biến môi trường `SESSION_SECRET` riêng, dùng HTTPS, giới hạn đăng nhập và bổ sung CSRF/rate-limit nếu triển khai công khai.

## 8. Đưa lên Internet (mọi người dùng chung dữ liệu)
Dữ liệu nằm trên Supabase nên mọi người truy cập đều thấy cùng một dữ liệu. Chỉ cần đưa server Node.js lên một dịch vụ hosting (ví dụ Render, Railway, Fly.io):

1. Đẩy code lên GitHub (file `.env` đã bị `.gitignore` chặn, đừng commit).
2. Trên Render: **New → Web Service** → chọn repo. Build command `npm install`, Start command `npm start`.
3. Thêm Environment Variables: `NODE_ENV=production`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SESSION_SECRET` (chuỗi ngẫu nhiên dài), `ADMIN_PASSWORD`, và `SEED_DEMO=false` nếu không cần dữ liệu mẫu.
4. Deploy xong sẽ có địa chỉ `https://ten-app.onrender.com` để chia sẻ cho cả lớp.

Nếu đã chạy bản cũ có admin/admin123: chạy lại `supabase/schema.sql` (để tạo bảng `sessions`) rồi đổi mật khẩu bằng
`npm run set-password -- admin MatKhauMoi123`.

Phiên đăng nhập lưu trong Supabase nên không mất khi server khởi động lại. Đăng nhập sai 10 lần/15 phút sẽ bị tạm khóa theo IP.
# class-manager
