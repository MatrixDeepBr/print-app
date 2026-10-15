/*
  Arquivo: js/auth.js
  Versão: 2.1.0
  Sessão: 10 — Revisão (2.0.0 era da 4B, 1.0.0 da Sessão 2)
  Data: 15/10/2026

  2.1.0 (remendo do iPhone, decisão do Maestro): no app instalado no iPhone
  (tela cheia + iOS), o login do Google pode não voltar para o app. Ali as
  telas Entrar e Criar conta mostram o e-mail em destaque, com a linha
  "No iPhone, entre com e-mail e senha." O Google fica como segunda opção,
  embaixo. Em qualquer outro aparelho, nada mudou.

  Telas: Entrar, Criar conta (e-mail), Recuperar senha e Complete seu cadastro.
  Funções: sair(ctx), garantirDocumento(user).

  2.0.0:
  - Entrar com Google (principal): signInWithPopup; se o popup for bloqueado,
    tenta signInWithRedirect. Entrar com e-mail continua igual, um toque abaixo.
  - Complete seu cadastro (telaCompletar): primeiro acesso com Google, ou
    cadastro que não terminou. Nome já vem do Google; pede WhatsApp, cidade,
    profissões, código de indicação e o aceite.
  - WhatsApp único: o cadastro grava users/{uid} e telefones/{whatsapp} NA MESMA
    gravação em lote. Se o número já tiver conta, as regras recusam o lote e a
    tela mostra "Este WhatsApp já tem uma conta. Entre com ela ou fale com a equipe."
  - Marca no aparelho: localStorage print.contas guarda os UIDs que já entraram
    neste navegador (menos o administrador). Conta nova num aparelho que já teve
    outra conta nasce com contaRepetidaAparelho: true (aviso no painel).
  - Várias profissões: especialidades (lista) + especialidade (a primeira marcada).

  O documento users/{uid} nasce com:
    nome, email, whatsapp (só dígitos, com DDD, sem 55), cidade,
    especialidades, especialidade, entrada ('google' | 'email'),
    contaRepetidaAparelho, status 'pendente', plano 'free', proAte null,
    testeProPendente false, criadoEm, aceiteEm, versaoTermos e
    codigoParceiro (só se preenchido).

  No navegador: print.email (e-mail lembrado), print.entrada (último jeito de
  entrar) e print.contas (UIDs que entraram aqui). A senha nunca é guardada.

  Extras exportados: formatarWhats, PROFISSOES, lerEspecialidades,
  nomesProfissoes, telaCompletar
*/

import { auth, db, fs, fa } from './firebase.js';
import { esc, traduzErro } from './utils.js';
import { pararUso } from './uso.js';
import { VERSAO_TERMOS } from './textos.js';

/* ============================================================
   1. Profissões
   ============================================================ */
/** [valor, ícone, rótulo, rótulo curto (painel)] */
export const PROFISSOES = [
  ['pintor', '🎨', 'Pintor', 'Pintor'],
  ['pedreiro', '🧱', 'Pedreiro', 'Pedreiro'],
  ['encanador', '🔧', 'Encanador', 'Encanador'],
  ['eletricista', '💡', 'Eletricista', 'Eletricista'],
  ['gesseiro', '🏛️', 'Gesseiro', 'Gesseiro'],
  ['reparos', '🧰', 'Marido de aluguel / reparos gerais', 'Marido de aluguel'],
  ['outro', '🛠️', 'Outro', 'Outro']
];
const VALORES_PROF = PROFISSOES.map(p => p[0]);

/** Lista de profissões do usuário. Antigo, sem a lista: [especialidade] ou ['pintor']. */
export function lerEspecialidades(u) {
  const lista = Array.isArray(u?.especialidades)
    ? [...new Set(u.especialidades.filter(k => VALORES_PROF.includes(k)))]
    : [];
  if (lista.length) return lista;
  return VALORES_PROF.includes(u?.especialidade) ? [u.especialidade] : ['pintor'];
}

/** ['pintor','reparos'] -> "Pintor · Marido de aluguel / reparos gerais" (curto: "Pintor · Marido de aluguel"). */
export function nomesProfissoes(lista, curto = false) {
  return (lista || []).map(k => {
    const p = PROFISSOES.find(x => x[0] === k);
    return p ? (curto ? p[3] : p[2]) : '';
  }).filter(Boolean).join(' · ');
}

function htmlProfissoes(sel) {
  return '<div class="cad-prof" role="group" aria-label="Profissões">' +
    PROFISSOES.map(([k, ic, n]) => {
      const on = sel.includes(k);
      return '<button type="button" class="' + (on ? 'on' : '') + '" aria-pressed="' + on + '" data-prof="' + k + '">' +
        '<span aria-hidden="true">' + ic + '</span> ' + esc(n) + '</button>';
    }).join('') +
    '</div>';
}

/** Liga os botões de profissão. aoMudar(lista) recebe a lista nova (na ordem em que foram marcadas). */
function ligarProfissoes(el, inicial, aoMudar) {
  let lista = inicial.slice();
  el.querySelectorAll('[data-prof]').forEach(b => b.addEventListener('click', () => {
    const k = b.dataset.prof;
    lista = lista.includes(k) ? lista.filter(x => x !== k) : [...lista, k];
    const on = lista.includes(k);
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
    aoMudar(lista.slice());
  }));
}

