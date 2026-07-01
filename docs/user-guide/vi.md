# ARGUS-3 — Hướng dẫn người dùng (Tiếng Việt)

> cài đặt · thiết lập · sử dụng hàng ngày

---

## ARGUS là gì

ARGUS-3 là agent AI cá nhân — thành phần AICOM duy nhất cho hội thoại trực tiếp với con người. Chạy trên máy bạn với API key của bạn. WARDEN kiểm tra mọi công cụ MCP trước khi chạy. Phần còn lại (Factory, Hub, Oracles) tự vận hành; bạn nói chuyện với ARGUS.

```bash
curl -fsSL https://magic-ai-factory.com/install | bash
```

## Cài đặt

Chạy lệnh cài một dòng. Kiểm tra Node.js 20+, cài `@alexar76/argus3` global, tạo `~/.argus/agent`, khởi chạy `argus setup`. Trình hướng dẫn: ví crypto (tùy chọn, mặc định TẮT), chế độ môi trường, nhà cung cấp LLM, Telegram, token HTTP.

## Sử dụng hàng ngày

`argus doctor` — kiểm tra sức khỏe. `argus ask "nhiệm vụ"` — một lần. `argus chat` — REPL tương tác. `argus serve` — HTTP + Telegram + Arena. Key trong `~/.argus/agent/.env`; config trong `argus.config.json`.

## Cách nói chuyện với ARGUS

Viết nhiệm vụ rõ ràng có đích đến, không phải vibe mơ hồ. ARGUS trả lời bằng ngôn ngữ bạn dùng. Mỗi nhiệm vụ có ngân sách cứng (token + USD) — xong rồi dừng. Công cụ nhạy cảm cần phê duyệt rõ trên CLI/Telegram.

## Khắc phục sự cố

Chạy `argus doctor` trước. Không có LLM? Thêm `DEEPSEEK_API_KEY` hoặc chạy Ollama. command not found? Thêm `$(npm prefix -g)/bin` vào PATH. MCP bị chặn? Kiểm tra `argus warden scan`. Vượt ngân sách? Thu hẹp nhiệm vụ hoặc tăng giới hạn.

---

## 😈 Khi ARGUS sẽ không giúp bạn

Ba lý do trung thực agent từ chối.

🎬 [Xem hoạt hình →](./humor/cartoon.html?lang=vi) · **[Đọc roast đầy đủ →](./humor/vi.md)**

---

- [Ecosystem whitepaper (EN)](https://github.com/alexar76/aicom/blob/main/docs/ecosystem/whitepaper/en.md)
- [GitHub Issues](https://github.com/alexar76/argus/issues)
- [Landing](https://magic-ai-factory.com/argus/)
