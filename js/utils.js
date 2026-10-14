/*
  Arquivo: js/utils.js
  Versão: 1.0.0
  Sessão: 1 — Base do projeto
  Data: 14/10/2026
  Funções pequenas usadas em todo o app. Não depende do Firebase.

  Contrato: moeda, esc, num, dataBR, primeiroNome, hojeISO, planoEfetivo
  Extras:   paraData (converte qualquer data), traduzErro (erro do Firebase em português)
*/

const fmtMoeda = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

/** 1234.5 -> "R$ 1.234,50". Aceita número ou texto. */
export function moeda(n) {
  return fmtMoeda.format(num(n));
}

/** Protege texto antes de colocar dentro do HTML. */
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

/**
 * Lê número digitado no jeito brasileiro. Nunca devolve NaN (devolve 0).
 * "25" -> 25 · "25,5" -> 25.5 · "1.234,56" -> 1234.56 · "R$ 80" -> 80
 */
export function num(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  let s = String(v ?? '').trim().replace(/[^\d,.-]/g, '');
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Converte para Date: Date, Timestamp do Firestore, milissegundos,
 * "2026-10-14" (data local, sem fuso) ou texto ISO. Devolve null se não der.
 */
export function paraData(d) {
  if (d == null || d === '') return null;
  if (d instanceof Date) return isNaN(d) ? null : d;
  if (typeof d.toDate === 'function') return d.toDate();
  if (typeof d === 'number') return new Date(d);
  if (typeof d === 'string') {
    const m = d.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
    const x = new Date(d);
    return isNaN(x) ? null : x;
  }
  if (typeof d.seconds === 'number') return new Date(d.seconds * 1000);
  return null;
}

/** Qualquer data -> "14/10/2026". Vazio se a data for inválida. */
export function dataBR(d) {
  const x = paraData(d);
  return x ? x.toLocaleDateString('pt-BR') : '';
}

/**
 * "joão da silva" -> "João". Se o nome estiver vazio, devolve a reserva
 * (padrão "pintor", para a tela "Olá, pintor").
 */
export function primeiroNome(nome, reserva = 'pintor') {
  const p = String(nome ?? '').trim().split(/\s+/)[0];
  if (!p) return reserva;
  return p.charAt(0).toLocaleUpperCase('pt-BR') + p.slice(1);
}

/** Data de hoje no horário do aparelho: "2026-10-14". */
export function hojeISO(d = new Date()) {
  const z = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + z(d.getMonth() + 1) + '-' + z(d.getDate());
}

/**
 * Plano que vale agora para o usuário (documento de users):
 *  - plano "pro"                          -> "pro"
 *  - plano "teste_pro" com proAte no futuro -> "pro"
 *  - qualquer outro caso                  -> "free"
 * Para saber se é teste, olhe usuario.plano === 'teste_pro'.
 */
export function planoEfetivo(usuario) {
  if (!usuario) return 'free';
  if (usuario.plano === 'pro') return 'pro';
  if (usuario.plano === 'teste_pro') {
    const ate = paraData(usuario.proAte);
    if (ate && ate.getTime() > Date.now()) return 'pro';
  }
  return 'free';
}

/** Erro do Firebase -> frase em português simples. */
export function traduzErro(e) {
  const c = String(e?.code || '').replace(/^firestore\//, '');
  const msg = {
    'auth/invalid-credential': 'E-mail ou senha incorretos.',
    'auth/wrong-password': 'E-mail ou senha incorretos.',
    'auth/user-not-found': 'E-mail ou senha incorretos.',
    'auth/invalid-email': 'E-mail inválido. Confira se digitou certo.',
    'auth/missing-password': 'Digite a senha.',
    'auth/missing-email': 'Digite o e-mail.',
    'auth/weak-password': 'Senha fraca. Use pelo menos 6 caracteres.',
    'auth/email-already-in-use': 'Este e-mail já tem cadastro. Tente entrar.',
    'auth/user-disabled': 'Esta conta foi desativada.',
    'auth/too-many-requests': 'Muitas tentativas. Espere alguns minutos e tente de novo.',
    'auth/network-request-failed': 'Sem internet. Confira a conexão e tente de novo.',
    'auth/unauthorized-domain': 'Este endereço não está autorizado no Firebase (Authentication > Configurações > Domínios autorizados).',
    'auth/operation-not-allowed': 'Login por e-mail e senha não está ativado no Firebase.',
    'permission-denied': 'Sem permissão para isso. Confira se está logado e liberado.',
    'unauthenticated': 'Você precisa entrar na sua conta.',
    'unavailable': 'Sem conexão com o servidor. Tente de novo em instantes.',
    'deadline-exceeded': 'O servidor demorou demais para responder.',
    'not-found': 'Não encontrado.',
    'already-exists': 'Isso já existe.',
    'resource-exhausted': 'Limite de uso do servidor atingido. Tente mais tarde.',
    'failed-precondition': 'Operação não permitida agora (pode faltar um índice no Firestore).',
    'invalid-argument': 'Algum dado está em formato errado.',
    'cancelled': 'Operação cancelada.'
  }[c];
  if (msg) return msg;
  if (c) return 'Algo deu errado (' + c + ').';
  return e?.message ? 'Algo deu errado: ' + e.message : 'Algo deu errado.';
}
