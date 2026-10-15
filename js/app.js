/*
  Arquivo: js/app.js
  Versão: 2.4.0
  Sessão: 9 — Instalação como app (PWA) e abrir sem internet
  Data: 15/10/2026
  2.4.0 (seção 9, nova; o resto é igual à 2.3.0, só mostrar() avisa a seção 9):
         registra o ./sw.js; faixa "Nova versão do Print. Tocar para atualizar"
         (a troca só acontece com o toque); faixa "Instalar o Print" (Android e
         computador pelo beforeinstallprompt; iPhone abre a folha "Como instalar
         no iPhone"); "Agora não" esconde por 7 dias (localStorage
         print.instalarDepois); faixa fina "Sem internet…". CSS injetado
         (<style data-print="pwa-css">, classes .pwa-).
  2.3.0 (só o caminho de Complete seu cadastro):
         rota #completar (telaCompletar de auth.js) e situação 'completar':
         logado sem users/{uid} (1º acesso com Google ou cadastro que não terminou),
         ou pendente antigo sem WhatsApp. Não cria mais documento pela metade:
         garantirDocumento devolve null e o app abre Complete seu cadastro.
         estado.semCadastro (novo). Telas Entrar, Criar conta e Completar
         carregam css/cadastro.css. O resto do arquivo é igual à 2.2.0.
  2.2.0: TELAS já apontam para perfil.js, inicio.js, clientes.js, orcamento.js
         e historico.js (se o arquivo ainda não existir, mostra a tela provisória);
         cada tela pode ter CSS próprio em css/{nome}.css (campo "css" em TELAS);
         atualizarTopo() mostra a logo do pintor (estado.perfil.logo) no topo e no menu.
         As Sessões 4, 5 e 6 NÃO alteram este arquivo, o style.css nem o index.html.
  Coração do app: estado global, roteador, toast, menu e tema.
  Sessão 2: telas reais de boas-vindas, entrar, cadastro, recuperar senha,
  situação da conta (pendente, recusado, bloqueado), contato e termos.

  Contrato de telas: cada tela é um módulo que exporta
    montar(container, ctx)   desenha a tela dentro de container
    desmontar()              (opcional) limpa ouvintes, timers etc.
  ctx traz: db, auth, estado, ir(tela, params), toast(msg, tipo), utils
  Extras no ctx: params (os params passados no ir), recarregarUsuario()

  Estado global: usuario (documento de users), uid, ehAdmin, planoEfetivo, perfil
  Extra (S2): erroUsuario (erro ao ler/criar o documento do usuário, ou null)

  Rotas do app (só para status "ativo"): #inicio #clientes #orcamento #historico #perfil #master
  Rotas sem login:          #boasvindas #entrar #cadastro #recuperar
  Situação da conta:        #pendente #recusado #bloqueado (+ #problema, extra da S2)
  Para qualquer logado:     #contato
  Livres (sempre abrem):    #termos (#termos/privacidade, #termos/sobre)

  Quem vai para onde (o roteador decide sozinho):
    sem login            -> boas-vindas na primeira vez, depois Entrar
    logado, sem cadastro -> #problema (Tentar de novo / Sair)
    pendente/recusado/bloqueado -> a tela da situação (e #contato)
    ativo                -> o app, com o menu inferior/lateral
  O menu só aparece para usuário ativo.

  Para ligar a tela real de uma sessão futura, troque o "carregar" dela em TELAS,
  por exemplo:  clientes: { ..., carregar: () => import('./clientes.js') }
*/

import { auth, db, fs, fa } from './firebase.js';
import * as utils from './utils.js';
import { iniciarUso, pararUso } from './uso.js';
import { jaViuBoasVindas } from './boasvindas.js';
import { garantirDocumento, sair, telaEntrar, telaCadastro, telaRecuperar, telaCompletar } from './auth.js'; // 2.3.0: + telaCompletar
import { rodapeLegal } from './textos.js';

const { esc } = utils;
const $ = s => document.querySelector(s);

/* ============================================================
   1. Estado global
   ============================================================ */
