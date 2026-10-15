/*
  Arquivo: js/clientes.js
  Versão: 1.0.0
  Sessão: 5 — Início e clientes
  Data: 15/10/2026
  Tela de clientes (#clientes): uma tela só com lista + busca + painel.
  O painel mostra os dados do cliente ou o formulário. No celular ele é uma
  folha que sobe de baixo; a partir de 900 px fica ao lado da lista.

  Contrato: montar(container, ctx) e desmontar() (cancela o onSnapshot).
  Banco (contrato S4/S5/S6, seção 4):
    users/{uid}/clientes/{id}: nome, nomeBusca, whatsapp (só dígitos), endereco,
                               obs, criadoEm, atualizadoEm
    resumos/{uid}.totalClientes: increment(+1) ao criar, increment(-1) ao excluir
                                 (setDoc com merge: true)
  Lista: onSnapshot da coleção inteira, ordenada e filtrada no aparelho (funciona
  offline). Gravação sem esperar o servidor (seção 5 do contrato).
  Excluir cliente NÃO apaga os orçamentos dele.

  Funções auxiliares que podem ir para o utils.js na Sessão 10:
    normalizarBusca(texto)  minúsculo, sem acento, espaços simples
    soDigitos(texto)
    foneBR(digitos)         "17991234567" -> "(17) 99123-4567"
    linkWhats(digitos)      "https://wa.me/5517991234567"
*/

import { db, fs } from './firebase.js';

const MAX_LISTA = 200;           // acima disso, pede para usar a busca
const LARGO = '(min-width: 900px)';

let S = null;

/* ============================================================
   Auxiliares (candidatas ao utils.js na Sessão 10)
   ============================================================ */
export function normalizarBusca(t) {
  return String(t ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/\s+/g, ' ').trim();
}

export function soDigitos(t) {
  return String(t ?? '').replace(/\D/g, '');
}

/** Máscara visual do WhatsApp. Aceita 55 na frente (12 ou 13 dígitos). */
export function foneBR(d) {
  d = soDigitos(d);
  if (!d) return '';
  let pre = '';
  if (d.length > 11 && d.startsWith('55')) { pre = '+55 '; d = d.slice(2); }
  if (d.length <= 2) return pre + '(' + d;
  const ddd = d.slice(0, 2);
  const r = d.slice(2, 11);
  if (r.length <= 4) return pre + '(' + ddd + ') ' + r;
  if (r.length <= 8) return pre + '(' + ddd + ') ' + r.slice(0, 4) + '-' + r.slice(4);
  return pre + '(' + ddd + ') ' + r.slice(0, 5) + '-' + r.slice(5);
}

/** Link do WhatsApp com o 55 do Brasil (não duplica se já tiver). */
export function linkWhats(d) {
  d = soDigitos(d);
  if (!d) return '';
  if (!(d.length >= 12 && d.startsWith('55'))) d = '55' + d;
  return 'https://wa.me/' + d;
}

const buscaDe = c => c.nomeBusca || normalizarBusca(c.nome);
const largo = () => window.matchMedia(LARGO).matches;

/* ============================================================
   Montar / desmontar
   ============================================================ */
export function montar(el, ctx) {
  S = {
    el, ctx,
    lista: [],          // [{ id, nome, nomeBusca, whatsapp, endereco, obs, ... }]
    carregou: false,
    erro: null,
    busca: '',
    painel: null,       // null | { modo: 'ver', id } | { modo: 'form', id, pre }
    unsub: null,
    conf: null          // overlay de confirmação aberto
  };

  el.classList.add('cli-tela');
  el.innerHTML =
    '<div class="cli-layout">' +
      '<div class="cli-col">' +
        '<div class="cli-cab"><h1>Clientes</h1><span class="muted js-total"></span></div>' +
        '<div class="cli-busca">' +
          '<span class="cli-lupa" aria-hidden="true">🔎</span>' +
          '<input type="search" class="js-busca" placeholder="Buscar por nome ou WhatsApp" ' +
            'aria-label="Buscar cliente por nome ou WhatsApp" autocomplete="off" enterkeyhint="search">' +
        '</div>' +
        '<button type="button" class="big primary cli-novo" data-acao="novo">➕ Novo cliente</button>' +
        '<div class="js-lista"><p class="muted">Carregando…</p></div>' +
      '</div>' +
      '<div class="cli-painel js-painel">' +
        '<div class="cli-folha js-folha" role="dialog" aria-label="Cliente"></div>' +
      '</div>' +
    '</div>';

  el.addEventListener('click', aoClicar);
  el.addEventListener('input', aoDigitar);
  el.addEventListener('submit', aoEnviar);
  document.addEventListener('keydown', aoTecla);

  desenharPainel();
  assinar();
}

