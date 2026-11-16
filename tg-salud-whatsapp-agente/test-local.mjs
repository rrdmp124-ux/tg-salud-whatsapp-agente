// Prueba local: simula Zernio y Claude con servidores falsos. No usa internet ni gasta dinero.
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SECRET = 'secreto-de-prueba';
const ACC = 'cuenta-wa-1';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-agente-'));
const NEGOCIO_FILE = path.join(tmp, 'negocio.json');
const ORDERS_FILE = path.join(tmp, 'orders.jsonl');

fs.writeFileSync(
  NEGOCIO_FILE,
  JSON.stringify({
    configurado: true,
    nombre: 'TG salud y bienestar (prueba)',
    descripcion: 'Prueba',
    productos: [
      { id: 'p1', nombre: 'Producto uno', precio_bs: 100, disponible: true },
      { id: 'p2', nombre: 'Producto dos', precio_bs: 50, disponible: true },
      { id: 'p3', nombre: 'Producto tres', precio_bs: 30, disponible: true, venta: 'persona' },
      { id: 'p4', nombre: 'Producto cuatro', disponible: true },
    ],
  }),
);

const sent = [];
const anthropicCalls = [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond, ms = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (cond()) return;
    await sleep(25);
  }
  throw new Error('Tiempo agotado esperando la condición');
}
const getPort = () =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
const startMock = (handler) =>
  new Promise((resolve) => {
    const s = http.createServer(handler);
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
const readJson = (req) =>
  new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => resolve(b ? JSON.parse(b) : {}));
  });

// Claude falso
const anthropic = await startMock(async (req, res) => {
  const body = await readJson(req);
  anthropicCalls.push(body);
  const last = body.messages[body.messages.length - 1];
  let out;
  if (Array.isArray(last.content)) {
    out = { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Listo, tu pedido quedó registrado ✅' }] };
  } else if (/PEDIDO/.test(last.content)) {
    out = {
      stop_reason: 'tool_use',
      content: [
        {
          type: 'tool_use',
          id: 'tu_1',
          name: 'registrar_pedido',
          input: {
            nombre_cliente: 'Ana',
            items: [{ id: 'p1', cantidad: 2 }, { id: 'p2', cantidad: 1 }],
            entrega: 'Recojo en tienda',
            metodo_pago: 'QR',
          },
        },
      ],
    };
  } else if (/BLOQUEADO|SINPRECIO/.test(last.content)) {
    const id = /BLOQUEADO/.test(last.content) ? 'p3' : 'p4';
    out = {
      stop_reason: 'tool_use',
      content: [
        { type: 'tool_use', id: 'tu_3', name: 'registrar_pedido', input: { nombre_cliente: 'Luis', items: [{ id, cantidad: 1 }], entrega: 'Recojo', metodo_pago: 'QR' } },
      ],
    };
  } else if (/HUMANO/.test(last.content)) {
    out = {
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 'tu_2', name: 'pasar_a_humano', input: { motivo: 'cliente pide persona' } }],
    };
  } else {
    out = { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Hola, soy el asistente de prueba.' }] };
  }
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out));
});

// Zernio falso
const zernio = await startMock(async (req, res) => {
  const m = req.url.match(/^\/api\/v1\/inbox\/conversations\/([^/]+)\/messages$/);
  if (req.method === 'POST' && m) {
    const body = await readJson(req);
    sent.push({ conv: decodeURIComponent(m[1]), auth: req.headers.authorization, idem: req.headers['idempotency-key'], body });
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"data":{"messageId":"m1"}}');
  } else {
    res.writeHead(404).end();
  }
});

const PORT = await getPort();
const child = spawn(process.execPath, ['server.js'], {
  env: {
    ...process.env,
    PORT: String(PORT),
    ZERNIO_API_KEY: 'zk-test',
    ZERNIO_WEBHOOK_SECRET: SECRET,
    ZERNIO_ACCOUNT_ID: ACC,
    ANTHROPIC_API_KEY: 'ak-test',
    ZERNIO_API_URL: `http://127.0.0.1:${zernio.address().port}/api/v1`,
    ANTHROPIC_API_URL: `http://127.0.0.1:${anthropic.address().port}/v1/messages`,
    NEGOCIO_FILE,
    ORDERS_FILE,
  },
  stdio: ['ignore', 'ignore', 'inherit'],
});

async function cleanup() {
  child.kill();
  anthropic.close();
  zernio.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

let n = 0;
const event = (text, extra = {}) => ({
  id: `evt_${++n}`,
  event: 'message.received',
  message: {
    id: `msg_${n}`,
    conversationId: 'conv1',
    platform: 'whatsapp',
    direction: 'incoming',
    text,
    sender: { id: '59170000000', name: 'Cliente' },
    ...(extra.message || {}),
  },
  conversation: { id: extra.message?.conversationId || 'conv1', status: 'active' },
  account: { id: extra.accountId || ACC, accountId: extra.accountId || ACC },
  ...(extra.top || {}),
});
async function post(evt, { badSig = false } = {}) {
  const raw = JSON.stringify(evt);
  const sig = crypto.createHmac('sha256', SECRET).update(raw).digest('hex');
  return fetch(`http://127.0.0.1:${PORT}/webhooks/zernio`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-zernio-signature': badSig ? 'f'.repeat(64) : sig },
    body: raw,
  });
}

