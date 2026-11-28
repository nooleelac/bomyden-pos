# Máy in khu Ngoài trời (Xprinter XP-Q80W)

Việc cần làm sau khi mua máy in. Ghi ngày 29/11/2026.

## Đã xong

- **Máy in theo khu**: phiếu tạm tính, phiếu chuyển khoản và hoá đơn của bàn sẽ in ra máy in gán cho khu của bàn đó, dù bấm in từ điện thoại hay máy tính nào. Đã chạy migration `0038_area_printer` và deploy lên order.bomyden.vn.
- **Chia khu**:
  - **Trong nhà**: bàn 1–10, 2A, 4A, 6A, 8A, CF 1, CF 2, MĐ 1, MĐ 2.
  - **Ngoài trời**: bàn 11–25. Bàn 23, 24, 25 mới tạo và đã có mã QR riêng.
- Đơn mang về, báo cáo ca và in thử vẫn in ra máy in cài trên từng thiết bị như trước.

## Cách hoạt động (đọc 1 lần cho hiểu)

- Điện thoại **không in thẳng** ra máy in. Nó gửi lệnh in lên máy chủ, rồi **app cầu nối** chạy trên một máy tính ở quán lấy lệnh về và đẩy ra máy in.
- Vì vậy điện thoại dùng mạng nào cũng được, kể cả 4G. **Chỉ app cầu nối phải dùng chung mạng với máy in.**
- Trong nhà có mạng FPT và PC để bàn đang chạy cầu nối số 1. Ngoài trời dùng mạng VNPT, nên cần **cầu nối số 2** chạy trong mạng VNPT.

## Việc cần làm khi có máy in

### 1. Chuẩn bị máy tính chạy cầu nối ngoài trời

- Dùng một laptop cũ hoặc mini PC chạy Windows, bắt **WiFi VNPT**.
- Máy phải **luôn bật** trong giờ bán. Vào Settings → System → Power, đặt **Sleep = Never**. Nếu là laptop thì đặt thêm "khi gập máy: không làm gì".
- Cài **Node.js** bản LTS từ nodejs.org.

### 2. Cho máy in XP-Q80W vào WiFi VNPT

- Cắm máy in vào máy tính bằng dây USB. Mở phần mềm cấu hình của Xprinter (có trong đĩa hoặc trên trang của hãng) và chọn chế độ WiFi **STA / Client**.
- Chọn WiFi VNPT, nhập mật khẩu WiFi.
- Đặt **IP cố định**, ví dụ `192.168.1.200`. Ba số đầu phải giống mạng VNPT: xem IP của laptop bằng lệnh `ipconfig`.
  - Cách khác: vào trang quản lý modem VNPT và giữ cố định IP cho máy in (DHCP reservation).
- Tắt máy in, bật lại rồi in trang tự kiểm tra (giữ nút FEED khi bật máy). Trên phiếu phải thấy đúng IP vừa đặt.

### 3. Cài app cầu nối số 2

1. Đăng nhập tài khoản quản lý trên order.bomyden.vn, vào **Cài đặt → Máy in → WiFi/LAN → Thêm app cầu nối**.
2. Đặt tên **"Cầu nối ngoài trời"**, bấm **Tạo mã**, rồi **Chép mã**. Mã chỉ hiện một lần và không được gửi lên mạng xã hội.
3. Trên laptop ngoài trời, tải file `cau-noi-may-in.mjs` (có link ở cùng màn hình) vào thư mục `C:\BoMyDen`.
4. Mở Command Prompt trong thư mục đó và chạy:
   ```
   node cau-noi-may-in.mjs --tu-chay
   ```
   Dán mã vào rồi bấm Enter. Từ đó trở đi, cầu nối tự chạy mỗi khi bật máy.
5. Quay lại màn hình WiFi/LAN trong app. "Cầu nối ngoài trời" phải hiện **đang chạy** và thấy máy in `192.168.1.200`. Nếu chưa thấy thì bấm **Dò lại**.

### 4. Gán máy in cho khu

- Vào **Cài đặt → Cài đặt bàn**. Ở khu **Ngoài trời**, ô **"Máy in của khu"** chọn `Máy in 192.168.1.200 · Cầu nối ngoài trời`.
- Khu **Trong nhà** có hai cách:
  - Chọn máy in trong nhà (qua cầu nối PC) để mọi điện thoại in phiếu của bàn trong nhà đều ra máy trong nhà.
  - Hoặc để "Theo từng máy" như hiện nay.
- Ô này chỉ liệt kê máy in mà cầu nối **tự dò thấy**. Nếu không thấy máy in, kiểm tra lại bước 2.

### 5. In thử

- Dùng một điện thoại đang bắt WiFi VNPT, mở đơn ở **bàn 11–25** và bấm **In tạm tính**. Phiếu phải ra ở máy ngoài trời.
- Mở đơn ở **bàn 1–10** và in tạm tính. Phiếu phải ra ở máy trong nhà, hoặc máy cài trên điện thoại đó nếu khu Trong nhà để "Theo từng máy".
- Rút WiFi khỏi laptop ngoài trời rồi in thử. App sẽ báo lỗi sau khoảng 30 giây, không in nhầm sang máy khác. Cắm lại WiFi là in được bình thường.

### 6. Việc khác

- In tem QR cho **bàn 23, 24, 25** (Cài đặt → Mã QR gọi món) và dán lên bàn.
- **Hoá đơn** của bàn ngoài trời cũng ra máy ngoài trời, kể cả khi thu ngân bấm in từ quầy trong nhà. Nếu muốn hoá đơn luôn in tại quầy thì cần sửa code: chỉ cho phiếu tạm tính đi theo khu.

## Khi in không được

| Hiện tượng | Kiểm tra |
| --- | --- |
| "App cầu nối chưa in sau 30 giây" | Laptop ngoài trời còn bật không, còn WiFi VNPT không, cửa sổ cầu nối có bị tắt không |
| "Máy in … không tới được máy in" | Máy in còn bật không, còn trong WiFi VNPT không, IP có bị đổi không (in trang tự kiểm tra để xem) |
| Không thấy máy in trong danh sách | Máy in và laptop có cùng mạng VNPT không, bấm Dò lại |
| Chữ nhỏ, mờ | Cài đặt → Máy in: khổ giấy 80mm, in đậm |
