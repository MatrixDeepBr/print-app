/*
  Arquivo: js/perfil.js
  Versão: 1.1.0
  Sessão: 4B — Várias profissões (1.0.0 era da Sessão 4)
  Data: 15/10/2026
  1.1.0: a Modalidade (escolha única) virou Profissões (marca e desmarca, pelo
         menos 1), com a opção nova "Marido de aluguel / reparos gerais".
         Grava especialidades (lista) e especialidade (a primeira marcada, para
         quem já lê esse campo). O cabeçalho mostra "Pintor · Pedreiro".
         Usuário antigo sem a lista: lerEspecialidades() de auth.js.

  Tela Perfil (#perfil): dados que vão no PDF (empresa, modalidade, CPF/CNPJ,
  telefone, cidade, logo, PIX, cor, modelo de PDF, validade, condições e rodapé)
  e a parte da conta (tema, Falar com a equipe, Sair, Termos).

  Dois modos:
    - normal: cabeçalho + 3 seções recolhíveis + botão Salvar fixo no rodapé.
    - guia (primeira entrada): 3 passos curtos, cada um com Pular.
      Abre com ir('perfil', { guia: true }) (Início, S5) e também sozinho quando
      a conta ainda não tem guiaFeito e o perfil está vazio (para quem abre
      #perfil direto). No fim, ou ao pular tudo, grava perfil.guiaFeito = true.

  Grava em users/{uid}: especialidades e especialidade (raiz) e perfil.* (updateDoc com
  caminhos "perfil.campo"; nunca reescreve o documento inteiro).
  Offline: não espera o servidor; avisa "Salvo no aparelho…" sem internet.

  Contrato: montar(container, ctx), desmontar()
  Extras (para a Sessão 10 juntar no utils.js, se quiser):
    soDigitos, formatarTelefone, formatarDocumento, reduzirLogo
*/

import { db, fs } from './firebase.js';
import { sair, PROFISSOES, lerEspecialidades, nomesProfissoes } from './auth.js'; // 1.1.0: + profissões
import { rodapeLegal } from './textos.js';

/* ============================================================
   1. Constantes
   ============================================================ */
/* 1.1.0: a lista de profissões fica em auth.js (PROFISSOES), a mesma do cadastro e do painel. */

const COR_PADRAO = '#2447d6'; // o azul do app
const CORES = [
  ['#2447d6', 'Azul'],
  ['#0f766e', 'Verde-água'],
  ['#15803d', 'Verde'],
  ['#b91c1c', 'Vermelho'],
  ['#c2410c', 'Laranja'],
  ['#a16207', 'Mostarda'],
  ['#7c3aed', 'Roxo'],
  ['#1f2937', 'Grafite']
];

const MODELOS = [
  ['classico', 'Clássico', 'Limpo e tradicional'],
  ['moderno', 'Moderno', 'Faixa na sua cor'],
  ['premium', 'Premium', 'Elegante, com moldura']
];

const TEMAS = { auto: 'Tema automático', claro: 'Tema claro', escuro: 'Tema escuro' };

const LOGO_ALVO = 50 * 1024;   // ~50 KB (tamanho do texto gravado)
const LOGO_LIMITE = 80 * 1024; // passou disso, avisa e não usa

/* Campos editáveis (o "rascunho" da tela). */
const CAMPOS = ['especialidades', 'empresa', 'documento', 'telefone', 'cidade', 'logo',
  'corPrincipal', 'pix', 'modeloPdf', 'validadeDias', 'condicoes', 'rodape'];

/* Campos de cada passo da guia. */
const PASSOS = [
  { campos: ['empresa', 'especialidades'] },
  { campos: ['logo'] },
  { campos: ['telefone', 'pix'] }
];

/* ============================================================
   2. Funções auxiliares (candidatas ao utils.js na Sessão 10)
   ============================================================ */
export function soDigitos(v) { return String(v ?? '').replace(/\D/g, ''); }

/** "17991234567" -> "(17) 99123-4567" · aceita parcial (máscara enquanto digita). */
export function formatarTelefone(v) {
  const d = soDigitos(v).slice(0, 11);
  if (!d) return '';
  const ddd = d.slice(0, 2), r = d.slice(2);
  if (!r) return '(' + ddd;
  const n = d.length > 10 ? 5 : 4;
  return '(' + ddd + ') ' + r.slice(0, n) + (r.length > n ? '-' + r.slice(n) : '');
}

