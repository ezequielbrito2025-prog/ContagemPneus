#!/usr/bin/env node
/*
 * Controle de Pneus — servidor local
 * ------------------------------------
 * Este arquivo transforma o app (antes 100% dentro do navegador, sem servidor)
 * num sistema compartilhado: um computador da rede roda este servidor, guarda
 * os dados centralizados num arquivo (dados/store.json) e avisa em tempo real
 * (via Server-Sent Events) todos os navegadores conectados sempre que algo
 * muda — entrada, saída, ajuste, contagem, etc.
 *
 * Não usa nenhuma biblioteca externa (só módulos que já vêm com o Node.js),
 * então não precisa rodar "npm install" — só precisa ter o Node.js instalado.
 *
 * Como usar:
 *   1. Instale o Node.js (https://nodejs.org) neste computador, uma vez só.
 *   2. Dê duplo clique em "iniciar-servidor.bat" (Windows) — ou rode
 *      `node server.js` no terminal.
 *   3. Deixe essa janela aberta. Ela mostra o endereço para acessar deste
 *      computador e de outros dispositivos na mesma rede Wi-Fi/cabo.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const url = require('url');
const crypto = require('crypto');

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const ROOT = __dirname;
/* Em casa/rede local, os dados ficam dentro da própria pasta do app (dados/store.json). Num
   servidor de hospedagem (Railway, Render, etc.), o disco normal se perde a cada reinício — por
   isso lá se anexa um "volume" (armazenamento permanente) ao serviço, e o servidor passa a
   guardar os dados nele em vez de dentro da pasta do app. RAILWAY_VOLUME_MOUNT_PATH é preenchida
   sozinha pelo Railway assim que um volume é conectado ao serviço (não precisa configurar nada a
   mais); DATA_DIR serve pra apontar manualmente em qualquer outro provedor de hospedagem. */
const DATA_DIR = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(ROOT, 'dados');
const DATA_FILE = path.join(DATA_DIR, 'store.json');

const CATEGORIES = ["Pneu novo", "Pneu conserto", "Pneu recapado"];
const DEFAULT_WAREHOUSES = ["Almoxarifado Dois Irmãos", "Almoxarifado Muribeca"];
const DEFAULT_SUPPLIERS = ["Carlos Eduardo", "Dafonte Renovadora", "Renove Pneus"];
// sha256("admin123") no mesmo formato usado pelo app (front-end também usa SHA-256).
const ADMIN_HASH = "sha256_240be518fabd2724ddb6f04eeb1da5967448d7e831c08c8fa822809f74c720a9";

const SEED_MATERIALS = [
  { code: "OS0027V", name: "PNEU CONSERTO 275/80", category: "Pneu conserto" },
  { code: "OT0040R33", name: "PNEU CONSERTO 235/75", category: "Pneu conserto" },
  { code: "OT0040C33", name: "PNEU CONSERTO 225/75", category: "Pneu conserto" },
  { code: "OT0040633", name: "PNEU CONSERTO 215/75", category: "Pneu conserto" },
  { code: "OT0082007AN0314", name: "PNEU CONSERTO 7.5/16", category: "Pneu conserto" },
  { code: "OT0042721", name: "PNEU RECAPADO 275/80", category: "Pneu recapado" },
  { code: "OT0042R31", name: "PNEU RECAPADO 235/75", category: "Pneu recapado" },
  { code: "OT0040C30", name: "PNEU RECAPADO 225/75", category: "Pneu recapado" },
  { code: "OT0040630", name: "PNEU RECAPADO 215/75", category: "Pneu recapado" },
  { code: "OT0080035F53515", name: "PNEU RECAPADO 7.5/16", category: "Pneu recapado" },
  { code: "OT0042A30", name: "PNEU RECAPADO 295/80", category: "Pneu recapado" },
  { code: "OT0040S30", name: "PNEU RECAPADO 11R", category: "Pneu recapado" },
  { code: "OT0080044040122", name: "PNEU NOVO 235/75 G686 GOODYEAR", category: "Pneu novo" },
  { code: "OT0082011700403", name: "PNEU NOVO 175/70 R14 F580 FIRESTONE", category: "Pneu novo" },
  { code: "OT0082017C70103", name: "PNEU NOVO 215/75 ARMOR MAX GOODYEAR", category: "Pneu novo" },
  { code: "OT0082021920103", name: "PNEU NOVO 225/75 G32 GOODYEAR", category: "Pneu novo" },
  { code: "OT0082025D00335", name: "PNEU NOVO 275/80 FG88 PIRELLI", category: "Pneu novo" },
  { code: "OT0082025E70103", name: "PNEU NOVO 275/80 ARMOR MAX GOODYEAR", category: "Pneu novo" },
  { code: "OT0082025IC0465", name: "PNEU NOVO 275/80 T819 FIRESTONE", category: "Pneu novo" },
  { code: "OT0082033140303", name: "PNEU NOVO 215/75 FG85 PIRELLI", category: "Pneu novo" },
  { code: "OT0082069790303", name: "PNEU NOVO MOTO 90/90 PIRELLI", category: "Pneu novo" },
  { code: "OT0082082790303", name: "PNEU NOVO MOTO 2,75X18 PIRELLI", category: "Pneu novo" },
  { code: "OT0082102D40303", name: "PNEU NOVO 165/70 F.ENERGY PIRELLI", category: "Pneu novo" },
  { code: "OT0082156BB0151", name: "PNEU NOVO 185/55 E.GRIP GOODYEAR", category: "Pneu novo" },
  { code: "OT008A025HG1055", name: "PNEU NOVO 275/80 R165E BRIDGESTONE", category: "Pneu novo" },
  { code: "OT008A025HT0456", name: "PNEU NOVO 275/80 T822 FIRESTONE", category: "Pneu novo" }
];

