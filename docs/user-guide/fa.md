# ARGUS-3 — راهنمای کاربر (فارسی)

> نصب · راه‌اندازی · استفاده روزانه

---

## ARGUS چیست

ARGUS-3 عامل هوش مصنوعی شخصی شماست — تنها جزء AICOM برای گفتگوی مستقیم با انسان. روی دستگاه شما با کلیدهای API شما اجرا می‌شود. WARDEN هر ابزار MCP را قبل از اجرا بررسی می‌کند. بقیه اکوسیستم (Factory, Hub, Oracles) خودمختار است؛ شما با ARGUS صحبت می‌کنید.

```bash
curl -fsSL https://magic-ai-factory.com/install | bash
```

## نصب

نصب‌کننده یک‌خطی را اجرا کنید. Node.js 20+ را بررسی، `@aimarket/argus` را سراسری نصب، `~/.argus/agent` می‌سازد و `argus setup` را شروع می‌کند. ویزارد: کیف پول crypto (اختیاری، پیش‌فرض خاموش)، حالت محیط، ارائه‌دهنده LLM، Telegram اختیاری، توکن HTTP.

## استفاده روزانه

`argus doctor` — بررسی سلامت. `argus ask "کار"` — یک‌بار. `argus chat` — REPL تعاملی. `argus serve` — HTTP + Telegram + Arena. کلیدها در `~/.argus/agent/.env`؛ پیکربندی در `argus.config.json`.

## چگونه با ARGUS صحبت کنیم

کارهای روشن با خط پایان بنویسید، نه vibeهای مبهم. ARGUS به زبانی که استفاده می‌کنید پاسخ می‌دهد. هر کار بودجه سخت (توکن + USD) دارد — تمام می‌کند و می‌ایستد. ابزارهای حساس در CLI/Telegram نیاز به تأیید صریح دارند.

## عیب‌یابی

اول `argus doctor` را اجرا کنید. LLM ندارید؟ `DEEPSEEK_API_KEY` اضافه کنید یا Ollama را شروع کنید. command not found? `$(npm prefix -g)/bin` را به PATH اضافه کنید. MCP مسدود؟ `argus warden scan` را بررسی کنید. بودجه تمام شد؟ کار را محدود کنید یا سقف را بالا ببرید.

---

## 😈 وقتی ARGUS کمکتان نمی‌کند

سه دلیل صادقانه برای رد عامل.

🎬 [تماشای کارتون انیمیشنی →](./humor/cartoon.html?lang=fa) · **[خواندن roast کامل →](./humor/fa.md)**

---

- [Ecosystem whitepaper (EN)](https://github.com/alexar76/aicom/blob/main/docs/ecosystem/whitepaper/en.md)
- [GitHub Issues](https://github.com/alexar76/argus/issues)
- [Landing](https://magic-ai-factory.com/argus/)
