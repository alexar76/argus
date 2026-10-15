# ARGUS-3 — Kullanıcı Kılavuzu (Türkçe)

> kurulum · yapılandırma · günlük kullanım

---

## ARGUS nedir

ARGUS-3 kişisel AI ajantınızdır — doğrudan insan konuşması için tek AICOM bileşeni. Makinenizde, API anahtarlarınızla çalışır. WARDEN her MCP aracını çalıştırmadan önce inceler. Ekosistemin geri kalanı (Factory, Hub, Oracles) özerk; siz ARGUS ile konuşursunuz.

```bash
curl -fsSL https://magic-ai-factory.com/install | bash
```

## Kurulum

Tek satırlık kurulumu çalıştırın. Node.js 20+ kontrol, `@aimarket/argus` global kurulum, `~/.argus/agent` oluşturma, `argus setup` başlatma. Sihirbaz: crypto cüzdan (isteğe bağlı, varsayılan KAPALI), ortam modu, LLM sağlayıcı, Telegram, HTTP token.

## Günlük kullanım

`argus doctor` — sağlık kontrolü. `argus ask "görev"` — tek seferlik. `argus chat` — etkileşimli REPL. `argus serve` — HTTP + Telegram + Arena. Anahtarlar `~/.argus/agent/.env`; yapılandırma `argus.config.json`.

## ARGUS ile nasıl konuşulur

Bitiş çizgisi net görevler yazın, belirsiz vibe'lar değil. ARGUS kullandığınız dilde cevap verir. Her görevin sabit bütçesi (token + USD) vardır — bitirir ve durur. Hassas araçlar CLI/Telegram'da açık onay gerektirir.

## Sorun giderme

Önce `argus doctor` çalıştırın. LLM yok mu? `DEEPSEEK_API_KEY` ekleyin veya Ollama başlatın. command not found? `$(npm prefix -g)/bin` PATH'e. MCP engellendi mi? `argus warden scan`. Bütçe aşıldı mı? Görevi daraltın veya limitleri artırın.

---

## 😈 ARGUS'un yardım etmeyeceği durumlar

Ajanın hayır demesinin üç dürüst nedeni.

🎬 [Animasyonu izle →](./humor/cartoon.html?lang=tr) · **[Tam roast'u oku →](./humor/tr.md)**

---

- [Ecosystem whitepaper (EN)](https://github.com/alexar76/aicom/blob/main/docs/ecosystem/whitepaper/en.md)
- [GitHub Issues](https://github.com/alexar76/argus/issues)
- [Landing](https://magic-ai-factory.com/argus/)
