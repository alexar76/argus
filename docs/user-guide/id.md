# ARGUS-3 — Panduan Pengguna (Indonesia)

> instal · setup · penggunaan harian

---

## Apa itu ARGUS

ARGUS-3 adalah agen AI pribadi Anda — satu-satunya komponen AICOM untuk percakapan langsung dengan manusia. Berjalan di mesin Anda dengan kunci API Anda. WARDEN memeriksa setiap alat MCP sebelum dijalankan. Sisanya (Factory, Hub, Oracles) otonom; Anda berbicara dengan ARGUS.

```bash
curl -fsSL https://magic-ai-factory.com/install | bash
```

## Instal

Jalankan installer satu baris. Cek Node.js 20+, instal `@alexar76/argus3` global, buat `~/.argus/agent`, luncurkan `argus setup`. Wizard: wallet crypto (opsional, default OFF), mode lingkungan, provider LLM, Telegram opsional, token HTTP opsional.

## Penggunaan harian

`argus doctor` — cek kesehatan. `argus ask "tugas"` — sekali jalan. `argus chat` — REPL interaktif. `argus serve` — HTTP + Telegram + Arena. Kunci di `~/.argus/agent/.env`; config di `argus.config.json`.

## Cara berbicara dengan ARGUS

Tulis tugas jelas dengan garis finish, bukan vibe samar. ARGUS menjawab dalam bahasa yang Anda gunakan. Setiap tugas punya budget keras (token + USD) — selesai lalu berhenti. Alat sensitif butuh persetujuan eksplisit di CLI/Telegram.

## Pemecahan masalah

Jalankan `argus doctor` dulu. Tidak ada LLM? Tambah `DEEPSEEK_API_KEY` atau jalankan Ollama. command not found? Tambah `$(npm prefix -g)/bin` ke PATH. MCP diblokir? Cek `argus warden scan`. Budget habis? Persempit tugas atau naikkan limit.

---

## 😈 Ketika ARGUS tidak akan membantu

Tiga alasan jujur agen bilang tidak.

🎬 [Tonton kartun animasi →](./humor/cartoon.html?lang=id) · **[Baca roast lengkap →](./humor/id.md)**

---

- [Ecosystem whitepaper (EN)](https://github.com/alexar76/aicom/blob/main/docs/ecosystem/whitepaper/en.md)
- [GitHub Issues](https://github.com/alexar76/argus/issues)
- [Landing](https://magic-ai-factory.com/argus/)