function mascara(d, grupos, seps) {
  let out = '', i = 0;
  grupos.forEach((g, k) => {
    const parte = d.slice(i, i + g);
    if (!parte) return;
    if (k > 0) out += seps[k - 1];
    out += parte;
    i += g;
  });
  return out;
}

/** CPF (11 dígitos) ou CNPJ (14), com pontos e traço. Aceita parcial. */
export function formatarDocumento(v) {
  const d = soDigitos(v).slice(0, 14);
  return d.length <= 11
    ? mascara(d, [3, 3, 3, 2], ['.', '.', '-'])
    : mascara(d, [2, 3, 3, 4, 2], ['.', '.', '/', '-']);
}

function corValida(c) { return /^#[0-9a-f]{6}$/i.test(String(c || '')); }
function logoValida(l) { return /^data:image\/(png|jpeg|webp);base64,/.test(String(l || '')); }

/* ---------- Logo: reduz no aparelho ---------- */
async function abrirImagem(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } catch (e) {
    throw new Error('Não deu para abrir esta imagem. Tente outra foto.');
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

function desenharCanvas(img, lado, fundoBranco) {
  const w0 = img.naturalWidth || img.width, h0 = img.naturalHeight || img.height;
  const k = Math.min(1, lado / Math.max(w0, h0));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w0 * k));
  c.height = Math.max(1, Math.round(h0 * k));
  const g = c.getContext('2d');
  if (fundoBranco) { g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); }
  g.imageSmoothingQuality = 'high';
  g.drawImage(img, 0, 0, c.width, c.height);
  return c;
}

function temTransparencia(c) {
  try {
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    for (let i = 3; i < d.length; i += 4) if (d[i] < 250) return true;
  } catch (e) { /* sem acesso aos pixels: trata como sem transparência */ }
  return false;
}

/**
 * Foto/imagem -> texto data:image (até 400 px no lado maior, ~50 KB).
 * PNG se tiver transparência; senão JPEG (baixa a qualidade até caber).
 * Devolve { url, kb }. Erro com mensagem em português se não couber em 80 KB.
 */