export function desmontar() {
  if (!S) return;
  try { S.unsub?.(); } catch (e) { /* ignora */ }
  fecharConfirmacao();
  document.documentElement.classList.remove('cli-travado');
  S.el.removeEventListener('click', aoClicar);
  S.el.removeEventListener('input', aoDigitar);
  S.el.removeEventListener('submit', aoEnviar);
  document.removeEventListener('keydown', aoTecla);
  S = null;
}

/* ============================================================
   Dados ao vivo
   ============================================================ */
function colecao() {
  return fs.collection(db, 'users', S.ctx.estado.uid, 'clientes');
}

function assinar() {
  if (!S.ctx.estado.uid) return;
  S.unsub = fs.onSnapshot(colecao(), snap => {
    if (!S) return;
    S.lista = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    ordenar();
    S.carregou = true;
    S.erro = null;
    desenharLista();
    // Atualiza os dados abertos (se outro aparelho mudou) — nunca o formulário.
    if (S.painel?.modo === 'ver') {
      if (achar(S.painel.id)) desenharPainel();
      else fecharPainel();
    }
  }, e => {
    console.error('[Print] clientes', e);
    if (!S) return;
    S.erro = e;
    S.carregou = true;
    desenharLista();
  });
}

function ordenar() {
  S.lista.sort((a, b) => String(a.nome || '').localeCompare(String(b.nome || ''), 'pt-BR', { sensitivity: 'base' }));
}

const achar = id => S.lista.find(c => c.id === id);

/** Coloca ou troca um cliente na lista local (antes do servidor responder). */
function guardarLocal(c) {
  const i = S.lista.findIndex(x => x.id === c.id);
  if (i >= 0) S.lista[i] = { ...S.lista[i], ...c };
  else S.lista.push(c);
  ordenar();
}

/* ============================================================
   Lista + busca
   ============================================================ */
function filtrar() {
  const termos = normalizarBusca(S.busca).split(' ')
    .map(t => t.replace(/[^a-z0-9]/g, ''))
    .filter(Boolean);
  if (!termos.length) return S.lista;
  const achados = S.lista.filter(c => {
    const nome = buscaDe(c);
    const fone = soDigitos(c.whatsapp);
    return termos.every(t => nome.includes(t) || (/^\d+$/.test(t) && fone.includes(t)));
  });
  // Quem tem uma palavra começando com o que foi digitado aparece primeiro.
  const comeca = c => (' ' + buscaDe(c)).includes(' ' + termos[0]) ? 0 : 1;
  return achados.map((c, i) => [comeca(c), i, c]).sort((a, b) => a[0] - b[0] || a[1] - b[1]).map(x => x[2]);
}