export const estado = {
  usuario: null,        // documento users/{uid} (ou null)
  uid: null,
  ehAdmin: false,
  planoEfetivo: 'free', // 'free' ou 'pro' (ver utils.planoEfetivo)
  perfil: {},           // usuario.perfil (ou {})
  erroUsuario: null,    // S2: erro ao carregar/criar users/{uid}
  semCadastro: false    // 2.3.0: logado, mas users/{uid} não existe no servidor (falta Complete seu cadastro)
};

/* ============================================================
   2. Toast (aviso rápido)
   ============================================================ */
let toastTimer = null;
/** toast('Salvo!') · toast('Salvo!', 'ok') · toast('Falhou', 'erro') */
export function toast(msg, tipo = '') {
  const el = $('.js-toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.remove('ok', 'erro');
  if (tipo) el.classList.add(tipo);
  el.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('on'), tipo === 'erro' ? 4500 : 2400);
}

/* ============================================================
   3. Telas
   ============================================================ */

/** Tela provisória: só um título (as telas reais chegam nas próximas sessões). */
function provisoria(titulo, nota) {
  return {
    montar(el) {
      el.innerHTML = '<h1>' + esc(titulo) + '</h1>' +
        (nota ? '<p class="muted">' + esc(nota) + '</p>' : '');
    }
  };
}

/**
 * 2.2.0: carrega o módulo real da tela; se o arquivo ainda não existir
 * (sessão não concluída), mostra a tela provisória no lugar.
 * Sessão 10: trocar por import direto quando todas as telas existirem.
 */
function modulo(carregar, reserva) {
  return async () => {
    try { return await carregar(); }
    catch (e) {
      console.warn('[Print] tela ainda indisponível, usando provisória', e);
      return reserva;
    }
  };
}

/** 2.2.0: CSS próprio da tela (css/{nome}.css), carregado uma vez só. */
const cssCarregados = {};
function carregarCSS(nome) {
  if (!nome) return Promise.resolve();
  if (!cssCarregados[nome]) {
    cssCarregados[nome] = new Promise(ok => {
      const l = document.createElement('link');
      l.rel = 'stylesheet';
      l.href = './css/' + nome + '.css';
      l.dataset.css = nome;
      l.onload = l.onerror = () => ok();
      document.head.appendChild(l);
      setTimeout(ok, 3000); // nunca trava a tela esperando CSS
    });
  }
  return cssCarregados[nome];
}

/** 2.2.0: logo do pintor no topo e no menu (volta para o "P" sem logo). */
function atualizarTopo() {
  const logo = estado.perfil?.logo;
  document.querySelectorAll('.topo .marca-logo, .menu-marca .marca-logo').forEach(el => {
    if (logo && /^data:image\//.test(logo)) {
      const img = document.createElement('img');
      img.src = logo;
      img.alt = '';
      el.replaceChildren(img);
      el.style.background = '#fff';
    } else {
      el.textContent = 'P';
      el.style.background = '';
    }
  });
}

/**
 * Perfil PROVISÓRIO (a Sessão 4 faz o perfil real).
 * A Sessão 4 deve manter: botão Falar com a equipe, botão Sair e o rodapé
 * com Termos, Privacidade e Sobre (rodapeLegal() de textos.js).
 */
const perfilProvisorio = {
  montar(el, ctx) {
    const u = estado.usuario || {};
    el.innerHTML =
      '<h1>Perfil</h1>' +
      '<p class="muted">Tela provisória. O perfil completo chega na Sessão 4.</p>' +
      '<div class="card"><b>' + esc(u.nome || 'Sem nome') + '</b>' +
      '<p class="muted">' + esc(u.email || auth.currentUser?.email || '') + '</p></div>' +
      '<button class="big js-contato" type="button">💬 Falar com a equipe</button>' +
      '<button class="big js-sair" type="button">↩️ Sair</button>' +
      rodapeLegal();
    el.querySelector('.js-contato').addEventListener('click', () => ctx.ir('contato', { de: 'perfil' }));
    const b = el.querySelector('.js-sair');
    b.addEventListener('click', async () => { b.disabled = true; await sair(ctx); b.disabled = false; });
  }
};

