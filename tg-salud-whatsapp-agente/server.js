// Agente de WhatsApp para TG salud y bienestar
// Recibe mensajes por webhook de Zernio, responde con Claude y envía la respuesta por WhatsApp.
// Sin dependencias externas: solo Node.js 20 o superior.

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { buildSystemPrompt } from './prompt.js';

const env = process.env;

const cfg = {
  port: Number(env.PORT || 3000),
  zernioKey: env.ZERNIO_API_KEY,
  zernioSecret: env.ZERNIO_WEBHOOK_SECRET,
  accountId: env.ZERNIO_ACCOUNT_ID,
  anthropicKey: env.ANTHROPIC_API_KEY,
  model: env.ANTHROPIC_MODEL || 'claude-sonnet-5-5',
  zernioUrl: (env.ZERNIO_API_URL || 'https://zernio.com/api/v1').replace(/\/$/, ''),
  anthropicUrl: env.ANTHROPIC_API_URL || 'https://api.anthropic.com/v1/messages',
  ordersWebhook: env.ORDERS_WEBHOOK_URL || '',
  ordersFile: env.ORDERS_FILE || './orders.jsonl',
  negocioFile: env.NEGOCIO_FILE || new URL('./negocio.json', import.meta.url),
  handoffHours: Number(env.HANDOFF_HOURS || 4),
  allowUnconfigured: env.ALLOW_UNCONFIGURED === '1',
};

const log = (lvl, msg, extra = {}) =>
  console.log(JSON.stringify({ t: new Date().toISOString(), lvl, msg, ...extra }));

// ---------- Arranque y validaciones ----------

const missing = ['ZERNIO_API_KEY', 'ZERNIO_WEBHOOK_SECRET', 'ZERNIO_ACCOUNT_ID', 'ANTHROPIC_API_KEY'].filter(
  (k) => !env[k],
);
if (missing.length) {
  log('error', `Faltan variables de entorno: ${missing.join(', ')}`);
  process.exit(1);
}

let negocio;
try {
  negocio = JSON.parse(fs.readFileSync(cfg.negocioFile, 'utf8'));
} catch (e) {
  log('error', 'No pude leer negocio.json (revisa que sea un JSON válido)', { err: String(e) });
  process.exit(1);
}

const configurado = negocio.configurado === true || cfg.allowUnconfigured;
if (!configurado) {
  log(
    'warn',
    'negocio.json aún no está configurado: el agente NO responderá a clientes hasta que lo completes y pongas "configurado": true',
  );
}

const sinPrecio = (negocio.productos || [])
  .filter((p) => p.disponible !== false && p.venta !== 'persona' && typeof p.precio_bs !== 'number')
  .map((p) => p.id);
if (sinPrecio.length) {
  log('warn', 'Hay productos sin precio: el agente no los cotizará ni los registrará hasta que cargues precio_bs', { productos: sinPrecio });
}

const SYSTEM_PROMPT = buildSystemPrompt(negocio);
const catalogo = new Map((negocio.productos || []).filter((p) => p.disponible !== false).map((p) => [p.id, p]));

// ---------- Utilidades ----------

function fetchTimeout(url, opts, ms) {
  return fetch(url, { ...opts, signal: AbortSignal.timeout(ms) });
}

function safeEqual(a, b) {
  const A = Buffer.from(String(a));
  const B = Buffer.from(String(b));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}

function splitText(text, max = 3800) {
  const out = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < max / 2) cut = max;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  if (rest) out.push(rest);
  return out;
}

