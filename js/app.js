/*
  Arquivo: js/app.js
  Versão: 2.1.0
  Sessão: 3 — Painel master (liga js/master.js; tela #diagnostico removida)
  Data: 14/10/2026
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
import { garantirDocumento, sair, telaEntrar, telaCadastro, telaRecuperar } from './auth.js';
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
  erroUsuario: null     // S2: erro ao carregar/criar users/{uid}
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
  inicio:      { titulo: 'Início',    protegida: true, carregar: async () => provisoria('Início', 'Tela provisória. A tela inicial chega na Sessão 5.') },
  clientes:    { titulo: 'Clientes',  protegida: true, carregar: async () => provisoria('Clientes', 'Tela provisória. Chega na Sessão 5.') },
  orcamento:   { titulo: 'Orçamento', protegida: true, carregar: async () => provisoria('Novo orçamento', 'Tela provisória. Chega na Sessão 6.') },
  historico:   { titulo: 'Histórico', protegida: true, carregar: async () => provisoria('Histórico', 'Tela provisória. Chega na Sessão 6.') },
  perfil:      { titulo: 'Perfil',    protegida: true, carregar: async () => perfilProvisorio },
  master:      { titulo: 'Painel master', protegida: true, admin: true, carregar: () => import('./master.js') },

  boasvindas:  { titulo: 'Boas-vindas',     soDeslogado: true, carregar: () => import('./boasvindas.js') },
  entrar:      { titulo: 'Entrar',          soDeslogado: true, carregar: async () => telaEntrar },
  cadastro:    { titulo: 'Criar conta',     soDeslogado: true, carregar: async () => telaCadastro },
  recuperar:   { titulo: 'Recuperar senha', soDeslogado: true, carregar: async () => telaRecuperar },

  pendente:    { titulo: 'Aguardando liberação', situacao: true, carregar: async () => (await import('./status.js')).telaPendente },
  recusado:    { titulo: 'Cadastro não aprovado', situacao: true, carregar: async () => (await import('./status.js')).telaRecusado },
  bloqueado:   { titulo: 'Acesso bloqueado',      situacao: true, carregar: async () => (await import('./status.js')).telaBloqueado },
  problema:    { titulo: 'Sua conta',             situacao: true, carregar: async () => (await import('./status.js')).telaProblema },

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
  if (!estado.usuario) return 'problema';
  const s = estado.usuario.status;
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
    try { mod = await def.carregar(); }
    catch (e) {
      console.error('[Print] carregar tela', e);
      mod = provisoria('Não deu para abrir esta tela', 'Confira a internet e tente de novo.');
    }
  }
  if (minha !== geracao) return; // o usuário já foi para outra tela

  mostrarMenu(situacao() === 'ativo');
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
    Object.assign(estado, { usuario: null, uid: null, ehAdmin: false, planoEfetivo: 'free', perfil: {}, erroUsuario: null });
    return;
  }
  estado.uid = user.uid;
  estado.erroUsuario = null;
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
    // Conta existe no Authentication, mas o documento não: cria agora (pendente).
    try {
      estado.usuario = await garantirDocumento(user);
    } catch (e) {
      console.warn('[Print] criar documento do usuário', e);
      estado.usuario = null;
      estado.erroUsuario = e;
    }
  }
  estado.planoEfetivo = utils.planoEfetivo(estado.usuario);
  estado.perfil = estado.usuario?.perfil || {};

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
}

/* ============================================================
   8. Partida
   ============================================================ */
function iniciar() {
  aplicarTema(lerTema());
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
