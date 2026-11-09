// Một bảng thuật ngữ cho cả app: cùng một trạng thái, cùng một việc thì mọi màn gọi cùng một tên. Trước đây màn chính
// nói "Đang làm", bảng tag nói "Đang chạy"; "Cần duyệt" và "Chờ duyệt"; "Active", "In-Active" tiếng Anh; "Đang mở" vừa
// là phiên đang khởi động vừa là "đang mở ngoài app"; và năm cách gọi việc chạy tiếp một phiên.

export const RUNNING = new Set(['starting', 'idle', 'busy', 'waiting']);

export const STATUS_LABEL = {
  starting: 'Đang khởi động',
  idle: 'Sẵn sàng',
  busy: 'Đang làm',
  waiting: 'Cần duyệt',
  stopped: 'Đã dừng',
  crashed: 'Hỏng',
};

// Nhãn trạng thái của một phiên. Máy của phiên mất kết nối (trạm đặt offline) thì phiên có thể vẫn chạy trên máy,
// chỉ là không với tới được: nói đúng như vậy thay vì "Sẵn sàng".
export const statusLabel = (s) => (s?.offline && RUNNING.has(s.status) ? 'Mất kết nối' : STATUS_LABEL[s?.status] || s?.status || '');

// Nhóm phiên theo trạng thái (bảng tag, danh sách phiên của máy).
export const GROUP_RUNNING = 'Đang chạy';
export const GROUP_STOPPED = 'Đã dừng';

// Việc với một phiên: "Chạy lại" (phiên app đã dừng, nối tiếp đúng hội thoại), "Tiếp tục ở app" (phiên mở ngoài app
// hay phiên cũ trên máy, app nhận làm tiếp), "Tách nhánh mới" (hội thoại mới bắt đầu từ chỗ đó).
export const VERB = { resume: 'Chạy lại', takeOver: 'Tiếp tục ở app', fork: 'Tách nhánh mới' };