/* ================= helpers ================= */
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 10); }
function nowIso() { return new Date().toISOString(); }
/* O hash da senha é calculado sempre aqui no servidor (nunca no navegador): o Node não tem a
   restrição de "contexto seguro" que os navegadores impõem à Web Crypto API (que só libera
   crypto.subtle em https:// ou localhost) — por isso, acessando por IP da rede local em http://,
   um cálculo feito no navegador não seria confiável. O navegador manda a senha em texto puro só
   nesta chamada de rede local; o servidor nunca guarda a senha em texto puro, só o hash. */
function hashPassword(pw) {
  return 'sha256_' + crypto.createHash('sha256').update(String(pw || ''), 'utf8').digest('hex');
}

/* ================= sessões (login) =================
   Enquanto o app rodava só dentro da rede local confiável, não existia checagem de sessão no
   servidor — a tela só escondia botões, mas qualquer requisição direta à API funcionava sem
   login. Isso é aceitável numa rede fechada, mas vira um risco real assim que o servidor fica
   acessível pela internet (qualquer pessoa que descobrisse o endereço poderia ler ou alterar os
   dados, inclusive os hashes de senha, sem nunca passar pela tela de login). A partir daqui, um
   login bem-sucedido gera um token de sessão guardado num cookie HttpOnly; toda outra rota da
   API (menos /api/login e /api/session) exige esse cookie válido. */
var sessions = Object.create(null); // token -> { username, role, warehouseId, createdAt }
var SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 dias
function newSessionToken() { return crypto.randomBytes(24).toString('hex'); }
function isHttps(req) {
  return req.headers['x-forwarded-proto'] === 'https' || !!(req.socket && req.socket.encrypted);
}
function parseCookies(req) {
  var out = {};
  var header = req.headers.cookie;
  if (!header) return out;
  header.split(';').forEach(function (part) {
    var i = part.indexOf('=');
    if (i === -1) return;
    var k = part.slice(0, i).trim(), v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  });
  return out;
}
function setSessionCookie(req, res, token) {
  var parts = ['sid=' + token, 'HttpOnly', 'Path=/', 'SameSite=Lax', 'Max-Age=' + Math.floor(SESSION_MAX_AGE_MS / 1000)];
  if (isHttps(req)) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}
function clearSessionCookie(req, res) {
  var parts = ['sid=', 'HttpOnly', 'Path=/', 'Max-Age=0', 'SameSite=Lax'];
  if (isHttps(req)) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}
function getSession(req) {
  var token = parseCookies(req).sid;
  if (!token) return null;
  var sess = sessions[token];
  if (!sess) return null;
  if (Date.now() - sess.createdAt > SESSION_MAX_AGE_MS) { delete sessions[token]; return null; }
  return { token: token, username: sess.username, role: sess.role, warehouseId: sess.warehouseId };
}
function createSession(req, res, u) {
  var token = newSessionToken();
  sessions[token] = { username: u.username, role: u.role, warehouseId: u.warehouseId || null, createdAt: Date.now() };
  setSessionCookie(req, res, token);
}
function destroySession(req, res) {
  var token = parseCookies(req).sid;
  if (token) delete sessions[token];
  clearSessionCookie(req, res);
}

/* Tentativas de login: trava por um tempo depois de várias senhas erradas seguidas pro mesmo
   usuário, pra dificultar tentativa de adivinhar senha por força bruta pela internet. */
var loginAttempts = Object.create(null); // username -> { count, lockedUntil }
var LOGIN_MAX_ATTEMPTS = 8;
var LOGIN_LOCK_MS = 10 * 60 * 1000;
function loginIsLocked(username) {
  var rec = loginAttempts[username];
  return !!(rec && rec.lockedUntil && Date.now() < rec.lockedUntil);
}
function registerLoginFailure(username) {
  var rec = loginAttempts[username] || { count: 0, lockedUntil: 0 };
  rec.count++;
  if (rec.count >= LOGIN_MAX_ATTEMPTS) { rec.lockedUntil = Date.now() + LOGIN_LOCK_MS; rec.count = 0; }
  loginAttempts[username] = rec;
}
function registerLoginSuccess(username) { delete loginAttempts[username]; }

