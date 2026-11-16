# Agente de WhatsApp para TG salud y bienestar

Responde dudas y toma pedidos 24 horas por el WhatsApp Business conectado en Zernio.

```
Cliente (WhatsApp) → Zernio → webhook en Render (este proyecto) → Claude
                                         ↓
Cliente (WhatsApp) ← Zernio ← respuesta del agente
```

## Qué hace

- Contesta con la información de `negocio.json` (catálogo, precios, pagos, entrega, políticas).
- Guía la venta: recomienda, confirma el pedido con el cliente y lo registra con un código. El **total lo calcula el sistema**, no la IA, y todo pedido queda **pendiente hasta que un profesional del equipo lo valide**.
- Pasa el chat a una persona (y se queda callado `HANDOFF_HOURS` horas) ante reclamos, devoluciones, pedidos especiales o dudas que no sabe responder.
- Tiene límites de salud: no diagnostica, no da dosis ni indicaciones de aplicación, no promete resultados y pasa esas consultas a una persona. No hace preguntas de salud a los clientes (eso lo atiende tu profesional), pero si el cliente menciona por su cuenta embarazo, ser menor de edad, una enfermedad o medicamentos, no registra el pedido y pasa el chat al profesional.
- Para comprar solo pide producto, cantidad, nombre y ubicación (pin de ubicación de WhatsApp o dirección escrita). No pide método de pago: lo coordina tu equipo.
- Si el cliente envía un audio o una foto, pide amablemente que escriba.

## Paso 1: completa los datos del negocio

Los 19 productos del documento ya están cargados en `negocio.json`. Falta:

1. Escribir `precio_bs` de cada producto (un número, en bolivianos). Un producto sin precio **nunca se cotiza ni se registra**: el agente pasa el chat a una persona.
2. Reemplazar lo que dice `EDITA` (descripción, horario, pagos, entrega, políticas).
3. Cambiar `"configurado"` a `true`. Mientras esté en `false`, el agente **no responde**.

Cada producto tiene un campo `venta`:

- `"bot"` (las tirzepatidas): el agente puede registrar el pedido, que queda pendiente de validación del profesional.
- `"persona"` (los péptidos, las mezclas y la retatrutida): el agente solo informa lo que dice el rotulado y pasa el chat a una persona. El sistema bloquea el registro de estos pedidos aunque la IA lo intente. Si quieres cambiar esto, cambia el valor de `venta` producto por producto.

## Paso 2: sube el proyecto a GitHub

Crea un repositorio privado y sube estos archivos. `.env` y `orders.jsonl` ya están excluidos.

## Paso 3: crea el servicio en Render

1. En Render: **New → Blueprint** y elige el repositorio (usa `render.yaml`), o **New → Web Service** con:
   - Build command: `npm install`
   - Start command: `npm start`
   - Health check path: `/health`
2. Elige un **plan de pago** para que funcione 24/7. En el plan gratuito, Render duerme el servicio sin tráfico y los mensajes se atrasan.
3. Agrega las variables de entorno:

| Variable | Valor |
|---|---|
| `ANTHROPIC_API_KEY` | Clave de console.anthropic.com (la API se factura aparte del chat de Claude) |
| `ZERNIO_API_KEY` | Clave de API de tu panel de Zernio |
| `ZERNIO_ACCOUNT_ID` | `6af66372a2344cd36e73679b` (tu WhatsApp +591 63759213) |
| `ZERNIO_WEBHOOK_SECRET` | Una clave larga inventada por ti (anótala, se usa en el paso 4) |
| `ANTHROPIC_MODEL` | `claude-sonnet-5-5` |
| `HANDOFF_HOURS` | `4` |
| `ORDERS_WEBHOOK_URL` | (opcional) dónde enviar cada pedido |

4. Cuando termine el despliegue, abre `https://TU-SERVICIO.onrender.com/health`. Debe mostrar `{"ok":true,"configurado":true}`.

## Paso 4: conecta el webhook de Zernio

Desde una terminal (reemplaza los valores), o desde el panel de Zernio en Webhooks:

```bash
curl -X POST https://zernio.com/api/v1/webhooks/settings \
  -H "Authorization: Bearer TU_ZERNIO_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "agente-tg-salud",
    "url": "https://TU-SERVICIO.onrender.com/webhooks/zernio",
    "events": ["message.received"],
    "secret": "EL_MISMO_ZERNIO_WEBHOOK_SECRET"
  }'
```

## Paso 5: prueba

Escribe desde otro número al WhatsApp del negocio: pregunta por un producto, pide uno y confirma. Comparte también un pin de ubicación: si el agente responde que no puede leerla, mira en Render → Logs la línea `mensaje sin texto` (muestra los campos que llegaron) para ajustarlo. En **Render → Logs** verás cada respuesta y cada pedido registrado.

## Dónde llegan los pedidos

- Se registran en los logs de Render y en `orders.jsonl` (este archivo **se borra** cuando Render reinicia o redespliega).
- Para guardarlos de forma permanente, usa `ORDERS_WEBHOOK_URL` (por ejemplo, una hoja de Google Sheets con Apps Script, Zapier o Make). Recibe un JSON con código, cliente, productos, total, entrega y pago.
- Los chats que pasan a una persona aparecen en tu WhatsApp Business / bandeja de Zernio; en los logs verás `traspaso a humano`.

## Prueba local sin gastar nada

```bash
npm test
```

Simula Zernio y Claude con servidores falsos y comprueba firma, duplicados, pedidos y traspaso a humano.

## Límites actuales (para mejorar después)

- La memoria de cada conversación está en RAM: si Render reinicia, el agente olvida el hilo (el cliente puede seguir sin problema, pero repite datos). Una base de datos (Postgres de Render) lo resolvería.
- Una sola instancia. No escales a varias sin agregar una base de datos compartida.
- Meta solo permite respuestas libres dentro de las 24 horas posteriores al último mensaje del cliente. Como el cliente escribe primero, esto cubre la atención y la venta normal.
- Con la app de WhatsApp Business en el teléfono, si respondes tú a mano el agente no se entera; si quieres tomar un chat, avísale con una frase que active el traspaso o amplía el código.
