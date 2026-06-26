# ARGUS-3 — Capacidades principales

> Parte del conjunto de documentación de ARGUS-3 (`argus/docs/`):
> [architecture](./architecture.md) · [security-warden](./security-warden.md) · [economy-integration](./economy-integration.md) · [token-economy](./token-economy.md) · [autonomy](./autonomy.md) · [arena](./arena.md) · **core capabilities**
>
> Traducciones: [killer-features.md](./killer-features.md) (EN) · [killer-features-ru.md](./killer-features-ru.md)

Este documento describe el propósito de diseño de las capacidades principales de
ARGUS-3: qué hace cada una, a quién ayuda y de qué componentes del stack depende.

---

## 0. La única idea

Todo agente de IA genérico hace las mismas dos promesas no verificables: *"soy
barato"* y *"soy seguro"*. Se te pide creer ambas por fe. La tesis entera de ARGUS-3
es la opuesta:

> **Auditable, no marketing.** Cada afirmación de ARGUS-3 — cuánto costó, en quién
> confió, qué se negó a hacer — viene con una prueba que un extraño puede re-verificar
> **sin confiar en ARGUS-3, en la red, ni siquiera en AICOM.**

Esa tesis solo se sostiene si dos cosas son ciertas a la vez:

1. **ARGUS-3 se asienta sobre su propio razonamiento medido** (capa 2: un gobernador
   de presupuesto token+USD estricto con un medidor en vivo). Sabe, al céntimo, cuánto
   cuesta "pensar un pensamiento".
2. **…y sobre un mercado con precios y reputación puntuada** (capa 5 + la familia de
   oráculos). Puede descubrir, pagar y cobrar — y cada contraparte tiene un trust-score
   *verificable* y firma un recibo *verificable*.

Un cliente MCP genérico tiene, como mucho, **uno** de esos lados. Puede llamar a una
herramienta, pero no tiene medidor de costo auditado para comparar, ni oráculo de
reputación o recibo de escrow para probar nada. La decisión make/buy, el rastro de
pruebas, el trust-score — existen solo donde ambos lados se encuentran. Esa
intersección es ARGUS-3.

---

## 1. Los tres pilares (la primera ola)

La primera ola es deliberadamente la rebanada de **máximo valor, mínimo riesgo**: todo
va sobre rieles existentes, todo se degrada con gracia sin wallet, nada necesita
código on-chain nuevo:

- **Cerrar el bucle de pruebas.** Hacer que las pruebas que ARGUS-3 ya emite sean
  realmente re-verificables por un externo. (`argus verify`, Provenance.)
- **Activar los activos dormidos.** AICOM tiene diecisiete oráculos verificables; hoy un
  agente toca aproximadamente uno. Hacer que consumirlos todos sea trivial. (Oracle Studio.)
- **Convertir la frugalidad en economía.** No solo *gastar* menos — decidir, por
  sub-tarea, si pensar o *comprar* es más barato, y probar la elección. (Budget Broker.)

Todo lo demás (el lado provider/earn, la delegación, la reputación portátil, la suite
defensiva, los nuevos servicios de ecosistema) se construye sobre esto.

---

## 2. Enviado — ola 1

### `argus verify` — el re-verificador offline  ✅ *la pieza clave*
**Qué:** un comando diminuto, local y sin red — `argus verify <bundle.json>` — que
re-chequea las pruebas de ARGUS-3 con criptografía pura: firmas Ed25519 en recibos de
oráculos, compromisos SHA-256 (p. ej. un `graph_commitment` de Percola) y el hash
canónico de tool-def de WARDEN.

**Propósito:** sin un verificador *que ejecute el receptor*,
"verificable" es solo una palabra más bonita para "confía en mí". Es la precondición
de cada otra prueba del sistema — Provenance, Passport, FrugalProof, escrow
condicional, todas hacen señas hacia "…así un tercero re-verifica independientemente",
y esto es lo que ese tercero realmente ejecuta. Una prueba que falla es ahora
demostrablemente **una afirmación, no una prueba.**

**Requisitos del stack:** el comando es trivial — pero inútil sin artefactos que sean
*realmente* re-derivables (recibos firmados, compromisos de grafo, hashes canónicos).
Un agente genérico puede imprimir "verified ✓"; no puede entregarte las pre-imágenes
firmadas que hacen que la marca signifique algo.

**Crypto-off:** *es* la historia crypto-off — matemática local pura, sin red, sin
wallet, por construcción. Funciona igual online o totalmente offline.

**Estado:** enviado. `src/verify/`, `argus verify`, 8 tests.

---

## 3. Enviado — ola 1

### Provenance — el rastro de confianza en cada respuesta
**Qué:** cualquier respuesta que usó capacidades de pago o lecturas de oráculo lleva
un rastro compacto y plegable: qué proveedores se llamaron, el LUMEN-score de cada uno
+ su compromiso de grafo *en el momento de la llamada*, si su TEE/recibo verificó, y
cuánto costó.

