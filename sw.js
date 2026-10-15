/*
  Arquivo: sw.js
  Versão: 1.0.0
  Sessão: 9 — Instalação como app (PWA) e abrir sem internet
  Data: 15/10/2026

  Guarda no aparelho o "esqueleto" do Print para ele abrir sem internet.

  >>> REGRA PARA TODA SESSÃO FUTURA <<<
  Mudou qualquer arquivo do app (html, css, js, ícone)? Suba o número em VERSAO
  logo abaixo (ex.: 1.0.0 -> 1.0.1). Criou arquivo novo? Acrescente-o também
  em ARQUIVOS_APP. Sem isso, quem tem o app instalado não recebe a novidade
  pelo aviso "Nova versão do Print".

  Como funciona:
  - Instalação: baixa tudo de ARQUIVOS_APP + FIREBASE (obrigatórios) e o jsPDF
    (se falhar, entra no cache na primeira vez que o PDF carregar com sinal).
  - Arquivos do app e bibliotecas (gstatic do Firebase, jsPDF): cache primeiro,
    atualizando em segundo plano.
  - Abrir o app (navegação) sem internet: devolve o index.html do cache.
  - Firestore, Authentication, login Google e qualquer outro endereço:
    o service worker NÃO responde, a chamada passa direto pela rede.
  - Versão nova fica esperando. Só assume quando o app manda {tipo:'atualizar'}
    (o pintor tocou em "Nova versão do Print. Tocar para atualizar").
*/

const VERSAO = '1.0.0';
const CACHE = 'print-' + VERSAO;

const ARQUIVOS_APP = [
  './',
  './index.html',
  './style.css',
  './manifest.json',
  './icones/icone-192.png',
  './icones/icone-512.png',
  './icones/icone-maskable-512.png',
  './icones/apple-touch-icon.png',
  './js/app.js',
  './js/auth.js',
  './js/boasvindas.js',
  './js/clientes.js',
  './js/contato.js',
  './js/firebase-config.js',
  './js/firebase.js',
  './js/historico.js',
  './js/inicio.js',
  './js/master.js',
  './js/orcamento.js',
  './js/pdf.js',
  './js/perfil.js',
  './js/status.js',
  './js/textos.js',
  './js/uso.js',
  './js/utils.js',
  './css/cadastro.css',
  './css/clientes.css',
  './css/inicio.css',
  './css/orcamento.css',
  './css/pdf.css',
  './css/perfil.css'
];

// Os 3 módulos que o js/firebase.js importa (sem eles o app não abre offline).
const FIREBASE = [
  'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js',
  'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js',
  'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js'
];

// Gerador de PDF (o js/pdf.js carrega na primeira vez que gera um PDF).
const JSPDF = 'https://cdn.jsdelivr.net/npm/jspdf@4.2.1/dist/jspdf.umd.min.js';

// Endereços de fora que o service worker guarda (o resto passa direto).
function ehBibliotecaGuardavel(url) {
  return (url.hostname === 'www.gstatic.com' && url.pathname.startsWith('/firebasejs/12.19.0/')) ||
         (url.hostname === 'cdn.jsdelivr.net' && url.pathname.startsWith('/npm/jspdf@')) ||
         (url.hostname === 'unpkg.com' && url.pathname.startsWith('/jspdf@')); // reserva: só quando usada
}

// Nunca guardar (passam direto), mesmo que um dia caiam numa regra acima.
const NUNCA = [
  'firestore.googleapis.com', 'identitytoolkit.googleapis.com', 'securetoken.googleapis.com',
  'accounts.google.com', 'apis.google.com', 'www.googleapis.com'
];
function ehNunca(url) {
  return NUNCA.includes(url.hostname) ||
         url.hostname.endsWith('.firebaseapp.com') ||
         url.pathname.startsWith('/__/auth');
}

const ESCOPO = new URL('./', self.location.href);