/* ============================================================
   2. Memória da sessão (nada disso vai para o disco)
   ============================================================ */
let rascunho = {};          // cadastro por e-mail (sem a senha), para não perder ao abrir os Termos
let rascunhoComp = null;    // Complete seu cadastro: { uid, ... }
let dadosCadastro = null;   // dados do cadastro por e-mail em andamento
let garantindo = null;      // { uid, p } evita criar o documento duas vezes ao mesmo tempo
let erroWhats = null;       // { uid } quando o último cadastro deste aparelho bateu num WhatsApp já usado

const MSG_WHATS = 'Este WhatsApp já tem uma conta. Entre com ela ou fale com a equipe.';
const AVISO_DADOS = 'Seus clientes e orçamentos são seus e ficam guardados com segurança. Para melhorar o app, só acompanhamos o uso: quantas vezes você abre e quantos orçamentos faz.';

/* ============================================================
   3. Ajudantes
   ============================================================ */
function guardar(chave, valor) {
  try { localStorage.setItem(chave, valor); } catch (e) { /* ignora */ }
}
function ler(chave) {
  try { return localStorage.getItem(chave) || ''; } catch (e) { return ''; }
}
const lembrarEmail = email => guardar('print.email', email);
const emailLembrado = () => ler('print.email');
const lembrarEntrada = jeito => guardar('print.entrada', jeito);

const soDigitos = s => String(s ?? '').replace(/\D/g, '');

/** "17999998888" -> "(17) 99999-8888" enquanto digita. */
export function formatarWhats(v) {
  const d = soDigitos(v).slice(0, 11);
  if (d.length <= 2) return d.length ? '(' + d : '';
  if (d.length <= 6) return '(' + d.slice(0, 2) + ') ' + d.slice(2);
  if (d.length <= 10) return '(' + d.slice(0, 2) + ') ' + d.slice(2, 6) + '-' + d.slice(6);
  return '(' + d.slice(0, 2) + ') ' + d.slice(2, 7) + '-' + d.slice(7);
}

/** WhatsApp do jeito que vai para o banco: só dígitos, com DDD, sem o 55. */
function limparWhats(v) {
  let d = soDigitos(v);
  if (d.length >= 12 && d.startsWith('55')) d = d.slice(2);
  return d;
}

function limparCodigo(v) {
  return String(v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
}

/** Desiste de esperar depois de ms (o Firestore offline pode esperar para sempre). */
function comPrazo(promessa, ms) {
  return Promise.race([
    promessa,
    new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error('timeout'), { code: 'deadline-exceeded' })), ms))
  ]);
}

/** Campo de senha com botão Mostrar/Esconder. */
function campoSenha(id, autocomplete) {
  return '<div class="senha-campo">' +
    '<input id="' + id + '" name="senha" type="password" autocomplete="' + autocomplete + '" minlength="6" required>' +
    '<button class="senha-ver js-ver" type="button" aria-controls="' + id + '" aria-label="Mostrar senha">Mostrar</button>' +
    '</div>';
}
function ligarVerSenha(el) {
  el.querySelectorAll('.js-ver').forEach(b => b.addEventListener('click', () => {
    const inp = el.querySelector('#' + b.getAttribute('aria-controls'));
    const ver = inp.type === 'password';
    inp.type = ver ? 'text' : 'password';
    b.textContent = ver ? 'Esconder' : 'Mostrar';
    b.setAttribute('aria-label', ver ? 'Esconder senha' : 'Mostrar senha');
  }));
}

function cabecalho(titulo, sub) {
  return '<div class="auth-marca">Print — Orçamentos e Gestão</div>' +
    '<h1>' + esc(titulo) + '</h1>' + (sub ? '<p class="muted">' + esc(sub) + '</p>' : '');
}

function ocupado(btn, sim, txt) {
  btn.disabled = sim;
  if (txt) btn.innerHTML = txt;
}

/** 2.1.0: app instalado (tela cheia) num iPhone/iPad. */
function iphoneInstalado() {
  try {
    const ua = navigator.userAgent || '';
    const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
    const app = window.navigator.standalone === true || !!window.matchMedia?.('(display-mode: standalone)').matches;
    return ios && app;
  } catch (e) { return false; }
}
const LINHA_IPHONE = 'No iPhone, entre com e-mail e senha.';

/* ============================================================
   4. Marca no aparelho (print.contas)
   ============================================================ */
const CHAVE_CONTAS = 'print.contas';

function contasDoAparelho() {
  try {
    const a = JSON.parse(localStorage.getItem(CHAVE_CONTAS) || '[]');
    return Array.isArray(a) ? a.filter(x => typeof x === 'string' && x) : [];
  } catch (e) { return []; }
}

function guardarContaNoAparelho(uid) {
  const a = contasDoAparelho().filter(x => x !== uid);
  a.push(uid);
  guardar(CHAVE_CONTAS, JSON.stringify(a.slice(-20)));
}

// Toda conta que entra neste navegador fica anotada (menos o administrador,
// para o dono poder ajudar no próprio celular sem marcar ninguém).
fa.onAuthStateChanged(auth, async user => {
  if (!user) return;
  try {
    const s = await fs.getDoc(fs.doc(db, 'admins', user.uid));
    if (s.exists()) return;
  } catch (e) { /* sem resposta: anota mesmo assim */ }
  guardarContaNoAparelho(user.uid);
});