function desenharLista() {
  if (!S) return;
  const { esc } = S.ctx.utils;
  const box = S.el.querySelector('.js-lista');
  const total = S.el.querySelector('.js-total');
  total.textContent = S.carregou && S.lista.length ? S.lista.length + (S.lista.length === 1 ? ' cliente' : ' clientes') : '';

  if (!S.carregou) { box.innerHTML = '<p class="muted">Carregando…</p>'; return; }
  if (S.erro && !S.lista.length) {
    box.innerHTML = '<div class="card"><b>Não deu para abrir os clientes.</b><p class="muted">' +
      esc(S.ctx.utils.traduzErro(S.erro)) + '</p></div>';
    return;
  }
  if (!S.lista.length) {
    box.innerHTML = '<div class="card cli-vazio"><b>Nenhum cliente ainda.</b>' +
      '<p class="muted">Toque em <b>Novo cliente</b>. Só o nome já basta, o resto você completa depois.</p></div>';
    return;
  }

  const achados = filtrar();
  if (!achados.length) {
    const q = S.busca.trim();
    box.innerHTML = '<div class="card cli-vazio"><p>Nenhum cliente com “' + esc(q) + '”.</p>' +
      '<button type="button" class="big" data-acao="novo-da-busca">➕ Cadastrar “' + esc(q) + '”</button></div>';
    return;
  }

  const mostrar = achados.slice(0, MAX_LISTA);
  const aberto = S.painel?.id;
  box.innerHTML = '<ul class="cli-lista">' + mostrar.map(c => {
    const det = [foneBR(c.whatsapp), c.endereco].filter(Boolean).map(esc).join(' · ');
    return '<li><button type="button" class="cli-item' + (c.id === aberto ? ' on' : '') + '" data-id="' + esc(c.id) + '">' +
      '<span class="cli-av" aria-hidden="true">' + esc(inicial(c.nome)) + '</span>' +
      '<span class="cli-item-txt"><b>' + esc(c.nome || 'Sem nome') + '</b>' +
      (det ? '<small>' + det + '</small>' : '') + '</span>' +
      '<span class="cli-seta" aria-hidden="true">›</span></button></li>';
  }).join('') + '</ul>' +
  (achados.length > MAX_LISTA ? '<p class="muted pequeno">Mostrando ' + MAX_LISTA + ' de ' + achados.length + '. Use a busca para achar os outros.</p>' : '');
}

function inicial(nome) {
  const p = String(nome || '').trim().charAt(0);
  return p ? p.toLocaleUpperCase('pt-BR') : '?';
}

/* ============================================================
   Painel (dados ou formulário)
   ============================================================ */
function abrirPainel(p) {
  S.painel = p;
  desenharPainel();
  desenharLista(); // marca o cliente aberto
  const folha = S.el.querySelector('.js-folha');
  folha.scrollTop = 0;
  if (p.modo === 'form') {
    // No celular abre o teclado direto no nome (cadastro em segundos).
    const campo = folha.querySelector(p.foco === 'whatsapp' ? '[name="whatsapp"]' : '[name="nome"]');
    campo?.focus();
  } else if (!largo()) {
    folha.querySelector('.cli-fechar')?.focus();
  }
}

function fecharPainel() {
  if (!S) return;
  S.painel = null;
  desenharPainel();
  desenharLista();
}

function desenharPainel() {
  const painel = S.el.querySelector('.js-painel');
  const folha = S.el.querySelector('.js-folha');
  const p = S.painel;
  painel.classList.toggle('aberto', !!p);
  // No celular a folha cobre a tela: trava a rolagem do fundo.
  document.documentElement.classList.toggle('cli-travado', !!p && !largo());

  if (!p) {
    folha.innerHTML = '<div class="cli-dica"><span aria-hidden="true">👥</span>' +
      '<p class="muted">Toque em um cliente para ver os dados, ou em <b>Novo cliente</b>.</p></div>';
    return;
  }
  folha.innerHTML = p.modo === 'ver' ? htmlVer(achar(p.id)) : htmlForm(p.id ? achar(p.id) : null, p.pre);
}

function htmlVer(c) {
  const { esc } = S.ctx.utils;
  if (!c) return '';
  const fone = foneBR(c.whatsapp);
  const zap = linkWhats(c.whatsapp);
  return '<div class="cli-folha-cab">' +
      '<h2>' + esc(c.nome || 'Sem nome') + '</h2>' +
      '<button type="button" class="x cli-fechar" data-acao="fechar" aria-label="Fechar">✕</button>' +
    '</div>' +
    '<dl class="cli-dados">' +
      '<div><dt>WhatsApp</dt><dd>' + (fone ? esc(fone) : '<span class="muted">não informado</span>') + '</dd></div>' +
      '<div><dt>Endereço</dt><dd>' + (c.endereco ? esc(c.endereco) : '<span class="muted">não informado</span>') + '</dd></div>' +
      (c.obs ? '<div><dt>Observações</dt><dd class="cli-obs">' + esc(c.obs) + '</dd></div>' : '') +
    '</dl>' +
    '<button type="button" class="big primary" data-acao="orcar">➕ Novo orçamento</button>' +
    (zap
      ? '<a class="big cli-zap" href="' + esc(zap) + '" target="_blank" rel="noopener">💬 WhatsApp</a>'
      : '<button type="button" class="big" data-acao="editar" data-foco="whatsapp">💬 Colocar WhatsApp</button>') +
    '<div class="cli-duplo">' +
      '<button type="button" class="big" data-acao="editar">✏️ Editar</button>' +
      '<button type="button" class="big cli-excluir" data-acao="excluir">🗑️ Excluir</button>' +
    '</div>';
}

