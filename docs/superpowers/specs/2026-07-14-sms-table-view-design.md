# Diseño: página SMS como tabla paginada con búsqueda

**Fecha:** 2026-07-14
**Estado:** aprobado (diseño validado en conversación)
**Alcance:** solo UI + un helper puro. Sin cambios en base de datos, webhook, tipos ni navegación.

## Objetivo

Reemplazar la vista actual de `/sms` (tarjetas agrupadas por remitente, límite fijo
de 500) por una tabla paginada server-side con buscador, al estilo de la página de
Contacts. Todo el historial navegable, 25 filas por página.

## Decisiones tomadas (con el usuario)

1. **Tabla + buscador** (eligió la variante con filtro sobre la tabla simple).
2. Paginación de **25 por página** con Anterior/Siguiente y contador total,
   calcada del patrón de `src/app/(dashboard)/contacts/page.tsx`.
3. La agrupación por remitente desaparece por completo.

## Componentes

### 1. `src/lib/sms/search.ts` (nuevo, puro, testeable)

- `escapeIlike(term: string): string` — escapa `%`, `_` y `\` para usar el término
  dentro de un patrón `ilike` de PostgREST. Además el término se usará dentro de
  `.or(...)`, cuya sintaxis se rompe con `,` y `()`: la función también los elimina
  (los reemplaza por espacio) porque no aparecen en números ni nombres reales.
- `buildSmsSearchPattern(term: string): string | null` — término vacío o solo
  espacios → `null` (sin filtro); cualquier otro término → `%<escapeIlike(term.trim())>%`,
  listo para usar tanto en `ilike` de `from_number` como en el `ilike` de nombres
  de contacto. Centraliza trim + escapado en un solo lugar testeable; la búsqueda
  siempre intenta ambas vías (número Y nombre) para cualquier término no vacío.

### 2. `src/app/(dashboard)/sms/page.tsx` (reescritura)

Client component (igual que hoy). Estado: `page` (0-based), `searchTerm` (input),
`debouncedTerm` (300 ms), `rows: SmsMessage[] | null`, `totalCount`, `error`.

**Consulta por página (sin búsqueda):**

```ts
supabase
  .from("sms_messages")
  .select("*, contact:contacts(id, name)", { count: "exact" })
  .eq("account_id", accountId)
  .order("received_at", { ascending: false })
  .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1)
```

**Con término de búsqueda** (dos pasos):

1. Buscar contactos de la cuenta cuyo nombre coincida:
   `from("contacts").select("id").eq("account_id", accountId).ilike("name", `%${escaped}%`).limit(50)`.
2. Filtrar los SMS con un `.or(...)` que combine número y contactos:
   - con ids: `.or(`from_number.ilike.%${escaped}%,contact_id.in.(${ids.join(",")})`)`
   - sin ids: `.ilike("from_number", `%${escaped}%`)`
   El resto de la consulta (select/count/order/range) es idéntico.

Cambiar el término resetea `page` a 0. Borrarlo restaura la lista completa.

**Tabla** (`Table/TableHeader/TableBody/...` de `src/components/ui/table.tsx`),
columnas:

| Columna | Contenido |
|---|---|
| De | Nombre del contacto si `contact?.name` (número debajo, `text-xs text-muted-foreground`); si no, el número. |
| Mensaje | `body` truncado a una línea (`truncate`, `max-w-*`); si `num_media > 0`, ícono `Paperclip` + enlaces "media N" (`target="_blank" rel="noopener noreferrer"`), como hoy. Body nulo → "(sin texto)" en cursiva. |
| Fecha | `format(received_at, "PPp")` (date-fns), `whitespace-nowrap`. |

**Paginador** bajo la tabla, mismo comportamiento que Contacts: botones
Anterior/Siguiente (`Button variant="outline" size="sm"`, deshabilitados en los
extremos), texto "página X de Y" y contador total de mensajes arriba a la derecha
del buscador. `totalPages = Math.ceil(totalCount / PAGE_SIZE)`; si `totalCount`
es 0 no se muestra el paginador.

**Buscador**: `Input` (`src/components/ui/input.tsx`) con placeholder
"Buscar por número o contacto…" — en inglés en el código/i18n: la página actual
tiene sus textos hardcodeados en inglés; se mantiene ese enfoque (los textos de
esta página no pasan por next-intl hoy y este cambio no lo introduce).

**Estados**: error (igual que hoy); cargando (spinner `Loader2`, igual que hoy);
vacío sin búsqueda ("No SMS received yet" + hint del webhook, igual que hoy);
vacío con búsqueda ("No messages match your search").

### 3. Tests: `src/lib/sms/search.test.ts` (nuevo)

- `escapeIlike`: escapa `%`, `_`, `\`; elimina `,` `(` `)`; deja intactos dígitos,
  letras, `+`, espacios.
- `buildSmsSearchPattern`: vacío/blanco → `null`; `"+51 999"` → `"%+51 999%"`;
  `" Lili "` → `"%Lili%"` (trim); término con `%`/`_` queda escapado (sin
  wildcards inyectados).

La página en sí no lleva test unitario (igual que Contacts y que la versión
actual); la verificación de la página es `npm run typecheck` + `npm run lint`.

## Fuera de alcance (explícito)

- Realtime, envío de SMS, borrado de filas desde la UI, ordenamiento por columnas,
  selección de filas, i18n de los textos de la página.
- Cambios de esquema o del webhook.