function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('Cuerpo demasiado grande'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ---------- Estado en memoria ----------
// Nota: se pierde si Render reinicia el servicio. Para el historial largo o varias
// instancias conviene guardar esto en una base de datos (ver README).

const seenEvents = new Map(); // id de evento -> expira
function alreadySeen(id) {
  if (!id) return false;
  const now = Date.now();
  const exp = seenEvents.get(id);
  if (exp && exp > now) return true;
  seenEvents.set(id, now + 6 * 3600_000);
  return false;
}

const states = new Map(); // conversationId -> estado
function getState(id) {
  let s = states.get(id);
  if (!s) {
    s = { history: [], pausedUntil: 0, lastNonText: 0, touched: Date.now() };
    states.set(id, s);
  }
  s.touched = Date.now();
  return s;
}

function pushTurn(st, role, text) {
  const last = st.history[st.history.length - 1];
  if (last && last.role === role) last.text += '\n' + text;
  else st.history.push({ role, text });
  while (st.history.length > 30) st.history.shift();
  while (st.history.length && st.history[0].role !== 'user') st.history.shift();
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of seenEvents) if (v < now) seenEvents.delete(k);
  for (const [k, s] of states) {
    if (s.touched < now - 24 * 3600_000 && s.pausedUntil < now) states.delete(k);
  }
}, 30 * 60_000).unref();

// Un mensaje a la vez por conversación, para no responder desordenado.
const queues = new Map();
function enqueue(key, job) {
  const prev = queues.get(key) || Promise.resolve();
  const next = prev.then(job).catch((e) => log('error', 'tarea fallida', { err: String(e).slice(0, 400) }));
  queues.set(key, next);
  next.finally(() => {
    if (queues.get(key) === next) queues.delete(key);
  });
}

// ---------- Herramientas del agente ----------

const TOOLS = [
  {
    name: 'registrar_pedido',
    description:
      'Registra un pedido confirmado por el cliente. Úsala SOLO cuando el cliente ya confirmó productos, cantidades, nombre, forma de entrega y método de pago. El total lo calcula el sistema. El pedido queda pendiente hasta que un profesional del equipo lo valide. No sirve para productos que cierra una persona ni para productos sin precio.',
    input_schema: {
      type: 'object',
      properties: {
        nombre_cliente: { type: 'string', description: 'Nombre del cliente' },
        items: {
          type: 'array',
          description: 'Productos del pedido',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'ID del producto tal como aparece en el catálogo' },
              cantidad: { type: 'integer', minimum: 1 },
            },
            required: ['id', 'cantidad'],
          },
        },
        entrega: { type: 'string', description: 'Ubicación de entrega: el texto de la ubicación compartida por el cliente (tal como aparece, con [Ubicación compartida: ...]) o la dirección/referencia que escribió' },
        metodo_pago: { type: 'string', description: 'Método de pago, solo si el cliente lo mencionó (opcional)' },
        notas: { type: 'string', description: 'Observaciones del cliente (opcional)' },
      },
      required: ['nombre_cliente', 'items', 'entrega'],
    },
  },
  {
    name: 'pasar_a_humano',
    description:
      'Pausa al asistente en esta conversación para que una persona del equipo atienda. Úsala ante reclamos, devoluciones, pedidos especiales, clientes molestos, pedidos de hablar con una persona o preguntas que no puedes responder con la información disponible.',
    input_schema: {
      type: 'object',
      properties: { motivo: { type: 'string', description: 'Resumen breve del motivo' } },
      required: ['motivo'],
    },
  },
];

