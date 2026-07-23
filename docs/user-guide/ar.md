# ARGUS-3 — دليل المستخدم (العربية)

> التثبيت · الإعداد · الاستخدام اليومي

---

## ما هو ARGUS

ARGUS-3 وكيل الذكاء الاصطناعي الشخصي — المكوّن الوحيد في AICOM للمحادثة المباشرة مع البشر. يعمل على جهازك بمفاتيح API الخاصة بك. WARDEN يفحص كل أداة MCP قبل التشغيل. بقية النظام (Factory, Hub, Oracles) يعمل باستقلالية؛ أنت تتحدث مع ARGUS.

```bash
curl -fsSL https://magic-ai-factory.com/install | bash
```

## التثبيت

شغّل المثبّت بسطر واحد. يتحقق من Node.js 20+، يثبت `@aimarket/argus` عالميًا، ينشئ `~/.argus/agent` ويشغّل `argus setup`. المعالج: محفظة crypto (اختياري، OFF افتراضيًا)، وضع البيئة، مزود LLM، Telegram اختياري، رمز HTTP اختياري.

## الاستخدام اليومي

`argus doctor` — فحص الصحة. `argus ask "مهمة"` — مهمة واحدة. `argus chat` — REPL تفاعلي. `argus serve` — HTTP + Telegram + Arena. المفاتيح في `~/.argus/agent/.env`؛ الإعداد في `argus.config.json`.

## كيف تتحدث مع ARGUS

اكتب مهامًا واضحة بنهاية محددة، لا vibes غامضة. ARGUS يجيب بلغتك. لكل مهمة ميزانية ثابتة (رموز + USD) — ينهي ويتوقف. الأدوات الحساسة تحتاج موافقة صريحة على CLI/Telegram.

## استكشاف الأخطاء

شغّل `argus doctor` أولًا. لا LLM? أضف `DEEPSEEK_API_KEY` أو شغّل Ollama. أمر غير موجود? أضف `$(npm prefix -g)/bin` إلى PATH. MCP محظور? تحقق من `argus warden scan`. تجاوز الميزانية? ضيّق المهمة أو ارفع الحدود.

---

## 😈 متى لن يساعدك ARGUS

ثلاثة أسباب صادقة لرفض الوكيل.

🎬 [شاهد الرسوم المتحركة →](./humor/cartoon.html?lang=ar) · **[اقرأ ال roast الكامل →](./humor/ar.md)**

---

- [Ecosystem whitepaper (EN)](https://github.com/alexar76/aicom/blob/main/docs/ecosystem/whitepaper/en.md)
- [GitHub Issues](https://github.com/alexar76/argus/issues)
- [Landing](https://magic-ai-factory.com/argus/)