/** true se outra conta (que não seja esta) já entrou neste aparelho. */
function aparelhoTemOutraConta(uid) {
  return contasDoAparelho().some(x => x !== uid);
}

/* ============================================================
   5. Entrar com Google
   ============================================================ */
const G_ICONE =
  '<span class="auth-g" aria-hidden="true"><svg viewBox="0 0 48 48" width="22" height="22">' +
  '<path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.6 5.4 2.7 13.3l7.9 6.1C12.5 13.6 17.8 9.5 24 9.5z"/>' +
  '<path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.7 6c4.5-4.2 6.9-10.3 6.9-17.7z"/>' +
  '<path fill="#FBBC05" d="M10.6 28.6c-.5-1.4-.8-3-.8-4.6s.3-3.2.8-4.6l-7.9-6.1C1 16.6 0 20.2 0 24s1 7.4 2.7 10.7l7.9-6.1z"/>' +
  '<path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.7-6c-2.2 1.5-5 2.3-8.2 2.3-6.2 0-11.5-4.1-13.4-9.9l-7.9 6.1C6.6 42.6 14.6 48 24 48z"/>' +
  '</svg></span>';

function botaoGoogle(texto) {
  return '<button class="big primary auth-google js-google" type="button">' + G_ICONE + '<span>' + esc(texto) + '</span></button>';
}

function msgGoogle(e) {
  const c = String(e?.code || '');
  const m = {
    'auth/operation-not-allowed': 'O login com Google ainda não está ativado no Firebase.',
    'auth/account-exists-with-different-credential': 'Este e-mail já tem conta com senha. Use Entrar com e-mail.',
    'auth/unauthorized-domain': 'Este endereço não está autorizado no Firebase (Authentication > Configurações > Domínios autorizados).',
    'auth/web-storage-unsupported': 'Este navegador bloqueia o login do Google. Tente outro navegador ou use Entrar com e-mail.'
  }[c];
  if (m) return m;
  if (c === 'auth/network-request-failed') return traduzErro(e);
  return traduzErro(e) + ' Se continuar, use Entrar com e-mail.';
}

// Aviso que chega depois (volta do Google pelo caminho de redirecionamento).
let avisoGoogle = null;
let avisar = null;
function dispararAviso(m) {
  if (avisar) avisar(m); else avisoGoogle = m;
}
function prepararAvisos(ctx) {
  avisar = m => ctx.toast(m, 'erro');
  if (avisoGoogle) { const m = avisoGoogle; avisoGoogle = null; setTimeout(() => ctx.toast(m, 'erro'), 300); }
}

// Voltou do Google pelo redirecionamento? Confere o resultado uma vez.
(function conferirRetornoGoogle() {
  let veio = false;
  try { veio = sessionStorage.getItem('print.googleRedirect') === '1'; sessionStorage.removeItem('print.googleRedirect'); } catch (e) { /* ignora */ }
  if (!veio) return;
  fa.getRedirectResult(auth).then(r => {
    if (r?.user) { lembrarEntrada('google'); console.info('[Print] Google: entrou pelo redirecionamento'); return; }
    if (!auth.currentUser) {
      console.warn('[Print] Google: o redirecionamento voltou sem login');
      dispararAviso('Não deu para voltar do Google por este caminho. Toque de novo em Entrar com Google ou use Entrar com e-mail.');
    }
  }).catch(e => {
    console.warn('[Print] Google: redirecionamento', e?.code || e);
    dispararAviso(msgGoogle(e));
  });
})();

async function entrarComGoogle(ctx, btn) {
  if (btn.disabled) return;
  const original = btn.innerHTML;
  ocupado(btn, true, G_ICONE + '<span>Abrindo o Google…</span>');
  const prov = new fa.GoogleAuthProvider();
  prov.setCustomParameters({ prompt: 'select_account' }); // sempre pergunta qual conta (celular com várias contas)
  try {
    await fa.signInWithPopup(auth, prov);
    lembrarEntrada('google');
    console.info('[Print] Google: entrou pelo popup');
    // O app.js percebe o login e abre a tela certa (Complete seu cadastro, pendente ou o app).
  } catch (e) {
    const c = String(e?.code || '');
    console.warn('[Print] Google: popup', c || e);
    if (c === 'auth/popup-closed-by-user' || c === 'auth/cancelled-popup-request' || c === 'auth/user-cancelled') {
      ocupado(btn, false, original);
      return;
    }
    if (c === 'auth/popup-blocked' || c === 'auth/operation-not-supported-in-this-environment') {
      try {
        try { sessionStorage.setItem('print.googleRedirect', '1'); } catch (e2) { /* ignora */ }
        await fa.signInWithRedirect(auth, prov); // sai da página e volta logado
        return;
      } catch (e2) {
        console.warn('[Print] Google: redirecionamento', e2?.code || e2);
        ctx.toast(msgGoogle(e2), 'erro');
        ocupado(btn, false, original);
        return;
      }
    }
    ctx.toast(msgGoogle(e), 'erro');
    ocupado(btn, false, original);
  }
}

/* ============================================================
   6. Documento do usuário (users/{uid} + telefones/{whatsapp})
   ============================================================ */

/**
 * Cria o cadastro: users/{uid} e telefones/{whatsapp} na mesma gravação em lote.
 * d = { nome, whatsapp, cidade, especialidades, codigoParceiro }.
 * Erro com code 'print/whats-repetido' se o WhatsApp já tiver conta.
 */