function htmlForm(c, pre = {}) {
  const { esc } = S.ctx.utils;
  const v = { nome: '', whatsapp: '', endereco: '', obs: '', ...(c || {}), ...(pre || {}) };
  return '<form class="cli-form" novalidate>' +
    '<div class="cli-folha-cab">' +
      '<h2>' + (c ? 'Editar cliente' : 'Novo cliente') + '</h2>' +
      '<button type="button" class="x cli-fechar" data-acao="cancelar" aria-label="Fechar">✕</button>' +
    '</div>' +
    '<label for="cli-nome">Nome <span class="cli-obrig">(obrigatório)</span></label>' +
    '<input id="cli-nome" name="nome" type="text" autocomplete="off" autocapitalize="words" enterkeyhint="next" maxlength="120" value="' + esc(v.nome) + '">' +
    '<label for="cli-whats">WhatsApp</label>' +
    '<input id="cli-whats" name="whatsapp" type="tel" inputmode="tel" autocomplete="off" enterkeyhint="next" placeholder="(17) 99999-9999" value="' + esc(foneBR(v.whatsapp)) + '">' +
    '<label for="cli-end">Endereço</label>' +
    '<input id="cli-end" name="endereco" type="text" autocomplete="off" enterkeyhint="next" maxlength="200" placeholder="Rua, número, bairro" value="' + esc(v.endereco) + '">' +
    '<label for="cli-obs">Observações</label>' +
    '<textarea id="cli-obs" name="obs" class="cli-obs-campo" maxlength="1000" placeholder="Ex.: casa de esquina, portão azul">' + esc(v.obs) + '</textarea>' +
    '<button type="submit" class="big primary cli-salvar">Salvar</button>' +
    '<button type="button" class="big cli-cancelar" data-acao="cancelar">Cancelar</button>' +
  '</form>';
}

/* ============================================================
   Eventos
   ============================================================ */
function aoClicar(ev) {
  const painel = S.el.querySelector('.js-painel');
  // Toque no fundo escuro (só no celular) fecha a folha.
  if (ev.target === painel && !largo()) { fecharPainel(); return; }

  const item = ev.target.closest('.cli-item');
  if (item) { abrirPainel({ modo: 'ver', id: item.dataset.id }); return; }

  const b = ev.target.closest('[data-acao]');
  if (!b) return;
  const id = S.painel?.id;
  switch (b.dataset.acao) {
    case 'novo':
      abrirPainel({ modo: 'form', id: null });
      break;
    case 'novo-da-busca': {
      const q = S.busca.trim();
      const d = soDigitos(q);
      const soNumero = d.length >= 3 && !/[a-zA-ZÀ-ÿ]/.test(q);
      abrirPainel({ modo: 'form', id: null, pre: soNumero ? { whatsapp: d } : { nome: q }, foco: soNumero ? 'nome' : 'whatsapp' });
      break;
    }
    case 'fechar':
      fecharPainel();
      break;
    case 'cancelar':
      if (id && achar(id)) abrirPainel({ modo: 'ver', id });
      else fecharPainel();
      break;
    case 'editar':
      abrirPainel({ modo: 'form', id, foco: b.dataset.foco });
      break;
    case 'orcar':
      S.ctx.ir('orcamento', { clienteId: id });
      break;
    case 'excluir':
      pedirExclusao(id);
      break;
  }
}