async function runTool(tu, st, ctx) {
  try {
    if (tu.name === 'registrar_pedido') {
      const { nombre_cliente, items, entrega, metodo_pago, notas } = tu.input || {};
      if (!Array.isArray(items) || !items.length) return JSON.stringify({ ok: false, error: 'El pedido no tiene productos' });
      const detalle = [];
      let total = 0;
      for (const it of items) {
        const prod = catalogo.get(it.id);
        const cant = Number(it.cantidad);
        if (!prod) return JSON.stringify({ ok: false, error: `Producto inexistente o agotado: ${it.id}` });
        if (prod.venta === 'persona') return JSON.stringify({ ok: false, error: `${prod.nombre} lo confirma una persona del equipo: no registres este pedido; usa pasar_a_humano.` });
        if (typeof prod.precio_bs !== 'number') return JSON.stringify({ ok: false, error: `El precio de ${prod.nombre} aún no está cargado: no registres este pedido; usa pasar_a_humano.` });
        if (!Number.isInteger(cant) || cant < 1 || cant > 100) return JSON.stringify({ ok: false, error: `Cantidad inválida para ${it.id}` });
        const subtotal = prod.precio_bs * cant;
        total += subtotal;
        detalle.push({ id: prod.id, producto: prod.nombre, cantidad: cant, precio_unitario_bs: prod.precio_bs, subtotal_bs: subtotal });
      }
      const codigo = 'TG-' + Date.now().toString(36).toUpperCase().slice(-5) + crypto.randomBytes(2).toString('hex').toUpperCase();
      const pedido = {
        codigo,
        fecha: new Date().toISOString(),
        conversationId: ctx.convId,
        cliente_whatsapp: ctx.cliente,
        nombre_cliente,
        entrega,
        metodo_pago: metodo_pago || '',
        notas: notas || '',
        items: detalle,
        total_bs: total,
        estado: 'pendiente de validación del profesional',
      };
      try {
        fs.appendFileSync(cfg.ordersFile, JSON.stringify(pedido) + '\n');
      } catch (e) {
        log('warn', 'no pude escribir orders.jsonl', { err: String(e) });
      }
      if (cfg.ordersWebhook) {
        try {
          await fetchTimeout(
            cfg.ordersWebhook,
            { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(pedido) },
            10_000,
          );
        } catch (e) {
          log('warn', 'falló ORDERS_WEBHOOK_URL', { err: String(e) });
        }
      }
      log('info', 'pedido registrado', { codigo, total_bs: total });
      return JSON.stringify({ ok: true, codigo, total_bs: total, detalle });
    }

    if (tu.name === 'pasar_a_humano') {
      st.pausedUntil = Date.now() + cfg.handoffHours * 3600_000;
      log('info', 'traspaso a humano', { convId: ctx.convId, motivo: String(tu.input?.motivo || '').slice(0, 200) });
      return JSON.stringify({ ok: true, nota: `El asistente queda en pausa ${cfg.handoffHours} horas en este chat.` });
    }

    return JSON.stringify({ ok: false, error: `Herramienta desconocida: ${tu.name}` });
  } catch (e) {
    return JSON.stringify({ ok: false, error: String(e).slice(0, 200) });
  }
}

// ---------- Claude ----------

async function callAnthropic(messages) {
  const res = await fetchTimeout(
    cfg.anthropicUrl,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': cfg.anthropicKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: cfg.model,
        max_tokens: 700,
        system: SYSTEM_PROMPT,
        tools: TOOLS,
        messages,
      }),
    },
    45_000,
  );
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

async function runModel(st, ctx) {
  const messages = st.history.map((t) => ({ role: t.role, content: t.text }));
  let lastText = '';
  for (let i = 0; i < 5; i++) {
    const data = await callAnthropic(messages);
    const blocks = data.content || [];
    const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    const toolUses = blocks.filter((b) => b.type === 'tool_use');
    if (text) lastText = text;
    if (!toolUses.length || data.stop_reason !== 'tool_use') return text || lastText;
    messages.push({ role: 'assistant', content: blocks });
    const results = [];
    for (const tu of toolUses) {
      results.push({ type: 'tool_result', tool_use_id: tu.id, content: await runTool(tu, st, ctx) });
    }
    messages.push({ role: 'user', content: results });
  }
  return lastText;
}

// ---------- WhatsApp (Zernio) ----------