/* Nunca manda o hash da senha pro navegador (nem do próprio usuário, nem de ninguém) — o app não
   precisa disso pra nada além de checar login, o que já acontece aqui no servidor. Só o backup
   completo do admin (/api/backup/export, rota separada) inclui os hashes de verdade, porque
   precisa disso pra um backup restaurado continuar deixando todo mundo logar. */
function publicStore(s) {
  return Object.assign({}, s, {
    users: (s.users || []).map(function (u) {
      return { username: u.username, role: u.role, warehouseId: u.warehouseId || null, createdAt: u.createdAt };
    })
  });
}

function seedMaterialsFor(wh) {
  return SEED_MATERIALS.map(function (s) {
    return {
      id: uid(), code: s.code, name: s.name, category: s.category, warehouseId: wh.id, warehouseName: wh.name,
      quantity: 0, unit: "UND", createdAt: nowIso(), updatedAt: nowIso()
    };
  });
}

function buildSeedStore() {
  const whs = DEFAULT_WAREHOUSES.map(function (name) { return { id: uid(), name: name, createdAt: nowIso() }; });
  const suppliers = DEFAULT_SUPPLIERS.map(function (name) { return { id: uid(), name: name, createdAt: nowIso() }; });
  var materials = [];
  whs.forEach(function (wh) { materials = materials.concat(seedMaterialsFor(wh)); });
  const users = [{ username: 'admin', passwordHash: ADMIN_HASH, role: 'admin', warehouseId: null, createdAt: nowIso() }];
  return { warehouses: whs, suppliers: suppliers, materials: materials, movements: [], users: users, dailyCounts: {} };
}

/* Garante que dados salvos por uma versão anterior (ou incompletos) fiquem no formato atual.
   Importante: esta versão introduziu DOIS almoxarifados físicos separados (antes havia só um,
   "Depósito"). Para não apagar nada que já existia, a migração aqui NUNCA remove nem renomeia
   um almoxarifado já existente — ela só garante que os dois almoxarifados padrão ("Almoxarifado Dois
   Irmãos" e "Almoxarifado Muribeca") existam, criando (com catálogo zerado) qualquer um dos
   dois que ainda não exista pelo nome. Se o servidor já tinha um único "Depósito" de uma versão
   anterior, ele continua existindo como um almoxarifado à parte — o admin pode renomeá-lo pela tela
   de Almoxarifados se quiser reaproveitá-lo como um dos dois novos, ou apagar a pasta "dados" para
   recomeçar do zero (perde os dados atuais). */
function migrate(s) {
  s = s || {};
  if (!Array.isArray(s.warehouses)) s.warehouses = [];
  if (!Array.isArray(s.materials)) s.materials = [];
  DEFAULT_WAREHOUSES.forEach(function (name) {
    var exists = s.warehouses.find(function (w) { return w.name === name; });
    if (!exists) {
      var newWh = { id: uid(), name: name, createdAt: nowIso() };
      s.warehouses.push(newWh);
      s.materials = s.materials.concat(seedMaterialsFor(newWh));
    }
  });
  s.materials.forEach(function (m) { delete m.minStock; });
  if (!Array.isArray(s.movements)) s.movements = [];
  if (!Array.isArray(s.users) || s.users.length === 0) {
    s.users = [{ username: 'admin', passwordHash: ADMIN_HASH, role: 'admin', warehouseId: null, createdAt: nowIso() }];
  }
  // Operadores sem almoxarifado válido definido (contas de uma versão anterior a essa) recebem o
  // primeiro almoxarifado como padrão, pra não ficarem sem conseguir acessar nada. Admins sempre têm
  // acesso a todos os almoxarifados, então não carregam um warehouseId.
  var fallbackWhId = s.warehouses[0] && s.warehouses[0].id;
  s.users.forEach(function (u) {
    if (u.role === 'admin') { u.warehouseId = null; return; }
    var ok = u.warehouseId && s.warehouses.find(function (w) { return w.id === u.warehouseId; });
    if (!ok) u.warehouseId = fallbackWhId || null;
  });
  if (!Array.isArray(s.suppliers) || s.suppliers.length === 0) {
    s.suppliers = DEFAULT_SUPPLIERS.map(function (name) { return { id: uid(), name: name, createdAt: nowIso() }; });
  }
  if (!s.dailyCounts || typeof s.dailyCounts !== 'object') s.dailyCounts = {};
  return s;
}

function persist(s) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  var tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2), 'utf8');
  fs.renameSync(tmp, DATA_FILE);
}