export async function reduzirLogo(file) {
  if (!file || !/^image\//.test(file.type || 'image/')) throw new Error('Escolha uma foto ou imagem.');
  const img = await abrirImagem(file);
  const transp = /png|webp|gif/.test(file.type) && temTransparencia(desenharCanvas(img, 400, false));
  let melhor = null;
  for (const lado of [400, 340, 280, 220, 180]) {
    if (transp) {
      const url = desenharCanvas(img, lado, false).toDataURL('image/png');
      if (!melhor || url.length < melhor.length) melhor = url;
      if (url.length <= LOGO_ALVO) break;
    } else {
      const c = desenharCanvas(img, lado, true);
      for (const q of [0.88, 0.8, 0.7, 0.6, 0.5, 0.42]) {
        const url = c.toDataURL('image/jpeg', q);
        if (!melhor || url.length < melhor.length) melhor = url;
        if (url.length <= LOGO_ALVO) break;
      }
      if (melhor.length <= LOGO_ALVO) break;
    }
  }
  if (!melhor || melhor.length > LOGO_LIMITE) {
    throw new Error('Esta imagem ficou pesada demais. Tente uma logo mais simples ou um recorte menor.');
  }
  return { url: melhor, kb: Math.round(melhor.length / 1024) };
}

/** Desiste de esperar depois de ms (sem internet, a gravação fica na fila do aparelho). */
function comPrazo(promessa, ms) {
  return Promise.race([
    promessa.then(() => 'ok'),
    new Promise(res => setTimeout(() => res('fila'), ms))
  ]);
}

/* ---------- Tema (mesma chave e mesmo efeito do app.js) ---------- */
function lerTema() {
  try { return localStorage.getItem('print.tema') || 'auto'; } catch (e) { return 'auto'; }
}
function aplicarTema(t) {
  try { localStorage.setItem('print.tema', t); } catch (e) { /* só nesta visita */ }
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

/* ============================================================
   3. Estado da tela
   ============================================================ */
let sessao = null;         // { ctx, el, original, rascunho, modo, passo, ... }
let guardado = null;       // rascunho guardado quando a pessoa desiste de sair (botão Voltar)

/** Valores iniciais: o que está gravado, com os padrões e o cadastro como reserva. */
function valoresDe(estado) {
  const u = estado.usuario || {};
  const p = estado.perfil || {};
  return {
    especialidades: lerEspecialidades(u), // 1.1.0
    empresa: p.empresa ?? '',
    documento: p.documento ?? '',
    telefone: soDigitos(p.telefone ?? u.whatsapp ?? ''),
    cidade: p.cidade ?? u.cidade ?? '',
    logo: logoValida(p.logo) ? p.logo : '',
    corPrincipal: corValida(p.corPrincipal) ? p.corPrincipal.toLowerCase() : COR_PADRAO,
    pix: p.pix ?? '',
    modeloPdf: MODELOS.some(m => m[0] === p.modeloPdf) ? p.modeloPdf : 'classico',
    validadeDias: Number.isInteger(p.validadeDias) && p.validadeDias > 0 ? p.validadeDias : 15,
    condicoes: p.condicoes ?? '',
    rodape: p.rodape ?? ''
  };
}

function mudou() {
  if (!sessao) return false;
  return CAMPOS.some(k => String(sessao.rascunho[k]) !== String(sessao.original[k]));
}

/* ============================================================
   4. Montar / desmontar
   ============================================================ */
export function montar(el, ctx) {
  const { estado } = ctx;
  const perfilVazio = !estado.perfil?.empresa && !estado.perfil?.logo && !estado.perfil?.pix;
  const guiaPedida = ctx.params?.guia === true;
  const modo = guiaPedida || (estado.perfil?.guiaFeito !== true && perfilVazio) ? 'guia' : 'normal';

  const original = valoresDe(estado);
  let rascunho = { ...original };
  if (guardado && guardado.uid === estado.uid) {
    rascunho = { ...guardado.rascunho };
  }
  const voltarDoGuardado = !!guardado;
  guardado = null;

  sessao = {
    ctx, el, original, rascunho,
    modo: voltarDoGuardado ? 'normal' : modo,
    guiaPedida,
    passo: 0,
    descartar: false,
    salvando: false
  };

  el.classList.add('pf-tela');
  sessao.aoClicar = aoClicarFora;
  sessao.aoFechar = aoFecharJanela;
  document.addEventListener('click', sessao.aoClicar, true);
  window.addEventListener('beforeunload', sessao.aoFechar);

  desenhar();
}

export function desmontar() {
  if (!sessao) return;
  const s = sessao;
  document.removeEventListener('click', s.aoClicar, true);
  window.removeEventListener('beforeunload', s.aoFechar);
  document.querySelector('.pf-barra')?.remove();
  // Saiu pelo botão Voltar do aparelho (ou outro caminho sem clique) com alteração não salva.
  if (mudou() && !s.descartar) {
    if (!confirm('Você tem alterações não salvas no Perfil. Sair sem salvar?')) {
      guardado = { uid: s.ctx.estado.uid, rascunho: { ...s.rascunho } };
      const ir = s.ctx.ir;
      setTimeout(() => ir('perfil'), 0);
    }
  }
  sessao = null;
}

/** Clique em link/menu que troca de tela: pergunta antes se há alteração. */
function aoClicarFora(e) {
  if (!sessao || !mudou()) return;
  const a = e.target.closest?.('a[href^="#"]');
  if (!a) return;
  if (a.getAttribute('href') === '#perfil') return;
  if (confirm('Você tem alterações não salvas. Sair sem salvar?')) {
    sessao.descartar = true;
  } else {
    e.preventDefault();
    e.stopPropagation();
  }
}

function aoFecharJanela(e) {
  if (sessao && mudou()) { e.preventDefault(); e.returnValue = ''; }
}

/** Nossos botões que saem da tela (Falar com a equipe, Sair). */
function podeSair() {
  if (!mudou()) return true;
  if (confirm('Você tem alterações não salvas. Sair sem salvar?')) {
    sessao.descartar = true;
    return true;
  }
  return false;
}

function desenhar() {
  if (!sessao) return;
  document.querySelector('.pf-barra')?.remove();
  if (sessao.modo === 'guia') desenharGuia();
  else desenharNormal();
}

/* ============================================================
   5. Pedaços de HTML (usados nos dois modos)
   ============================================================ */
/* 1.1.0: botões que marcam e desmarcam (pelo menos 1). */
function htmlModalidades(esc) {
  const sel = sessao.rascunho.especialidades;
  return '<div class="pf-modal" role="group" aria-label="Profissões">' +
    PROFISSOES.map(([k, ic, n]) => {
      const on = sel.includes(k);
      return '<button type="button" class="pf-op' + (on ? ' on' : '') + (k === 'reparos' ? ' pf-op-largo' : '') + '" ' +
        'aria-pressed="' + on + '" data-esp="' + k + '">' +
        '<span aria-hidden="true">' + ic + '</span>' + esc(n) + '</button>';
    }).join('') +
    '</div>';
}

/** "🎨 Pintor · Pedreiro" (ícone da principal). */
function textoProfissoes(lista) {
  const p = PROFISSOES.find(x => x[0] === lista[0]) || PROFISSOES[0];
  return p[1] + ' ' + nomesProfissoes(lista);
}

function htmlLogo(esc) {
  const logo = sessao.rascunho.logo;
  return '<div class="pf-logo-box">' +
    '<div class="pf-logo-previa' + (logo ? ' com' : '') + '">' +
      (logo ? '<img src="' + esc(logo) + '" alt="Sua logo">' : '<span aria-hidden="true">🖼️</span>') +
    '</div>' +
    '<div class="pf-logo-acoes">' +
      '<label class="big pf-logo-btn"><input class="pf-arquivo js-arquivo" type="file" accept="image/*">' +
        '<span aria-hidden="true">📷</span> ' + (logo ? 'Trocar logo' : 'Escolher logo') + '</label>' +
      (logo ? '<button type="button" class="big pf-remover js-remover-logo">🗑️ Remover logo</button>' : '') +
      '<p class="campo-ajuda js-logo-info">' + (logo
        ? 'Logo pronta (' + Math.round(logo.length / 1024) + ' KB).'
        : 'Foto da câmera ou imagem da galeria. O app ajusta o tamanho sozinho.') + '</p>' +
    '</div>' +
  '</div>';
}

function campoTexto(id, rotulo, valor, extra, esc, ajuda) {
  return '<div class="campo"><label for="' + id + '">' + rotulo + '</label>' +
    '<input id="' + id + '" value="' + esc(valor) + '" ' + extra + '>' +
    (ajuda ? '<p class="campo-ajuda">' + ajuda + '</p>' : '') + '</div>';
}

function htmlEmpresa(esc) {
  const r = sessao.rascunho;
  return campoTexto('pf-empresa', 'Nome da empresa ou o seu nome', r.empresa,
      'data-campo="empresa" maxlength="80" autocomplete="organization" placeholder="Ex.: Silva Pinturas"', esc,
      'Aparece no alto dos seus orçamentos.');
}
function htmlTelefone(esc) {
  return campoTexto('pf-telefone', 'WhatsApp / telefone', formatarTelefone(sessao.rascunho.telefone),
    'data-campo="telefone" type="tel" inputmode="numeric" autocomplete="tel" placeholder="(17) 99123-4567"', esc);
}
function htmlPix(esc) {
  return campoTexto('pf-pix', 'Chave PIX', sessao.rascunho.pix,
    'data-campo="pix" maxlength="100" autocapitalize="off" spellcheck="false" placeholder="CPF, e-mail, celular ou chave aleatória"', esc,
    'Sai no orçamento para o cliente pagar.');
}

/* ============================================================
   6. Modo guia (primeira entrada)
   ============================================================ */
function desenharGuia() {
  const { el, ctx } = sessao;
  const { esc } = ctx.utils;
  const n = sessao.passo;
  const ultimo = n === PASSOS.length - 1;

  const titulos = [
    ['Vamos deixar seus orçamentos com a sua cara', 'Leva 1 minuto. Dá para mudar depois no Perfil.'],
    ['Sua logo', 'Ela vai no PDF do orçamento e no topo do app.'],
    ['Contato e PIX', 'Para o cliente falar com você e pagar.']
  ];
  let corpo = '';
  if (n === 0) corpo = htmlEmpresa(esc) + '<p class="rotulo">Você trabalha como <span class="muted">(pode marcar mais de uma)</span></p>' + htmlModalidades(esc);
  if (n === 1) corpo = htmlLogo(esc);
  if (n === 2) corpo = htmlTelefone(esc) + htmlPix(esc);

  el.innerHTML =
    '<div class="top">' +
      '<div class="dots" aria-label="Passo ' + (n + 1) + ' de 3">' +
        PASSOS.map((_, i) => '<i class="' + (i <= n ? 'on' : '') + '"></i>').join('') + '</div>' +
      '<button type="button" class="link-btn pf-pular-tudo js-pular-tudo">Pular tudo</button>' +
    '</div>' +
    '<p class="muted pf-passo">Passo ' + (n + 1) + ' de 3</p>' +
    '<h1>' + esc(titulos[n][0]) + '</h1>' +
    '<p class="muted">' + esc(titulos[n][1]) + '</p>' +
    '<div class="pf-guia-corpo">' + corpo + '</div>' +
    '<button type="button" class="big primary js-continuar">' + (ultimo ? '✓ Concluir' : 'Continuar') + '</button>' +
    '<button type="button" class="big pf-pular js-pular">Pular este passo</button>';

  ligarCampos(el);
  el.querySelector('.js-continuar').addEventListener('click', () => avancarGuia(true));
  el.querySelector('.js-pular').addEventListener('click', () => avancarGuia(false));
  el.querySelector('.js-pular-tudo').addEventListener('click', () => terminarGuia());
  el.querySelector('input:not([type=file])')?.focus({ preventScroll: true });
}

function avancarGuia(gravar) {
  const s = sessao;
  const campos = PASSOS[s.passo].campos;
  if (gravar) {
    if (!validar(campos)) return;
    if (campos.some(k => String(s.rascunho[k]) !== String(s.original[k]))) salvar(campos, false, true);
  } else {
    campos.forEach(k => { s.rascunho[k] = s.original[k]; });
  }
  if (s.passo < PASSOS.length - 1) {
    s.passo++;
    desenhar();
    window.scrollTo(0, 0);
  } else {
    terminarGuia();
  }
}

function terminarGuia() {
  const s = sessao;
  // Pular tudo: o que não foi gravado volta ao que era.
  CAMPOS.forEach(k => { s.rascunho[k] = s.original[k]; });
  salvar([], true, true);
  if (s.guiaPedida) {
    s.ctx.toast('Perfil pronto! Dá para mudar quando quiser.', 'ok');
    s.ctx.ir('inicio');
  } else {
    s.ctx.toast('Perfil pronto! Confira o resto aqui embaixo.', 'ok');
    s.modo = 'normal';
    desenhar();
    window.scrollTo(0, 0);
  }
}

/* ============================================================
   7. Modo normal
   ============================================================ */
function desenharNormal() {
  const { el, ctx } = sessao;
  const { esc } = ctx.utils;
  const r = sessao.rascunho;
  const u = ctx.estado.usuario || {};
  const email = u.email || ctx.auth.currentUser?.email || '';
  const plano = ctx.estado.planoEfetivo === 'pro' ? 'Pro' : 'Free';
  const tema = lerTema();
  const corLivre = !CORES.some(c => c[0] === r.corPrincipal);

  el.innerHTML =
    // Cabeçalho
    '<div class="pf-cab">' +
      '<div class="pf-cab-logo' + (r.logo ? ' com' : '') + '">' +
        (r.logo ? '<img src="' + esc(r.logo) + '" alt="">' : esc((r.empresa || u.nome || 'P').trim().charAt(0).toUpperCase() || 'P')) +
      '</div>' +
      '<div class="pf-cab-txt"><b>' + esc(r.empresa || u.nome || 'Seu perfil') + '</b>' +
        '<span class="muted">' + esc(email) + '</span>' +
        '<span class="pf-cab-mod">' + esc(textoProfissoes(r.especialidades)) + '</span></div>' +
    '</div>' +

    // Minha empresa
    '<details class="card pf-secao" open>' +
      '<summary class="pf-sum"><span aria-hidden="true">🏢</span> Minha empresa</summary>' +
      '<div class="pf-corpo">' +
        '<p class="rotulo">Logo</p>' + htmlLogo(esc) +
        htmlEmpresa(esc) +
        '<p class="rotulo">Profissões <span class="muted">(pode marcar mais de uma)</span></p>' + htmlModalidades(esc) +
        campoTexto('pf-doc', 'CPF ou CNPJ (opcional)', formatarDocumento(r.documento),
          'data-campo="documento" inputmode="numeric" placeholder="000.000.000-00"', esc) +
        htmlTelefone(esc) +
        campoTexto('pf-cidade', 'Cidade', r.cidade,
          'data-campo="cidade" maxlength="60" autocomplete="address-level2" placeholder="Ex.: São José do Rio Preto"', esc) +
        htmlPix(esc) +
      '</div>' +
    '</details>' +

    // Orçamento e PDF
    '<details class="card pf-secao">' +
      '<summary class="pf-sum"><span aria-hidden="true">📄</span> Orçamento e PDF</summary>' +
      '<div class="pf-corpo">' +
        '<p class="rotulo">Cor principal</p>' +
        '<div class="pf-cores" role="radiogroup" aria-label="Cor principal">' +
          CORES.map(([c, n]) =>
            '<button type="button" role="radio" class="pf-cor' + (r.corPrincipal === c ? ' on' : '') + '" ' +
            'aria-checked="' + (r.corPrincipal === c) + '" aria-label="' + n + '" data-cor="' + c + '" ' +
            'style="--pf-c:' + c + '"></button>').join('') +
        '</div>' +
        '<label class="pf-cor-livre' + (corLivre ? ' on' : '') + '">' +
          '<input type="color" class="js-cor-livre" value="' + esc(r.corPrincipal) + '">' +
          '<span>Outra cor' + (corLivre ? ' (' + esc(r.corPrincipal) + ')' : '') + '</span></label>' +

        '<p class="rotulo">Modelo de PDF padrão</p>' +
        '<div class="pf-modelos" role="radiogroup" aria-label="Modelo de PDF" style="--pf-c:' + esc(r.corPrincipal) + '">' +
          MODELOS.map(([k, n, d]) =>
            '<button type="button" role="radio" class="pf-modelo' + (r.modeloPdf === k ? ' on' : '') + '" ' +
            'aria-checked="' + (r.modeloPdf === k) + '" data-modelo="' + k + '">' +
              '<span class="pf-mini pf-mini-' + k + '" aria-hidden="true">' +
                '<i class="a"></i><i class="b"></i><i class="c"></i><i class="c"></i><i class="d"></i>' +
              '</span>' +
              '<b>' + n + '</b><small>' + d + '</small>' +
            '</button>').join('') +
        '</div>' +
        '<p class="campo-ajuda">Você ainda pode trocar o modelo em cada orçamento.</p>' +

        campoTexto('pf-validade', 'Validade do orçamento (dias)', r.validadeDias,
          'data-campo="validadeDias" type="number" inputmode="numeric" min="1" max="365" step="1"', esc) +
        '<div class="campo"><label for="pf-condicoes">Condições de pagamento (opcional)</label>' +
          '<textarea id="pf-condicoes" class="pf-texto-curto" data-campo="condicoes" maxlength="300" ' +
          'placeholder="Ex.: 50% na entrada e 50% na entrega. PIX ou dinheiro.">' + esc(r.condicoes) + '</textarea></div>' +
        '<div class="campo"><label for="pf-rodape">Rodapé do PDF (opcional)</label>' +
          '<textarea id="pf-rodape" class="pf-texto-curto" data-campo="rodape" maxlength="150" ' +
          'placeholder="Ex.: Obrigado pela preferência!">' + esc(r.rodape) + '</textarea></div>' +
      '</div>' +
    '</details>' +

    // Conta
    '<details class="card pf-secao">' +
      '<summary class="pf-sum"><span aria-hidden="true">⚙️</span> Conta</summary>' +
      '<div class="pf-corpo">' +
        '<p class="rotulo">Tema da tela</p>' +
        '<div class="seg tres" role="radiogroup" aria-label="Tema">' +
          [['auto', 'Automático'], ['claro', 'Claro'], ['escuro', 'Escuro']].map(([k, n]) =>
            '<button type="button" role="radio" class="' + (tema === k ? 'on' : '') + '" ' +
            'aria-checked="' + (tema === k) + '" data-tema="' + k + '">' + n + '</button>').join('') +
        '</div>' +
        '<button class="big js-contato" type="button" style="margin-top:14px">💬 Falar com a equipe</button>' +
        '<button class="big js-sair" type="button">↩️ Sair</button>' +
        '<p class="pf-plano muted">Plano: ' + plano + '</p>' +
      '</div>' +
    '</details>' +

    rodapeLegal();

  // Botão Salvar fixo (fora da seção, para ficar acima do menu)
  const barra = document.createElement('div');
  barra.className = 'bar pf-barra';
  barra.innerHTML = '<button type="button" class="big primary js-salvar"></button>';
  document.querySelector('.js-conteudo')?.appendChild(barra);
  barra.querySelector('.js-salvar').addEventListener('click', () => {
    if (!validar(CAMPOS)) return;
    salvar(CAMPOS, false);
  });
  atualizarBotao();

  ligarCampos(el);

  el.querySelectorAll('[data-cor]').forEach(b => b.addEventListener('click', () => {
    sessao.rascunho.corPrincipal = b.dataset.cor;
    redesenharMantendoRolagem();
  }));
  el.querySelector('.js-cor-livre').addEventListener('change', e => {
    if (corValida(e.target.value)) {
      sessao.rascunho.corPrincipal = e.target.value.toLowerCase();
      redesenharMantendoRolagem();
    }
  });
  el.querySelectorAll('[data-modelo]').forEach(b => b.addEventListener('click', () => {
    sessao.rascunho.modeloPdf = b.dataset.modelo;
    redesenharMantendoRolagem();
  }));
  el.querySelectorAll('[data-tema]').forEach(b => b.addEventListener('click', () => {
    aplicarTema(b.dataset.tema);
    el.querySelectorAll('[data-tema]').forEach(x => {
      const on = x === b;
      x.classList.toggle('on', on);
      x.setAttribute('aria-checked', String(on));
    });
    ctx.toast(TEMAS[b.dataset.tema]);
  }));
  el.querySelector('.js-contato').addEventListener('click', () => {
    if (podeSair()) ctx.ir('contato', { de: 'perfil' });
  });
  const bSair = el.querySelector('.js-sair');
  bSair.addEventListener('click', async () => {
    if (!podeSair()) return;
    bSair.disabled = true;
    await sair(ctx);
    bSair.disabled = false;
  });
}

/** Redesenha a tela sem perder as seções abertas nem a posição da rolagem. */
function redesenharMantendoRolagem() {
  if (!sessao) return;
  const el = sessao.el;
  const abertas = [...el.querySelectorAll('details.pf-secao')].map(d => d.open);
  const y = window.scrollY;
  desenhar();
  if (sessao.modo === 'normal') {
    el.querySelectorAll('details.pf-secao').forEach((d, i) => { if (abertas[i] !== undefined) d.open = abertas[i]; });
    window.scrollTo(0, y);
  }
}

function atualizarBotao() {
  const b = document.querySelector('.pf-barra .js-salvar');
  if (!b || !sessao) return;
  const m = mudou();
  b.disabled = !m || sessao.salvando;
  b.textContent = sessao.salvando ? 'Salvando…' : m ? '💾 Salvar' : '✓ Tudo salvo';
}

/* ============================================================
   8. Campos: digitação, máscaras, modalidade e logo
   ============================================================ */
function ligarCampos(el) {
  const s = sessao;
  el.querySelectorAll('[data-campo]').forEach(inp => {
    inp.addEventListener('input', () => {
      const k = inp.dataset.campo;
      inp.classList.remove('pf-erro');
      if (k === 'telefone') {
        inp.value = formatarTelefone(inp.value);
        s.rascunho.telefone = soDigitos(inp.value);
      } else if (k === 'documento') {
        inp.value = formatarDocumento(inp.value);
        s.rascunho.documento = inp.value;
      } else if (k === 'validadeDias') {
        const n = parseInt(inp.value, 10);
        s.rascunho.validadeDias = Number.isFinite(n) ? n : '';
      } else {
        s.rascunho[k] = inp.value;
      }
      atualizarBotao();
    });
  });

  // 1.1.0: marca e desmarca; a primeira marcada é a principal; nunca fica vazia.
  el.querySelectorAll('[data-esp]').forEach(b => b.addEventListener('click', () => {
    const k = b.dataset.esp;
    const lista = s.rascunho.especialidades;
    if (lista.includes(k)) {
      if (lista.length === 1) { s.ctx.toast('Deixe pelo menos uma profissão marcada.', 'erro'); return; }
      s.rascunho.especialidades = lista.filter(x => x !== k);
    } else {
      s.rascunho.especialidades = [...lista, k];
    }
    const on = s.rascunho.especialidades.includes(k);
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
    const cab = el.querySelector('.pf-cab-mod');
    if (cab) cab.textContent = textoProfissoes(s.rascunho.especialidades);
    atualizarBotao();
  }));

  const arq = el.querySelector('.js-arquivo');
  if (arq) arq.addEventListener('change', async () => {
    const file = arq.files && arq.files[0];
    arq.value = '';
    if (!file) return;
    const info = el.querySelector('.js-logo-info');
    if (info) info.textContent = 'Preparando a logo…';
    try {
      const { url } = await reduzirLogo(file);
      if (!sessao) return;
      sessao.rascunho.logo = url;
      redesenharMantendoRolagem();
      sessao?.ctx.toast(sessao.modo === 'guia' ? 'Logo pronta!' : 'Logo pronta! Toque em Salvar.', 'ok');
    } catch (e) {
      if (info) info.textContent = e.message;
      sessao?.ctx.toast(e.message, 'erro');
    }
  });

  el.querySelector('.js-remover-logo')?.addEventListener('click', () => {
    s.rascunho.logo = '';
    redesenharMantendoRolagem();
  });
}

/* ============================================================
   9. Validação e gravação
   ============================================================ */
function marcarErro(campo, msg) {
  const inp = sessao.el.querySelector('[data-campo="' + campo + '"]');
  if (inp) {
    inp.classList.add('pf-erro');
    const det = inp.closest('details');
    if (det) det.open = true;
    inp.focus();
  }
  sessao.ctx.toast(msg, 'erro');
  return false;
}

function validar(campos) {
  const r = sessao.rascunho;
  if (campos.includes('especialidades') && !r.especialidades.length) { // 1.1.0
    sessao.ctx.toast('Marque pelo menos uma profissão.', 'erro');
    return false;
  }
  if (campos.includes('telefone')) {
    const n = soDigitos(r.telefone).length;
    if (n && n !== 10 && n !== 11) return marcarErro('telefone', 'Telefone com DDD: 10 ou 11 números.');
  }
  if (campos.includes('documento')) {
    const n = soDigitos(r.documento).length;
    if (n && n !== 11 && n !== 14) return marcarErro('documento', 'CPF tem 11 números e CNPJ tem 14.');
  }
  if (campos.includes('validadeDias')) {
    const v = r.validadeDias;
    if (!Number.isInteger(v) || v < 1 || v > 365) return marcarErro('validadeDias', 'Validade: de 1 a 365 dias.');
  }
  return true;
}

/** Valor limpo de cada campo para gravar. */
function valorParaGravar(k, v) {
  if (k === 'especialidades') { const l = lerEspecialidades({ especialidades: v }); return l; } // 1.1.0
  if (k === 'telefone') return soDigitos(v);
  if (k === 'validadeDias') return Number.isInteger(v) ? v : 15;
  if (k === 'logo') return logoValida(v) ? v : '';
  if (k === 'corPrincipal') return corValida(v) ? v.toLowerCase() : COR_PADRAO;
  return String(v ?? '').trim();
}

/**
 * Grava os campos pedidos em users/{uid}. Não espera o servidor:
 * a tela atualiza na hora e o Firestore envia quando tiver internet.
 * guiaFeito: grava perfil.guiaFeito = true junto.
 * silencioso: não mostra o toast de "salvo" (usado no fim da guia).
 */
function salvar(campos, guiaFeito, silencioso) {
  const s = sessao;
  const { ctx } = s;
  if (!ctx.estado.uid) return;

  const dados = {};
  const novoPerfil = {};
  campos.forEach(k => {
    const v = valorParaGravar(k, s.rascunho[k]);
    if (k === 'especialidades') { dados.especialidades = v; dados.especialidade = v[0]; } // 1.1.0: + a principal
    else { dados['perfil.' + k] = v; novoPerfil[k] = v; }
    s.rascunho[k] = v;
  });
  if (guiaFeito) { dados['perfil.guiaFeito'] = true; novoPerfil.guiaFeito = true; }
  dados['perfil.atualizadoEm'] = fs.serverTimestamp();

  const anterior = { ...s.original };
  campos.forEach(k => { s.original[k] = s.rascunho[k]; });

  // Atualiza o estado local na hora (o recarregarUsuario confirma depois).
  ctx.estado.perfil = { ...(ctx.estado.perfil || {}), ...novoPerfil };
  if (ctx.estado.usuario) {
    ctx.estado.usuario.perfil = ctx.estado.perfil;
    if (dados.especialidades) { // 1.1.0
      ctx.estado.usuario.especialidades = dados.especialidades;
      ctx.estado.usuario.especialidade = dados.especialidade;
    }
  }

  const promessa = fs.updateDoc(fs.doc(db, 'users', ctx.estado.uid), dados);
  s.salvando = true;
  atualizarBotao();

  comPrazo(promessa, 2500).then(r => {
    if (sessao === s) { s.salvando = false; atualizarBotao(); }
    if (!silencioso) {
      if (r === 'ok') ctx.toast('Perfil salvo!', 'ok');
      else ctx.toast(navigator.onLine ? 'Salvo. Enviando…' : 'Salvo no aparelho, envia quando tiver internet.', 'ok');
    }
    ctx.recarregarUsuario(); // atualiza a logo do topo
  });

  promessa.catch(e => {
    console.error('[Print] salvar perfil', e);
    ctx.toast(ctx.utils.traduzErro(e), 'erro');
    if (sessao === s) {
      campos.forEach(k => { s.original[k] = anterior[k]; });
      s.salvando = false;
      atualizarBotao();
    }
  });
}