async function sendMessage(convId, accountId, text) {
  for (const part of splitText(text)) {
    const res = await fetchTimeout(
      `${cfg.zernioUrl}/inbox/conversations/${encodeURIComponent(convId)}/messages`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${cfg.zernioKey}`,
          'idempotency-key': crypto.randomUUID(),
        },
        body: JSON.stringify({ accountId, message: part }),
      },
      15_000,
    );
    if (!res.ok) throw new Error(`Zernio ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
}

// Texto que ve la IA. Si el cliente comparte su ubicación (pin de WhatsApp), la convertimos a texto.
function extractText(msg) {
  const t = String(msg.text || '').trim();
  const fromAttachments = Array.isArray(msg.attachments) ? msg.attachments.find((a) => a?.type === 'location') : undefined;
  const loc = msg.metadata?.location || msg.location || fromAttachments;
  const lat = loc?.latitude ?? loc?.lat;
  const lng = loc?.longitude ?? loc?.lng ?? loc?.lon;
  if (lat != null && lng != null) {
    const lugar = [loc.name, loc.address].filter(Boolean).join(', ');
    return `${t ? t + '\n' : ''}[Ubicación compartida: ${lugar ? lugar + ' — ' : ''}${lat},${lng} — https://maps.google.com/?q=${lat},${lng}]`;
  }
  return t;
}

async function answer({ convId, accountId, msg }) {
  const st = getState(convId);
  if (st.pausedUntil > Date.now()) {
    log('info', 'chat en pausa: lo atiende una persona', { convId });
    return;
  }

  const text = extractText(msg);
  if (!text) {
    log('info', 'mensaje sin texto', { convId, campos: Object.keys(msg), metadata: Object.keys(msg.metadata || {}) });
    if (Date.now() - st.lastNonText > 10 * 60_000) {
      st.lastNonText = Date.now();
      await sendMessage(
        convId,
        accountId,
        'Hola 👋 Por ahora solo puedo leer mensajes de texto y ubicaciones. ¿Me cuentas por escrito en qué te puedo ayudar? Si es tu ubicación, también puedes escribir tu dirección o una referencia.',
      );
    }
    return;
  }

  pushTurn(st, 'user', text.slice(0, 2000));

  const ctx = { convId, cliente: { id: msg.sender?.id || null, nombre_whatsapp: msg.sender?.name || null } };
  let reply;
  try {
    reply = await runModel(st, ctx);
  } catch (e) {
    log('error', 'falló la consulta al modelo', { err: String(e).slice(0, 300) });
    reply =
      'Disculpa, tuve un problema técnico en este momento 🙏 Escríbeme de nuevo en unos minutos o una persona del equipo te atenderá en cuanto pueda.';
  }
  if (!reply) reply = 'Disculpa, no logré procesar tu mensaje. ¿Podrías repetirlo?';

  pushTurn(st, 'assistant', reply);
  await sendMessage(convId, accountId, reply);
  log('info', 'respuesta enviada', { convId, chars: reply.length });
}

// ---------- Webhook ----------

async function processEvent(event) {
  if (event.event !== 'message.received') return;
  const msg = event.message || {};
  if (msg.direction && msg.direction !== 'incoming') return;
  if (msg.platform && msg.platform !== 'whatsapp') return;

  const accountId = event.account?.id || event.account?.accountId;
  if (accountId !== cfg.accountId) return;
  if (alreadySeen(event.id)) return;
  if (!configurado) {
    log('warn', 'mensaje ignorado: negocio.json sin configurar');
    return;
  }

  const convId = msg.conversationId || event.conversation?.id;
  if (!convId) return;
  enqueue(convId, () => answer({ convId, accountId, msg }));
}

async function handleWebhook(req, res) {
  let raw;
  try {
    raw = await readBody(req);
  } catch {
    res.writeHead(413).end('Too large');
    return;
  }
  const expected = crypto.createHmac('sha256', cfg.zernioSecret).update(raw).digest('hex');
  if (!safeEqual(req.headers['x-zernio-signature'] || '', expected)) {
    res.writeHead(400).end('Invalid signature');
    return;
  }
  // Zernio exige un 2xx en menos de 5 segundos: respondemos ya y procesamos después.
  res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
  let event;
  try {
    event = JSON.parse(raw.toString('utf8'));
  } catch {
    return;
  }
  processEvent(event).catch((e) => log('error', 'evento fallido', { err: String(e).slice(0, 300) }));
}

const server = http.createServer((req, res) => {
  const url = (req.url || '').split('?')[0];
  if (req.method === 'POST' && url === '/webhooks/zernio') return void handleWebhook(req, res);
  if (req.method === 'GET' && url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, configurado, productos_sin_precio: sinPrecio.length }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end('Agente de TG salud y bienestar activo');
});

process.on('unhandledRejection', (e) => log('error', 'unhandledRejection', { err: String(e).slice(0, 300) }));

server.listen(cfg.port, () => log('info', `Agente escuchando en el puerto ${cfg.port}`, { modelo: cfg.model, configurado }));
