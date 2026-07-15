// Prueba manual del webhook de SMS: envía un mensaje falso firmado
// exactamente como lo firma Twilio (HMAC-SHA1 del URL + params ordenados).
//
// Uso:
//   TWILIO_AUTH_TOKEN=tu-token node test-sms-webhook.mjs
//
// Respuestas esperadas:
//   200 <Response/>  → todo funciona; revisa la página /sms del dashboard
//   403              → el token que pasaste no coincide con el del deploy,
//                      o NEXT_PUBLIC_SITE_URL no es exactamente el dominio de URL
//   500              → firma OK pero falló la BD (¿aplicaste la migración 036?)
import crypto from 'node:crypto'

const URL = 'https://crm-chi-gules.vercel.app/api/twilio/webhook'

const token = process.env.TWILIO_AUTH_TOKEN
if (!token) {
  console.error('Falta el token. Ejecuta: TWILIO_AUTH_TOKEN=tu-token node test-sms-webhook.mjs')
  process.exit(1)
}

const params = {
  MessageSid: 'SMtest' + Date.now(), // único en cada corrida (el dedupe rechaza repetidos)
  From: '+51999888777',
  To: '+15550001111',
  Body: 'Mensaje de prueba manual 🎉',
  NumMedia: '0',
}

const data = URL + Object.keys(params).sort().map((k) => k + params[k]).join('')
const signature = crypto.createHmac('sha1', token).update(data, 'utf8').digest('base64')

const res = await fetch(URL, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/x-www-form-urlencoded',
    'X-Twilio-Signature': signature,
  },
  body: new URLSearchParams(params).toString(),
})

console.log('HTTP', res.status)
console.log(await res.text())