/* ---------- Instalação ---------- */
self.addEventListener('install', evento => {
  evento.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // 'reload' pula o cache do navegador (o GitHub Pages guarda 10 min):
    // assim a versão nova baixa os arquivos novos de verdade.
    const pedidos = ARQUIVOS_APP.map(u => new Request(u, { cache: 'reload' }))
      .concat(FIREBASE.map(u => new Request(u, { mode: 'cors', cache: 'reload' })));
    await cache.addAll(pedidos); // se um falhar, a instalação tenta de novo na próxima abertura
    try {
      await cache.add(new Request(JSPDF, { mode: 'cors', cache: 'reload' }));
    } catch (e) {
      // sem jsPDF agora: ele entra no cache na primeira vez que o PDF carregar com sinal
    }
    // Não chama skipWaiting: a versão nova espera o toque do pintor.
  })());
});

/* ---------- Ativação: apaga caches de versões antigas ---------- */
self.addEventListener('activate', evento => {
  evento.waitUntil((async () => {
    const nomes = await caches.keys();
    await Promise.all(nomes
      .filter(n => n.startsWith('print-') && n !== CACHE)
      .map(n => caches.delete(n)));
    await self.clients.claim(); // na 1ª instalação, já controla a página aberta
  })());
});

/* ---------- Mensagens do app ---------- */
self.addEventListener('message', evento => {
  if (evento.data && evento.data.tipo === 'atualizar') self.skipWaiting();
});

/* ---------- Pedidos ---------- */
self.addEventListener('fetch', evento => {
  const req = evento.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (e) { return; }
  if (ehNunca(url)) return;

  const doApp = url.origin === ESCOPO.origin && url.pathname.startsWith(ESCOPO.pathname);

  // Abrir o app (ou recarregar): index.html do cache, atualizando em segundo plano.
  if (req.mode === 'navigate') {
    if (!doApp) return;
    evento.respondWith(navegacao(evento, req));
    return;
  }

  if (doApp || ehBibliotecaGuardavel(url)) {
    evento.respondWith(cachePrimeiro(evento, req));
  }
  // qualquer outro endereço: passa direto pela rede
});

/** Cache primeiro; busca na rede em segundo plano e atualiza o cache. */
async function cachePrimeiro(evento, req) {
  const cache = await caches.open(CACHE);
  const guardado = await cache.match(req, { ignoreSearch: true });
  const daRede = buscarEGuardar(cache, req);
  if (guardado) {
    evento.waitUntil(daRede.catch(() => {}));
    return guardado;
  }
  return daRede;
}

async function buscarEGuardar(cache, req) {
  const resp = await fetch(req);
  // Só guarda resposta boa e legível (status 200, sem resposta "opaca").
  if (resp && resp.ok && (resp.type === 'basic' || resp.type === 'cors')) {
    await cache.put(req, resp.clone());
  }
  return resp;
}

/** Navegação: o app é uma página só (index.html); as telas vêm pelo #. */
async function navegacao(evento, req) {
  const cache = await caches.open(CACHE);
  // Sempre a mesma página (./ e ./index.html são iguais), para não misturar versões.
  const guardado = (await cache.match('./index.html')) || (await cache.match('./'));
  if (guardado) {
    evento.waitUntil(
      fetch('./index.html', { cache: 'no-cache' }).then(async r => {
        if (r && r.ok && r.type === 'basic' && !r.redirected) {
          await cache.put('./index.html', r.clone());
          await cache.put('./', r);
        }
      }).catch(() => {})
    );
    return guardado;
  }
  try {
    return await fetch(req);
  } catch (e) {
    return new Response(
      '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">' +
      '<title>Print</title><body style="font:16px system-ui;padding:24px;text-align:center">' +
      '<h1>Sem internet</h1><p>Abra o Print uma vez com internet para ele funcionar sem sinal.</p></body>',
      { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    );
  }
}