function aoDigitar(ev) {
  const t = ev.target;
  if (t.classList.contains('js-busca')) {
    S.busca = t.value;
    desenharLista();
    return;
  }
  if (t.name === 'whatsapp') mascarar(t, ev);
}

function aoEnviar(ev) {
  if (!ev.target.classList.contains('cli-form')) return;
  ev.preventDefault();
  salvar(ev.target);
}

function aoTecla(ev) {
  if (ev.key !== 'Escape' || !S) return;
  if (S.conf) { fecharConfirmacao(); return; }
  if (S.painel) {
    if (S.painel.modo === 'form' && S.painel.id && achar(S.painel.id)) abrirPainel({ modo: 'ver', id: S.painel.id });
    else fecharPainel();
  }
}

/** Máscara do WhatsApp enquanto digita (mantém o cursor no lugar certo). */
function mascarar(input, ev) {
  const antes = input.dataset.dig || '';
  let pos = input.selectionStart ?? input.value.length;
  let dig = soDigitos(input.value).slice(0, 13);
  if (dig.length > 11 && !dig.startsWith('55')) dig = dig.slice(0, 11);
  let digAntesCursor = soDigitos(input.value.slice(0, pos)).length;
  // Apagou só um traço, espaço ou parêntese: apaga o número antes dele.
  if (ev.inputType === 'deleteContentBackward' && dig === antes && digAntesCursor > 0) {
    dig = dig.slice(0, digAntesCursor - 1) + dig.slice(digAntesCursor);
    digAntesCursor--;
  }
  input.value = foneBR(dig);
  input.dataset.dig = dig;
  // Cursor logo depois do mesmo número de dígitos
  let novo = 0, n = 0;
  while (novo < input.value.length && n < digAntesCursor) {
    if (/\d/.test(input.value[novo])) n++;
    novo++;
  }
  if (digAntesCursor >= dig.length) novo = input.value.length;
  try { input.setSelectionRange(novo, novo); } catch (e) { /* alguns teclados não deixam */ }
}

/* ============================================================
   Salvar e excluir (sem travar sem internet)
   ============================================================ */
function salvar(form) {
  const { toast } = S.ctx;
  const id = S.painel?.id || null;
  const nome = form.nome.value.trim().replace(/\s+/g, ' ');
  if (!nome) {
    toast('Digite o nome do cliente.', 'erro');
    form.nome.focus();
    return;
  }
  const dados = {
    nome,
    nomeBusca: normalizarBusca(nome),
    whatsapp: soDigitos(form.whatsapp.value).slice(0, 13),
    endereco: form.endereco.value.trim(),
    obs: form.obs.value.trim()
  };

  // Na edição, só avisa se o nome ou o WhatsApp mudaram (não incomoda a cada ajuste).
  const atual = id ? achar(id) : null;
  const mudouNome = !atual || buscaDe(atual) !== dados.nomeBusca;
  const mudouFone = !atual || soDigitos(atual.whatsapp) !== dados.whatsapp;
  const parecido = S.lista.find(c => c.id !== id &&
    ((mudouNome && buscaDe(c) === dados.nomeBusca) ||
     (mudouFone && dados.whatsapp && soDigitos(c.whatsapp) === dados.whatsapp)));
  if (parecido) {
    const { esc } = S.ctx.utils;
    const fone = foneBR(parecido.whatsapp);
    confirmar({
      titulo: 'Já existe um cliente parecido. Salvar mesmo assim?',
      html: '<div class="card cli-parecido"><b>' + esc(parecido.nome) + '</b>' +
        (fone ? '<span class="muted">' + esc(fone) + '</span>' : '') + '</div>',
      sim: 'Salvar mesmo assim',
      outro: { txt: 'Ver o que já existe', acao: () => abrirPainel({ modo: 'ver', id: parecido.id }) },
      acao: () => gravar(id, dados)
    });
    return;
  }
  gravar(id, dados);
}

