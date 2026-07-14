# Diseño: Webhook de recepción de SMS vía Twilio

**Fecha:** 2026-07-14
**Estado:** aprobado (diseño validado en conversación)
**Alcance:** solo recepción. El envío de SMS queda explícitamente fuera de esta versión.

## Objetivo

Recibir los SMS entrantes de un número de Twilio en el CRM: Twilio hace POST a un
webhook de la app, la app valida la firma, guarda el mensaje y lo muestra en una
sección nueva del dashboard, separada del inbox de WhatsApp.

## Decisiones tomadas (con el usuario)

1. **Sección SMS separada** — no se toca el inbox de WhatsApp ni las tablas
   `conversations`/`messages` existentes.
2. **Solo recepción** — sin envío de respuestas en esta versión.
3. **Credenciales por variables de entorno** — sin pantalla de settings ni tabla
   de configuración de Twilio.
4. **Tabla plana** — una sola tabla `sms_messages`; la UI agrupa por remitente.

## Flujo

```
Twilio recibe SMS en tu número
  → POST application/x-www-form-urlencoded a /api/twilio/webhook
    (campos: MessageSid, From, To, Body, NumMedia, MediaUrl0..N)
  → validar header X-Twilio-Signature (HMAC-SHA1 con TWILIO_AUTH_TOKEN)
  → resolver account_id
  → match de contacto por teléfono (phonesMatch existente)
  → INSERT en sms_messages (dedupe por twilio_sid)
  → responder 200 con TwiML vacío: <?xml ...?><Response/> (Content-Type: text/xml)
```

## Migración: `supabase/migrations/036_sms_messages.sql`

```sql
CREATE TABLE IF NOT EXISTS sms_messages (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id   UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id   UUID REFERENCES contacts(id) ON DELETE SET NULL,
  from_number  TEXT NOT NULL,
  to_number    TEXT NOT NULL,
  body         TEXT,
  twilio_sid   TEXT NOT NULL UNIQUE,   -- MessageSid; dedupe de reintentos de Twilio
  num_media    INTEGER NOT NULL DEFAULT 0,
  media_urls   JSONB,                  -- MediaUrl0..N si llega MMS
  received_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sms_messages_account_received
  ON sms_messages(account_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_sms_messages_from_number
  ON sms_messages(from_number);
```

- RLS: patrón del repo (migración 017) — `SELECT` para miembros vía
  `is_account_member(account_id)`; `INSERT` solo service role (política
  `WITH CHECK (true)` como en `messages`, el webhook usa el cliente admin).
- `DELETE` para `is_account_member(account_id, 'agent')` (poder limpiar spam).
- Idempotente (`IF NOT EXISTS` / `DROP POLICY IF EXISTS`), como todas las
  migraciones del repo.

## Webhook: `src/app/api/twilio/webhook/route.ts`

Espejo estructural de `src/app/api/whatsapp/webhook/route.ts`:

- **POST** único handler (Twilio no tiene handshake de verificación tipo Meta;
  la pantalla "A message comes in → Webhook / HTTP POST" solo pide la URL).
- Body `application/x-www-form-urlencoded` → `await request.formData()`.
- **Validación de firma** en `src/lib/sms/twilio-signature.ts`, sin dependencia
  del paquete `twilio`: `base64(HMAC-SHA1(authToken, url + params ordenados
  alfabéticamente concatenados clave+valor))` comparado con
  `X-Twilio-Signature` usando `crypto.timingSafeEqual`. La URL canónica se
  construye con `NEXT_PUBLIC_SITE_URL` + pathname (+ query si la hubiera).
  - Sin `TWILIO_AUTH_TOKEN` en el entorno → 503 y log claro (webhook deshabilitado).
  - Firma inválida → 403.
- **Resolución de cuenta**: si `TWILIO_SMS_ACCOUNT_ID` está definida, se usa;
  si no, se consulta `accounts` y si hay exactamente una fila se usa esa;
  si hay varias → 500 con log pidiendo configurar la env var.
- **Match de contacto**: normaliza `From` y busca contacto de esa cuenta con
  `phonesMatch` (`src/lib/whatsapp/phone-utils.ts`); si coincide se guarda
  `contact_id`, si no queda NULL.
- **Dedupe**: `INSERT` y si choca contra `twilio_sid UNIQUE` (violación de
  unicidad, helper `isUniqueViolation` existente) se responde 200 igualmente —
  Twilio reintenta ante no-200 y no queremos duplicados ni reintentos eternos.
- Respuesta siempre `200` con `<Response/>` (`text/xml`) en el camino feliz,
  para que Twilio no marque el handler como fallido.
- Cliente Supabase admin lazy-init con `SUPABASE_SERVICE_ROLE_KEY`, igual que
  el webhook de WhatsApp.

## Página: `src/app/(dashboard)/sms/page.tsx`

- Entrada "SMS" nueva en la navegación del dashboard (mismo patrón que las
  páginas hermanas: `automations`, `broadcasts`...).
- Server component: lee `sms_messages` de la cuenta del usuario (RLS media),
  agrupa por `from_number`, muestra nombre del contacto si `contact_id` no es
  NULL, mensajes en orden cronológico con fecha.
- Sin realtime en esta versión — recarga manual. (Posible follow-up: reutilizar
  `use-realtime.ts`.)
- MMS: si `num_media > 0`, mostrar indicador y enlaces a `media_urls`.

## Variables de entorno (documentar en `.env.local.example`)

| Var | Requerida | Uso |
|---|---|---|
| `TWILIO_AUTH_TOKEN` | Sí (para el webhook) | Validar `X-Twilio-Signature` |
| `TWILIO_SMS_ACCOUNT_ID` | Solo multi-cuenta | A qué cuenta asignar los SMS entrantes |

No se necesita `TWILIO_ACCOUNT_SID` para recibir (solo haría falta para enviar,
fuera de alcance).

## Manejo de errores

- Firma inválida / token ausente → 403 / 503, nada se inserta.
- Cuenta no resoluble → 500 + log accionable.
- SMS duplicado (reintento de Twilio) → 200 silencioso.
- Errores de insert → 500 (Twilio reintenta) + `console.error` con el sid.
- El webhook nunca lanza excepciones sin capturar: try/catch envolvente como
  el webhook de WhatsApp.

## Tests (vitest, junto a los existentes)

- `twilio-signature.test.ts`: firma válida, inválida, header ausente,
  ordenamiento de parámetros, timing-safe.
- `route` (handler): 503 sin token, 403 firma mala, inserta y responde TwiML,
  dedupe devuelve 200 sin insertar, match de contacto puebla `contact_id`,
  resolución de cuenta (única / env var / ambigua).

## Configuración en Twilio Console

Número → Messaging → "A message comes in": **Webhook**,
URL `https://<dominio-de-la-app>/api/twilio/webhook`, **HTTP POST**.
"Primary handler fails": vacío. La app debe estar desplegada antes de guardar.

## Fuera de alcance (explícito)

- Envío/respuesta de SMS (requeriría `TWILIO_ACCOUNT_SID` + API REST de Twilio).
- Pantalla de settings para Twilio.
- Integración con el inbox unificado, automatizaciones, flows o IA.
- Realtime en la página SMS.
