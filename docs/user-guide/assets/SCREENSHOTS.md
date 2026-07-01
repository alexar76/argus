# ARGUS user-guide — screenshot capture checklist

Capture these for the next docs refresh (`web/frontend` or manual).

| ID | Scene | Suggested command / URL | Filename |
|----|-------|-------------------------|----------|
| `install-01` | Terminal: `curl …/install \| bash` banner | run installer | `install-banner.png` |
| `setup-01` | `argus setup` — crypto opt-in prompt | interactive | `setup-crypto.png` |
| `setup-02` | `argus setup` — LLM provider choice | interactive | `setup-llm.png` |
| `setup-03` | `argus setup` — completion summary | interactive | `setup-done.png` |
| `doctor-01` | `argus doctor` all green | `argus doctor` | `doctor-ok.png` |
| `chat-01` | `argus chat` first exchange | `argus chat` | `chat-session.png` |
| `serve-01` | `argus serve` + browser `/health` | `curl localhost:8787/health` | `serve-health.png` |
| `arena-01` | Agent Arena UI | `https://magic-ai-factory.com/arena/` | `arena-ui.png` |
| `mcp-01` | Cursor MCP config with `argus mcp` | Cursor settings | `cursor-mcp.png` |
| `telegram-01` | Telegram `/start` + one task | BotFather token | `telegram-chat.png` |

Place captures in `argus/docs/user-guide/assets/` and reference from locale guides as
`./assets/<filename>`.