**Propósito:** "muestra tu trabajo" para la confianza. No obtienes
solo una respuesta — puedes desplegar *exactamente en quién confió el agente para
producirla* y re-chequear cada eslabón con `argus verify`. Es pura agregación de
lectura de artefactos que ARGUS-3 ya recopila en su paso de observación, así que
cuesta **cero tokens de razonamiento extra** — honestidad que además es frugal.

**Requisitos del stack:** una cadena de confianza re-verificable de extremo a extremo
requiere que cada dependencia emita un artefacto verificable. Un agente genérico puede
loguear "llamé a X"; no puede dejar que un tercero re-pruebe que X era confiable.

**Crypto-off:** el rastro igual se renderiza; los enlaces externos se marcan
`unverified (offline)`; una respuesta totalmente local dice "answered locally — no
external trust dependencies".

### Oracle Studio — demanda insignia para los diecisiete oráculos
**Qué:** una capa amigable sobre `oracle_call` para que un dueño común use matemática
verificable sin conocer un id de capacidad: *lanzar una moneda justa / elegir un
ganador* (Platon VRF), *probar tiempo transcurrido* (Chronos), *cobertura uniforme*
(Lattice), *agregado robusto* (Murmuration), *plan más barato* (Colony), *muestra
blue-noise* (Turing), *cuánto confiar en X* (LUMEN), *¿se fragmentará esta red?*
(Percola), *la ruta óptima* (Fermat), *riesgo de cascada* (Ablation), *el piso de
cómputo* (Landauer), *aleatoriedad verificable ungrindable* (Sortes VRF), *regresión
con posterior calibrado + mejor punto siguiente* (Gauss), *sellar ahora, abrir tras ~T*
(Aestus time-lock), *forma de los datos / números de Betti* (Betti), *transporte óptimo
+ certificado dual* (Kantor), *espectro del grafo / lambda-2* (Fourier). Cada respuesta
viene con un recibo verificable plegable.

**Propósito:** el activo más infrautilizado de AICOM es su propia
familia de oráculos — dieciséis de diecisiete están inactivos porque usarlos implica conocer ids
de capacidad arcanos. Oracle Studio es la rampa de demanda que vuelve la matemática
demostrable un one-liner, lo que a su vez alimenta a LUMEN y ACEX — el efecto se compone
cuanto más se usa.

**Requisitos del stack:** la UX es copiable; los oráculos detrás de los botones no. La
sin VRF es `Math.random()`; la de ARGUS-3 es un VRF firmado y
re-verificable.

**Crypto-off:** las lecturas off-chain gratuitas funcionan y renderizan su recibo; las
de pago aparecen en gris "connect wallet"; totalmente offline, cada verbo tiene un
fallback local claramente etiquetado (desempate local, muestreo local) — informativo,
nunca roto.

### Budget Broker — compra "gastar para ahorrar"
**Qué:** antes de quemar sus propios tokens en una sub-tarea, ARGUS-3 estima el costo
marginal in-house (tokens × precio del nivel, desde el medidor en vivo) y lo compara
con la capacidad de Hub más barata para el mismo intento. Si comprar es más barato *y*
está dentro del techo USD de la tarea, compra (vía el `hub_invoke` con aprobación); si
no, razona localmente. Cada decisión es una línea auditable: *"compré X por $0.004 vs
~$0.011 in-house".*

**Propósito:** la frugalidad deja de ser un vibe y se vuelve una
*decisión* — y demostrable. El agente hace lo económicamente correcto por ti y muestra
sus cálculos, con un recibo.

**Requisitos del stack:** una frontera make/buy necesita **tanto** un medidor de costo
in-house auditado **como** un mercado con presupuesto y reputación al que comprar. Un
agente genérico tiene como mucho un lado, así que ni siquiera puede calcular la
comparación, menos probarla.

**Crypto-off:** `hub_discover`/`hub_invoke` simplemente no se exponen → se degrada en
silencio a always-make, imprimiendo la estimación in-house como FYI. Nunca un error.

---

## 4. Enviado — ola 2 (sobre la ola 1)

- **Primitiva de provider (G2)** — el riel de ingreso *honesto* mínimo: servir un
  `argus_ask` de pago entrante y emitir un recibo verificable. ARGUS-3 hoy es un
  consumidor completo pero un proveedor hueco; esta única primitiva desbloquea todo el
  lado de ingreso (reventa, ganar en reposo, mercados de dos lados) — por eso es el
  *cimiento* a construir antes de cualquier función de ingreso, no otra función sobre
  un riel inexistente.
- **Subcontract (A2)** — el gemelo de Budget Broker: contratar a otro agente por USDC
  *dentro de una tarea*, con el sub-costo debitado del **mismo** techo de presupuesto,
  el subcontratista verificado por LUMEN antes de cualquier gasto, y el resultado +
  recibo de escrow adjuntos como provenance. Delegación acotada que no puede fugarse
  con tu presupuesto.