function loadStore() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      var raw = fs.readFileSync(DATA_FILE, 'utf8');
      var parsed = JSON.parse(raw);
      var migrated = migrate(parsed);
      persist(migrated);
      return migrated;
    }
  } catch (e) {
    console.error('Não consegui ler dados/store.json (' + e.message + '). Começando um catálogo novo — o arquivo antigo não foi apagado.');
  }
  var fresh = buildSeedStore();
  persist(fresh);
  return fresh;
}

var store = loadStore();

function warehouseName(id) { var w = store.warehouses.find(function (x) { return x.id === id; }); return w ? w.name : '—'; }
function supplierNameById(id) { var s = store.suppliers.find(function (x) { return x.id === id; }); return s ? s.name : ''; }
function materialById(id) { return store.materials.find(function (x) { return x.id === id; }); }

/* ================= clientes conectados (tempo real) ================= */
var sseClients = [];
function broadcastState() {
  var payload = 'data: ' + JSON.stringify(publicStore(store)) + '\n\n';
  sseClients.forEach(function (res) { try { res.write(payload); } catch (e) { /* cliente já desconectado */ } });
}
function saveAndBroadcast() {
  persist(store);
  broadcastState();
}

/* ================= arquivos estáticos (o app em si) =================
   Lista branca fixa: nunca serve nada fora desses arquivos (por exemplo,
   nunca serve dados/store.json, que tem os hashes de senha). */
var STATIC_FILES = {
  '/': 'index.html',
  '/index.html': 'index.html',
  '/style.css': 'style.css',
  '/app.js': 'app.js'
};
var CONTENT_TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8' };

function serveStatic(req, res, pathname) {
  var rel = STATIC_FILES[pathname];
  if (!rel) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Não encontrado'); return; }
  var filePath = path.join(ROOT, rel);
  fs.readFile(filePath, function (err, data) {
    if (err) { res.writeHead(500); res.end('Erro ao ler ' + rel); return; }
    res.writeHead(200, {
      'Content-Type': CONTENT_TYPES[path.extname(filePath)] || 'application/octet-stream',
      // Nunca deixa o navegador guardar uma cópia antiga do app em cache: sem isso, depois de
      // uma atualização do sistema, alguns dispositivos continuariam rodando a versão de JS
      // antiga (cache do navegador) enquanto o servidor já está com a versão nova — os dois
      // lados ficam com "sotaques" diferentes e coisas como login passam a falhar.
      'Cache-Control': 'no-cache, no-store, must-revalidate'
    });
    res.end(data);
  });
}

