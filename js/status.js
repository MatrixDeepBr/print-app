/*
  Arquivo: js/status.js
  Versão: 1.1.0
  Sessão: 3B — Liberação automática com espera (1.0.0 era da Sessão 2)
  Data: 15/10/2026
  Telas da situação da conta: Aguardando liberação, Recusado, Bloqueado,
  e "Não deu para abrir sua conta" (quando o documento do usuário não carrega).
  Sem login, não mostram nada (o app.js leva para Entrar).

  Contrato de telas: telaPendente, telaRecusado, telaBloqueado, telaProblema
  Enquanto uma dessas telas está aberta, o app fica de olho no documento do
  usuário: quando a equipe libera (status "ativo"), o app abre sozinho.

  1.1.0 — Liberação automática (config/app.liberacaoAutomatica ligada):
  a tela Aguardando liberação espera o tempo da pessoa (sorteado entre
  autoMinutosMin e autoMinutosMax a partir do UID, sempre o mesmo para a
  mesma pessoa), grava a liberação no próprio documento (as regras só aceitam
  com a chave ligada e depois do tempo mínimo) e abre o app. Se a pessoa
  fechar o app antes, a liberação acontece quando ela abrir de novo.
  Grava em users/{uid}: status 'ativo', liberadoEm (hora do servidor),
  testeProPendente true e liberadoPor 'auto'.
  Extras exportados (o painel master usa): segundosDaVez(uid, min, max), lerMinutos(config)
*/

import { db, fs } from './firebase.js';
import { sair, formatarWhats } from './auth.js';

const MSG_PADRAO = 'Recebemos seu cadastro. Em breve a equipe libera seu acesso.';
const MSG_AUTO = 'Seu cadastro está em análise. Normalmente leva poucos minutos.';
const MSG_LIBERADO = 'Seu acesso foi liberado! Bem-vindo ao Print.';
const NOVA_TENTATIVA_MS = 30000;   // se não deu (sem internet, relógio adiantado), tenta de novo em 30 s
const MAX_TENTATIVAS = 20;

/* Resumo dos cartões 2 e 3 das boas-vindas. */
const RESUMO_PRO = 'O app é grátis, e quem entra agora ganha 2 meses de Pro quando ele abrir. Depois, o Pro terá um valor, avisado com 30 dias de antecedência. O Free continua grátis.';
const RESUMO_EQUIPE = 'Dúvidas, ideias ou benefícios para profissionais? Fale com a equipe do Print.';

let pararVigia = null;

/* ============================================================
   Tempo de espera da liberação automática
   ============================================================ */
/** Lê os minutos de config/app (padrão 5 e 10; mínimo 1, máximo 120). */
export function lerMinutos(c = {}) {
  const int = (v, p) => { const n = Math.round(Number(v)); return Number.isFinite(n) && n > 0 ? n : p; };
  const min = Math.min(120, int(c.autoMinutosMin, 5));
  const max = Math.max(min, Math.min(120, int(c.autoMinutosMax, 10)));
  return { min, max };
}

/**
 * Segundos de espera desta pessoa, contados do cadastro: entre min e max
 * minutos, sorteados a partir do UID (sempre o mesmo para a mesma pessoa).
 * Mais 5 s de folga, porque a regra exige "depois" do tempo mínimo.
 */
export function segundosDaVez(uid, min = 5, max = 10) {
  let h = 2166136261;                       // FNV-1a
  for (const ch of String(uid || '')) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
  const faixa = Math.max(0, (max - min) * 60);
  return min * 60 + 5 + (faixa ? h % (faixa + 1) : 0);
}

let auto = null; // { timer, tentativas, aoVoltarNet }

function pararAuto() {
  if (!auto) return;
  clearTimeout(auto.timer);
  if (auto.aoVoltarNet) window.removeEventListener('online', auto.aoVoltarNet);
  auto = null;
}

