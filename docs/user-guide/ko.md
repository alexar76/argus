# ARGUS-3 — 사용자 가이드 (한국어)

> 설치 · 설정 · 일상 사용

---

## ARGUS란

ARGUS-3는 개인 AI 에이전트 — 인간과 직접 대화하도록 만든 유일한 AICOM 구성요소입니다. 내 컴퓨터에서 내 API 키로 실행됩니다. WARDEN은 MCP 도구를 실행 전 검사합니다. Factory, Hub, Oracles 등 나머지는 자율 운영; 당신은 ARGUS와 대화합니다.

```bash
curl -fsSL https://magic-ai-factory.com/install | bash
```

## 설치

한 줄 설치 명령 실행. Node.js 20+ 확인, `@alexar76/argus3` 전역 설치, `~/.argus/agent` 생성, `argus setup` 시작. 마법사: crypto 지갑(선택, 기본 OFF), 환경 모드, LLM 제공자, Telegram, HTTP 토큰.

## 일상 사용

`argus doctor` — 상태 점검. `argus ask "작업"` — 일회성. `argus chat` — 대화형 REPL. `argus serve` — HTTP + Telegram + Arena. 키는 `~/.argus/agent/.env`, 설정은 `argus.config.json`.

## ARGUS와 대화하는 법

끝이 분명한 명확한 작업을 작성하세요. 모호한 vibe 말고. ARGUS는 사용하는 언어로 답합니다. 각 작업에 고정 예산(토큰+USD) — 끝나면 멈춥니다. 민감한 도구는 CLI/Telegram에서 명시적 승인 필요.

## 문제 해결

먼저 `argus doctor` 실행. LLM 없음? `DEEPSEEK_API_KEY` 추가 또는 Ollama 시작. command not found? `$(npm prefix -g)/bin`을 PATH에. MCP 차단? `argus warden scan`. 예산 초과? 작업 범위 줄이거나 설정에서 한도 올리기.

---

## 😈 ARGUS가 도와주지 않을 때

에이전트가 거절하는 세 가지 솔직한 이유.

🎬 [애니메이션 보기 →](./humor/cartoon.html?lang=ko) · **[전체 roast 읽기 →](./humor/ko.md)**

---

- [Ecosystem whitepaper (EN)](https://github.com/alexar76/aicom/blob/main/docs/ecosystem/whitepaper/en.md)
- [GitHub Issues](https://github.com/alexar76/argus/issues)
- [Landing](https://magic-ai-factory.com/argus/)
