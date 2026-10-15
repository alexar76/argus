# ARGUS-3 — คู่มือผู้ใช้ (ไทย)

> ติดตั้ง · ตั้งค่า · ใช้งานประจำวัน

---

## ARGUS คืออะไร

ARGUS-3 คือเอเจนต์ AI ส่วนตัว — ส่วนประกอบ AICOM เดียวสำหรับสนทนากับมนุษย์โดยตรง ทำงานบนเครื่องคุณด้วย API key ของคุณ WARDEN ตรวจเครื่องมือ MCP ก่อนรัน ส่วนอื่น (Factory, Hub, Oracles) ทำงานอัตโนมัติ คุณคุยกับ ARGUS

```bash
curl -fsSL https://magic-ai-factory.com/install | bash
```

## ติดตั้ง

รันตัวติดตั้งบรรทัดเดียว ตรวจ Node.js 20+ ติดตั้ง `@aimarket/argus` แบบ global สร้าง `~/.argus/agent` เริ่ม `argus setup` ตัวช่วย: crypto wallet (ไม่บังคับ ปิดเป็นค่าเริ่มต้น) โหมดสภาพแวดล้อม LLM provider Telegram token HTTP

## ใช้งานประจำวัน

`argus doctor` — ตรวจสุขภาพ `argus ask "งาน"` — ครั้งเดียว `argus chat` — REPL โต้ตอบ `argus serve` — HTTP + Telegram + Arena คีย์อยู่ `~/.argus/agent/.env` config ใน `argus.config.json`

## วิธีคุยกับ ARGUS

เขียนงานชัดเจนมีเส้นชัย ไม่ใช่ vibe คลุมเครือ ARGUS ตอบภาษาที่คุณใช้ แต่ละงานมีงบแข็ง (token + USD) — ทำเสร็จแล้วหยุด เครื่องมือ sensitive ต้องอนุมัติชัดบน CLI/Telegram

## แก้ปัญหา

รัน `argus doctor` ก่อน ไม่มี LLM? เพิ่ม `DEEPSEEK_API_KEY` หรือเริ่ม Ollama command not found? เพิ่ม `$(npm prefix -g)/bin` ใน PATH MCP ถูกบล็อก? ตรวจ `argus warden scan` เกินงบ? ลดขอบเขตงานหรือเพิ่ม limit

---

## 😈 เมื่อ ARGUS จะไม่ช่วยคุณ

สามเหตุผลที่เอเจนต์ปฏิเสธอย่างตรงไปตรงมา

🎬 [ดูการ์ตูนแอนิเมชัน →](./humor/cartoon.html?lang=th) · **[อ่าน roast เต็ม →](./humor/th.md)**

---

- [Ecosystem whitepaper (EN)](https://github.com/alexar76/aicom/blob/main/docs/ecosystem/whitepaper/en.md)
- [GitHub Issues](https://github.com/alexar76/argus/issues)
- [Landing](https://magic-ai-factory.com/argus/)