/** Fica de olho no próprio documento: se o status mudar, abre a tela certa. */
function vigiarStatus(ctx, statusAtual) {
  pararVigia?.();
  pararVigia = null;
  if (!ctx.estado.uid) return;
  let mudou = false;
  pararVigia = fs.onSnapshot(fs.doc(db, 'users', ctx.estado.uid), s => {
    const novo = s.exists() ? s.data().status : null;
    if (mudou || !novo || novo === statusAtual) return;
    mudou = true;
    pararAuto();
    ctx.recarregarUsuario().then(() => {
      if (novo === 'ativo') ctx.toast(MSG_LIBERADO, 'ok');
      ctx.ir('inicio'); // o app.js decide a tela pela situação nova
    });
  }, () => { /* sem permissão ou sem internet: segue sem vigiar */ });
}

function desmontar() {
  pararVigia?.();
  pararVigia = null;
  pararAuto();
}

function semLogin(el, ctx) {
  if (ctx.estado.uid) return false;
  el.innerHTML = '';
  return true;
}

function ligarSair(el, ctx) {
  el.querySelectorAll('.js-sair').forEach(b => b.addEventListener('click', async () => {
    b.disabled = true;
    await sair(ctx);
    b.disabled = false;
  }));
}

/* ============================================================
   Aguardando liberação
   ============================================================ */
export const telaPendente = {
  async montar(el, ctx) {
    pararAuto();
    if (semLogin(el, ctx)) return;
    const { esc, primeiroNome } = ctx.utils;
    const u = ctx.estado.usuario || {};
    const falta = !u.nome || !u.whatsapp || !u.cidade;

    el.innerHTML =
      '<div class="status-topo"><span class="status-ic" aria-hidden="true">⏳</span>' +
      '<h1>Aguardando liberação</h1>' +
      '<p class="muted">Cadastro recebido, ' + esc(primeiroNome(u.nome, 'pintor')) + '!</p></div>' +
      '<div class="card destaque"><p class="js-msg">' + esc(MSG_PADRAO) + '</p>' +
      '<p class="muted pequeno js-sub">Quando a equipe liberar, o app abre sozinho.</p></div>' +
      (falta ? formCompletar(u, esc) : '') +
      '<div class="card resumo">' +
        '<p><span aria-hidden="true">⭐</span> ' + esc(RESUMO_PRO) + '</p>' +
        '<p><span aria-hidden="true">💬</span> ' + esc(RESUMO_EQUIPE) + '</p>' +
      '</div>' +
      '<button class="big primary js-contato" type="button">💬 Falar com a equipe</button>' +
      '<button class="big js-sair" type="button">Sair</button>';

    el.querySelector('.js-contato').addEventListener('click', () => ctx.ir('contato', { de: 'pendente' }));
    ligarSair(el, ctx);
    if (falta) ligarCompletar(el, ctx);
    vigiarStatus(ctx, 'pendente');

    // Mensagem configurada pelo dono em config/app.mensagemPendente
    // e, com a chave ligada, a liberação automática.
    await lerConfigPendente(el, ctx);
  },
  desmontar
};

async function lerConfigPendente(el, ctx) {
  let c = null;
  try {
    const s = await fs.getDoc(fs.doc(db, 'config', 'app'));
    c = s.exists() ? s.data() : {};
  } catch (e) { /* sem internet: fica a mensagem padrão */ }
  if (!el.isConnected || !ctx.estado.uid) return;
  const alvo = el.querySelector('.js-msg');
  if (c && c.liberacaoAutomatica === true) {
    if (alvo) alvo.textContent = MSG_AUTO;
    const sub = el.querySelector('.js-sub');
    if (sub) sub.textContent = 'Quando for liberado, o app abre sozinho.';
    agendarAuto(el, ctx, c);
    return;
  }
  const m = c ? String(c.mensagemPendente || '').trim() : '';
  if (m && alvo) alvo.textContent = m;
  // Não deu para ler (sem internet): tenta de novo quando a conexão voltar.
  if (!c) esperarInternet(el, ctx, () => lerConfigPendente(el, ctx));
}