try {
  await waitFor(async () => false, 1).catch(() => {});
  // esperar a que el servidor arranque
  let up = false;
  for (let i = 0; i < 80 && !up; i++) {
    try {
      up = (await fetch(`http://127.0.0.1:${PORT}/health`)).ok;
    } catch {
      await sleep(50);
    }
  }
  assert.ok(up, 'el servidor no arrancó');
  const health = await (await fetch(`http://127.0.0.1:${PORT}/health`)).json();
  assert.equal(health.configurado, true);
  console.log('✔ arranca y /health responde');

  // 1. firma inválida
  const bad = await post(event('hola'), { badSig: true });
  assert.equal(bad.status, 400);
  await sleep(200);
  assert.equal(sent.length, 0);
  console.log('✔ rechaza firma inválida');

  // 2. mensaje normal
  const e1 = event('hola, ¿qué productos tienen?');
  assert.equal((await post(e1)).status, 200);
  await waitFor(() => sent.length === 1);
  assert.equal(sent[0].conv, 'conv1');
  assert.equal(sent[0].auth, 'Bearer zk-test');
  assert.equal(sent[0].body.accountId, ACC);
  assert.match(sent[0].body.message, /asistente de prueba/);
  assert.ok(sent[0].idem);
  assert.ok(anthropicCalls[0].system.includes('Producto uno'));
  assert.ok(anthropicCalls[0].system.includes('LO CIERRA UNA PERSONA DEL EQUIPO'));
  assert.ok(anthropicCalls[0].system.includes('precio por confirmar'));
  assert.equal(anthropicCalls[0].messages[0].role, 'user');
  console.log('✔ responde un mensaje y lo envía por Zernio');

  // 3. duplicado
  await post(e1);
  await sleep(300);
  assert.equal(sent.length, 1);
  console.log('✔ ignora eventos duplicados');

  // 4. mensaje saliente y otra cuenta
  await post(event('eco', { message: { direction: 'outgoing' } }));
  await post(event('otra cuenta', { accountId: 'otra' }));
  await sleep(300);
  assert.equal(sent.length, 1);
  console.log('✔ ignora mensajes salientes y de otras cuentas');

  // 5. mensaje sin texto (ubicación, audio...)
  await post(event('', { message: { conversationId: 'conv-media' } }));
  await waitFor(() => sent.length === 2);
  assert.match(sent[1].body.message, /solo puedo leer mensajes de texto/);
  console.log('✔ pide texto cuando llega un mensaje sin texto');

  // 6. pedido con herramienta
  await post(event('quiero hacer un PEDIDO', { message: { conversationId: 'conv-pedido' } }));
  await waitFor(() => sent.length === 3);
  assert.match(sent[2].body.message, /pedido quedó registrado/);
  const orders = fs.readFileSync(ORDERS_FILE, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(orders.length, 1);
  assert.equal(orders[0].total_bs, 250); // 2×100 + 1×50, calculado por el sistema
  assert.match(orders[0].codigo, /^TG-/);
  assert.equal(orders[0].nombre_cliente, 'Ana');
  assert.equal(orders[0].estado, 'pendiente de validación del profesional');
  console.log('✔ registra el pedido y calcula el total (Bs 250)');

  // 7. traspaso a humano: después el agente se calla
  await post(event('quiero hablar con un HUMANO', { message: { conversationId: 'conv-humano' } }));
  await waitFor(() => sent.length === 4);
  const callsBefore = anthropicCalls.length;
  await post(event('¿hola? ¿sigues ahí?', { message: { conversationId: 'conv-humano' } }));
  await sleep(400);
  assert.equal(sent.length, 4);
  assert.equal(anthropicCalls.length, callsBefore);
  console.log('✔ tras pasar a una persona, el agente deja de responder en ese chat');

  // 7b. ubicación compartida (pin): llega como metadata.location y la IA la recibe como texto
  {
    const before = sent.length;
    await post(event('', { message: { conversationId: 'conv-loc', metadata: { location: { latitude: -17.78, longitude: -63.18, name: 'Casa' } } } }));
    await waitFor(() => sent.length === before + 1);
    const lastCall = anthropicCalls[anthropicCalls.length - 1];
    assert.match(lastCall.messages[0].content, /Ubicación compartida: Casa — -17\.78,-63\.18/);
    console.log('✔ entiende el pin de ubicación compartido');
  }

  // 8. el sistema no registra productos de venta con persona ni productos sin precio
  for (const [kw, conv] of [['BLOQUEADO', 'conv-bloq'], ['SINPRECIO', 'conv-sinprecio']]) {
    const before = sent.length;
    await post(event('quiero ' + kw, { message: { conversationId: conv } }));
    await waitFor(() => sent.length === before + 1);
    const lastCall = anthropicCalls[anthropicCalls.length - 1];
    const tr = lastCall.messages[lastCall.messages.length - 1].content[0];
    assert.equal(tr.type, 'tool_result');
    assert.match(tr.content, /"ok":false/);
  }
  assert.equal(fs.readFileSync(ORDERS_FILE, 'utf8').trim().split('\n').length, 1);
  console.log('✔ no registra pedidos de productos "persona" ni sin precio');

  console.log('\nTodas las pruebas pasaron ✅');
  await cleanup();
  process.exit(0);
} catch (e) {
  console.error('\n✘ Falló la prueba:', e.message);
  await cleanup();
  process.exit(1);
}
