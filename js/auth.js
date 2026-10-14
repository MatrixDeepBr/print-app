/*
  Arquivo: js/auth.js
  Versão: 1.0.0
  Sessão: 2 — Cadastro, login e pendente
  Data: 14/10/2026
  Telas Entrar, Cadastrar e Recuperar senha, e a função Sair.

  Contrato de telas: telaEntrar, telaCadastro, telaRecuperar (cada uma com montar(container, ctx))
  Funções:           sair(ctx), garantirDocumento(user)

  O documento users/{uid} nasce com:
    nome, email, whatsapp (só dígitos), cidade,
    status 'pendente', plano 'free', proAte null, testeProPendente false,
    criadoEm, aceiteEm, versaoTermos e codigoParceiro (só se preenchido).

  Se a conta for criada no Authentication mas o documento falhar (internet caiu,
  por exemplo), o app cria o documento que faltou no próximo login
  (garantirDocumento, chamado pelo app.js). Ninguém fica preso.

  No navegador fica lembrado só o e-mail (print.email). A senha nunca é guardada.
*/

import { auth, db, fs, fa } from './firebase.js';
import { esc, traduzErro } from './utils.js';
import { pararUso } from './uso.js';
import { VERSAO_TERMOS } from './textos.js';

/* ============================================================
   1. Memória da sessão (nada disso vai para o disco)
   ============================================================ */
let rascunho = {};          // o que já foi digitado no cadastro (sem a senha), para não perder ao abrir os Termos
let dadosCadastro = null;   // dados do cadastro em andamento, usados para criar users/{uid}
let garantindo = null;      // { uid, p } evita criar o documento duas vezes ao mesmo tempo

/* ============================================================
   2. Ajudantes
   ============================================================ */
function lembrarEmail(email) {
  try { localStorage.setItem('print.email', email); } catch (e) { /* ignora */ }
}
function emailLembrado() {
  try { return localStorage.getItem('print.email') || ''; } catch (e) { return ''; }
}

const soDigitos = s => String(s ?? '').replace(/\D/g, '');

/** "17999998888" -> "(17) 99999-8888" enquanto digita. */
export function formatarWhats(v) {
  const d = soDigitos(v).slice(0, 11);
  if (d.length <= 2) return d.length ? '(' + d : '';
  if (d.length <= 6) return '(' + d.slice(0, 2) + ') ' + d.slice(2);
  if (d.length <= 10) return '(' + d.slice(0, 2) + ') ' + d.slice(2, 6) + '-' + d.slice(6);
  return '(' + d.slice(0, 2) + ') ' + d.slice(2, 7) + '-' + d.slice(7);
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
  if (txt) btn.textContent = txt;
}

/* ============================================================
   3. Documento do usuário (users/{uid})
   ============================================================ */

/**
 * Garante que users/{uid} existe. Se não existir no servidor, cria como pendente.
 * Usa os dados do cadastro em andamento; se não houver (ex.: o documento falhou
 * no cadastro e a pessoa voltou outro dia), cria com o que se sabe e a tela de
 * pendente pede o que faltar. Devolve os dados do documento.
 * Lança erro se não der para falar com o servidor (o app mostra "Tentar de novo").
 */
export function garantirDocumento(user) {
  if (garantindo && garantindo.uid === user.uid) return garantindo.p;

  const p = (async () => {
    const ref = fs.doc(db, 'users', user.uid);
    // Confere no SERVIDOR (nunca cria por engano por causa do cache offline).
    const s = await comPrazo(fs.getDocFromServer(ref), 20000);
    if (s.exists()) return s.data();

    const email = String(user.email || '').toLowerCase();
    const d = dadosCadastro && dadosCadastro.email === email ? dadosCadastro : null;
    const novo = {
      nome: d?.nome || user.displayName || '',
      email,
      whatsapp: d?.whatsapp || '',
      cidade: d?.cidade || '',
      status: 'pendente',
      plano: 'free',
      proAte: null,
      testeProPendente: false,
      criadoEm: fs.serverTimestamp(),
      // A conta só pode ser criada pelo formulário, que exige o aceite.
      aceiteEm: fs.serverTimestamp(),
      versaoTermos: VERSAO_TERMOS
    };
    if (d?.codigoParceiro) novo.codigoParceiro = d.codigoParceiro;

    await comPrazo(fs.setDoc(ref, novo), 20000);
    if (d) dadosCadastro = null;
    try {
      const s2 = await fs.getDoc(ref);
      if (s2.exists()) return s2.data();
    } catch (e) { /* segue com a cópia local */ }
    return { ...novo, criadoEm: new Date(), aceiteEm: new Date() };
  })();

  garantindo = { uid: user.uid, p };
  p.catch(() => {}).finally(() => { if (garantindo && garantindo.p === p) garantindo = null; });
  return p;
}

/* ============================================================
   4. Sair
   ============================================================ */
export async function sair(ctx) {
  try {
    await pararUso();
    await fa.signOut(auth);
    ctx?.toast?.('Você saiu.', 'ok');
    // O app.js percebe a saída e abre a tela Entrar.
  } catch (e) {
    ctx?.toast?.(traduzErro(e), 'erro');
  }
}

/* ============================================================
   5. Tela Entrar
   ============================================================ */