function esperarInternet(el, ctx, depois) {
  pararAuto();
  auto = { timer: null, tentativas: 0, aoVoltarNet: null };
  auto.aoVoltarNet = () => { if (el.isConnected) depois(); };
  window.addEventListener('online', auto.aoVoltarNet, { once: true });
}

/* ============================================================
   Liberação automática (chave ligada no painel)
   ============================================================ */
function agendarAuto(el, ctx, c, tentativas = 0) {
  pararAuto();
  const u = ctx.estado.usuario || {};
  const { min, max } = lerMinutos(c);
  // Sem data de cadastro (não deveria acontecer): conta a partir de agora.
  const criado = ctx.utils.paraData(u.criadoEm) || new Date();
  const hora = criado.getTime() + segundosDaVez(ctx.estado.uid, min, max) * 1000;
  const espera = Math.max(0, hora - Date.now());
  auto = { timer: null, tentativas, aoVoltarNet: null };
  auto.timer = setTimeout(() => tentarLiberar(el, ctx), espera);
}

async function tentarLiberar(el, ctx) {
  if (!auto || !el.isConnected || !ctx.estado.uid) return;
  const tentativas = auto.tentativas + 1;
  if (!navigator.onLine) {
    // Sem internet: libera quando a conexão voltar.
    esperarInternet(el, ctx, () => tentarLiberar2(el, ctx, tentativas));
    return;
  }
  return tentarLiberar2(el, ctx, tentativas);
}

async function tentarLiberar2(el, ctx, tentativas) {
  if (!el.isConnected || !ctx.estado.uid) return;
  pararAuto();
  // Para o vigia antes de gravar: senão a cópia local (ainda não confirmada
  // pelo servidor) abriria o app antes da hora.
  pararVigia?.();
  pararVigia = null;
  const ref = fs.doc(db, 'users', ctx.estado.uid);
  try {
    // Confere a chave de novo (o dono pode ter desligado enquanto esperava).
    const sc = await fs.getDocFromServer(fs.doc(db, 'config', 'app'));
    const c = sc.exists() ? sc.data() : {};
    if (c.liberacaoAutomatica !== true) {
      if (el.isConnected) telaPendente.montar(el, ctx); // volta ao modo normal
      return;
    }
    const r = await Promise.race([
      fs.updateDoc(ref, {
        status: 'ativo',
        liberadoEm: fs.serverTimestamp(),
        testeProPendente: true,
        liberadoPor: 'auto'
      }).then(() => 'ok'),
      new Promise(res => setTimeout(() => res('demorou'), 20000))
    ]);
    if (r !== 'ok') throw new Error('demorou');
    if (!el.isConnected) return;
    ctx.toast(MSG_LIBERADO, 'ok');
    await ctx.recarregarUsuario();
    ctx.ir('inicio'); // o app.js decide a tela pela situação nova
  } catch (e) {
    // Negado (ainda não deu o tempo, chave desligada, já foi liberado ou
    // recusado), sem internet ou demorou: volta a vigiar e tenta de novo.
    console.warn('[Print] liberação automática', e?.code || e?.message || e);
    if (!el.isConnected) return;
    vigiarStatus(ctx, 'pendente');
    if (tentativas >= MAX_TENTATIVAS) return;
    auto = { timer: null, tentativas, aoVoltarNet: null };
    auto.timer = setTimeout(() => tentarLiberar(el, ctx), NOVA_TENTATIVA_MS);
  }
}

/* Se o cadastro ficou incompleto (documento recriado depois de uma falha). */
function formCompletar(u, esc) {
  return '<form class="card js-completar" novalidate>' +
    '<b>Complete seu cadastro</b>' +
    '<p class="muted pequeno">Assim a equipe consegue falar com você.</p>' +
    '<label for="p-nome">Seu nome</label>' +
    '<input id="p-nome" name="nome" autocomplete="name" maxlength="80" value="' + esc(u.nome || '') + '">' +
    '<label for="p-whats">WhatsApp (com DDD)</label>' +
    '<input id="p-whats" name="whatsapp" type="tel" inputmode="tel" placeholder="(17) 90000-0000" value="' + esc(formatarWhats(u.whatsapp || '')) + '">' +
    '<label for="p-cidade">Cidade</label>' +
    '<input id="p-cidade" name="cidade" maxlength="60" value="' + esc(u.cidade || '') + '">' +
    '<button class="big primary js-salvar" type="submit" style="margin-top:14px">Salvar</button>' +
    '</form>';
}

