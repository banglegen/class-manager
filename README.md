# Quản lý lớp xanh v4 — Vercel + Supabase

Bản này dành cho:
- Vercel: chạy website + Express API.
- Supabase: PostgreSQL database dùng chung.
- GitHub: lưu source code.

Vercel hỗ trợ deploy Express trực tiếp. Database và session không lưu trên filesystem của Vercel; dữ liệu lâu dài nằm ở Supabase PostgreSQL.

## 1. Tạo Supabase

1. Vào https://supabase.com/
2. Tạo New project.
3. Ghi nhớ database password.
4. Vào Connect.
5. Copy connection string PostgreSQL, ưu tiên Session pooler nếu Supabase hiển thị.
6. Có thể dùng SQL Editor để kiểm tra database.

Ví dụ biến:
```env
DATABASE_URL=postgresql://...
```

Không đưa DATABASE_URL lên GitHub.

## 2. Chạy local

Tạo `.env`:
```env
DATABASE_URL=postgresql://...
SESSION_SECRET=chuoi-bi-mat-dai
NODE_ENV=development
SEED_DEMO=true
ADMIN_USERNAME=admin
ADMIN_PASSWORD=admin123
```

Sau đó:
```bash
npm install
npm start
```

Mở:
http://localhost:3000

Lần đầu app tự tạo các bảng và dữ liệu demo nếu `SEED_DEMO=true`.

## 3. Đưa lên GitHub

```bash
git init
git add .
git commit -m "class manager v4 vercel supabase"
git branch -M main
git remote add origin https://github.com/TEN-GITHUB/class-manager-green.git
git push -u origin main
```

`.gitignore` đã loại `.env`, `node_modules`, database SQLite cũ.

## 4. Deploy Vercel

Vào https://vercel.com/

1. Add New -> Project.
2. Import repository GitHub.
3. Chọn repository.
4. Framework Preset: Other nếu Vercel hỏi.
5. Deploy.

Vercel sẽ dùng `vercel.json` để chạy Express server.

## 5. Environment Variables trên Vercel

Project -> Settings -> Environment Variables.

Thêm:

```text
DATABASE_URL = connection string Supabase
SESSION_SECRET = một chuỗi bí mật dài
NODE_ENV = production
SEED_DEMO = false
ADMIN_USERNAME = admin
ADMIN_PASSWORD = mật khẩu admin
```

Sau khi thêm/chỉnh biến môi trường, redeploy project.

## 6. Tài khoản

Nếu `SEED_DEMO=false`, lần chạy đầu app tự tạo tài khoản admin:
- username = ADMIN_USERNAME
- password = ADMIN_PASSWORD

Sau khi đăng nhập, Admin vào `Tài khoản` để tạo:
- Lớp trưởng
- Lớp phó
- Tổ trưởng

## 7. Quyền

Admin:
- Học sinh
- Quy tắc điểm
- Tài khoản
- Điểm
- Hạnh kiểm
- Excel/Word

Lớp trưởng:
- Học sinh
- Điểm
- Hạnh kiểm
- Excel/Word

Lớp phó:
- Điểm
- Hạnh kiểm
- Excel/Word

Tổ trưởng:
- Xem dữ liệu của tổ mình
- Ghi điểm cho học sinh trong tổ mình

## 8. Quan trọng

Không dùng `class.db` trên Vercel. Vercel là môi trường chạy ứng dụng; dữ liệu lâu dài phải nằm ở database ngoài. Bản này dùng Supabase PostgreSQL.

Export Excel/Word được tạo trong request rồi gửi về trình duyệt, không cần lưu file lâu dài trên Vercel.

## 9. Nếu muốn chuyển dữ liệu từ v2

Không tự copy `class.db` lên Vercel. Cần chạy một script migrate SQLite -> PostgreSQL để giữ dữ liệu cũ.