/*
  protegida:   só abre para usuário com status "ativo"
  admin:       só abre para quem está em admins/{uid}
  soDeslogado: só abre sem login (boas-vindas, entrar, cadastro, recuperar)
  situacao:    tela da situação da conta (pendente, recusado, bloqueado, problema)
  logado:      abre para qualquer usuário logado com cadastro (contato)
  livre:       abre sempre (termos)
*/
const TELAS = {
  // 2.2.0: telas reais das Sessões 4, 5 e 6 (provisória enquanto o arquivo não existir)
  inicio:      { titulo: 'Início',    protegida: true, css: 'inicio',
                 carregar: modulo(() => import('./inicio.js'), provisoria('Início', 'Tela provisória. A tela inicial chega na Sessão 5.')) },
  clientes:    { titulo: 'Clientes',  protegida: true, css: 'clientes',
                 carregar: modulo(() => import('./clientes.js'), provisoria('Clientes', 'Tela provisória. Chega na Sessão 5.')) },
  orcamento:   { titulo: 'Orçamento', protegida: true, css: 'orcamento',
                 carregar: modulo(() => import('./orcamento.js'), provisoria('Novo orçamento', 'Tela provisória. Chega na Sessão 6.')) },
  historico:   { titulo: 'Histórico', protegida: true, css: 'orcamento',
                 carregar: modulo(() => import('./historico.js'), provisoria('Histórico', 'Tela provisória. Chega na Sessão 6.')) },
  perfil:      { titulo: 'Perfil',    protegida: true, css: 'perfil',
                 carregar: modulo(() => import('./perfil.js'), perfilProvisorio) },
  master:      { titulo: 'Painel master', protegida: true, admin: true, carregar: () => import('./master.js') },

  boasvindas:  { titulo: 'Boas-vindas',     soDeslogado: true, carregar: () => import('./boasvindas.js') },
  entrar:      { titulo: 'Entrar',          soDeslogado: true, css: 'cadastro', carregar: async () => telaEntrar },     // 2.3.0: + css
  cadastro:    { titulo: 'Criar conta',     soDeslogado: true, css: 'cadastro', carregar: async () => telaCadastro },   // 2.3.0: + css
  recuperar:   { titulo: 'Recuperar senha', soDeslogado: true, carregar: async () => telaRecuperar },

  pendente:    { titulo: 'Aguardando liberação', situacao: true, carregar: async () => (await import('./status.js')).telaPendente },
  recusado:    { titulo: 'Cadastro não aprovado', situacao: true, carregar: async () => (await import('./status.js')).telaRecusado },
  bloqueado:   { titulo: 'Acesso bloqueado',      situacao: true, carregar: async () => (await import('./status.js')).telaBloqueado },
  problema:    { titulo: 'Sua conta',             situacao: true, carregar: async () => (await import('./status.js')).telaProblema },
  completar:   { titulo: 'Complete seu cadastro', situacao: true, css: 'cadastro', carregar: async () => telaCompletar }, // 2.3.0

  contato:     { titulo: 'Falar com a equipe', logado: true, carregar: () => import('./contato.js') },
  termos:      { titulo: 'Termos e privacidade', livre: true, carregar: () => import('./textos.js') }
};

const MENU = [
  { tela: 'inicio',    ic: '🏠', txt: 'Início' },
  { tela: 'clientes',  ic: '👥', txt: 'Clientes' },
  { tela: 'orcamento', ic: '➕', txt: 'Orçamento' },
  { tela: 'historico', ic: '📄', txt: 'Histórico' },
  { tela: 'perfil',    ic: '👤', txt: 'Perfil' },
  { tela: 'master',    ic: '🛡️', txt: 'Master', admin: true }
];

/**
 * Situação de quem está usando o app agora:
 * 'deslogado', 'problema' (logado sem cadastro carregado), 'pendente',
 * 'recusado', 'bloqueado' ou 'ativo'.
 */
function situacao() {
  if (!estado.uid) return 'deslogado';
  if (!estado.usuario) return estado.semCadastro ? 'completar' : 'problema'; // 2.3.0
  const s = estado.usuario.status;
  // 2.3.0: pendente antigo sem WhatsApp (documento criado pela metade) completa o cadastro
  if (!estado.ehAdmin && (s || 'pendente') === 'pendente' && !estado.usuario.whatsapp) return 'completar';
  if (s === 'ativo' || s === 'recusado' || s === 'bloqueado') return s;
  return 'pendente'; // pendente ou qualquer valor estranho
}