function ligarCompletar(el, ctx) {
  const f = el.querySelector('.js-completar');
  const btn = f.querySelector('.js-salvar');
  f.whatsapp.addEventListener('input', () => { f.whatsapp.value = formatarWhats(f.whatsapp.value); });
  f.addEventListener('submit', async ev => {
    ev.preventDefault();
    if (btn.disabled) return;
    const nome = f.nome.value.trim().replace(/\s+/g, ' ');
    const whatsapp = f.whatsapp.value.replace(/\D/g, '');
    const cidade = f.cidade.value.trim().replace(/\s+/g, ' ');
    if (nome.length < 2) { ctx.toast('Digite o seu nome.', 'erro'); f.nome.focus(); return; }
    if (whatsapp.length < 10 || whatsapp.length > 11) { ctx.toast('Digite o WhatsApp com DDD.', 'erro'); f.whatsapp.focus(); return; }
    if (cidade.length < 2) { ctx.toast('Digite a sua cidade.', 'erro'); f.cidade.focus(); return; }
    btn.disabled = true;
    btn.textContent = 'Salvando…';
    try {
      await fs.updateDoc(fs.doc(db, 'users', ctx.estado.uid), { nome, whatsapp, cidade });
      await ctx.recarregarUsuario();
      ctx.toast('Dados salvos!', 'ok');
      telaPendente.montar(el, ctx);
    } catch (e) {
      ctx.toast(ctx.utils.traduzErro(e), 'erro');
      btn.disabled = false;
      btn.textContent = 'Salvar';
    }
  });
}

/* ============================================================
   Recusado e Bloqueado
   ============================================================ */
function telaSimples(status, ic, titulo, texto) {
  return {
    montar(el, ctx) {
      if (semLogin(el, ctx)) return;
      el.innerHTML =
        '<div class="status-topo"><span class="status-ic" aria-hidden="true">' + ic + '</span>' +
        '<h1>' + titulo + '</h1></div>' +
        '<div class="card"><p>' + texto + '</p></div>' +
        '<button class="big js-sair" type="button">Sair</button>';
      ligarSair(el, ctx);
      vigiarStatus(ctx, status);
    },
    desmontar
  };
}

export const telaRecusado = telaSimples('recusado', '🚫', 'Cadastro não aprovado',
  'No momento, o seu cadastro não foi aprovado pela equipe.');

export const telaBloqueado = telaSimples('bloqueado', '🔒', 'Acesso bloqueado',
  'O acesso desta conta está bloqueado.');

/* ============================================================
   Não deu para abrir a conta (documento não carregou ou não existe)
   ============================================================ */
export const telaProblema = {
  montar(el, ctx) {
    if (semLogin(el, ctx)) return;
    const det = ctx.estado.erroUsuario ? ctx.utils.traduzErro(ctx.estado.erroUsuario) : 'O cadastro não terminou de ser criado.';
    el.innerHTML =
      '<div class="status-topo"><span class="status-ic" aria-hidden="true">📶</span>' +
      '<h1>Não deu para abrir sua conta</h1></div>' +
      '<div class="card"><p>' + ctx.utils.esc(det) + '</p>' +
      '<p class="muted pequeno">Confira a internet e toque em Tentar de novo.</p></div>' +
      '<button class="big primary js-tentar" type="button">Tentar de novo</button>' +
      '<button class="big js-sair" type="button">Sair</button>';
    const b = el.querySelector('.js-tentar');
    b.addEventListener('click', async () => {
      b.disabled = true;
      b.textContent = 'Tentando…';
      await ctx.recarregarUsuario();
      if (ctx.estado.usuario) ctx.ir('inicio');
      else telaProblema.montar(el, ctx);
    });
    ligarSair(el, ctx);
  }
};