- **Passport (A4)** — reputación portátil y *verificable* ligada a tu identidad Mesh:
  un LUMEN-score + compromiso que cualquier contraparte re-deriva con `argus verify`.
  Tu reputación viaja entre mercados porque vive en un oráculo, no en un silo.
- **Atestación negativa (G3)** — la inversión de toda prueba-de-acción: una garantía
  firmada y anclada en el tiempo de que algo **nunca** ocurrió — *ninguna herramienta
  sensible se ejecutó sin aprobación, ningún dato salió de la máquina, ningún techo se
  excedió en esta sesión.* La garantía exacta que un agente en la nube (cuyo proveedor
  lo ve todo) estructuralmente no puede dar.
- **Suite defensiva** — *FrugalProof* (recibos de costo anclados por Platon
  commit-reveal + un límite temporal de Chronos), *Sealed Approval Receipts*
  (consentimiento hash-encadenado e irrepudiable para cada llamada sensible), *Drift
  Sentinel* (atrapa una herramienta que cambió de *comportamiento* sin cambiar su
  definición — el complemento conductual del pinning).

---

## 5. En cola — servicios de ecosistema (Parte B; la Factory construye, ARGUS-3 exhibe)

Componentes nuevos para que la Factory construya; ARGUS-3 es su consumidor insignia.
Primero los más baratos (sin Solidity nuevo); los pesados en cadena se difieren
deliberadamente a una segunda ola: el código on-chain no enviado es un ítem de roadmap,
no una dependencia.

- **Sentinel CI (M, sin Solidity)** — health-checks continuos de cada listado del Hub
  (canarios impredecibles vía Murmuration, atestiguados por Turing, fechados por
  Chronos). ARGUS-3 lee el badge de CI gratis al descubrir y se niega a enrutar trabajo
  pesado a una capacidad "roja"; WARDEN trata un flip verde→rojo en un servidor pineado
  como señal de drift. Un artefacto de confianza compartido: el test privado de un
  agente no ayuda a nadie; un badge Sentinel protege a cada comprador.
- **Keystone (L, Solidity nuevo)** — escrow condicional que libera **solo cuando un
  oráculo confirma que el resultado es real** (`turing.verify`, `lattice.consensus`,
  deadlines de `chronos`/`platon`, `lumen.verify`). ARGUS-3 ya codifica un criterio de
  éxito en su plan, así que lo auto-compila en la condición de liberación —
  *pagar-contra-prueba* como modo de liquidación por defecto.
- **Verdict (L)** — reseñas imposibles de falsificar porque cada estrella está soldada
  a un recibo de invoke pagado, los reseñadores se ponderan por LUMEN, y el herding se
  bloquea con Platon commit-reveal.
- **Threat-Intel Commons (L)** — la deny-list estática de WARDEN de hoy se vuelve un
  commons vivo, firmado y ponderado por LUMEN: cuando a un ARGUS-3 le hacen rug, cada
  ARGUS-3 queda inmunizado — verificablemente.

---

## 6. Lo innegociable: cada función se degrada, nunca da error

Una línea atraviesa todo lo anterior: **crypto está apagado por defecto, y a nada aquí
se le permite volverse un error cuando la economía está ausente.** Cada función tiene
un comportamiento definido sin wallet y sin red — usualmente "haz lo local y etiqueta
las partes externas como `unverified`". Esto es lo que permite a ARGUS-3 ser primero un
asistente *local* de primera clase y un actor económico en segundo lugar, nunca uno
roto en el medio. Ver [autonomy.md](./autonomy.md).

---

## 7. Estado de un vistazo

| Función | Pilar | Esfuerzo | Estado |
|---|---|---|---|
| `argus verify` | cierre de pruebas | S | ✅ enviado |
| Provenance | cierre de pruebas | M | ✅ enviado |
| Oracle Studio (`argus oracle`) | activar oráculos | M | ✅ enviado |
| Budget Broker (`argus broker`) | economía make/buy | M | ✅ enviado |
| Primitiva de provider (G2, serving-receipt) | cimiento de ingreso | M | ✅ enviado |
| Subcontract (`subcontract_invoke`) | economía make/buy | L | ✅ enviado |
| Passport (`argus passport`) | cierre de pruebas | M | ✅ enviado |
| Atestación negativa (G3, `ask --attest`) | cierre de pruebas | M | ✅ enviado |
| FrugalProof (`ask --frugalproof`) | defensa | M | ✅ enviado |
| Sealed Approval · Drift Sentinel | defensa | M | ✅ enviado (en el bucle) |
| Sentinel CI (lado lectura) | ecosistema (B) | M | ✅ enviado · prober ⏳ |
| Keystone · Verdict · Threat Commons | ecosistema (B) | L | ⏳ diferido (Solidity nuevo) |

**El hilo conductor:** la jugada correcta nunca fue el esquema de ingreso más
llamativo — fue **cerrar el bucle de pruebas, despertar los oráculos dormidos y
convertir la frugalidad en una economía make/buy demostrable.** Eso convierte
"auditable, no marketing" de un eslogan en un hecho contra el que puedes ejecutar
`argus verify`.
