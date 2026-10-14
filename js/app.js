/*
  Arquivo: js/app.js
  Versão: 1.0.0
  Sessão: 1 — Base do projeto
  Data: 14/10/2026
  Coração do app: estado global, roteador, toast, menu e tema.

  Contrato de telas: cada tela é um módulo que exporta
    montar(container, ctx)   desenha a tela dentro de container
    desmontar()              (opcional) limpa ouvintes, timers etc.
  ctx traz: db, auth, estado, ir(tela, params), toast(msg, tipo), utils
  Extras no ctx: params (os params passados no ir), recarregarUsuario()

  Estado global: usuario (documento de users), uid, ehAdmin, planoEfetivo, perfil

  Rotas: #inicio #clientes #orcamento #historico #perfil #master
         #diagnostico (TEMPORÁRIA, só da Sessão 1 — remover na Sessão 2 ou 10)

  Para ligar a tela real de uma sessão futura, troque o "carregar" dela em TELAS,
  por exemplo:  clientes: { ..., carregar: () => import('./clientes.js') }
*/

import { app, auth, db, fs, fa, modoCache, VERSAO_FIREBASE } from './firebase.js';
import * as utils from './utils.js';
import { iniciarUso, pararUso, gravarUsoAgora } from './uso.js';

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
  perfil: {}            // usuario.perfil (ou {})
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
  toastTimer = setTimeout(() => el.classList.remove('on'), tipo === 'erro' ? 4000 : 2400);
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

/*
  protegida: só abre para usuário com status "ativo"
  admin:     só abre para quem está em admins/{uid}
*/
const TELAS = {
  inicio:      { titulo: 'Início',    protegida: true, carregar: async () => provisoria('Início', 'Tela provisória. A tela inicial chega na Sessão 5.') },
  clientes:    { titulo: 'Clientes',  protegida: true, carregar: async () => provisoria('Clientes', 'Tela provisória. Chega na Sessão 5.') },
  orcamento:   { titulo: 'Orçamento', protegida: true, carregar: async () => provisoria('Novo orçamento', 'Tela provisória. Chega na Sessão 6.') },
  historico:   { titulo: 'Histórico', protegida: true, carregar: async () => provisoria('Histórico', 'Tela provisória. Chega na Sessão 6.') },
  perfil:      { titulo: 'Perfil',    protegida: true, carregar: async () => provisoria('Perfil', 'Tela provisória. Chega na Sessão 4.') },
  master:      { titulo: 'Master',    protegida: true, admin: true, carregar: async () => provisoria('Painel master', 'Tela provisória. Chega na Sessão 3.') },
  diagnostico: { titulo: 'Diagnóstico', carregar: async () => telaDiagnostico } // TEMPORÁRIA
};

const MENU = [
  { tela: 'inicio',    ic: '🏠', txt: 'Início' },
  { tela: 'clientes',  ic: '👥', txt: 'Clientes' },
  { tela: 'orcamento', ic: '➕', txt: 'Orçamento' },
  { tela: 'historico', ic: '📄', txt: 'Histórico' },
  { tela: 'perfil',    ic: '👤', txt: 'Perfil' },
  { tela: 'master',    ic: '🛡️', txt: 'Master', admin: true }
];

/** Confere se a tela pode abrir. Devolve uma tela de bloqueio ou null. */
function bloqueioDe(def) {
  if (!def.protegida) return null;
  if (!estado.uid) {
    return {
      montar(el) {
        // Provisório: na Sessão 2 isto vira a tela de login.
        el.innerHTML = '<h1>Entre na sua conta</h1>' +
          '<p class="muted">O login definitivo chega na Sessão 2. Por enquanto, use a tela de diagnóstico.</p>' +
          '<a class="big primary" href="#diagnostico">Abrir diagnóstico</a>';
      }
    };
  }
  if (estado.usuario?.status !== 'ativo') {
    return {
      montar(el) {
        // Provisório: na Sessão 2 isto vira a tela "Aguardando liberação".
        const st = estado.usuario?.status || 'sem cadastro';
        el.innerHTML = '<h1>Aguardando liberação</h1>' +
          '<p class="muted">Situação da conta: <b>' + esc(st) + '</b>. A tela definitiva chega na Sessão 2.</p>' +
          '<a class="big" href="#diagnostico">Abrir diagnóstico</a>';
      }
    };
  }
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
  const nome = telaDoEndereco();
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
   ============================================================ */
function montarMenu() {
  const box = $('.js-menu');
  if (!box) return;
  box.innerHTML = MENU
    .filter(m => !m.admin || estado.ehAdmin)
    .map(m => '<a class="menu-item" href="#' + m.tela + '" data-tela="' + m.tela + '">' +
      '<span class="ic" aria-hidden="true">' + m.ic + '</span><span>' + esc(m.txt) + '</span></a>')
    .join('');
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
    Object.assign(estado, { usuario: null, uid: null, ehAdmin: false, planoEfetivo: 'free', perfil: {} });
    return;
  }
  estado.uid = user.uid;
  const [u, a] = await Promise.allSettled([
    fs.getDoc(fs.doc(db, 'users', user.uid)),
    fs.getDoc(fs.doc(db, 'admins', user.uid))
  ]);
  estado.usuario = u.status === 'fulfilled' && u.value.exists() ? u.value.data() : null;
  estado.ehAdmin = a.status === 'fulfilled' && a.value.exists();
  if (u.status === 'rejected') console.warn('[Print] leitura de users', u.reason);
  estado.planoEfetivo = utils.planoEfetivo(estado.usuario);
  estado.perfil = estado.usuario?.perfil || {};

  if (estado.usuario?.status === 'ativo') iniciarUso(criarCtx());
  else await pararUso();
}

