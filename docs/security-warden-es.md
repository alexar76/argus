# 🛡️ WARDEN — el firewall MCP

> 🌐 Idiomas: [English](./security-warden.md) · [Русский](./security-warden-ru.md) · **Español**

> Parte del conjunto de documentación de ARGUS (`argus/docs/`):
> [architecture](./architecture.md) · **security-warden** · [economy-integration](./economy-integration.md) · [token-economy](./token-economy.md) · [autonomy](./autonomy.md)

Los servidores MCP son código de terceros que inyecta **texto controlable por un atacante**
(nombres de herramientas, descripciones, esquemas de entrada) directamente en el contexto
del modelo como instrucciones de confianza, y luego ejecuta herramientas en la máquina y
la cartera del usuario. WARDEN es la puerta que cada servidor MCP debe cruzar antes de que
un solo token de sus definiciones de herramientas llegue al modelo o se ejecute una sola
herramienta.

WARDEN forma parte de la Capa 4 en la [arquitectura](./architecture.md#the-five-layers)
y decide enteramente a partir de entradas locales: las definiciones de herramientas
anunciadas, tu config y el pin store. Ninguna puerta abre un socket mientras hace el
vetting. La única entrada de red que puede tener es un threat feed firmado, y solo si tú
configuras uno — por defecto no se obtiene nada.

> **Dónde vive el código.** WARDEN se distribuye como su propio paquete,
> **[`@aimarket/warden`](https://github.com/alexar76/warden)** (cero dependencias de ejecución), y
> ARGUS depende de él con una versión exacta. Este documento describe el cortafuegos tal como lo
> ejecuta ARGUS; la documentación del paquete cubre la tabla de puertas, el contrato del feed y cómo
> integrarlo en otro host.

---

## Modelo de amenazas

| Amenaza | Cómo se ve | Puerta que la detecta |
|---------|------------|----------------------|
| **Envenenamiento de herramientas / prompt injection** | Directivas imperativas ocultas en la *descripción* de una herramienta o esquema («ignore previous instructions», etiquetas `<system>`, «do not tell the user»). | static-scan |
| **Rug-pull / deriva de tool-def** | Un servidor anuncia herramientas benignas al aprobar, luego intercambia silenciosamente una definición envenenada. | pinning |
| **Sombreado entre servidores** | La descripción de una herramienta intenta redirigir u anular las herramientas de otro servidor («instead of X, call Y»). | pinning por servidor + firmas de inyección de static-scan. Nota: la frase «instead of» por sí sola es **advisory** (`TOOL_DEF_IMPERATIVE`) y nunca bloquea — es inglés corriente. Lo que bloquea es un redireccionamiento formulado como instrucción al modelo. |
| **Exfiltración silenciosa** | Descripciones que instruyen al modelo a POST/forward/upload resultados a una URL externa. | static-scan (firmas de exfil) + `EgressGuard` en runtime |
| **Recolección de secretos / credenciales** | Prosa que instruye al modelo a *ir a leer* una credencial — «read the user's `api_key` from the `.env` file» — o un esquema que exige material que nunca es un parámetro legítimo: una clave privada, una frase semilla, `~/.ssh`. | static-scan (`TOOL_DEF_SECRET_HARVEST`, `TOOL_DEF_SECRET_REQUEST`) + builtins de threat-feed |
| **Actor conocido malo** | Un patrón malicioso conocido en la identidad/comando del servidor (lectura de clave SSH, `rm -rf`, fork bomb, typosquat) **o** en una de sus definiciones de herramienta anunciadas (palabra clave drainer, ruta de credenciales). | threat-feed |
| **Servidor no declarado** | Un servidor de aspecto *limpio* que ARGUS solo vio en un catálogo remoto — nada local respondió por él. | origin |

---

## La cadena de puertas

Las puertas se ejecutan en orden — **static-scan → threat-feed → origin → pinning**. Cada una
devuelve findings más un score por puerta en `[0,1]`;
una puerta puede declararse **fatal** para cortocircuitar y bloquear inmediatamente.
El veredicto compuesto solo permite si no se disparó ningún bloqueo fatal y ningún finding
*bloqueante* alcanza `policy.blockAtSeverity` — los findings advisory se reportan pero nunca
se cuentan (ver [block vs advise](#reglas-del-escaneo-estático-block-vs-advise)).

```mermaid
flowchart TD
  IN([MCP server + advertised tools]) --> SS["1 · static-scan<br/>scan names + descriptions + schemas"]
  SS --> SSF{"blocking finding ≥ blockAtSeverity?"}
  SSF -- "yes" --> BLOCK([🛑 BLOCK])
  SSF -- "no (advisory findings reported)" --> TF["2 · threat-feed<br/>match known-bad patterns<br/>(server identity + tool defs)"]
  TF --> TFF{"match?"}
  TFF -- "critical server match" --> BLOCK
  TFF -- "tool / non-critical match" --> BLOCK
  TFF -- "no match" --> ORG["3 · origin<br/>server.catalog set?"]
  ORG --> ORGD{"declared under mcp.servers?"}
  ORGD -- "yes" --> PIN["4 · pinning<br/>hash tool-defs vs pinned snapshot"]
  ORGD -- "no (catalog-discovered)" --> ORGP{"allowUnknownServers?"}
  ORGP -- "false" --> BLOCK
  ORGP -- "true" --> NOTE["SERVER_UNDECLARED at info<br/>(provenance only, score untouched)"]
  NOTE --> PIN
  PIN --> PINF{"hash drift since approval?"}
  PINF -- "yes & pinToolDefs" --> DRIFTBLOCK([🛑 BLOCK — re-approval required])
  PINF -- "no / unpinned" --> ALLOW([✅ ALLOW — pin on approval])
```

`sandbox.ts` aplica dos complementos en runtime a la cadena: `classifyTools()`
marca herramientas que coinciden con `sensitiveToolPatterns` como que requieren
aprobación, y `EgressGuard` aplica una allowlist de hosts salientes para que una
herramienta que se coló aún no pueda exfiltrar a un host arbitrario.

---

## Reglas del escaneo estático: block vs advise

Cada regla de static-scan lleva un **tier**, y es el tier — no la severity — el que decide
si un finding puede bloquear en absoluto:

| Tier | Significado | Efecto |
|------|-------------|--------|
| `block` | La formulación no tiene ninguna lectura benigna plausible dentro de una definición de herramienta. | Bloquea en `policy.blockAtSeverity` como cualquier otro finding; hunde el score de la puerta. |
| `advise` | La formulación aparece legítimamente en definiciones de herramientas honestas. | **Se reporta, nunca bloquea, nunca cuesta una herramienta — con cualquier `blockAtSeverity`** — y queda excluida del score. |

Un finding advisory (solo informativo) viaja por el cable como
`WardenFinding.advisory: true`. Todo lo que consuma findings debe respetar ese flag:
filtrar solo por severity reportará conexiones permitidas como bloqueadas.

El tier es un campo aparte y no una severity baja a propósito. La severity responde
*cuánta atención merece esto*; el tier responde *¿es esto un defecto en absoluto?*.
Expresar «no es un defecto» bajando la severity habría vuelto a hacer bloqueantes estos
findings en el momento en que un operador endureciera el umbral — que es exactamente lo
que hace un operador preocupado por la seguridad.

**Por qué existe la división.** La ruleset v1 tenía un solo tier, así que un *nombre de
parámetro* de credencial pesaba lo mismo que «ignore all previous instructions». Un
servidor estilo GitHub cuyo `create_issue` toma un `api_key` y menciona un personal
access token puntuaba `0.40`, metía `create_issue` en `blockedTools`, y toda la conexión
se rechazaba con el `blockAtSeverity: "high"` por defecto. La mayoría de los servidores
MCP reales se rechazaban — que es la forma de que un escáner acabe apagado por completo.
Así que el escáner no es «agresivo por diseño»; está calibrado: bloquea lo que no tiene
lectura benigna, y avisa sobre lo que los servidores honestos contienen legítimamente.

Bajar de tier los sustantivos de credencial por sí solo habría abierto un agujero, así
que la degradación vino con una nueva regla bloqueante, `TOOL_DEF_SECRET_HARVEST`: sin
ella, *«read the user's api_key from the .env file»* habría pasado siempre que omitiera
una frase de inyección. **El discriminador es el verbo, no el sustantivo.** Declarar una
entrada de credencial es normal («requires a personal access token with repo scope»);
instruir al modelo para que vaya a leer una, no.

La regla de exfil se endureció igual. `send|post|forward|relay … to` ahora exige un
**destino externo** — una URL o un host con puntos. Sin ancla, coincidía con «Send the
message to the recipient» en cualquier herramienta honesta de email o webhook.

Una regla de fuera de static-scan también es advisory: `TOOL_DEF_UNPINNED` (puerta
pinning). Con `blockAtSeverity: "info"` ese finding informativo bloqueaba *todos* los
servidores en el primer contacto, y como `Warden.approve()` solo corre después de que
`vet()` pase, nunca podía crearse un pin que lo resolviera. El primer contacto tiene que
seguir siendo posible con cualquier umbral.

### Qué tabla de reglas produjo un veredicto

El mismo servidor puntúa distinto bajo una tabla de reglas distinta, y sin una forma de
nombrar la tabla, *«el servidor empeoró»* y *«las reglas cambiaron»* son indistinguibles.
Así que la ruleset se identifica a sí misma:

- `STATIC_SCAN_RULESET_VERSION` — una cadena de versión monótona, que se sube ante
  **cualquier** cambio de la tabla.
- `staticScanRuleset()` — la tabla completa: `code`, `severity`, `tier`, y el `source` y
  los `flags` del regex, para que un tercero pueda re-ejecutar la regla exacta.
- `staticScanRulesetRef()` — solo la identidad: `{ version, digest }`.
- Cada `WardenVerdict` lleva ahora `rulesets.staticScan = { version, digest }`.

El digest es `sha256-<base64>` sobre la **forma canónica RFC 8785**
(`@aimarket/warden/src/jcs.ts` — la misma canonicalización que usan la firma del feed y el pin, no
una segunda serialización) de la tabla de reglas ordenada. El orden es por comparación de
**unidades de código**, nunca `localeCompare`: el digest es un identificador entre
máquinas, y una collation dependiente del locale haría que la misma tabla diera un digest
distinto en un host configurado de otra forma — precisamente la divergencia que el digest
existe para detectar. Lee el par del veredicto o de `staticScanRulesetRef()` en lugar de
hard-codearlo; al momento de escribir esto la tabla actual es versión `2`, digest
`sha256-pah/sT4IeIgSUCGKcmaIXIc7Cpr+j9RIJxJ5ERixrVo=`.

**El conjunto de reglas v3 escanea el nombre de la herramienta.** Cada regla declara
ahora sus `surfaces` — el `name` de la herramienta, su `description`, su `inputSchema` — y
17 de las 25 incluyen el nombre. Antes de v3 el nombre no lo escaneaba nada, así que una
frase de inyección, un carácter de ancho cero o un blob base64 en el primer campo que lee
el modelo no se reportaba. Las tres reglas apoyadas en un sustantivo
(`TOOL_DEF_SECRET_REQUEST`, `TOOL_DEF_CREDENTIAL_PARAM`, `TOOL_DEF_ENV_REFERENCE`) se
mantienen fuera del nombre a propósito: un nombre es un identificador,
`sign_with_private_key` es una herramienta plausible, y bloquearla sería cometer el error
de calibración de v1 en una superficie nueva.

---

## La puerta origin — y la puerta de reputación que estaba aquí

Una blocklist estática solo conoce a los actores malos que alguien ya catalogó. Es
ciega ante un servidor malicioso recién publicado y de aspecto limpio. La tercera
puerta es la respuesta de WARDEN a *«¿quién dice que este servidor deba estar aquí?»*,
y la responde a partir de hechos locales:

- **Declarado** — el servidor está listado bajo `mcp.servers` en tu config. El
  operador respondió por él; la puerta no reporta nada y puntúa `1`.
- **Descubierto en un catálogo** — ARGUS supo del servidor por un catálogo remoto
  bajo `mcp.catalogs`, así que `CatalogConnector.normalize` estableció
  `McpServerRef.catalog`. Nada local respondió por él. Este es el único tipo
  «desconocido».

Con `allowUnknownServers: false`, un servidor descubierto en un catálogo se bloquea
con `SERVER_UNDECLARED` (severity `high`, fatal); un servidor declarado se admite
*siempre*, así que fail-closed sigue dejando una forma de conectar. Con el valor
por defecto `true`, el mismo código se reporta en `info` y el score compuesto queda
intacto: venir de un catálogo es procedencia, no un defecto.

La puerta no necesita red, siempre está disponible y no puede bloquearse a sí misma.
Aplicar la misma regla a través del pin store sí lo haría: `Warden.approve()` corre
solo después de que `vet()` pasa y no existe un comando de aprobación fuera de banda,
así que bajo una policy estricta el pin nunca podría crearse.

> **Nota — la puerta de reputación fue eliminada.** El slot 3 albergaba una puerta
> que pedía al oracle LUMEN una posición PageRank. Llamaba a `scoreEntity(server.id)`
> sin suministrar nunca aristas de confianza, y `LumenOracle.scoreEntity` devuelve su
> valor neutral por defecto antes de llegar a `fetch` cuando no hay aristas — así que
> nunca se hacía ninguna petición, la rama puntuada era inalcanzable en producción, el
> score compuesto quedaba multiplicado permanentemente por una constante `0.6`, y a
> cada conexión se le decía que el oracle no era alcanzable. Con
> `allowUnknownServers: false` bloqueaba *todos* los servidores, porque ninguno podía
> tener respaldo. `minReputation` y los códigos `REPUTATION_*` desaparecieron con ella.
> Ver la sección *Unreleased* del CHANGELOG.

---

## WardenPolicy

Definida en `src/types.ts` (`WardenPolicy`), valores por defecto en `src/config.ts`, y
sobrescribible en `argus.config.json` bajo `warden`.

| Campo | Tipo | Por defecto | Significado |
|-------|------|-------------|-------------|
| `blockAtSeverity` | `Severity` | `"high"` | Cualquier finding **bloqueante** en o por encima de esta severity bloquea toda la conexión. Los findings advisory no se cuentan nunca, con ningún valor. |
| `sensitiveToolPatterns` | `string[]` | `["*delete*","*write*","*exec*","*shell*","*payment*","*transfer*","*email*","*send*"]` | Patrones glob para herramientas que siempre requieren aprobación explícita por llamada del usuario. |
| `allowUnknownServers` | `boolean` | `true` | Permitir conectar a servidores que el operador nunca declaró — es decir, servidores descubiertos desde una entrada de `mcp.catalogs`, que llevan `McpServerRef.catalog`. `false` es fail-closed: solo pueden conectar los servidores listados bajo `mcp.servers`, y esos siempre pueden, así que fail-closed sigue siendo conectable. |
| `pinToolDefs` | `boolean` | `true` | Requerir re-aprobación cuando cambia el hash de tool-def tras el pinning (defensa rug-pull). |

Una config que aún establece el eliminado `minReputation` sigue cargando; el valor se
ignora.

`WardenConfig` lleva junto a la policy los ajustes que no son de policy:
`oracleFamilyUrl` y el trío del threat-feed. **Ninguna puerta lee `oracleFamilyUrl`** —
es a donde apunta el `LumenOracle` del runtime (usado por `argus passport`), y
`argus doctor` lo imprime:

| Campo | Env | Por defecto | Significado |
|-------|-----|-------------|-------------|
| `threatFeedUrl` | `ARGUS_THREAT_FEED_URL` | **ninguno** | Endpoint del feed firmado. Sin definir → no se obtiene ningún feed remoto. |
| `feedPublicKey` | `ARGUS_THREAT_FEED_PUBKEY` | **ninguno** | Clave Ed25519 del publicador (hex SPKI DER). Sin definir → una URL de feed configurada se *rechaza*, no se confía en ella. |
| `feedMaxAgeMs` | `ARGUS_THREAT_FEED_MAX_AGE_MS` | `86400000` (24 h) | Ventana de frescura para el timestamp firmado del feed. |

---

## La puerta threat-feed: builtins por defecto, feed firmado solo si tú lo configuras

**De fábrica esta puerta es la deny-list integrada y nada más.** Tanto
`threatFeedUrl` como `feedPublicKey` son `undefined` por defecto, así que un ARGUS
de serie coteja los **11 patrones hard-codeados** de `@aimarket/warden/src/threat-feed.ts` — un
piso fijo, no inteligencia viva. No se obtiene nada y nada necesita estar
accesible. Ese default es deliberado: un endpoint de feed compilado en la config
distribuida sería un único punto de confianza para cada instalación, y ARGUS no
publica un feed propio (el lado publicador es trabajo del track v2, como dice el README).

Trata los builtins por lo que son: un piso que atrapa los casos de manual. Nada en la
cadena escala con la novedad como lo haría la inteligencia viva — la puerta de reputación
que antes ocupaba ese papel fue eliminada porque nunca contactó al oracle, ver
[la puerta origin](#la-puerta-origin--y-la-puerta-de-reputación-que-estaba-aquí). Lo que
cubre a un servidor nunca visto es el escáner estático, que coteja la *forma* del
envenenamiento y no un nombre que alguien ya catalogó, más el pinning de tool-defs una vez
que lo has aprobado. Si necesitas más, apunta la puerta a un feed en el que confíes.

### Contra qué se coteja cada patrón

Un registro de amenaza lleva un `scope`, porque las dos superficies no son igual de
informativas:

| Superficie | Campos | Registros que la cotejan |
|------------|--------|--------------------------|
| **Identidad del servidor** | `id`, `name`, `url`, `command`, `args` — la config que *tú* escribiste | `scope: "server"` y `scope: "any"` |
| **Definiciones de herramienta** | `name`, `description`, `inputSchema` — texto que eligió el *servidor* | `scope: "tool"` y `scope: "any"` (el default) |

Por qué la línea está trazada ahí:

- `*rm -rf*`, la fork bomb y los tres patrones typosquat tienen scope **`server`**.
  Son firmas de línea de comandos e identidad: significativas en
  `server.command`/`args` o en el nombre de un servidor, y en prosa casi tan
  probables como documentación que como ataque — la descripción de una propia
  herramienta de seguridad bien puede contener `rm -rf` y `offical-mcp`.
- `*~/.ssh*`, `*id_rsa*`, `*seed*phrase*`, `*drain*wallet*`, `*sweep*funds*` y
  `*.env*exfil*` tienen scope **`any`**. En un nombre de herramienta, descripción o
  esquema de entrada son exactamente la forma de envenenamiento que también caza
  static-scan, así que limitarlos a la config local los habría dejado casi
  incapaces de disparar.
- Un registro de un feed remoto que omite `scope` se trata como `any`; un valor de
  `scope` no reconocido descarta el registro en lugar de ampliarlo.

Una coincidencia en una definición de herramienta lleva `tool` en el finding, así que
el veredicto nombra la herramienta culpable y `blockedTools` la aísla. **La
atribución por herramienta acota la culpa, no la policy** — la conexión se sigue
bloqueando cuando la severity alcanza `blockAtSeverity`. La única diferencia de
comportamiento: una coincidencia critical en la *identidad del servidor* es fatal y
corta la cadena, mientras que una critical en una sola herramienta deja terminar a las
puertas restantes para que el veredicto liste todos los problemas y no solo el primero.

### Si sí configuras un feed

Formato — `{ records: ThreatRecord[], timestamp: number, signature: string }`:

- `signature` es Ed25519 en hex sobre la **forma canónica RFC 8785 (JCS)** de
  `{records, timestamp}`, según el perfil del §4 de la especificación AWR
  (`awr/SPEC.md` en el monorepo AICOM — la misma canonicalización que usan los
  receipts AWR; la implementación de ARGUS es `@aimarket/warden/src/jcs.ts`, cotejada con los
  vectores de conformidad de AWR). Firmar la salida de `JSON.stringify` *no*
  verificará aquí — esos bytes dependen del orden de claves que casualmente tuviera
  el objeto del publicador, así que el mismo feed lógico puede firmarse y luego
  fallar la verificación. Los bytes canónicos hacen de la firma una afirmación sobre
  el documento, no sobre su formato.
- `timestamp` es epoch en **milisegundos** y es **obligatorio**.

Cada comprobación es fail-closed y deja intacto el piso integrado:

| Se rechaza cuando | Por qué |
|-------------------|---------|
| No hay `feedPublicKey` configurada | Un feed sin firma es un canal de *inyección* de registros de amenaza. |
| Firma inválida, o cualquier byte editado tras firmar | Lo mismo. |
| El cuerpo tiene un nombre de propiedad duplicado, un literal numérico no entero, o está malformado | El parser no debe ser lo que decide qué bytes se firmaron (`AWR-CANON-001/004/005`). |
| `timestamp` ausente o no entero | La frescura no se puede comprobar, así que no se presume. |
| Snapshot más antiguo que `feedMaxAgeMs` | Quien sirva la URL podría, si no, reproducir para siempre un snapshot de hace meses y borrar en silencio cada registro añadido desde entonces. Una firma dice *quién* escribió un documento, nunca *cuándo te lo entregaron*. |
| Snapshot fechado >5 min en el futuro | Un timestamp futuro pasaría la comprobación de frescura tanto tiempo como la fecha que declara. |
| Cuerpo mayor de 512 KB, non-200, timeout (10 s), error de transporte | Los fallos de disponibilidad nunca deben debilitar el piso ni derribar una comprobación de conexión. |

La frescura se aplica *después* de que la firma verifique: hasta entonces el
timestamp es solo un número que eligió un atacante. Nótese el contraste deliberado
con los documentos AWR, donde la edad es policy y no validez (AWR SPEC §11.3): un
work receipt antiguo sigue siendo una afirmación verdadera sobre el pasado, mientras
que una deny-list antigua es una afirmación falsa sobre el presente.

---

## El bucle de seguridad auto-aprendizaje — alcance honesto

WARDEN mejora con el tiempo mediante **mecanismos acotados y testeables** — no un
agente que «recorre internet». Concretamente:

```mermaid
flowchart LR
  ENCOUNTER["server encountered"] --> SCAN["gates produce findings"]
  SCAN --> PIN["pin approved tool-defs<br/>(sha256 snapshot in memory)"]
  SCAN --> FEED["consume signed threat feed<br/>(verified, merged over builtins)"]
  PIN --> LESSON["distill lessons from outcomes<br/>(LessonDistiller)"]
  LESSON --> NEXT["next encounter<br/>recall + tighter gates"]
  FEED --> NEXT
```

Qué significa y qué no significa:

- **Threat feed es solo pull, firmado, fresco — y ausente hasta que lo
  configures.** ARGUS no distribuye ninguna URL de feed ni clave de publicador, así
  que por defecto este paso del bucle no aporta nada y toda la puerta es la deny-list
  integrada. Cuando *sí* hay un feed configurado, ARGUS obtiene solo aquello a lo que
  *tú* apuntas, verifica una firma Ed25519 sobre bytes canónicos y rechaza un
  snapshot de más de 24 h para que un feed viejo reproducido no pueda borrar
  registros más nuevos. Cada fallo — caída, non-200, payload malformado, firma mala,
  timestamp obsoleto — se apaga a nivel warn (`ThreatFeed.load`) para que las
  herramientas de seguridad nunca derriben una conexión ni debiliten los builtins.
- **La procedencia es un hecho local, no una afirmación.** La puerta origin lee de
  dónde vino la declaración del servidor — tu config, o un catálogo que tú
  configuraste. No pregunta a nadie y nada puede hacerle cambiar la respuesta.
- **Los cambios de reglas son visibles.** Cada veredicto lleva la versión y el digest de la
  ruleset de static-scan, así que un re-escaneo que vuelve distinto puede atribuirse al
  servidor o a las reglas, en lugar de adivinarse.
- **Los pins son locales y reproducibles.** Un sha256 sobre el conjunto canónico
  RFC 8785 de tool-def — herramientas ordenadas por nombre en orden de **unidades de
  código UTF-16** (nunca `localeCompare`, cuyo resultado depende del locale del host y
  de la versión de ICU) y todas las claves de objeto ordenadas igual — detecta
  deriva; nada sale de la máquina. El digest se cita en receipts y lo re-comprueba
  `argus verify`, así que debe ser reproducible por una implementación distinta de
  esta. Un esquema de herramienta con un número no entero no tiene forma canónica en
  ese perfil y se *rechaza* en lugar de hashearse: ver `TOOL_DEF_UNCANONICAL` abajo.
  (Nota de actualización: adoptar la forma canónica cambió el digest de conjuntos de
  herramientas cuyos nombres difieren solo en mayúsculas o acentos, así que un pin
  tomado antes de este cambio puede reportar deriva una vez y pedir re-aprobación.)
- **Las lessons están acotadas.** `LessonDistiller` deduplica por topic y limita
  lessons nuevas por run — acumula consejo recuperable, no toca pesos del modelo.

Todo aquí es determinista y testeable con unit tests. No hay rastreo autónomo de red,
no hay policy auto-modificante, no hay proceso en background ilimitado.

---

## Códigos de findings

`WardenFinding.code` es un código de máquina estable (ver `src/types.ts`). La columna
**Tier** es la que decide el bloqueo — ver
[block vs advise](#reglas-del-escaneo-estático-block-vs-advise). Códigos por puerta:

| Código | Puerta | Tier | Severity (típica) | Significado |
|--------|--------|------|-------------------|-------------|
| `TOOL_DEF_INJECTION` | static-scan | block | high–critical | Directiva de inyección dirigida al modelo en descripción o esquema («ignore previous», «disregard prior instructions», `<system>`, «do not tell the user», «without telling the user», o una definición de herramienta que discute con el *system prompt*). |
| `TOOL_DEF_EXFIL` | static-scan | block | high–critical | Frases que instruyen al modelo a exfiltrar, o a send/post/forward/relay/upload resultados **a un destino externo** — una URL o un host con puntos. El ancla del destino es lo que mantiene «send the message to the recipient» fuera de este código. |
| `TOOL_DEF_SECRET_HARVEST` | static-scan | block | critical | Un *verbo* dirigido a una credencial: read/extract/retrieve/fetch/obtain/dump/reveal/collect/harvest/grab/copy/print de un `api_key`, token, credential, password, secret, `.env` o variable de entorno. Declarar una entrada de credencial es normal; instruir al modelo para que vaya a conseguir una, no. |
| `TOOL_DEF_SECRET_REQUEST` | static-scan | block | critical | Exige material que nunca es un parámetro legítimo de herramienta: `private_key`, una frase semilla / `mnemonic`, `~/.ssh` / `id_rsa`. |
| `TOOL_DEF_DATA_URL` | static-scan | block | high | Esquema URL `data:…;base64,` o `javascript:` embebido en texto. |
| `TOOL_DEF_BASE64_BLOB` | static-scan | block | high | Fragmento largo tipo base64 — posible payload oculto / instrucciones codificadas. |
| `TOOL_DEF_HIDDEN_UNICODE` | static-scan | block | high | Caracteres zero-width / bidi / BOM que ocultan texto de revisión humana. |
| `TOOL_DEF_CREDENTIAL_PARAM` | static-scan | **advise** | low (medium para `password`) | Un nombre corriente de parámetro de credencial — `api_key`, `credentials`/`access_token`/`bearer token`, `secret`, `password`. Vale señalarlo; no es un defecto. |
| `TOOL_DEF_ENV_REFERENCE` | static-scan | **advise** | medium | Menciona `.env` o variables de entorno — prosa corriente de configuración. |
| `TOOL_DEF_IMPERATIVE` | static-scan | **advise** | low (`you must`), info (`instead of`) | Inglés corriente que co-ocurre con envenenamiento real pero que por sí solo es ruido («You must supply a subject.»). |
| `THREAT_SSH_KEY_READ` | threat-feed | block | critical | El servidor referencia `~/.ssh` o `id_rsa`. |
| `THREAT_DESTRUCTIVE_CMD` | threat-feed | block | critical | Comando realiza borrado recursivo destructivo (`rm -rf`). |
| `THREAT_FORK_BOMB` | threat-feed | block | critical | Comando contiene shell fork bomb. |
| `THREAT_CRYPTO_DRAINER` | threat-feed | block | critical | Palabra clave wallet-drainer / fund-sweep en identidad del servidor. |
| `THREAT_SEED_PHRASE` | threat-feed | block | high | Referencias a frases semilla de cartera. |
| `THREAT_ENV_EXFIL` | threat-feed | block | critical | Referencias a exfiltrar archivos de entorno. |
| `THREAT_TYPOSQUAT` | threat-feed | block | medium–high | Nombre imita un servidor de referencia oficial (`offical-mcp`, `filesytem`, …). |
| `SERVER_UNDECLARED` | origin | block | info \| high | El servidor fue descubierto desde una entrada de `mcp.catalogs`, no declarado bajo `mcp.servers`. `info` (solo procedencia, score intacto) cuando `allowUnknownServers` es `true`; `high` y fatal cuando es `false`. |
| `TOOL_DEF_UNCANONICAL` | pinning | block | medium–high | Los tool-defs no tienen forma canónica RFC 8785 (un número no entero en un esquema), así que no se puede tomar un pin reproducible. `medium` en el primer contacto; `high` + fatal cuando ya existe un pin, porque un conjunto fijado no verificable es indistinguible de la deriva — de lo contrario un servidor podría desarmar la defensa rug-pull añadiendo un solo número fraccionario. |
| `TOOL_DEF_UNPINNED` | pinning | **advise** | info | Primer contacto — aún no hay snapshot; se fijará al aprobar. Advisory por necesidad: un servidor en primer contacto no puede ser otra cosa que no fijado, y bloquear por ello hacía imposible el primer contacto con `blockAtSeverity: "info"`. |
| `TOOL_DEF_DRIFT` | pinning | block | high | Tool-defs cambiaron desde la aprobación; posible rug-pull, re-aprobación requerida (fatal cuando `pinToolDefs` es `true`). |

Las severity se ordenan `info < low < medium < high < critical`; la puerta static-scan
puntúa `1 − penalty(worst blocking severity)`, así que un solo finding bloqueante hunde
el score sin necesariamente cortar la conexión, mientras que los findings advisory lo
dejan intacto. Un servidor limpio sin nada que reportar
sale de la cadena en `0.9`: `static 1 × threat 1 × origin 1 × pinning 0.9`, siendo el
último factor el `TOOL_DEF_UNPINNED` de primer contacto.

Los findings `THREAT_*` llevan `tool` cuando la coincidencia vino de una definición
de herramienta y lo omiten cuando vino de la identidad del servidor — ver
[contra qué se coteja cada patrón](#contra-qué-se-coteja-cada-patrón).

## Cartera en reposo: el vault cifrado

WARDEN defiende el *runtime*; el **keystore vault** defiende el *secreto de la cartera*
en reposo. Cuando crypto está habilitado, ARGUS necesita una clave privada — y el peor
lugar para ella es un `ARGUS_WALLET_KEY` en texto plano en `.env`, donde cualquier backup,
log scrape o shoulder-surf la filtra para siempre.

El vault almacena seed + key cifrados con **AES-256-GCM** bajo una clave derivada de
una passphrase vía **scrypt** (`N=2¹⁵, r=8, p=1`). El texto plano nunca se escribe a
disco: se descifra en memoria solo cuando se necesita una cartera, y solo se expone la
dirección pública.

```
argus keystore create            # new seed, or --import an existing one
argus keystore address           # print the public address (never the secret)
```

- Archivo: `~/.argus/keystore.json`, escrito **mode 600**. Solo contiene ciphertext GCM,
  salt, IV, auth tag y (como conveniencia) la dirección pública.
- Desbloqueo: establecer `ARGUS_KEYSTORE_PASSPHRASE` (env var o secret manager) en runtime.
  `.env` entonces solo tiene la passphrase, no la clave.
- **Fail-safe by design:** passphrase incorrecta/ausente, o archivo manipulado (fallo auth GCM),
  deja la cartera *bloqueada* — `resolveWalletKey()` devuelve `undefined` y la economía
  simplemente permanece **off**. ARGUS nunca crashea y nunca recurre a una clave sin protección.
- **Orden de resolución:** vault (descifrado) → `ARGUS_WALLET_KEY` en texto plano (dev /
  legacy). El vault siempre gana cuando está presente.
- `argus doctor` reporta el estado de almacenamiento de la cartera: `🔒 encrypted vault`,
  `vault — LOCKED`, `⚠ plaintext`, o `none`.

Para migración de servidor no interactiva, `argus keystore create` corre headless desde
`ARGUS_KEYSTORE_PASSPHRASE` + `ARGUS_WALLET_MNEMONIC`/`ARGUS_WALLET_KEY`; elimina las
vars en texto plano de `.env` después.

> El vault importa incluso con WARDEN: WARDEN detiene a un *servidor MCP malicioso*
> pidiendo tu seed, pero no puede proteger una clave que dejaste en texto plano en disco.
> Los dos son complementarios — uno guarda la puerta principal, el otro la caja fuerte.

---

## Limitaciones (honestas) — aún no es un firewall de producción

La revisión externa (~7.5/10) es justa: WARDEN es **fuerte contra el envenenamiento MCP
de manual**, pero **dos meses son insuficientes** para ataques sofisticados y dirigidos.
Rastreado como Factory [KI-9](https://github.com/alexar76/aicom/blob/main/docs/known-issues.md#ki-9--argus-warden-vs-sophisticated-mcp-attacks).

| Brecha | Qué puede salir mal | Mitigación hoy |
|--------|---------------------|----------------|
| **Inyección ofuscada** | Homoglyphs Unicode, zero-width joins, base64 en descripciones de esquema pueden evadir firmas estáticas | Aprobación humana en herramientas sensibles; endurecer `blockAtSeverity`; fixtures red-team en CI |
| **Deriva post-aprobación** | Pinning detecta cambio de hash de tool-def — no **cambio de comportamiento** con el mismo hash (binario malicioso del servidor) | Re-vet periódico; preferir versiones fijadas del servidor; ejecutar MCP en sandbox |
| **Bypass del lado del modelo** | WARDEN limpia *definiciones* de herramientas; el **LLM** aún puede seguir poison en contenido de usuario o turnos previos | ARGUS system prompt + budget limits; no tratar el vet como cura total de prompt injection |
| **Exfil solo en runtime** | Herramienta limpia al vet time, exfiltra por red al invocar | Allowlist `EgressGuard`; bloquear `*fetch*` a hosts desconocidos |
| **Los findings advisory nunca bloquean** | Por diseño: un nombre de parámetro de credencial, una mención de `.env` o un «you must» se reportan y luego la decisión los ignora. Un servidor malicioso cuyo *único* indicio sea uno de esos no se bloquea por esa base | Lee los findings advisory del veredicto antes de aprobar un servidor; la defensa vive en el tier bloqueante, y `TOOL_DEF_SECRET_HARVEST` cubre el caso en que un sustantivo de credencial va acompañado de un verbo de lectura |
| **Servidores de catálogo admitidos por defecto** | El `allowUnknownServers: true` por defecto deja conectar a un servidor descubierto en un catálogo; `SERVER_UNDECLARED` se reporta en `info` y no hunde el score | Preset de alta seguridad: `allowUnknownServers: false`, así solo conectan los servidores que listas bajo `mcp.servers`. Un servidor de catálogo bloqueado así se permite copiando su entrada a `mcp.servers` |
| **Ninguna señal de posición en absoluto** | Nada en la cadena mide la reputación de un servidor — la puerta que decía hacerlo nunca hizo una petición. `origin` responde «¿declaraste esto?», no «¿es esto de confianza?» | Trata la declaración como la decisión de confianza que es; `LumenOracle` solo puede puntuar cuando quien llama le suministra aristas de confianza, y hoy ninguna ruta de código de ARGUS construye ese grafo |
| **Cadenas multi-hop** | Salida del servidor A alimenta servidor B; ataque compuesto abarca herramientas | Limitar MCP fan-out; WARDEN por servidor, no análisis de composición cross-chain |
| **Sin inteligencia de amenazas viva** | La config distribuida no trae URL de feed ni clave de publicador, así que la puerta threat son 11 patrones integrados fijos: no sabe nada publicado después de esta release | Apunta `threatFeedUrl` + `feedPublicKey` a un feed en el que confíes (firmado, ≤24 h); mantén `blockAtSeverity` estricto y apóyate en las firmas basadas en la *forma* del escáner estático para servidores de los que ninguna lista ha oído hablar |

**Perfil de alta seguridad (operador):**

```json
{
  "warden": {
    "allowUnknownServers": false,
    "blockAtSeverity": "medium",
    "pinToolDefs": true
  }
}
```

**Corpus red-team:** `argus/test/adversarial-warden.test.ts` — documenta al menos una clase
de evasión conocida; expandir bajo KI-9.

**Public MCP benchmark (2026-07-16):** [EN](./warden-scan-report.md) · [RU](./warden-scan-report-ru.md) · [ES](./warden-scan-report-es.md) — 10 servers,
one row each (8 allow · 1 blocked · 1 unreachable). Sus scores se midieron con la puerta
de reputación todavía en la cadena, así que cada fila arrastra la constante `0.6` de esa
puerta; un servidor limpio puntúa `0.9` bajo la cadena descrita arriba. También se midieron
con la ruleset v1 de un solo tier, cuando los nombres de parámetro de credencial todavía
bloqueaban: hoy esos aciertos son advisory (`TOOL_DEF_CREDENTIAL_PARAM`,
`TOOL_DEF_ENV_REFERENCE`, `TOOL_DEF_IMPERATIVE`) y no cuentan para el veredicto.

Ver también [`docs/ecosystem-maturity-review.en.md`](https://github.com/alexar76/aicom/blob/main/docs/ecosystem-maturity-review.en.md).