function gravar(id, dados) {
  const { toast, utils } = S.ctx;
  const novo = !id || !achar(id);
  const ref = novo ? fs.doc(colecao()) : fs.doc(colecao(), id);
  const agora = fs.serverTimestamp();
  const falhou = e => {
    console.error('[Print] salvar cliente', e);
    toast(utils.traduzErro(e), 'erro');
  };

  // Não espera o servidor: sem internet a promessa só termina quando o sinal voltar.
  try {
    const p = novo
      ? fs.setDoc(ref, { ...dados, criadoEm: agora, atualizadoEm: agora })
      : fs.updateDoc(ref, { ...dados, atualizadoEm: agora });
    p.catch(falhou);
  } catch (e) { falhou(e); return; }

  if (novo) contarClientes(1);
  guardarLocal({ id: ref.id, ...dados, criadoEm: new Date(), atualizadoEm: new Date() });
  avisarSalvo();
  if (novo && S.busca.trim()) { // limpa a busca para o cliente novo aparecer
    S.busca = '';
    const b = S.el.querySelector('.js-busca');
    if (b) b.value = '';
  }
  abrirPainel({ modo: 'ver', id: ref.id });
}

function pedirExclusao(id) {
  const c = achar(id);
  if (!c) return;
  confirmar({
    titulo: 'Excluir ' + (c.nome || 'este cliente') + '?',
    texto: 'Os orçamentos desse cliente continuam salvos.',
    sim: '🗑️ Excluir',
    perigo: true,
    acao: () => excluir(id)
  });
}

function excluir(id) {
  const { toast, utils } = S.ctx;
  try {
    fs.deleteDoc(fs.doc(colecao(), id)).catch(e => {
      console.error('[Print] excluir cliente', e);
      toast(utils.traduzErro(e), 'erro');
    });
  } catch (e) { toast(utils.traduzErro(e), 'erro'); return; }
  contarClientes(-1);
  S.lista = S.lista.filter(c => c.id !== id);
  fecharPainel();
  toast(navigator.onLine ? 'Cliente excluído' : 'Cliente excluído no aparelho, atualiza quando tiver internet', 'ok');
}

/** resumos/{uid}.totalClientes (o painel master lê). */
function contarClientes(n) {
  try {
    fs.setDoc(fs.doc(db, 'resumos', S.ctx.estado.uid), { totalClientes: fs.increment(n) }, { merge: true })
      .catch(e => console.warn('[Print] resumo de clientes', e));
  } catch (e) { console.warn('[Print] resumo de clientes', e); }
}

function avisarSalvo() {
  S.ctx.toast(navigator.onLine ? 'Salvo ✓' : 'Salvo no aparelho, envia quando tiver internet', 'ok');
}

/* ============================================================
   Confirmação (folha por cima de tudo; nunca usa alert/confirm)
   ============================================================ */
function confirmar({ titulo, texto, html, sim, perigo, outro, acao }) {
  fecharConfirmacao();
  const { esc } = S.ctx.utils;
  const ov = document.createElement('div');
  ov.className = 'ov cli-conf';
  ov.innerHTML = '<div class="sheet" role="alertdialog" aria-modal="true" aria-labelledby="cli-conf-tit">' +
    '<h2 id="cli-conf-tit" class="cli-conf-tit">' + esc(titulo) + '</h2>' +
    (texto ? '<p>' + esc(texto) + '</p>' : '') + (html || '') +
    '<button type="button" class="big ' + (perigo ? 'cli-perigo' : 'primary') + '" data-c="sim">' + esc(sim) + '</button>' +
    (outro ? '<button type="button" class="big" data-c="outro">' + esc(outro.txt) + '</button>' : '') +
    '<button type="button" class="big" data-c="nao">Cancelar</button>' +
  '</div>';
  ov.addEventListener('click', ev => {
    if (ev.target === ov) { fecharConfirmacao(); return; }
    const b = ev.target.closest('[data-c]');
    if (!b) return;
    fecharConfirmacao();
    if (b.dataset.c === 'sim') acao();
    else if (b.dataset.c === 'outro') outro.acao();
  });
  document.body.appendChild(ov);
  S.conf = ov;
  ov.querySelector('[data-c="sim"]').focus();
}

function fecharConfirmacao() {
  if (!S?.conf) return;
  S.conf.remove();
  S.conf = null;
}