/** Para qual tela a pessoa vai, dada a tela pedida e a situação dela. */
function destinoPara(nome) {
  const def = TELAS[nome];
  if (def.livre) return nome;
  const s = situacao();
  if (s === 'deslogado') {
    if (def.soDeslogado) return nome;
    return jaViuBoasVindas() ? 'entrar' : 'boasvindas';
  }
  if (s === 'problema') return 'problema';
  if (s === 'completar') return def.logado ? nome : 'completar'; // 2.3.0 (Falar com a equipe continua aberto)
  if (s !== 'ativo') {
    if (def.logado) return nome;   // contato
    return s;                      // pendente, recusado ou bloqueado
  }
  // ativo
  if (def.soDeslogado || def.situacao) return 'inicio';
  return nome;
}

/** Bloqueio que sobra depois do destino: área do administrador. */
function bloqueioDe(def) {
  if (def.admin && !estado.ehAdmin) {
    return provisoria('Área restrita', 'Esta área é só do administrador.');
  }
  return null;
}

/* ============================================================
   4. Roteador
   ============================================================ */
let telaAtual = null;      // { nome, mod }
let pedido = null;         // { tela, params } vindo do ir()
let geracao = 0;           // evita trocar de tela fora de ordem
let iniciado = false;

function telaDoEndereco() {
  const t = location.hash.replace(/^#\/?/, '').split(/[/?]/)[0];
  return TELAS[t] ? t : 'inicio';
}

/** Abre uma tela: ir('clientes') · ir('orcamento', { id: 'abc' }) */
export function ir(tela, params = {}) {
  if (!TELAS[tela]) tela = 'inicio';
  pedido = { tela, params };
  const alvo = '#' + tela;
  if (location.hash === alvo) mostrar();
  else location.hash = alvo; // o hashchange chama mostrar()
}

function criarCtx(params = {}) {
  return { db, auth, estado, ir, toast, utils, params, recarregarUsuario };
}

async function mostrar() {
  const pedida = telaDoEndereco();
  const nome = destinoPara(pedida);
  if (nome !== pedida) {
    // Troca o endereço sem criar um passo a mais no botão Voltar.
    history.replaceState(null, '', '#' + nome);
  }
  const params = pedido && pedido.tela === nome ? pedido.params : {};
  pedido = null;
  const minha = ++geracao;

  if (telaAtual?.mod?.desmontar) {
    try { telaAtual.mod.desmontar(); } catch (e) { console.error('[Print] desmontar', e); }
  }
  telaAtual = null;

  const def = TELAS[nome];
  let mod = bloqueioDe(def);
  if (!mod) {
    try { [mod] = await Promise.all([def.carregar(), carregarCSS(def.css)]); }
    catch (e) {
      console.error('[Print] carregar tela', e);
      mod = provisoria('Não deu para abrir esta tela', 'Confira a internet e tente de novo.');
    }
  }
  if (minha !== geracao) return; // o usuário já foi para outra tela

  mostrarMenu(situacao() === 'ativo');
  pwaTrocouTela(nome); // 2.4.0
  const conteudo = $('.js-conteudo');
  const el = document.createElement('section');
  el.className = 'tela';
  conteudo.replaceChildren(el);
  telaAtual = { nome, mod };
  document.title = (def.titulo ? def.titulo + ' · ' : '') + 'Print';
  marcarMenu(nome);
  window.scrollTo(0, 0);

  try {
    await mod.montar(el, criarCtx(params));
  } catch (e) {
    console.error('[Print] montar tela', e);
    el.innerHTML = '<h1>Algo deu errado</h1><p class="muted">' + esc(utils.traduzErro(e)) + '</p>';
  }
}

/* ============================================================
   5. Menu (inferior no celular, lateral no computador)
   Só aparece para usuário ativo.
   ============================================================ */
function mostrarMenu(sim) {
  document.documentElement.classList.toggle('sem-menu', !sim);
  const nav = $('.menu');
  if (nav) nav.hidden = !sim;
}

function montarMenu() {
  const box = $('.js-menu');
  if (!box) return;
  if (situacao() !== 'ativo') { box.innerHTML = ''; mostrarMenu(false); return; }
  box.innerHTML = MENU
    .filter(m => !m.admin || estado.ehAdmin)
    .map(m => '<a class="menu-item" href="#' + m.tela + '" data-tela="' + m.tela + '">' +
      '<span class="ic" aria-hidden="true">' + m.ic + '</span><span>' + esc(m.txt) + '</span></a>')
    .join('');
  mostrarMenu(true);
  if (telaAtual) marcarMenu(telaAtual.nome);
}

function marcarMenu(nome) {
  document.querySelectorAll('.menu-item').forEach(a => {
    const on = a.dataset.tela === nome;
    a.classList.toggle('on', on);
    if (on) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
}

/* ============================================================
   6. Tema claro / escuro (automático -> claro -> escuro)
   ============================================================ */
const TEMAS = { auto: 'Tema automático', claro: 'Tema claro', escuro: 'Tema escuro' };

function lerTema() {
  try { return localStorage.getItem('print.tema') || 'auto'; } catch (e) { return 'auto'; }
}

function aplicarTema(t) {
  const raiz = document.documentElement;
  if (t === 'claro') raiz.setAttribute('data-theme', 'light');
  else if (t === 'escuro') raiz.setAttribute('data-theme', 'dark');
  else raiz.removeAttribute('data-theme');
  document.querySelectorAll('.js-tema-txt').forEach(s => { s.textContent = TEMAS[t]; });
  document.querySelectorAll('.js-tema').forEach(b => b.setAttribute('aria-label', TEMAS[t] + ' (tocar para trocar)'));
  const fundo = getComputedStyle(raiz).getPropertyValue('--bg').trim();
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta && fundo) meta.setAttribute('content', fundo);
}

function trocarTema() {
  const ordem = ['auto', 'claro', 'escuro'];
  const novo = ordem[(ordem.indexOf(lerTema()) + 1) % ordem.length];
  try { localStorage.setItem('print.tema', novo); } catch (e) { /* sem armazenamento: só nesta visita */ }
  aplicarTema(novo);
  toast(TEMAS[novo]);
}

/* ============================================================
   7. Usuário logado
   ============================================================ */
async function carregarUsuario(user) {
  if (!user) {
    await pararUso();
    Object.assign(estado, { usuario: null, uid: null, ehAdmin: false, planoEfetivo: 'free', perfil: {}, erroUsuario: null, semCadastro: false });
    atualizarTopo(); // 2.2.0
    return;
  }
  estado.uid = user.uid;
  estado.erroUsuario = null;
  estado.semCadastro = false; // 2.3.0
  const [u, a] = await Promise.allSettled([
    fs.getDoc(fs.doc(db, 'users', user.uid)),
    fs.getDoc(fs.doc(db, 'admins', user.uid))
  ]);
  estado.ehAdmin = a.status === 'fulfilled' && a.value.exists();

  if (u.status === 'rejected') {
    console.warn('[Print] leitura de users', u.reason);
    estado.usuario = null;
    estado.erroUsuario = u.reason;
  } else if (u.value.exists()) {
    estado.usuario = u.value.data();
  } else {
    // 2.3.0: conta existe no Authentication, mas o documento não.
    // Se há um cadastro por e-mail em andamento, ele é criado agora (users + telefones).
    // Sem dados (1º acesso com Google ou cadastro que não terminou): Complete seu cadastro.
    try {
      estado.usuario = await garantirDocumento(user);
      if (!estado.usuario) estado.semCadastro = true;
    } catch (e) {
      console.warn('[Print] criar documento do usuário', e);
      estado.usuario = null;
      if (e?.code === 'print/whats-repetido') estado.semCadastro = true; // WhatsApp já usado: troca o número no Completar
      else estado.erroUsuario = e;
    }
  }
  estado.planoEfetivo = utils.planoEfetivo(estado.usuario);
  estado.perfil = estado.usuario?.perfil || {};
  atualizarTopo(); // 2.2.0

  if (estado.usuario?.status === 'ativo') iniciarUso(criarCtx());
  else await pararUso();
}

/** Relê o documento do usuário (ex.: depois de salvar o perfil). */
export async function recarregarUsuario() {
  try {
    await carregarUsuario(auth.currentUser);
  } catch (e) {
    console.error('[Print] recarregar usuário', e);
    toast(utils.traduzErro(e), 'erro');
  }
  montarMenu();
  // 2.3.0: "Tentar de novo" da tela de problema descobriu que falta completar o cadastro.
  if (situacao() === 'completar' && telaAtual?.nome === 'problema') mostrar();
}

/* ============================================================
   9. App instalado (PWA) — Sessão 9 · 2.4.0
   Faixas no alto (abaixo do topo): sem internet, nova versão, instalar.
   ============================================================ */
const PWA_ADIAR_DIAS = 7;
const pwa = {
  caixa: null,        // <div class="pwa-topo">
  pedidoInstalar: null, // evento beforeinstallprompt guardado
  regSw: null,        // registro do service worker
  atualizando: false, // o pintor tocou em "atualizar"
  tela: null          // tela atual (para não mostrar o convite nas boas-vindas)
};

function pwaInstalado() {
  return window.matchMedia?.('(display-mode: standalone)').matches ||
         window.matchMedia?.('(display-mode: fullscreen)').matches ||
         window.navigator.standalone === true;
}

function pwaEhIphone() {
  const ua = navigator.userAgent || '';
  return /iPhone|iPad|iPod/.test(ua) ||
         (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1); // iPad novo se diz Mac
}

function pwaAdiado() {
  try {
    const ate = Number(localStorage.getItem('print.instalarDepois') || 0);
    return ate > Date.now();
  } catch (e) { return false; }
}

function pwaAdiar() {
  try { localStorage.setItem('print.instalarDepois', String(Date.now() + PWA_ADIAR_DIAS * 864e5)); }
  catch (e) { /* sem armazenamento: some só nesta visita */ }
}

function pwaCss() {
  if (document.querySelector('style[data-print="pwa-css"]')) return;
  const st = document.createElement('style');
  st.dataset.print = 'pwa-css';
  st.textContent = `
.pwa-topo { position: sticky; top: 0; z-index: 3; }
.pwa-topo:empty { display: none; }
@media (min-width: 900px) { .pwa-topo { margin-left: var(--side-w); } }
.pwa-semnet { background: var(--star); color: #1b1b1b; font-size: 13px; font-weight: 600; line-height: 1.3; padding: 6px 16px; text-align: center; }
.pwa-faixa { display: flex; align-items: center; gap: 8px; max-width: 760px; margin: 8px auto 0; padding: 6px 6px 6px 14px; background: var(--card); border: 1.5px solid var(--line); border-radius: var(--raio); box-shadow: 0 4px 14px rgba(0, 0, 0, .12); }
.pwa-faixa + .pwa-faixa { margin-top: 6px; }
.pwa-topo > :last-child.pwa-faixa { margin-bottom: 4px; }
@media (max-width: 899px) { .pwa-faixa { margin-left: 10px; margin-right: 10px; } }
.pwa-faixa-txt { flex: 1 1 auto; font-weight: 650; font-size: 15px; min-width: 0; }
.pwa-btn { min-height: var(--toque); padding: 0 14px; border-radius: 12px; border: 1.5px solid var(--line); background: var(--card); font-weight: 650; font-size: 15px; flex: none; }
.pwa-btn.pwa-sim { background: var(--brand); border-color: var(--brand); color: var(--onbrand); }
.pwa-btn.pwa-nao { border-color: transparent; background: none; color: var(--muted); padding: 0 10px; }
button.pwa-faixa.pwa-nova { width: calc(100% - 20px); min-height: var(--toque); text-align: left; background: var(--brand); border-color: var(--brand); color: var(--onbrand); font: inherit; font-weight: 700; padding: 10px 14px; }
@media (min-width: 900px) { button.pwa-faixa.pwa-nova { width: auto; max-width: 760px; display: flex; } }
.pwa-folha .sheet h2 { margin: 4px 0 6px; font-size: 20px; }
.pwa-passos { list-style: none; margin: 12px 0 16px; padding: 0; counter-reset: pwa; }
.pwa-passos li { counter-increment: pwa; display: flex; align-items: center; gap: 12px; padding: 10px 0; border-bottom: 1px solid var(--line); font-size: 16px; }
.pwa-passos li:last-child { border-bottom: 0; }
.pwa-passos li::before { content: counter(pwa); flex: none; width: 30px; height: 30px; border-radius: 50%; background: var(--soft); color: var(--brand); font-weight: 800; display: inline-flex; align-items: center; justify-content: center; }
.pwa-ic { display: inline-flex; vertical-align: middle; color: var(--brand); }
.pwa-ic svg { width: 22px; height: 22px; }
`;
  document.head.appendChild(st);
}

function pwaCaixa() {
  if (pwa.caixa) return pwa.caixa;
  pwaCss();
  const c = document.createElement('div');
  c.className = 'pwa-topo';
  const topo = $('.topo');
  if (topo) topo.after(c); else $('.shell')?.prepend(c);
  pwa.caixa = c;
  return c;
}

/** Desenha as faixas que valem agora (chamada sempre que algo muda). */
function pwaDesenhar() {
  const c = pwaCaixa();
  const partes = [];

  if (navigator.onLine === false) {
    partes.push('<div class="pwa-semnet" role="status">Sem internet. O que você salvar vai junto quando o sinal voltar.</div>');
  }
  if (pwa.regSw?.waiting && navigator.serviceWorker?.controller) {
    partes.push('<button type="button" class="pwa-faixa pwa-nova js-pwa-atualizar">' +
      (pwa.atualizando ? '⏳ Atualizando…' : '🔄 Nova versão do Print. Tocar para atualizar') + '</button>');
  }
  if (pwaMostrarConvite()) {
    partes.push('<div class="pwa-faixa pwa-instalar" role="region" aria-label="Instalar o Print">' +
      '<span class="pwa-faixa-txt">📲 Instalar o Print</span>' +
      '<button type="button" class="pwa-btn pwa-nao js-pwa-depois">Agora não</button>' +
      '<button type="button" class="pwa-btn pwa-sim js-pwa-instalar">Instalar</button></div>');
  }

  c.innerHTML = partes.join('');
  pwaEncaixar();
  c.querySelector('.js-pwa-atualizar')?.addEventListener('click', pwaAtualizar);
  c.querySelector('.js-pwa-depois')?.addEventListener('click', () => { pwaAdiar(); pwaDesenhar(); });
  c.querySelector('.js-pwa-instalar')?.addEventListener('click', pwaInstalar);
}

/** Gruda as faixas logo abaixo do topo (a altura do topo muda com o entalhe do celular). */
function pwaEncaixar() {
  const c = pwa.caixa;
  if (!c) return;
  const t = $('.topo');
  const h = t && getComputedStyle(t).display !== 'none' ? t.getBoundingClientRect().height : 0;
  c.style.top = Math.round(h) + 'px';
}

function pwaMostrarConvite() {
  if (pwaInstalado() || pwaAdiado()) return false;
  if (!pwa.tela || pwa.tela === 'boasvindas') return false;
  if (pwa.pedidoInstalar) return true;                 // Android e computador
  return pwaEhIphone();                                 // iPhone/iPad: folha de ajuda
}

async function pwaInstalar() {
  const ev = pwa.pedidoInstalar;
  if (!ev) { pwaFolhaIphone(); return; }
  pwa.pedidoInstalar = null; // o pedido só pode ser usado uma vez
  try {
    ev.prompt();
    const r = await ev.userChoice;
    if (r?.outcome !== 'accepted') pwaAdiar(); // fechou sem instalar = "Agora não"
  } catch (e) {
    console.warn('[Print] instalar', e);
  }
  pwaDesenhar();
}

/** Folha "Como instalar no iPhone" (nunca alert). */
function pwaFolhaIphone() {
  pwaCss();
  const icCompartilhar = '<span class="pwa-ic" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="M8 7l4-4 4 4"/><path d="M6 11H5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-1"/></svg></span>';
  const icMais = '<span class="pwa-ic" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="4" y="4" width="16" height="16" rx="4"/><path d="M12 8v8M8 12h8"/></svg></span>';
  const ov = document.createElement('div');
  ov.className = 'ov pwa-folha';
  ov.innerHTML =
    '<div class="sheet" role="dialog" aria-modal="true" aria-labelledby="pwa-folha-tit">' +
      '<h2 id="pwa-folha-tit">Como instalar no iPhone</h2>' +
      '<p class="muted">Leva 10 segundos. Depois o Print abre pelo ícone, em tela cheia.</p>' +
      '<ol class="pwa-passos">' +
        '<li><span>Toque em <b>Compartilhar</b> ' + icCompartilhar + ' (o quadrado com a seta, na barra do Safari)</span></li>' +
        '<li><span>Role e toque em <b>Adicionar à Tela de Início</b> ' + icMais + '</span></li>' +
        '<li><span>Toque em <b>Adicionar</b>, no canto de cima</span></li>' +
      '</ol>' +
      '<button type="button" class="big primary js-pwa-ok">Entendi</button>' +
      '<button type="button" class="big js-pwa-folha-depois" style="justify-content:center">Agora não</button>' +
    '</div>';
  const fechar = () => { ov.remove(); document.removeEventListener('keydown', tecla); };
  const tecla = e => { if (e.key === 'Escape') fechar(); };
  ov.addEventListener('click', e => { if (e.target === ov) fechar(); });
  ov.querySelector('.js-pwa-ok').addEventListener('click', fechar);
  ov.querySelector('.js-pwa-folha-depois').addEventListener('click', () => { pwaAdiar(); fechar(); pwaDesenhar(); });
  document.addEventListener('keydown', tecla);
  document.body.appendChild(ov);
  ov.querySelector('.js-pwa-ok').focus();
}

/** O pintor tocou em "Nova versão": a versão que esperava assume e a página recarrega. */
function pwaAtualizar() {
  const espera = pwa.regSw?.waiting;
  if (!espera) { location.reload(); return; }
  pwa.atualizando = true;
  pwaDesenhar();
  espera.postMessage({ tipo: 'atualizar' });
  setTimeout(() => location.reload(), 4000); // reserva, se o aviso de troca não chegar
}

/** Chamada pelo roteador a cada troca de tela. */
function pwaTrocouTela(nome) {
  pwa.tela = nome;
  pwaDesenhar();
}

async function pwaRegistrar() {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
  // Só recarrega quando o pintor pediu (a 1ª instalação também troca o controle, sem recarregar).
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (pwa.atualizando) location.reload();
  });
  try {
    const reg = await navigator.serviceWorker.register('./sw.js', { scope: './' });
    pwa.regSw = reg;
    const vigiar = sw => {
      if (!sw) return;
      sw.addEventListener('statechange', () => { if (sw.state === 'installed') pwaDesenhar(); });
    };
    vigiar(reg.installing);
    reg.addEventListener('updatefound', () => vigiar(reg.installing));
    pwaDesenhar();
    // App instalado fica dias aberto em segundo plano: procura versão nova ao voltar (no máximo 1×/hora).
    let ultimaBusca = Date.now();
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && navigator.onLine !== false && Date.now() - ultimaBusca > 36e5) {
        ultimaBusca = Date.now();
        reg.update().catch(() => {});
      }
    });
  } catch (e) {
    console.warn('[Print] service worker não registrado', e);
  }
}

