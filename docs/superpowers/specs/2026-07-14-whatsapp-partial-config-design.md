# Diseño: guardado paso a paso de la conexión WhatsApp (verify token primero)

**Fecha:** 2026-07-14
**Estado:** aprobado (diseño validado en conversación)

## Objetivo

Permitir guardar **solo el verify token** en Settings → WhatsApp antes de tener las
credenciales de Meta (Phone number ID + access token), para poder completar la
verificación del webhook en Facebook de inmediato. Las credenciales se completan
después en el mismo formulario, con la validación contra Meta intacta.

## Decisiones tomadas (con el usuario)

1. Alcance mínimo: solo el verify token es guardable por separado ("verify token
   primero"). No se convierte el formulario en asistente de campos sueltos.
2. El camino de guardado completo (credenciales + validación Meta + registro +
   suscripción WABA) no cambia.

## Componentes

### 1. Migración `supabase/migrations/037_whatsapp_config_partial.sql`

```sql
ALTER TABLE whatsapp_config ALTER COLUMN access_token DROP NOT NULL;
ALTER TABLE whatsapp_config ALTER COLUMN phone_number_id DROP NOT NULL;
```

- Una fila "parcial" = credenciales NULL + `verify_token` cifrado + `status='disconnected'`.
- `DROP NOT NULL` es naturalmente idempotente. El UNIQUE de `phone_number_id`
  (migración 013) tolera múltiples NULL (semántica estándar de Postgres).

### 2. API `POST /api/whatsapp/config` — nuevo camino parcial

Insertado tras el parseo del body, ANTES del check actual que exige credenciales:

- Condición: `!access_token && !phone_number_id && verify_token` (string no vacío).
- Acción: `encrypt(verify_token)`; si existe fila de la cuenta → `update`
  `{ verify_token, updated_at }`; si no → `insert`
  `{ account_id, user_id, verify_token, status: 'disconnected' }`.
- Sin validación contra Meta, sin /register, sin subscribe.
- Respuesta: `{ success: true, saved: true, partial: true }`.
- El check existente (`access_token and phone_number_id are required`) queda para
  cualquier otro body incompleto (p. ej. solo phone_number_id).

### 3. API `GET /api/whatsapp/config` — estado parcial

Hoy, una fila sin access_token caería en `decrypt(null)` → "token_corrupted" +
botón de reset (UX equivocada). Nuevo branch ANTES del decrypt:

- Si `config && !config.access_token` → responder
  `{ connected: false, reason: 'partial_config', verify_token_saved: true, message: <texto guía> }`.

### 4. Formulario `src/components/settings/whatsapp-config.tsx`

- Botón secundario **"Save verify token"** (variant outline, pequeño) debajo del
  campo Verify token, siempre habilitado si el campo no está vacío y no se está
  guardando. Hace POST con `{ verify_token }` solamente; toast de éxito indicando
  el siguiente paso (pegar el mismo token en Meta → Verificar y guardar).
- Manejo del estado `reason: 'partial_config'` del GET: mostrar aviso informativo
  (no el banner de reset) tipo "Verify token guardado — completa el Phone number
  ID y el access token cuando los tengas".
- `handleSave` (guardado completo) no cambia.
- i18n: claves nuevas en `messages/en.json` → sección `Settings.whatsapp`:
  `saveVerifyTokenOnly`, `verifyTokenSaved` (toast). El estado `partial_config`
  del GET fluye por el renderizado de mensaje-desconectado existente (no
  activa el banner de reset porque `resetReason` solo se setea para
  `token_corrupted`/`meta_api_error`), así que no necesita clave propia.

### 5. Guardas en consumidores de `access_token` (credenciales NULL ⇒ "no configurado")

Hoy asumen que si la fila existe, las credenciales existen. Con filas parciales:

| Archivo | Guard |
|---|---|
| `src/lib/whatsapp/send-message.ts` | tras el fetch de config: `if (!config.access_token || !config.phone_number_id)` → mismo `SendMessageError('whatsapp_not_configured', …, 400)` que fila ausente |
| `src/app/api/whatsapp/broadcast/route.ts` | ídem con su error existente de "not configured" |
| `src/app/api/whatsapp/media/[mediaId]/route.ts` | ídem |
| `src/app/api/whatsapp/react/route.ts` | ídem |
| `src/app/api/whatsapp/templates/sync/route.ts` | ídem |
| `src/app/api/whatsapp/templates/submit/route.ts` | ídem (salvo modo dry-run, que no usa credenciales) |

Cada guard replica el error "no configurado" que esa ruta ya devuelve cuando no
hay fila — sin mensajes nuevos.

### 6. Sin cambios

- Webhook GET de verificación: ya itera filas con `decrypt` en try/catch — la fila
  parcial (token cifrado) matchea correctamente. Es el objetivo de la feature.
- Webhook POST de mensajes: busca por `phone_number_id`; NULL nunca matchea.

## Tests

- Ruta config (siguiendo el patrón de `send/route.test.ts` si aplica; si el mock
  resulta desproporcionado, tests de los guards puros + convenciones):
  - POST solo verify_token → 200 `{ partial: true }` (sin llamada a Meta).
  - POST body vacío → 400 (regla existente intacta).
- `send-message`: config con access_token NULL → `whatsapp_not_configured` (400),
  no un throw de decrypt.
- Migración: greps de convención (idempotencia trivial de ALTER).

## Fuera de alcance

- Asistente por campos, cambios al flujo de registro/PIN, i18n de otros idiomas,
  cambios al webhook.