async function criarCadastro(user, d, entrada) {
  if (!navigator.onLine) {
    throw Object.assign(new Error('offline'), { code: 'unavailable' });
  }
  const esp = d.especialidades.filter(k => VALORES_PROF.includes(k));
  const novo = {
    nome: d.nome,
    email: String(user.email || '').toLowerCase(),
    whatsapp: d.whatsapp,
    cidade: d.cidade,
    especialidades: esp,
    especialidade: esp[0] || 'pintor',
    entrada,
    contaRepetidaAparelho: aparelhoTemOutraConta(user.uid),
    status: 'pendente',
    plano: 'free',
    proAte: null,
    testeProPendente: false,
    criadoEm: fs.serverTimestamp(),
    aceiteEm: fs.serverTimestamp(),   // só chega aqui quem marcou o aceite
    versaoTermos: VERSAO_TERMOS
  };
  if (d.codigoParceiro) novo.codigoParceiro = d.codigoParceiro;

  const ref = fs.doc(db, 'users', user.uid);
  const lote = fs.writeBatch(db);
  lote.set(ref, novo);
  lote.set(fs.doc(db, 'telefones', d.whatsapp), { uid: user.uid, criadoEm: fs.serverTimestamp() });
  try {
    await comPrazo(lote.commit(), 20000);
  } catch (e) {
    if (String(e?.code || '').replace(/^firestore\//, '') === 'permission-denied') {
      erroWhats = { uid: user.uid };
      throw Object.assign(new Error(MSG_WHATS), { code: 'print/whats-repetido' });
    }
    throw e;
  }
  erroWhats = null;
  try {
    const s = await fs.getDoc(ref);
    if (s.exists()) return s.data();
  } catch (e) { /* segue com a cópia local */ }
  return { ...novo, criadoEm: new Date(), aceiteEm: new Date() };
}

/**
 * Completa um documento antigo que ficou sem WhatsApp (pendente).
 * Grava users (nome, whatsapp, cidade, profissões) e telefones no mesmo lote.
 */
async function completarDocumentoAntigo(uid, d) {
  if (!navigator.onLine) throw Object.assign(new Error('offline'), { code: 'unavailable' });
  const esp = d.especialidades.filter(k => VALORES_PROF.includes(k));
  const lote = fs.writeBatch(db);
  lote.update(fs.doc(db, 'users', uid), {
    nome: d.nome, whatsapp: d.whatsapp, cidade: d.cidade,
    especialidades: esp, especialidade: esp[0] || 'pintor'
  });
  lote.set(fs.doc(db, 'telefones', d.whatsapp), { uid, criadoEm: fs.serverTimestamp() });
  try {
    await comPrazo(lote.commit(), 20000);
  } catch (e) {
    if (String(e?.code || '').replace(/^firestore\//, '') === 'permission-denied') {
      erroWhats = { uid };
      throw Object.assign(new Error(MSG_WHATS), { code: 'print/whats-repetido' });
    }
    throw e;
  }
  erroWhats = null;
}

/**
 * Lê users/{uid} no SERVIDOR (nunca decide pelo cache offline).
 *  - existe: devolve os dados;
 *  - não existe e há um cadastro por e-mail em andamento: cria (users + telefones);
 *  - não existe e não há dados: devolve null (o app abre Complete seu cadastro).
 * Lança erro se não der para falar com o servidor (o app mostra "Tentar de novo")
 * e 'print/whats-repetido' se o WhatsApp do cadastro já tiver conta.
 */
export function garantirDocumento(user) {
  if (garantindo && garantindo.uid === user.uid) return garantindo.p;

  const p = (async () => {
    const ref = fs.doc(db, 'users', user.uid);
    const s = await comPrazo(fs.getDocFromServer(ref), 20000);
    if (s.exists()) return s.data();

    const email = String(user.email || '').toLowerCase();
    const d = dadosCadastro && dadosCadastro.email === email ? dadosCadastro : null;
    if (!d) return null;
    try {
      const doc = await criarCadastro(user, d, 'email');
      dadosCadastro = null;
      return doc;
    } catch (e) {
      // Guarda o que foi digitado para o Complete seu cadastro já vir preenchido.
      rascunhoComp = { uid: user.uid, nome: d.nome, whatsapp: d.whatsapp, cidade: d.cidade,
        especialidades: d.especialidades.slice(), codigo: d.codigoParceiro || '', aceite: true };
      dadosCadastro = null;
      throw e;
    }
  })();

  garantindo = { uid: user.uid, p };
  p.catch(() => {}).finally(() => { if (garantindo && garantindo.p === p) garantindo = null; });
  return p;
}

/* ============================================================
   7. Sair
   ============================================================ */
export async function sair(ctx) {
  try {
    await pararUso();
    await fa.signOut(auth);
    rascunhoComp = null;
    erroWhats = null;
    ctx?.toast?.('Você saiu.', 'ok');
    // O app.js percebe a saída e abre a tela Entrar.
  } catch (e) {
    ctx?.toast?.(traduzErro(e), 'erro');
  }
}

/* ============================================================
   8. Tela Entrar (Google em cima; e-mail um toque abaixo)
   ============================================================ */
export const telaEntrar = {
  montar(el, ctx) {
    prepararAvisos(ctx);
    const iphone = iphoneInstalado(); // 2.1.0
    const abrirEmail = iphone || !!ctx.params?.email || ctx.params?.modo === 'email' || ler('print.entrada') === 'email';

    const blocoGoogle = iphone
      ? '<p class="auth-ou">ou</p>' +
        '<button class="big auth-google js-google" type="button">' + G_ICONE + '<span>Entrar com Google</span></button>'
      : botaoGoogle('Entrar com Google') +
        '<p class="campo-ajuda auth-dica">Primeira vez? O cadastro é feito logo em seguida.</p>';

    el.innerHTML =
      (iphone
        ? cabecalho('Entrar', LINHA_IPHONE)
        : cabecalho('Entrar', 'Toque no botão do Google e escolha a sua conta. Sem digitar e-mail nem senha.') + blocoGoogle) +
      '<div class="auth-alt">' +
        '<button class="big js-abrir-email" type="button" aria-expanded="' + abrirEmail + '"' + (abrirEmail ? ' hidden style="display:none"' : '') + '>✉️ Entrar com e-mail</button>' + // 2.1.0: .big ignorava o hidden
        '<div class="js-email"' + (abrirEmail ? '' : ' hidden') + '>' +
          '<p class="auth-ou">Entrar com e-mail e senha</p>' +
          '<form class="js-form" novalidate>' +
            '<label for="e-email">E-mail</label>' +
            '<input id="e-email" name="email" type="email" inputmode="email" autocomplete="email" autocapitalize="off" spellcheck="false" required value="' + esc(ctx.params?.email || emailLembrado()) + '">' +
            '<label for="e-senha">Senha</label>' +
            campoSenha('e-senha', 'current-password') +
            '<button class="big primary js-entrar" type="submit" style="margin-top:18px">Entrar</button>' +
          '</form>' +
          '<button class="big js-esqueci" type="button">Esqueci a senha</button>' +
          '<button class="big js-criar" type="button">Criar conta com e-mail</button>' +
        '</div>' +
      '</div>' +
      (iphone ? blocoGoogle : ''); // 2.1.0: no iPhone instalado o Google fica embaixo

    ligarVerSenha(el);
    const f = el.querySelector('.js-form');
    const btn = el.querySelector('.js-entrar');
    const caixa = el.querySelector('.js-email');
    const bAbrir = el.querySelector('.js-abrir-email');

    el.querySelector('.js-google').addEventListener('click', ev => entrarComGoogle(ctx, ev.currentTarget));
    bAbrir.addEventListener('click', () => {
      caixa.hidden = false;
      bAbrir.hidden = true;
      bAbrir.style.display = 'none'; // 2.1.0
      bAbrir.setAttribute('aria-expanded', 'true');
      (f.email.value ? f.senha : f.email).focus();
    });
    if (abrirEmail) (f.email.value ? f.senha : f.email).focus({ preventScroll: true });

    el.querySelector('.js-esqueci').addEventListener('click', () => ctx.ir('recuperar', { email: f.email.value.trim() }));
    el.querySelector('.js-criar').addEventListener('click', () => ctx.ir('cadastro'));

    f.addEventListener('submit', async ev => {
      ev.preventDefault();
      if (btn.disabled) return;
      const email = f.email.value.trim().toLowerCase();
      const senha = f.senha.value;
      if (!email) { ctx.toast('Digite o e-mail.', 'erro'); f.email.focus(); return; }
      if (!senha) { ctx.toast('Digite a senha.', 'erro'); f.senha.focus(); return; }
      ocupado(btn, true, 'Entrando…');
      try {
        await fa.signInWithEmailAndPassword(auth, email, senha);
        lembrarEmail(email);
        lembrarEntrada('email');
        // O app.js percebe o login e abre a tela certa (app ou situação da conta).
      } catch (e) {
        ctx.toast(traduzErro(e), 'erro');
        ocupado(btn, false, 'Entrar');
      }
    });
  }
};

/* ============================================================
   9. Tela Criar conta (Google em cima; formulário por e-mail embaixo)
   ============================================================ */
export const telaCadastro = {
  montar(el, ctx) {
    prepararAvisos(ctx);
    const r = rascunho;
    const esp0 = Array.isArray(r.especialidades) ? r.especialidades : [];
    const iphone = iphoneInstalado(); // 2.1.0
    el.innerHTML =
      (iphone
        ? cabecalho('Criar minha conta', 'No iPhone, crie a conta com e-mail e senha. Depois a equipe libera o seu acesso.')
        : cabecalho('Criar minha conta', 'O jeito mais rápido é com a sua conta Google. Depois a equipe libera o seu acesso.') +
          botaoGoogle('Continuar com Google') +
          '<p class="auth-ou">ou crie com e-mail e senha</p>') +
      '<form class="js-form" novalidate>' +
        '<label for="c-nome">Seu nome</label>' +
        '<input id="c-nome" name="nome" autocomplete="name" autocapitalize="words" maxlength="80" required value="' + esc(r.nome || '') + '">' +
        '<label for="c-whats">WhatsApp (com DDD)</label>' +
        '<input id="c-whats" name="whatsapp" type="tel" inputmode="tel" autocomplete="tel-national" placeholder="(17) 90000-0000" required value="' + esc(formatarWhats(r.whatsapp || '')) + '">' +
        '<label for="c-cidade">Cidade</label>' +
        '<input id="c-cidade" name="cidade" autocomplete="address-level2" autocapitalize="words" maxlength="60" placeholder="Ex.: São José do Rio Preto" required value="' + esc(r.cidade || '') + '">' +
        '<p class="rotulo">Você trabalha como <span class="muted">(pode marcar mais de uma)</span></p>' +
        htmlProfissoes(esp0) +
        '<label for="c-email">E-mail</label>' +
        '<input id="c-email" name="email" type="email" inputmode="email" autocomplete="email" autocapitalize="off" spellcheck="false" required value="' + esc(r.email || '') + '">' +
        '<label for="c-senha">Crie uma senha</label>' +
        campoSenha('c-senha', 'new-password') +
        '<p class="campo-ajuda">Pelo menos 6 letras ou números.</p>' +
        '<label for="c-codigo">Código de parceiro <span class="muted">(opcional)</span></label>' +
        '<input id="c-codigo" name="codigo" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="12" value="' + esc(r.codigo || '') + '">' +
        '<p class="campo-ajuda">Se alguém te passou um código, coloque aqui.</p>' +
        '<div class="aviso-dados">' + esc(AVISO_DADOS) + '</div>' +
        '<label class="aceite"><input type="checkbox" name="aceite"' + (r.aceite ? ' checked' : '') + '>' +
          '<span>Li e aceito os Termos de uso e a Política de Privacidade.</span></label>' +
        '<div class="links-termos"><a href="#termos">Ler os Termos</a><a href="#termos/privacidade">Ler a Privacidade</a></div>' +
        '<button class="big primary js-criar" type="submit" style="margin-top:14px">Criar minha conta</button>' +
      '</form>' +
      (iphone ? '<p class="auth-ou">ou</p><button class="big auth-google js-google" type="button">' + G_ICONE + '<span>Continuar com Google</span></button>' : '') + // 2.1.0
      '<div class="auth-alt"><span class="muted">Já tem conta?</span>' +
      '<button class="big js-entrar" type="button">Entrar</button></div>';

    ligarVerSenha(el);
    const f = el.querySelector('.js-form');
    const btn = el.querySelector('.js-criar');
    let especialidades = esp0.slice();

    const guardarRascunho = () => {
      rascunho = {
        nome: f.nome.value, whatsapp: soDigitos(f.whatsapp.value), cidade: f.cidade.value,
        email: f.email.value, codigo: f.codigo.value, aceite: f.aceite.checked, especialidades: especialidades.slice()
      };
    };

    el.querySelector('.js-google').addEventListener('click', ev => entrarComGoogle(ctx, ev.currentTarget));
    ligarProfissoes(f, especialidades, lista => { especialidades = lista; guardarRascunho(); });

    // Guarda o que foi digitado (menos a senha) para não perder ao abrir os Termos.
    f.addEventListener('input', ev => {
      if (ev.target === f.whatsapp) {
        const pos = f.whatsapp.selectionStart === f.whatsapp.value.length;
        f.whatsapp.value = formatarWhats(f.whatsapp.value);
        if (pos) f.whatsapp.setSelectionRange(f.whatsapp.value.length, f.whatsapp.value.length);
      }
      if (ev.target === f.codigo) f.codigo.value = limparCodigo(f.codigo.value);
      guardarRascunho();
    });
    f.addEventListener('change', () => { rascunho.aceite = f.aceite.checked; });

    el.querySelector('.js-entrar').addEventListener('click', () => ctx.ir('entrar', f.email.value.trim() ? { email: f.email.value.trim() } : {}));

    f.addEventListener('submit', async ev => {
      ev.preventDefault();
      if (btn.disabled) return;
      const nome = f.nome.value.trim().replace(/\s+/g, ' ');
      const whatsapp = limparWhats(f.whatsapp.value);
      const cidade = f.cidade.value.trim().replace(/\s+/g, ' ');
      const email = f.email.value.trim().toLowerCase();
      const senha = f.senha.value;
      const codigoParceiro = limparCodigo(f.codigo.value);

      const erro = (msg, campo) => { ctx.toast(msg, 'erro'); campo?.focus(); };
      if (nome.length < 2) return erro('Digite o seu nome.', f.nome);
      if (whatsapp.length < 10 || whatsapp.length > 11) return erro('Digite o WhatsApp com DDD. Ex.: (17) 99999-8888', f.whatsapp);
      if (cidade.length < 2) return erro('Digite a sua cidade.', f.cidade);
      if (!especialidades.length) return erro('Marque pelo menos uma profissão.', f.querySelector('[data-prof]'));
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return erro('E-mail inválido. Confira se digitou certo.', f.email);
      if (senha.length < 6) return erro('A senha precisa ter pelo menos 6 letras ou números.', f.senha);
      if (!f.aceite.checked) return erro('Para continuar, marque que aceita os Termos e a Política de Privacidade.', f.aceite);
      if (!navigator.onLine) return erro('Sem internet. Para criar a conta, conecte-se e tente de novo.');

      ocupado(btn, true, 'Criando sua conta…');
      dadosCadastro = { email, nome, whatsapp, cidade, codigoParceiro, especialidades: especialidades.slice() };
      let contaCriada = false;
      try {
        const cred = await fa.createUserWithEmailAndPassword(auth, email, senha);
        contaCriada = true;
        lembrarEmail(email);
        lembrarEntrada('email');
        try { await fa.updateProfile(cred.user, { displayName: nome }); } catch (e) { /* não é essencial */ }
        await garantirDocumento(cred.user);
        rascunho = {};
        ctx.toast('Conta criada!', 'ok');
        // O app.js leva para "Aguardando liberação".
      } catch (e) {
        if (!contaCriada) {
          dadosCadastro = null;
          ocupado(btn, false, 'Criar minha conta');
          ctx.toast(traduzErro(e), 'erro');
        } else if (e?.code === 'print/whats-repetido') {
          // A conta de e-mail existe, mas o WhatsApp já é de outra conta.
          // O app.js abre Complete seu cadastro (já preenchido) para trocar o número ou sair.
          rascunho = {};
          ctx.toast(MSG_WHATS, 'erro');
        } else {
          // A conta existe, mas o cadastro não terminou. O app.js mostra Complete seu cadastro ou Tentar de novo.
          ctx.toast('Sua conta foi criada, mas faltou terminar o cadastro. Confira a internet e tente de novo.', 'erro');
        }
      }
    });
  }
};

/* ============================================================
   10. Tela Complete seu cadastro
   (primeiro acesso com Google, ou cadastro que não terminou)
   ============================================================ */
export const telaCompletar = {
  montar(el, ctx) {
    const user = auth.currentUser;
    if (!user || !ctx.estado.uid) { el.innerHTML = ''; return; }
    const uid = ctx.estado.uid;
    const docAntigo = ctx.estado.usuario; // existe só no caso raro de documento antigo sem WhatsApp
    if (!rascunhoComp || rascunhoComp.uid !== uid) {
      rascunhoComp = {
        uid,
        nome: docAntigo?.nome || user.displayName || '',
        whatsapp: docAntigo?.whatsapp || '',
        cidade: docAntigo?.cidade || '',
        especialidades: Array.isArray(docAntigo?.especialidades) ? lerEspecialidades(docAntigo) : [],
        codigo: '',
        aceite: false
      };
    }
    const r = rascunhoComp;
    const bateu = erroWhats && erroWhats.uid === uid;
    const email = String(user.email || '').toLowerCase();

    el.innerHTML =
      cabecalho('Complete seu cadastro', 'Falta pouco. Depois a equipe libera o seu acesso.') +
      '<p class="cad-conta muted">Conta: <b>' + esc(email || 'sem e-mail') + '</b></p>' +
      (bateu ? '<div class="card cad-alerta js-alerta" role="alert"><b>' + esc(MSG_WHATS) + '</b>' +
        '<p class="pequeno">Se o número é seu, toque em “Usar outra conta”, no fim da tela, e entre com a conta antiga. Se trocou de número, digite o novo.</p></div>' : '') +
      '<form class="js-form" novalidate>' +
        '<label for="k-nome">Seu nome</label>' +
        '<input id="k-nome" name="nome" autocomplete="name" autocapitalize="words" maxlength="80" required value="' + esc(r.nome) + '">' +
        '<label for="k-whats">WhatsApp (com DDD)</label>' +
        '<input id="k-whats" name="whatsapp" type="tel" inputmode="tel" autocomplete="tel-national" placeholder="(17) 90000-0000" required value="' + esc(formatarWhats(r.whatsapp)) + '">' +
        '<label for="k-cidade">Cidade</label>' +
        '<input id="k-cidade" name="cidade" autocomplete="address-level2" autocapitalize="words" maxlength="60" placeholder="Ex.: São José do Rio Preto" required value="' + esc(r.cidade) + '">' +
        '<p class="rotulo">Você trabalha como <span class="muted">(pode marcar mais de uma)</span></p>' +
        htmlProfissoes(r.especialidades) +
        (docAntigo ? '' :
          '<label for="k-codigo">Código de parceiro <span class="muted">(opcional)</span></label>' +
          '<input id="k-codigo" name="codigo" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="12" value="' + esc(r.codigo) + '">' +
          '<p class="campo-ajuda">Se alguém te passou um código, coloque aqui.</p>' +
          '<div class="aviso-dados">' + esc(AVISO_DADOS) + '</div>' +
          '<label class="aceite"><input type="checkbox" name="aceite"' + (r.aceite ? ' checked' : '') + '>' +
            '<span>Li e aceito os Termos de uso e a Política de Privacidade.</span></label>' +
          '<div class="links-termos"><a href="#termos">Ler os Termos</a><a href="#termos/privacidade">Ler a Privacidade</a></div>') +
        '<button class="big primary js-salvar" type="submit" style="margin-top:14px">Concluir cadastro</button>' +
      '</form>' +
      '<div class="auth-alt">' +
        '<button class="big js-contato" type="button">💬 Falar com a equipe</button>' +
        '<button class="big js-sair" type="button">↩️ Usar outra conta</button>' +
      '</div>';

    const f = el.querySelector('.js-form');
    const btn = el.querySelector('.js-salvar');
    if (!r.nome) f.nome.focus({ preventScroll: true });

    ligarProfissoes(f, r.especialidades, lista => { r.especialidades = lista; });
    f.addEventListener('input', ev => {
      if (ev.target === f.whatsapp) {
        const pos = f.whatsapp.selectionStart === f.whatsapp.value.length;
        f.whatsapp.value = formatarWhats(f.whatsapp.value);
        if (pos) f.whatsapp.setSelectionRange(f.whatsapp.value.length, f.whatsapp.value.length);
        if (bateu) el.querySelector('.js-alerta')?.remove();
      }
      if (f.codigo && ev.target === f.codigo) f.codigo.value = limparCodigo(f.codigo.value);
      r.nome = f.nome.value; r.whatsapp = soDigitos(f.whatsapp.value); r.cidade = f.cidade.value;
      if (f.codigo) r.codigo = f.codigo.value;
    });
    f.addEventListener('change', () => { if (f.aceite) r.aceite = f.aceite.checked; });

    el.querySelector('.js-contato').addEventListener('click', () => ctx.ir('contato', { de: 'completar' }));
    const bSair = el.querySelector('.js-sair');
    bSair.addEventListener('click', async () => { bSair.disabled = true; await sair(ctx); bSair.disabled = false; });

    f.addEventListener('submit', async ev => {
      ev.preventDefault();
      if (btn.disabled) return;
      const nome = f.nome.value.trim().replace(/\s+/g, ' ');
      const whatsapp = limparWhats(f.whatsapp.value);
      const cidade = f.cidade.value.trim().replace(/\s+/g, ' ');
      const codigoParceiro = f.codigo ? limparCodigo(f.codigo.value) : '';
      const erro = (msg, campo) => { ctx.toast(msg, 'erro'); campo?.focus(); };
      if (nome.length < 2) return erro('Digite o seu nome.', f.nome);
      if (whatsapp.length < 10 || whatsapp.length > 11) return erro('Digite o WhatsApp com DDD. Ex.: (17) 99999-8888', f.whatsapp);
      if (cidade.length < 2) return erro('Digite a sua cidade.', f.cidade);
      if (!r.especialidades.length) return erro('Marque pelo menos uma profissão.', f.querySelector('[data-prof]'));
      if (f.aceite && !f.aceite.checked) return erro('Para continuar, marque que aceita os Termos e a Política de Privacidade.', f.aceite);
      if (!navigator.onLine) return erro('Sem internet. Para concluir o cadastro, conecte-se e tente de novo.');

      ocupado(btn, true, 'Salvando…');
      const d = { nome, whatsapp, cidade, especialidades: r.especialidades.slice(), codigoParceiro };
      try {
        if (docAntigo) await completarDocumentoAntigo(uid, d);
        else await criarCadastro(user, d, ler('print.entrada') === 'email' ? 'email' : 'google');
        rascunhoComp = null;
        ctx.toast('Cadastro concluído!', 'ok');
        await ctx.recarregarUsuario();
        ctx.ir('pendente'); // o app.js decide a tela pela situação nova
      } catch (e) {
        console.warn('[Print] completar cadastro', e?.code || e);
        if (e?.code === 'print/whats-repetido') {
          telaCompletar.montar(el, ctx); // redesenha com o aviso no alto
          window.scrollTo(0, 0);
          ctx.toast(MSG_WHATS, 'erro');
          return;
        }
        ocupado(btn, false, 'Concluir cadastro');
        ctx.toast(traduzErro(e), 'erro');
      }
    });
  }
};

/* ============================================================
   11. Tela Recuperar senha (igual à 1.0.0)
   ============================================================ */
export const telaRecuperar = {
  montar(el, ctx) {
    const email0 = ctx.params?.email || emailLembrado();
    el.innerHTML =
      cabecalho('Recuperar senha', 'Mandamos um link para o seu e-mail para você criar uma senha nova.') +
      '<form class="js-form" novalidate>' +
        '<label for="r-email">E-mail do cadastro</label>' +
        '<input id="r-email" name="email" type="email" inputmode="email" autocomplete="email" autocapitalize="off" spellcheck="false" required value="' + esc(email0) + '">' +
        '<button class="big primary js-enviar" type="submit" style="margin-top:18px">Enviar link</button>' +
      '</form>' +
      '<div class="card ok-card js-ok" hidden>' +
        '<b>Link enviado!</b>' +
        '<p>Se este e-mail tiver cadastro, o link chega em alguns minutos. Olhe também a caixa de spam ou de lixo eletrônico.</p>' +
        '<p class="muted">Abra o link, crie a senha nova e volte aqui para entrar.</p>' +
      '</div>' +
      '<button class="big js-voltar" type="button">Voltar para Entrar</button>';

    const f = el.querySelector('.js-form');
    const btn = el.querySelector('.js-enviar');
    f.email.focus({ preventScroll: true });
    el.querySelector('.js-voltar').addEventListener('click', () => ctx.ir('entrar', { email: f.email.value.trim(), modo: 'email' }));

    f.addEventListener('submit', async ev => {
      ev.preventDefault();
      if (btn.disabled) return;
      const email = f.email.value.trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { ctx.toast('E-mail inválido. Confira se digitou certo.', 'erro'); f.email.focus(); return; }
      ocupado(btn, true, 'Enviando…');
      try {
        await fa.sendPasswordResetEmail(auth, email);
        lembrarEmail(email);
        el.querySelector('.js-ok').hidden = false;
        ocupado(btn, false, 'Enviar de novo');
      } catch (e) {
        // Por segurança, "e-mail sem cadastro" mostra a mesma mensagem de sucesso.
        if (e?.code === 'auth/user-not-found') {
          el.querySelector('.js-ok').hidden = false;
          ocupado(btn, false, 'Enviar de novo');
        } else {
          ctx.toast(traduzErro(e), 'erro');
          ocupado(btn, false, 'Enviar link');
        }
      }
    });
  }
};