function iniciarPwa() {
  pwaCaixa();
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();          // guarda para mostrar a nossa faixa
    pwa.pedidoInstalar = e;
    pwaDesenhar();
  });
  window.addEventListener('appinstalled', () => {
    pwa.pedidoInstalar = null;
    pwaDesenhar();
  });
  window.addEventListener('resize', pwaEncaixar);
  window.addEventListener('online', pwaDesenhar);
  window.addEventListener('offline', pwaDesenhar);
  window.matchMedia?.('(display-mode: standalone)').addEventListener?.('change', pwaDesenhar);
  pwaDesenhar();
  if (document.readyState === 'complete') pwaRegistrar();
  else window.addEventListener('load', pwaRegistrar, { once: true });
}

/* ============================================================
   8. Partida
   ============================================================ */
function iniciar() {
  aplicarTema(lerTema());
  iniciarPwa(); // 2.4.0
  document.querySelectorAll('.js-tema').forEach(b => b.addEventListener('click', trocarTema));
  window.matchMedia('(prefers-color-scheme: dark)')
    .addEventListener?.('change', () => aplicarTema(lerTema()));

  fa.onAuthStateChanged(auth, async user => {
    try {
      await carregarUsuario(user);
    } catch (e) {
      console.error('[Print] carregar usuário', e);
      toast(utils.traduzErro(e), 'erro');
    }
    montarMenu();
    if (!iniciado) {
      iniciado = true;
      window.addEventListener('hashchange', mostrar);
    }
    mostrar();
  });
}

iniciar();