/** Relê o documento do usuário (ex.: depois de salvar o perfil). */
export async function recarregarUsuario() {
  await carregarUsuario(auth.currentUser);
  montarMenu();
}

/* ============================================================
   8. Tela de DIAGNÓSTICO (TEMPORÁRIA — Sessão 1)
   Mostra se o Firebase, o login, a leitura de config/app e a
   gravação de uso estão funcionando. Remover quando não precisar mais.
   ============================================================ */
const telaDiagnostico = {
  _vivo: false,

  async montar(el) {
    this._vivo = true;
    const user = auth.currentUser;
    let emailSalvo = '';
    try { emailSalvo = localStorage.getItem('print.email') || ''; } catch (e) { /* ignora */ }

    el.classList.add('larga');
    el.innerHTML =
      '<h1>Diagnóstico</h1>' +
      '<p class="muted">Tela temporária da Sessão 1 para conferir a base do app.</p>' +
      (user
        ? '<div class="card"><b>Logado como</b><p class="muted">' + esc(user.email || '') + '</p>' +
          '<button class="big js-sair" type="button">Sair</button></div>'
        : '<form class="card js-login" autocomplete="off">' +
          '<b>Entrar com o usuário de teste</b>' +
          '<label for="d-email">E-mail</label>' +
          '<input id="d-email" name="email" type="email" inputmode="email" autocomplete="email" value="' + esc(emailSalvo) + '" required>' +
          '<label for="d-senha">Senha</label>' +
          '<input id="d-senha" name="senha" type="password" autocomplete="off" required>' +
          '<button class="big primary js-entrar" type="submit" style="margin-top:14px">Entrar</button>' +
          '</form>') +
      '<div class="card"><ul class="diag-lista">' +
      ['firebase', 'login', 'usuario', 'admin', 'config', 'uso']
        .map(k => '<li class="diag-item" data-k="' + k + '"><span class="diag-sinal">…</span><div><b></b><div class="diag-det"></div></div></li>')
        .join('') +
      '</ul></div>' +
      '<button class="big js-rodar" type="button">Conferir de novo</button>';

    el.querySelector('.js-login')?.addEventListener('submit', ev => this.entrar(ev, el));
    el.querySelector('.js-sair')?.addEventListener('click', () => this.sair());
    el.querySelector('.js-rodar').addEventListener('click', () => this.conferir(el));
    el.addEventListener('click', ev => {
      const b = ev.target.closest('.js-copiar');
      if (!b) return;
      navigator.clipboard?.writeText(b.dataset.txt)
        .then(() => toast('UID copiado', 'ok'))
        .catch(() => toast('Não deu para copiar. Selecione e copie à mão.', 'erro'));
    });
    await this.conferir(el);
  },

  desmontar() { this._vivo = false; },

  marcar(el, k, sinal, titulo, detalhe) {
    const li = el.querySelector('[data-k="' + k + '"]');
    if (!li) return;
    li.classList.remove('ok', 'falha');
    if (sinal === 'ok') li.classList.add('ok');
    if (sinal === 'falha') li.classList.add('falha');
    li.querySelector('.diag-sinal').textContent = sinal === 'ok' ? '✓' : sinal === 'falha' ? '✕' : sinal === 'info' ? 'i' : '…';
    li.querySelector('b').textContent = titulo;
    li.querySelector('.diag-det').innerHTML = detalhe || '';
  },

  async conferir(el) {
    const m = (...a) => this._vivo && this.marcar(el, ...a);
    const user = auth.currentUser;

    // 1. Firebase iniciado
    const pid = app?.options?.projectId;
    m('firebase', pid ? 'ok' : 'falha', 'Firebase iniciado',
      pid ? 'Projeto <span class="codigo">' + esc(pid) + '</span> · biblioteca ' + esc(VERSAO_FIREBASE) +
        ' · offline: ' + (modoCache === 'persistente' ? 'ligado' : 'desligado (navegador sem suporte)')
          : 'Configuração não carregou.');

    // 2. Usuário logado
    if (!user) {
      m('login', 'falha', 'Usuário logado', 'Ninguém logado. Entre com o usuário de teste acima.');
      ['usuario', 'admin', 'config', 'uso'].forEach(k => m(k, '', ({
        usuario: 'Documento do usuário', admin: 'Administrador', config: 'Leitura de config/app', uso: 'Gravação de uso'
      })[k], 'Aguardando login.'));
      return;
    }
    m('login', 'ok', 'Usuário logado',
      esc(user.email || '') + '<br>UID: <span class="codigo">' + esc(user.uid) + '</span> ' +
      '<button class="save js-copiar" type="button" data-txt="' + esc(user.uid) + '">Copiar UID</button>');

    // 3. Documento users/{uid}
    const u = estado.usuario;
    if (!u) {
      m('usuario', 'falha', 'Documento do usuário', 'Não existe <span class="codigo">users/' + esc(user.uid) + '</span> (ou não deu para ler). Crie no console (passo c).');
    } else {
      const ok = u.status === 'ativo';
      m('usuario', ok ? 'ok' : 'falha', 'Documento do usuário',
        'Nome: ' + esc(u.nome || '—') + ' · status: <b>' + esc(u.status || '—') + '</b> · plano: ' + esc(u.plano || '—') +
        ' · plano efetivo: ' + esc(estado.planoEfetivo) + (ok ? '' : '<br>Para a coleta de uso rodar, o status precisa ser "ativo".'));
    }

    // 4. Administrador
    m('admin', estado.ehAdmin ? 'ok' : 'info', 'Administrador',
      estado.ehAdmin ? 'Sim, este usuário está em admins.' : 'Não (normal para usuário comum).');

    // 5. Leitura de config/app (direto do servidor)
    m('config', '', 'Leitura de config/app', 'Lendo…');
    try {
      const s = await comPrazo(fs.getDocFromServer(fs.doc(db, 'config', 'app')), 15000);
      if (!s.exists()) {
        m('config', 'falha', 'Leitura de config/app', 'O documento <span class="codigo">config/app</span> não existe. Crie no console (passo c).');
      } else {
        const c = s.data();
        m('config', 'ok', 'Leitura de config/app',
          'liberacaoAutomatica: ' + esc(String(c.liberacaoAutomatica)) +
          ' · diasTesteProPadrao: ' + esc(String(c.diasTesteProPadrao)) +
          '<br>mensagemPendente: ' + esc(c.mensagemPendente ?? '—'));
      }
    } catch (e) {
      m('config', 'falha', 'Leitura de config/app', esc(utils.traduzErro(e)));
    }

    // 6. Gravação de uso
    if (u?.status !== 'ativo') {
      m('uso', 'falha', 'Gravação de uso', 'Só grava para usuário com status "ativo".');
      return;
    }
    m('uso', '', 'Gravação de uso', 'Gravando…');
    try {
      await comPrazo(gravarUsoAgora(), 15000);
      const hoje = utils.hojeISO();
      const s = await comPrazo(fs.getDocFromServer(fs.doc(db, 'uso', user.uid, 'dias', hoje)), 15000);
      if (!s.exists()) throw new Error('Gravou, mas o documento do dia não apareceu.');
      const d = s.data();
      m('uso', 'ok', 'Gravação de uso',
        'Documento <span class="codigo">uso/…/dias/' + esc(hoje) + '</span>: ' +
        'aberturas ' + esc(String(d.aberturas ?? 0)) +
        ' · segundos ativos ' + esc(String(d.segundosAtivos ?? 0)) +
        ' · orçamentos ' + esc(String(d.orcamentosCriados ?? 0)) +
        ' · valor ' + esc(utils.moeda(d.valorOrcado ?? 0)));
    } catch (e) {
      m('uso', 'falha', 'Gravação de uso', esc(e?.code ? utils.traduzErro(e) : (e?.message || String(e))));
    }
  },

  async entrar(ev, el) {
    ev.preventDefault();
    const f = ev.target;
    const email = f.email.value.trim();
    const senha = f.senha.value;
    const btn = el.querySelector('.js-entrar');
    btn.disabled = true;
    btn.textContent = 'Entrando…';
    try {
      await fa.signInWithEmailAndPassword(auth, email, senha);
      try { localStorage.setItem('print.email', email); } catch (e) { /* ignora */ }
      toast('Entrou!', 'ok');
      // onAuthStateChanged redesenha a tela
    } catch (e) {
      toast(utils.traduzErro(e), 'erro');
      btn.disabled = false;
      btn.textContent = 'Entrar';
    }
  },

  async sair() {
    try {
      await pararUso();
      await fa.signOut(auth);
      toast('Você saiu.', 'ok');
    } catch (e) {
      toast(utils.traduzErro(e), 'erro');
    }
  }
};

/** Desiste de esperar depois de ms (o Firestore offline pode esperar para sempre). */
function comPrazo(promessa, ms) {
  return Promise.race([
    promessa,
    new Promise((_, rej) => setTimeout(() => rej(new Error('Sem resposta do servidor em ' + ms / 1000 + ' s. Confira a internet.')), ms))
  ]);
}

/* ============================================================
   9. Partida
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
