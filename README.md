# Bò Mỹ Đen POS

Web app (PWA) order, màn hình bếp và thu ngân cho quán Bò Mỹ Đen. Kế hoạch: xem tài liệu kế hoạch dự án trong project.

## Chạy thử
```
npm install
cp .env.example .env   # điền URL và key Supabase
npm test               # kiểm thử tính tiền và VietQR
npm run dev
```

## Cấu trúc
- `supabase/migrations/0001_init.sql`: bảng dữ liệu, phân quyền theo vai trò, hàm `pay_order` thanh toán gộp nhiều phương thức trong một giao dịch
- `src/lib/billing.ts`: tính tạm tính, giảm giá, tiền còn thiếu, tiền thối
- `src/lib/vietqr.ts`: tạo mã VietQR có sẵn số tiền và nội dung
- `supabase/migrations/0006_staff_auth.sql`: vai trò (phục vụ, bếp, thu ngân, quản lý, chủ quán), mã PIN mã hoá bcrypt, đăng ký máy, phiên đăng nhập trên máy chung, khoá PIN khi nhập sai nhiều lần, mã duyệt của quản lý cho giảm giá / huỷ món đã gửi bếp, nhật ký
- `supabase/migrations/0009_role_permissions.sql` + `src/auth/permissions.ts`: phân quyền theo vai trò. Chủ quán bật / tắt từng quyền (19 quyền: gọi món, thu tiền, giảm giá, huỷ món, bếp, thực đơn, bàn, nhân viên, máy, nhật ký, xoá vĩnh viễn…) cho phục vụ, thu ngân, bếp, quản lý ở Nhân viên → Phân quyền (`#/nhan-vien/quyen`). Chủ quán luôn có mọi quyền. Mặc định giống quy tắc cũ; máy chủ kiểm tra lại bằng `has_perm()`
- `supabase/migrations/0010_admin_delete.sql`: quyền **Xoá vĩnh viễn** (`admin.delete`, mặc định chỉ chủ quán). Hàm `admin_delete(kind, id)` xoá hẳn nhóm món, món, nhóm tuỳ chọn, khu, bàn, đơn / hoá đơn, ca, nhân viên, máy cùng dữ liệu phụ thuộc; hoá đơn cũ vẫn giữ tên và giá món; mỗi lần xoá ghi vào nhật ký
- `src/auth/`: màn đăng nhập (chọn tên, nhập PIN), chặn màn hình theo vai trò, tự đăng xuất khi để yên, màn Nhân viên (`#/nhan-vien`), hộp duyệt của quản lý

## Đăng nhập nhân viên
- Không có Supabase: dùng nhân viên mẫu, PIN ghi dưới mỗi tên trên màn đăng nhập.
- Có Supabase: bật Anonymous sign-in. Máy đầu tiên: chạy trong SQL editor `select admin_add_staff('Tên chủ quán','owner','PIN');` rồi `select admin_create_device_code('Quầy thu ngân');`, nhập mã đó trên máy. Các máy sau: quản lý tạo mã ở màn Nhân viên, tab Máy.
- Màn bếp (`#/bep`) giữ đăng nhập; các máy khác tự đăng xuất sau số phút đặt ở tab Cài đặt.

## Kiểm thử SQL (Postgres 16 cục bộ, không đụng Supabase thật)
```
PG_BIN=/usr/lib/postgresql/16/bin supabase/tests/run.sh
```
Mỗi file `*_test.sql` chạy trên một cơ sở dữ liệu mới với toàn bộ migration.