/* ================= corpo JSON das requisições ================= */
function readJsonBody(req) {
  return new Promise(function (resolve, reject) {
    var chunks = [];
    var total = 0;
    req.on('data', function (c) {
      total += c.length;
      if (total > 2 * 1024 * 1024) { reject(new Error('payload muito grande')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', function () {
      try {
        var s = Buffer.concat(chunks).toString('utf8');
        resolve(s ? JSON.parse(s) : {});
      } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}
function sendJson(res, code, obj) {
  var body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

/* ================= rotas da API ================= */
function handleApi(req, res, pathname, body, session) {
  try {
    if (pathname === '/api/login' && req.method === 'POST') {
      var username = String((body && body.username) || '').trim().toLowerCase();
      if (loginIsLocked(username)) {
        return sendJson(res, 200, { ok: false, error: 'Muitas tentativas erradas. Espere alguns minutos e tente de novo.' });
      }
      var passwordHash = hashPassword((body && body.password) || '');
      var u = store.users.find(function (x) { return x.username.toLowerCase() === username; });
      if (!u || u.passwordHash !== passwordHash) {
        registerLoginFailure(username);
        return sendJson(res, 200, { ok: false, error: 'Usuário ou senha inválidos.' });
      }
      registerLoginSuccess(username);
      createSession(req, res, u);
      return sendJson(res, 200, { ok: true, user: { username: u.username, role: u.role, warehouseId: u.warehouseId || null } });
    }

    if (pathname === '/api/session' && req.method === 'GET') {
      if (!session) return sendJson(res, 200, { ok: false });
      // confirma que o usuário da sessão ainda existe (pode ter sido removido depois do login)
      var su = store.users.find(function (x) { return x.username === session.username; });
      if (!su) return sendJson(res, 200, { ok: false });
      return sendJson(res, 200, { ok: true, user: { username: su.username, role: su.role, warehouseId: su.warehouseId || null } });
    }

    if (pathname === '/api/logout' && req.method === 'POST') {
      destroySession(req, res);
      return sendJson(res, 200, { ok: true });
    }

    // Todas as rotas abaixo desta linha exigem login.
    if (!session) return sendJson(res, 401, { ok: false, error: 'Sessão expirada. Faça login novamente.' });
    var isSessionAdmin = session.role === 'admin';

    if (pathname === '/api/backup/export' && req.method === 'GET') {
      if (!isSessionAdmin) return sendJson(res, 403, { ok: false, error: 'Só o administrador pode exportar o backup completo.' });
      // única rota que manda os hashes de senha de verdade — pro backup continuar deixando todo
      // mundo logar depois de restaurado. Nunca é mandada por SSE/broadcast.
      return sendJson(res, 200, store);
    }

    if (pathname === '/api/materials' && req.method === 'POST') {
      var name = (body.name || '').trim(), code = (body.code || '').trim();
      var category = CATEGORIES.indexOf(body.category) > -1 ? body.category : CATEGORIES[0];
      var warehouseId = body.warehouseId, unit = (body.unit || 'UND').trim() || 'UND';
      var quantity = Number(body.quantity);
      if (!isSessionAdmin && warehouseId !== session.warehouseId) {
        return sendJson(res, 403, { ok: false, error: 'Você só pode cadastrar materiais no seu próprio almoxarifado.' });
      }
      if (!name || !code || !warehouseId) return sendJson(res, 200, { ok: false, error: 'Preencha nome, código e almoxarifado.' });
      var dup = store.materials.find(function (m) { return m.code.toLowerCase() === code.toLowerCase() && m.warehouseId === warehouseId; });
      if (dup) return sendJson(res, 200, { ok: false, error: 'Já existe um material com esse código nesse almoxarifado.' });
      var now = nowIso();
      store.materials.push({
        id: uid(), name: name, code: code, category: category, warehouseId: warehouseId, warehouseName: warehouseName(warehouseId),
        unit: unit, quantity: isNaN(quantity) ? 0 : quantity, createdAt: now, updatedAt: now
      });
      saveAndBroadcast();
      return sendJson(res, 200, { ok: true });
    }
    var mMat = pathname.match(/^\/api\/materials\/([^/]+)$/);
    if (mMat && req.method === 'POST') {
      var mat = materialById(mMat[1]);
      if (!mat) return sendJson(res, 200, { ok: false, error: 'Material não encontrado.' });
      if (!isSessionAdmin && (mat.warehouseId !== session.warehouseId || body.warehouseId !== session.warehouseId)) {
        return sendJson(res, 403, { ok: false, error: 'Você só pode editar materiais do seu próprio almoxarifado.' });
      }
      var name2 = (body.name || '').trim(), code2 = (body.code || '').trim();
      var category2 = CATEGORIES.indexOf(body.category) > -1 ? body.category : mat.category;
      var warehouseId2 = body.warehouseId, unit2 = (body.unit || 'UND').trim() || 'UND';
      if (!name2 || !code2 || !warehouseId2) return sendJson(res, 200, { ok: false, error: 'Preencha nome, código e almoxarifado.' });
      var dup2 = store.materials.find(function (m) { return m.id !== mat.id && m.code.toLowerCase() === code2.toLowerCase() && m.warehouseId === warehouseId2; });
      if (dup2) return sendJson(res, 200, { ok: false, error: 'Já existe um material com esse código nesse almoxarifado.' });
      mat.name = name2; mat.code = code2; mat.category = category2; mat.warehouseId = warehouseId2;
      mat.warehouseName = warehouseName(warehouseId2); mat.unit = unit2; mat.updatedAt = nowIso();
      saveAndBroadcast();
      return sendJson(res, 200, { ok: true });
    }

    if (pathname === '/api/warehouses' && req.method === 'POST') {
      if (!isSessionAdmin) return sendJson(res, 403, { ok: false, error: 'Só o administrador pode gerenciar almoxarifados.' });
      var whName = (body.name || '').trim();
      if (!whName) return sendJson(res, 200, { ok: false, error: 'Informe um nome.' });
      var whDup = store.warehouses.find(function (w) { return w.name.toLowerCase() === whName.toLowerCase(); });
      if (whDup) return sendJson(res, 200, { ok: false, error: 'Já existe um almoxarifado com esse nome.' });
      store.warehouses.push({ id: uid(), name: whName, createdAt: nowIso() });
      saveAndBroadcast();
      return sendJson(res, 200, { ok: true });
    }
    var mWh = pathname.match(/^\/api\/warehouses\/([^/]+)$/);
    if (mWh && req.method === 'POST') {
      if (!isSessionAdmin) return sendJson(res, 403, { ok: false, error: 'Só o administrador pode gerenciar almoxarifados.' });
      var wh = store.warehouses.find(function (w) { return w.id === mWh[1]; });
      if (!wh) return sendJson(res, 200, { ok: false, error: 'Almoxarifado não encontrado.' });
      var whName2 = (body.name || '').trim();
      if (!whName2) return sendJson(res, 200, { ok: false, error: 'Informe um nome.' });
      var whDup2 = store.warehouses.find(function (w) { return w.id !== wh.id && w.name.toLowerCase() === whName2.toLowerCase(); });
      if (whDup2) return sendJson(res, 200, { ok: false, error: 'Já existe um almoxarifado com esse nome.' });
      wh.name = whName2;
      store.materials.filter(function (m) { return m.warehouseId === wh.id; }).forEach(function (m) { m.warehouseName = whName2; });
      saveAndBroadcast();
      return sendJson(res, 200, { ok: true });
    }

    if (pathname === '/api/suppliers' && req.method === 'POST') {
      if (!isSessionAdmin) return sendJson(res, 403, { ok: false, error: 'Só o administrador pode gerenciar fornecedores.' });
      var supName = (body.name || '').trim();
      if (!supName) return sendJson(res, 200, { ok: false, error: 'Informe um nome.' });
      var supDup = store.suppliers.find(function (s) { return s.name.toLowerCase() === supName.toLowerCase(); });
      if (supDup) return sendJson(res, 200, { ok: false, error: 'Já existe um fornecedor com esse nome.' });
      store.suppliers.push({ id: uid(), name: supName, createdAt: nowIso() });
      saveAndBroadcast();
      return sendJson(res, 200, { ok: true });
    }
    var mSup = pathname.match(/^\/api\/suppliers\/([^/]+)$/);
    if (mSup && req.method === 'POST') {
      if (!isSessionAdmin) return sendJson(res, 403, { ok: false, error: 'Só o administrador pode gerenciar fornecedores.' });
      var sup = store.suppliers.find(function (s) { return s.id === mSup[1]; });
      if (!sup) return sendJson(res, 200, { ok: false, error: 'Fornecedor não encontrado.' });
      var supName2 = (body.name || '').trim();
      if (!supName2) return sendJson(res, 200, { ok: false, error: 'Informe um nome.' });
      var supDup2 = store.suppliers.find(function (s) { return s.id !== sup.id && s.name.toLowerCase() === supName2.toLowerCase(); });
      if (supDup2) return sendJson(res, 200, { ok: false, error: 'Já existe um fornecedor com esse nome.' });
      sup.name = supName2;
      store.movements.filter(function (mv) { return mv.supplierId === sup.id; }).forEach(function (mv) { mv.supplierName = supName2; });
      saveAndBroadcast();
      return sendJson(res, 200, { ok: true });
    }

    if (pathname === '/api/movements' && req.method === 'POST') {
      var type = body.type;
      var mat3 = materialById(body.materialId);
      var qty = Number(body.quantity);
      var date = body.date;
      var person = (body.person || '').trim();
      if (!mat3 || ['entrada', 'saida', 'ajuste'].indexOf(type) === -1 || isNaN(qty) || qty < 0 || !date || !person) {
        return sendJson(res, 200, { ok: false, error: 'Preencha os campos obrigatórios.' });
      }
      if (!isSessionAdmin && mat3.warehouseId !== session.warehouseId) {
        return sendJson(res, 403, { ok: false, error: 'Você só pode lançar movimentações do seu próprio almoxarifado.' });
      }
      var now3 = nowIso();
      var prevQty = Number(mat3.quantity || 0);
      var newQty, delta;
      if (type === 'entrada') { newQty = prevQty + qty; delta = qty; }
      else if (type === 'saida') {
        if (qty > prevQty) return sendJson(res, 200, { ok: false, error: 'Quantidade indisponível. Em estoque: ' + prevQty + ' ' + mat3.unit + '.' });
        newQty = prevQty - qty; delta = qty;
      } else { newQty = qty; delta = qty - prevQty; }

      mat3.quantity = newQty; mat3.updatedAt = now3;
      var isEntrada = type === 'entrada';
      var supplierId = isEntrada ? (body.supplierId || '') : '';
      var supName3 = supplierId ? supplierNameById(supplierId) : '';
      var asset = isEntrada ? '' : (body.asset || '').trim();
      // O almoxarifado da movimentação é sempre o do próprio material (cada material agora pertence a
      // um único almoxarifado físico) — não confiamos num warehouseId vindo do cliente para isso.
      var whId3 = mat3.warehouseId;
      store.movements.unshift({
        id: uid(), materialId: mat3.id, materialCode: mat3.code, materialName: mat3.name, type: type,
        quantity: type === 'ajuste' ? Math.abs(delta) : qty,
        previousQty: prevQty, newQty: newQty, date: date, asset: asset,
        supplierId: supplierId, supplierName: supName3, person: person,
        warehouseId: whId3, warehouseName: warehouseName(whId3), note: (body.note || '').trim(),
        createdAt: now3, createdBy: session.username
      });
      saveAndBroadcast();
      return sendJson(res, 200, { ok: true });
    }

    if (pathname === '/api/users' && req.method === 'POST') {
      if (!isSessionAdmin) return sendJson(res, 403, { ok: false, error: 'Só o administrador pode gerenciar usuários.' });
      var uUser = (body.username || '').trim().toLowerCase();
      var uPass = body.password || '';
      var uRole = body.role === 'admin' ? 'admin' : 'operador';
      var uWh = uRole === 'operador' ? (body.warehouseId || '') : '';
      if (!uUser || uPass.length < 4) return sendJson(res, 200, { ok: false, error: 'Usuário obrigatório e senha com ao menos 4 caracteres.' });
      if (uRole === 'operador' && !store.warehouses.find(function (w) { return w.id === uWh; })) {
        return sendJson(res, 200, { ok: false, error: 'Selecione um almoxarifado válido para o operador.' });
      }
      if (store.users.find(function (x) { return x.username.toLowerCase() === uUser; })) return sendJson(res, 200, { ok: false, error: 'Já existe um usuário com esse nome.' });
      store.users.push({ username: uUser, passwordHash: hashPassword(uPass), role: uRole, warehouseId: uRole === 'operador' ? uWh : null, createdAt: nowIso() });
      saveAndBroadcast();
      return sendJson(res, 200, { ok: true });
    }
    var mPass = pathname.match(/^\/api\/users\/([^/]+)\/password$/);
    if (mPass && req.method === 'POST') {
      if (!isSessionAdmin) return sendJson(res, 403, { ok: false, error: 'Só o administrador pode gerenciar usuários.' });
      var uTarget = store.users.find(function (x) { return x.username === decodeURIComponent(mPass[1]); });
      if (!uTarget) return sendJson(res, 200, { ok: false, error: 'Usuário não encontrado.' });
      if (!body.password || String(body.password).length < 4) return sendJson(res, 200, { ok: false, error: 'Senha inválida.' });
      uTarget.passwordHash = hashPassword(body.password);
      saveAndBroadcast();
      return sendJson(res, 200, { ok: true });
    }
    var mWhUser = pathname.match(/^\/api\/users\/([^/]+)\/warehouse$/);
    if (mWhUser && req.method === 'POST') {
      if (!isSessionAdmin) return sendJson(res, 403, { ok: false, error: 'Só o administrador pode gerenciar usuários.' });
      var whUserTarget = store.users.find(function (x) { return x.username === decodeURIComponent(mWhUser[1]); });
      if (!whUserTarget) return sendJson(res, 200, { ok: false, error: 'Usuário não encontrado.' });
      if (whUserTarget.role === 'admin') return sendJson(res, 200, { ok: false, error: 'Administradores já têm acesso a todos os almoxarifados.' });
      var newWhId = body.warehouseId;
      if (!store.warehouses.find(function (w) { return w.id === newWhId; })) return sendJson(res, 200, { ok: false, error: 'Almoxarifado inválido.' });
      whUserTarget.warehouseId = newWhId;
      saveAndBroadcast();
      return sendJson(res, 200, { ok: true });
    }
    var mDel = pathname.match(/^\/api\/users\/([^/]+)\/delete$/);
    if (mDel && req.method === 'POST') {
      if (!isSessionAdmin) return sendJson(res, 403, { ok: false, error: 'Só o administrador pode gerenciar usuários.' });
      var delUname = decodeURIComponent(mDel[1]);
      var delTarget = store.users.find(function (u) { return u.username === delUname; });
      var admins = store.users.filter(function (u) { return u.role === 'admin'; });
      if (delTarget && delTarget.role === 'admin' && admins.length <= 1) return sendJson(res, 200, { ok: false, error: 'Não é possível remover o único administrador.' });
      var idx = store.users.findIndex(function (u) { return u.username === delUname; });
      if (idx > -1) store.users.splice(idx, 1);
      saveAndBroadcast();
      return sendJson(res, 200, { ok: true });
    }

    if (pathname === '/api/counts' && req.method === 'POST') {
      var cDate = body.date, cMaterialId = body.materialId, cValue = body.value;
      if (!cDate || !cMaterialId) return sendJson(res, 200, { ok: false, error: 'Dados inválidos.' });
      var cMat = materialById(cMaterialId);
      if (!isSessionAdmin && (!cMat || cMat.warehouseId !== session.warehouseId)) {
        return sendJson(res, 403, { ok: false, error: 'Você só pode contar materiais do seu próprio almoxarifado.' });
      }
      if (!store.dailyCounts[cDate]) store.dailyCounts[cDate] = {};
      if (cValue === null || cValue === undefined || cValue === '') { delete store.dailyCounts[cDate][cMaterialId]; }
      else { store.dailyCounts[cDate][cMaterialId] = Number(cValue); }
      saveAndBroadcast();
      return sendJson(res, 200, { ok: true });
    }
    var mClear = pathname.match(/^\/api\/counts\/([^/]+)\/clear$/);
    if (mClear && req.method === 'POST') {
      var clearDate = decodeURIComponent(mClear[1]);
      // Operador nunca decide isso pelo body: independente do que o cliente mandar, só pode
      // limpar o próprio almoxarifado. Só o admin pode limpar um armazém específico à escolha ou
      // 'ALL' (todos de uma vez).
      var clearWhId = isSessionAdmin ? (body && body.warehouseId) : session.warehouseId;
      if (!store.dailyCounts[clearDate]) store.dailyCounts[clearDate] = {};
      if (clearWhId && clearWhId !== 'ALL') {
        // limpa só a contagem dos materiais desse almoxarifado — nunca mexe na contagem do outro.
        var whMatIds = {};
        store.materials.forEach(function (m) { if (m.warehouseId === clearWhId) whMatIds[m.id] = true; });
        Object.keys(store.dailyCounts[clearDate]).forEach(function (mid) {
          if (whMatIds[mid]) delete store.dailyCounts[clearDate][mid];
        });
      } else {
        store.dailyCounts[clearDate] = {};
      }
      saveAndBroadcast();
      return sendJson(res, 200, { ok: true });
    }

    if (pathname === '/api/backup/import' && req.method === 'POST') {
      if (!isSessionAdmin) return sendJson(res, 403, { ok: false, error: 'Só o administrador pode importar backup.' });
      if (!Array.isArray(body.users) || !Array.isArray(body.warehouses) || !Array.isArray(body.materials) || !Array.isArray(body.movements)) {
        return sendJson(res, 200, { ok: false, error: 'Arquivo inválido: não parece um backup deste app.' });
      }
      store = migrate(body);
      saveAndBroadcast();
      return sendJson(res, 200, { ok: true });
    }

    return sendJson(res, 404, { ok: false, error: 'Rota não encontrada.' });
  } catch (err) {
    console.error('Erro tratando ' + pathname + ':', err);
    return sendJson(res, 500, { ok: false, error: 'Erro interno no servidor.' });
  }
}

/* ================= servidor HTTP ================= */
var server = http.createServer(function (req, res) {
  var parsed = url.parse(req.url, true);
  var pathname = decodeURIComponent(parsed.pathname || '/');

  if (pathname === '/api/events' && req.method === 'GET') {
    var evtSession = getSession(req);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    if (evtSession) {
      // Só quem já está logado (cookie de sessão válido) recebe o estado de verdade — e só essas
      // conexões entram na lista que recebe as atualizações em tempo real. Antes do login, o
      // navegador abre essa conexão só pra saber que o servidor está de pé; não tem dado nenhum
      // pra vazar, então não faz sentido (nem é seguro) mandar os dados reais antes de logar.
      res.write('data: ' + JSON.stringify(publicStore(store)) + '\n\n');
      sseClients.push(res);
    } else {
      res.write('data: ' + JSON.stringify({ unauthenticated: true }) + '\n\n');
    }
    var keepAlive = setInterval(function () { try { res.write(': ping\n\n'); } catch (e) { } }, 25000);
    req.on('close', function () {
      clearInterval(keepAlive);
      sseClients = sseClients.filter(function (c) { return c !== res; });
    });
    return;
  }

  if (pathname.indexOf('/api/') === 0) {
    var apiSession = getSession(req);
    if (req.method === 'GET') { return handleApi(req, res, pathname, {}, apiSession); }
    readJsonBody(req).then(function (body) {
      handleApi(req, res, pathname, body, apiSession);
    }).catch(function () {
      sendJson(res, 400, { ok: false, error: 'Requisição inválida.' });
    });
    return;
  }

  if (req.method === 'GET') { return serveStatic(req, res, pathname); }
  res.writeHead(405); res.end();
});

server.listen(PORT, '0.0.0.0', function () {
  console.log('=========================================================');
  console.log(' Controle de Pneus — servidor rodando');
  console.log('=========================================================');
  console.log(' Neste computador, abra no navegador:');
  console.log('   http://localhost:' + PORT);
  var nets = os.networkInterfaces();
  var ips = [];
  Object.keys(nets).forEach(function (name) {
    (nets[name] || []).forEach(function (net) {
      if (net.family === 'IPv4' && !net.internal) ips.push(net.address);
    });
  });
  if (ips.length) {
    console.log('');
    console.log(' De OUTROS celulares/computadores na MESMA rede Wi-Fi/cabo, abra:');
    ips.forEach(function (ip) { console.log('   http://' + ip + ':' + PORT); });
  } else {
    console.log('');
    console.log(' Não consegui detectar o IP desta rede automaticamente.');
    console.log(' No Windows, abra o Prompt de Comando e digite "ipconfig" para achar o "Endereço IPv4".');
  }
  console.log('');
  console.log(' Deixe esta janela aberta enquanto o sistema estiver em uso.');
  console.log(' Para parar o servidor, feche esta janela ou aperte Ctrl+C.');
  console.log('=========================================================');
});
