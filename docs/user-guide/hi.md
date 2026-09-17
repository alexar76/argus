# ARGUS-3 — उपयोगकर्ता गाइड (हिन्दी)

> इंस्टॉल · सेटअप · दैनिक उपयोग

---

## ARGUS क्या है

ARGUS-3 आपका व्यक्तिगत AI एजेंट है — AICOM का एकमात्र हिस्सा जो सीधे इंसानों से बात करता है। आपकी मशीन पर, आपकी API keys के साथ चलता है। WARDEN हर MCP टूल चलाने से पहले जाँचता है। बाकी ecosystem (Factory, Hub, Oracles) स्वायत्त है; आप ARGUS से बात करते हैं।

```bash
curl -fsSL https://magic-ai-factory.com/install | bash
```

## इंस्टॉल

एक-पंक्ति इंस्टॉलर चलाएँ। Node.js 20+ जाँच, `@aimarket/argus` global install, `~/.argus/agent` बनाएगा, `argus setup` शुरू करेगा। विज़ार्ड: crypto wallet (वैकल्पिक, डिफ़ॉल्ट OFF), environment mode, LLM provider, Telegram, HTTP token।

## दैनिक उपयोग

`argus doctor` — health check। `argus ask "कार्य"` — एक बार। `argus chat` — interactive REPL। `argus serve` — HTTP + Telegram + Arena। Keys `~/.argus/agent/.env` में; config `argus.config.json` में।

## ARGUS से कैसे बात करें

स्पष्ट कार्य लिखें, अंतिम लक्ष्य के साथ — vague vibes नहीं। ARGUS आपकी भाषा में जवाब देता है। हर कार्य का hard budget (tokens + USD) — पूरा करके रुकता है। sensitive tools के लिए CLI/Telegram पर explicit approval।

## समस्या निवारण

पहले `argus doctor` चलाएँ। LLM नहीं? `DEEPSEEK_API_KEY` जोड़ें या Ollama शुरू करें। command not found? `$(npm prefix -g)/bin` PATH में। MCP blocked? `argus warden scan`। Budget exceeded? कार्य छोटा करें या limits बढ़ाएँ।

---

## 😈 जब ARGUS मदद नहीं करेगा

तीन ईमानदार कारण जिन पर एजेंट ना कहेगा।

🎬 [एनिमेटेड कार्टून देखें →](./humor/cartoon.html?lang=hi) · **[पूरा roast पढ़ें →](./humor/hi.md)**

---

- [Ecosystem whitepaper (EN)](https://github.com/alexar76/aicom/blob/main/docs/ecosystem/whitepaper/en.md)
- [GitHub Issues](https://github.com/alexar76/argus/issues)
- [Landing](https://magic-ai-factory.com/argus/)