export const telaEntrar = {
  montar(el, ctx) {
    el.innerHTML =
      cabecalho('Entrar', 'Use o e-mail e a senha do seu cadastro.') +
      '<form class="js-form" novalidate>' +
        '<label for="e-email">E-mail</label>' +
        '<input id="e-email" name="email" type="email" inputmode="email" autocomplete="email" autocapitalize="off" spellcheck="false" required value="' + esc(ctx.params?.email || emailLembrado()) + '">' +
        '<label for="e-senha">Senha</label>' +
        campoSenha('e-senha', 'current-password') +
        '<button class="big primary js-entrar" type="submit" style="margin-top:18px">Entrar</button>' +
      '</form>' +
      '<button class="big js-esqueci" type="button">Esqueci a senha</button>' +
      '<div class="auth-alt"><span class="muted">Ainda não tem conta?</span>' +
      '<button class="big js-criar" type="button">Criar minha conta</button></div>';

    ligarVerSenha(el);
    const f = el.querySelector('.js-form');
    const btn = el.querySelector('.js-entrar');
    (f.email.value ? f.senha : f.email).focus({ preventScroll: true });

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
        // O app.js percebe o login e abre a tela certa (app ou situação da conta).
      } catch (e) {
        ctx.toast(traduzErro(e), 'erro');
        ocupado(btn, false, 'Entrar');
      }
    });
  }
};

/* ============================================================
   6. Tela Cadastrar
   ============================================================ */
const AVISO_DADOS = 'Seus clientes e orçamentos são seus e ficam guardados com segurança. Para melhorar o app, só acompanhamos o uso: quantas vezes você abre e quantos orçamentos faz.';

export const telaCadastro = {
  montar(el, ctx) {
    const r = rascunho;
    el.innerHTML =
      cabecalho('Criar minha conta', 'É rápido. Depois a equipe libera o seu acesso.') +
      '<form class="js-form" novalidate>' +
        '<label for="c-nome">Seu nome</label>' +
        '<input id="c-nome" name="nome" autocomplete="name" autocapitalize="words" maxlength="80" required value="' + esc(r.nome || '') + '">' +
        '<label for="c-whats">WhatsApp (com DDD)</label>' +
        '<input id="c-whats" name="whatsapp" type="tel" inputmode="tel" autocomplete="tel-national" placeholder="(17) 90000-0000" required value="' + esc(formatarWhats(r.whatsapp || '')) + '">' +
        '<label for="c-cidade">Cidade</label>' +
        '<input id="c-cidade" name="cidade" autocomplete="address-level2" autocapitalize="words" maxlength="60" placeholder="Ex.: São José do Rio Preto" required value="' + esc(r.cidade || '') + '">' +
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
      '<div class="auth-alt"><span class="muted">Já tem conta?</span>' +
      '<button class="big js-entrar" type="button">Entrar</button></div>';

    ligarVerSenha(el);
    const f = el.querySelector('.js-form');
    const btn = el.querySelector('.js-criar');

    // Guarda o que foi digitado (menos a senha) para não perder ao abrir os Termos.
    f.addEventListener('input', ev => {
      if (ev.target === f.whatsapp) {
        const pos = f.whatsapp.selectionStart === f.whatsapp.value.length;
        f.whatsapp.value = formatarWhats(f.whatsapp.value);
        if (pos) f.whatsapp.setSelectionRange(f.whatsapp.value.length, f.whatsapp.value.length);
      }
      if (ev.target === f.codigo) f.codigo.value = limparCodigo(f.codigo.value);
      rascunho = {
        nome: f.nome.value, whatsapp: soDigitos(f.whatsapp.value), cidade: f.cidade.value,
        email: f.email.value, codigo: f.codigo.value, aceite: f.aceite.checked
      };
    });
    f.addEventListener('change', () => { rascunho.aceite = f.aceite.checked; });

    el.querySelector('.js-entrar').addEventListener('click', () => ctx.ir('entrar', { email: f.email.value.trim() }));
    if (!r.nome) f.nome.focus({ preventScroll: true });

    f.addEventListener('submit', async ev => {
      ev.preventDefault();
      if (btn.disabled) return;
      const nome = f.nome.value.trim().replace(/\s+/g, ' ');
      const whatsapp = soDigitos(f.whatsapp.value);
      const cidade = f.cidade.value.trim().replace(/\s+/g, ' ');
      const email = f.email.value.trim().toLowerCase();
      const senha = f.senha.value;
      const codigoParceiro = limparCodigo(f.codigo.value);

      const erro = (msg, campo) => { ctx.toast(msg, 'erro'); campo?.focus(); };
      if (nome.length < 2) return erro('Digite o seu nome.', f.nome);
      if (whatsapp.length < 10 || whatsapp.length > 11) return erro('Digite o WhatsApp com DDD. Ex.: (17) 99999-8888', f.whatsapp);
      if (cidade.length < 2) return erro('Digite a sua cidade.', f.cidade);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return erro('E-mail inválido. Confira se digitou certo.', f.email);
      if (senha.length < 6) return erro('A senha precisa ter pelo menos 6 letras ou números.', f.senha);
      if (!f.aceite.checked) return erro('Para continuar, marque que aceita os Termos e a Política de Privacidade.', f.aceite);

      ocupado(btn, true, 'Criando sua conta…');
      dadosCadastro = { email, nome, whatsapp, cidade, codigoParceiro };
      let contaCriada = false;
      try {
        const cred = await fa.createUserWithEmailAndPassword(auth, email, senha);
        contaCriada = true;
        lembrarEmail(email);
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
        } else {
          // A conta existe, mas o documento falhou. O app.js mostra "Tentar de novo".
          ctx.toast('Sua conta foi criada, mas faltou terminar o cadastro. Toque em Tentar de novo.', 'erro');
        }
      }
    });
  }
};

/* ============================================================
   7. Tela Recuperar senha
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
    el.querySelector('.js-voltar').addEventListener('click', () => ctx.ir('entrar', { email: f.email.value.trim() }));

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
