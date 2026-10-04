# Quản lý lớp v5 — Vercel + Supabase

- **Vercel**: chạy website + API (Express).
- **Supabase**: PostgreSQL dùng chung. App **tự tạo bảng** lần đầu chạy, không cần chạy SQL thủ công.

## 1. Tạo database Supabase
1. supabase.com → **New project** (nhớ Database password, region Singapore).
2. Bấm **Connect** → **Connection string** → chọn **Transaction pooler** (cổng 6543) — phù hợp nhất với Vercel.
   (Session pooler cổng 5432 cũng dùng được.)
3. Thay `[YOUR-PASSWORD]` bằng mật khẩu thật. Mật khẩu chỉ nên gồm chữ + số để tránh lỗi ký tự đặc biệt.

## 2. Chạy thử trên máy
```bash
npm install
copy .env.example .env      # Windows (Mac/Linux: cp .env.example .env)
```
Mở `.env`, sửa `DATABASE_URL`, `SESSION_SECRET`, `ADMIN_PASSWORD`. Đặt `SEED_DEMO=true` nếu muốn có học sinh mẫu để thử.
```bash
npm start
```
Mở http://localhost:3000 → đăng nhập bằng `ADMIN_USERNAME` / `ADMIN_PASSWORD`.
Kiểm tra DB: http://localhost:3000/api/health

## 3. Đưa lên GitHub
```bash
git init
git add .
git commit -m "class manager v5"
git branch -M main
git remote add origin https://github.com/TEN-BAN/class-manager.git
git push -u origin main
```

## 4. Deploy Vercel
1. vercel.com → **Add New → Project** → import repo.
2. Framework Preset: **Other**. Để nguyên các ô build.
3. Thêm **Environment Variables** *trước khi* Deploy:

| Tên | Giá trị |
|---|---|
| `DATABASE_URL` | chuỗi kết nối Supabase |
| `SESSION_SECRET` | chuỗi ngẫu nhiên dài |
| `ADMIN_USERNAME` | admin |
| `ADMIN_PASSWORD` | mật khẩu admin mạnh |
| `SEED_DEMO` | false |

4. Deploy. Sửa biến môi trường xong phải **Redeploy**.

## 5. Sử dụng
Admin đăng nhập → **Các tổ** (tạo/đổi tên tổ) → **Học sinh** (thêm lẻ hoặc *Nhập nhiều học sinh*) → **Tài khoản** (tạo lớp trưởng, lớp phó, tổ trưởng) → **Quy tắc & cài đặt** (chỉnh điểm gốc, quy tắc cộng/trừ).

| Quyền | Làm được |
|---|---|
| Admin | Tất cả |
| Lớp trưởng | Học sinh, ghi điểm, hạnh kiểm, xuất Excel/Word |
| Lớp phó | Ghi điểm, hạnh kiểm, xuất Excel/Word |
| Tổ trưởng | Xem + ghi điểm cho học sinh trong tổ mình |

**Cách tính điểm**: Tổng = Điểm gốc (mặc định 100) + cộng − trừ, mỗi tháng tính lại từ đầu.
Xếp loại: Tốt ≥ 90, Khá ≥ 80, Trung bình ≥ 65, Yếu < 65.

## 6. Lưu ý
- Tháng được tính theo giờ Việt Nam. Có thể chọn tháng cũ ở góc trên bên phải để xem/xuất báo cáo.
- Bảng đã bật RLS nên không thể bị đọc qua Supabase Data API; chỉ server mới truy cập được DB.
- Gói Supabase miễn phí tự tạm dừng sau ~1 tuần không dùng, vào dashboard bấm Restore.
- Không commit file `.env`.
