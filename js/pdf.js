/*
  Arquivo: js/pdf.js
  Versão: 1.0.0
  Sessão: 7 — PDF (3 modelos)
  Data: 15/10/2026
  Gera o PDF do orçamento em A4, desenhado direto com o jsPDF (sem captura de
  tela), e entrega: no celular abre o menu de compartilhar (WhatsApp, e-mail…);
  no computador baixa e abre numa aba nova. Depois pergunta "Marcar como Enviado?".

  Contrato: gerarPdf({ orcamento, perfil, usuario }) -> Promise.
            Em erro, lança o erro (a tela Orçamento mostra em toast).
  Modelos:  classico (serifa, azul-marinho) · moderno (faixa na cor do pintor)
            · premium (cabeçalho e rodapé escuros com dourado, miolo claro).
            Escolha: orcamento.modeloPdf, senão perfil.modeloPdf, senão classico.
  Contas:   iguais às da tela (relatório da S6, item 7). Subtotal e total vêm prontos
            do orçamento; valor da linha = cobr 'fechado' ? preco : qtd × preco;
            valor da fase = valorFechado (modo 'fechado') ou soma das linhas.
  Banco:    "Sim" na folha grava status 'enviado' e atualizadoEm em
            users/{uid}/orcamentos/{id} (updateDoc, sem esperar o servidor).
  Biblioteca: jsPDF 4.2.1 (versão fixa), pela CDN jsDelivr (reserva: unpkg),
            carregada só na primeira vez que gera PDF.
  CSS:      css/pdf.css (folhas), injetado por este módulo.

  Funções que podem ir para o utils.js na Sessão 10:
    formatarFone (só dígitos -> "(17) 99999-9999"), semAcento, winAnsi
*/

import { auth, db, fs } from './firebase.js';
import { moeda, num, paraData, dataBR, traduzErro } from './utils.js';
import { toast } from './app.js';

/* ============================================================
   1. Biblioteca e CSS (carregados só uma vez)
   ============================================================ */
const VERSAO_JSPDF = '4.2.1';
const URLS_JSPDF = [
  'https://cdn.jsdelivr.net/npm/jspdf@' + VERSAO_JSPDF + '/dist/jspdf.umd.min.js',
  'https://unpkg.com/jspdf@' + VERSAO_JSPDF + '/dist/jspdf.umd.min.js'
];
let promessaJsPdf = null;

function carregarScript(url) {
  return new Promise((ok, falha) => {
    const s = document.createElement('script');
    s.src = url;
    s.async = true;
    s.crossOrigin = 'anonymous';
    s.onload = () => ok();
    s.onerror = () => { s.remove(); falha(new Error('Sem internet para carregar o gerador de PDF. Tente de novo com sinal.')); };
    document.head.appendChild(s);
  });
}

function carregarJsPdf() {
  if (window.jspdf?.jsPDF) return Promise.resolve(window.jspdf.jsPDF);
  if (!promessaJsPdf) {
    promessaJsPdf = (async () => {
      let erro;
      for (const url of URLS_JSPDF) {
        try {
          await carregarScript(url);
          if (window.jspdf?.jsPDF) return window.jspdf.jsPDF;
        } catch (e) { erro = e; }
      }
      throw erro || new Error('Não deu para carregar o gerador de PDF.');
    })();
    promessaJsPdf.catch(() => { promessaJsPdf = null; }); // deixa tentar de novo depois
  }
  return promessaJsPdf;
}

function garantirCss() {
  if (document.querySelector('link[data-pdf-css]')) return;
  const l = document.createElement('link');
  l.rel = 'stylesheet';
  l.href = './css/pdf.css';
  l.dataset.pdfCss = '1';
  document.head.appendChild(l);
}

/* ============================================================
   2. Texto: acentos, telefone, nomes
   ============================================================ */
// Caracteres que as fontes padrão do PDF (Helvetica e Times) sabem desenhar.
const EXTRAS_WINANSI = '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ';

/** Deixa só o que a fonte do PDF desenha (tira emoji e símbolos raros). */
export function winAnsi(s) {
  let r = '';
  for (const ch of String(s ?? '').normalize('NFC').replace(/\r\n?/g, '\n').replace(/\t/g, ' ')) {
    const c = ch.codePointAt(0);
    if (ch === '\n' || (c >= 0x20 && c <= 0x7e) || (c >= 0xa0 && c <= 0xff) || EXTRAS_WINANSI.includes(ch)) r += ch;
    else if (c === 0x2212) r += '-';
  }
  return r.replace(/[ ]{2,}/g, ' ');
}

/** "José Antônio" -> "Jose Antonio" */
export function semAcento(s) {
  return String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/** Só dígitos -> "(17) 99999-9999" ou "(17) 3333-3333". Tira o 55 do Brasil. */
export function formatarFone(v) {
  let d = String(v ?? '').replace(/\D/g, '');
  if (d.length > 11 && d.startsWith('55')) d = d.slice(2);
  if (d.length === 11) return '(' + d.slice(0, 2) + ') ' + d.slice(2, 7) + '-' + d.slice(7);
  if (d.length === 10) return '(' + d.slice(0, 2) + ') ' + d.slice(2, 6) + '-' + d.slice(6);
  return d ? String(v).trim() : '';
}

/** "Orcamento-12-Jose.pdf" */
function nomeArquivo(o) {
  const primeiro = semAcento(String(o.clienteNome || '').trim().split(/\s+/)[0] || 'cliente').replace(/[^A-Za-z0-9]/g, '') || 'cliente';
  const n = String(o.numero ?? '').replace(/[^0-9A-Za-z]/g, '') || 'sn';
  return 'Orcamento-' + n + '-' + primeiro + '.pdf';
}

const fmtQtd = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 2 });

/* ============================================================
   3. Cores e modelos
   ============================================================ */
const MODELOS = ['classico', 'moderno', 'premium'];
const COR_PADRAO = '#2447d6';

function hexRgb(h) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(h || '').trim());
  const x = m ? m[1] : COR_PADRAO.slice(1);
  return [parseInt(x.slice(0, 2), 16), parseInt(x.slice(2, 4), 16), parseInt(x.slice(4, 6), 16)];
}
/** Mistura a cor com branco (p = 0 cor pura, 1 branco). */
const clarear = (c, p) => c.map(v => Math.round(v + (255 - v) * p));
const escurecer = (c, p) => c.map(v => Math.round(v * (1 - p)));
/** Cor clara demais para texto branco por cima? */
function ehClara([r, g, b]) {
  const l = x => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * l(r) + 0.7152 * l(g) + 0.0722 * l(b) > 0.45;
}

function tema(modelo, perfil) {
  if (modelo === 'moderno') {
    const cor = hexRgb(perfil.corPrincipal || COR_PADRAO);
    const clara = ehClara(cor);
    return {
      nome: 'moderno', fonte: 'helvetica',
      ink: [23, 32, 51], muted: [102, 112, 133], line: [221, 227, 238],
      acc: clara ? escurecer(cor, 0.45) : cor,   // títulos e cabeçalho da tabela
      faixa: cor, sobreFaixa: clara ? [23, 32, 51] : [255, 255, 255],
      zebra: clarear(cor, 0.93)
    };
  }
  if (modelo === 'premium') {
    return {
      nome: 'premium', fonte: 'helvetica',
      ink: [42, 42, 42], muted: [112, 106, 96], line: [228, 221, 205],
      acc: [150, 117, 42],                       // dourado escuro (lê bem no papel branco)
      ouro: [201, 162, 75], escuro: [29, 29, 31], creme: [240, 236, 226],
      zebra: null
    };
  }
  return {
    nome: 'classico', fonte: 'times',
    ink: [27, 27, 27], muted: [96, 96, 96], line: [214, 218, 228],
    acc: [28, 43, 90], zebra: null
  };
}

/* ============================================================
   4. Logo (data URL JPEG ou PNG) com a proporção certa
   ============================================================ */
async function lerLogo(dataUrl, maxW, maxH) {
  const m = /^data:image\/(png|jpe?g);base64,/i.exec(String(dataUrl || ''));
  if (!m) return null;
  try {
    const img = new Image();
    img.src = dataUrl;
    if (img.decode) await img.decode();
    else await new Promise((ok, f) => { img.onload = ok; img.onerror = f; });
    const iw = img.naturalWidth, ih = img.naturalHeight;
    if (!iw || !ih) return null;
    let h = maxH, w = h * iw / ih;
    if (w > maxW) { w = maxW; h = w * ih / iw; }
    return { data: dataUrl, fmt: m[1].toLowerCase() === 'png' ? 'PNG' : 'JPEG', w, h };
  } catch (e) {
    console.warn('[Print] logo não pôde ser lida', e);
    return null;
  }
}

/* ============================================================
   5. Montagem do PDF
   ============================================================ */
const W = 210, H = 297, M = 16, CW = W - 2 * M;
const PT = 0.3528;                       // 1 ponto em mm
const alt = (size, f = 1.28) => size * PT * f; // altura de uma linha

async function montarPdf(JsPDF, o, perfil, usuario) {
  const modelo = MODELOS.includes(o.modeloPdf) ? o.modeloPdf : (MODELOS.includes(perfil.modeloPdf) ? perfil.modeloPdf : 'classico');
  const T = tema(modelo, perfil);
  const doc = new JsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait', compress: true });
  const LIM = modelo === 'premium' ? H - 20 : H - 15; // onde o conteúdo para (rodapé da página embaixo)

  /* ---------- dados ---------- */
  const empresa = winAnsi(String(perfil.empresa || '').trim() || String(usuario.nome || '').trim());
  const docDig = String(perfil.documento || '').replace(/\D/g, '');
  const documento = perfil.documento ? (docDig.length === 14 ? 'CNPJ ' : docDig.length === 11 ? 'CPF ' : '') + perfil.documento : '';
  const fone = formatarFone(perfil.telefone || usuario.whatsapp);
  const cidade = String(perfil.cidade || usuario.cidade || '').trim();
  const partesContato = [documento, fone, cidade].filter(Boolean).map(winAnsi);
  const contato = partesContato.join('  ·  ');
  const criado = paraData(o.criadoEm) || new Date();
  const numero = o.numero != null && o.numero !== '' ? String(o.numero) : '';
  const meta = winAnsi((numero ? 'Nº ' + numero + '  ·  ' : '') + dataBR(criado));
  const valDias = Math.round(num(o.validadeDias)) || Math.round(num(perfil.validadeDias)) || 15;
  const validoAte = new Date(criado.getFullYear(), criado.getMonth(), criado.getDate() + valDias);
  const logo = await lerLogo(perfil.logo, 50, 18);

  const areas = o.areas || {};
  const ativas = ['int', 'ext'].filter(a => areas[a]?.ativo);
  const itens = Array.isArray(o.itens) ? o.itens : [];
  const vLinha = it => it.cobr === 'fechado' ? num(it.preco) : num(it.qtd) * num(it.preco);
  const vFase = a => areas[a].modo === 'fechado' ? num(areas[a].valorFechado) : itens.filter(i => i.area === a).reduce((s, i) => s + vLinha(i), 0);
  const subtotal = num(o.subtotal);
  const total = num(o.total);
  const descPct = Math.min(100, Math.max(0, num(o.descontoPct)));
  const NOME_AREA = { int: 'Serviço interno', ext: 'Serviço externo' };

  /* ---------- desenho básico ---------- */
  let y = M;
  const cor = c => { doc.setTextColor(c[0], c[1], c[2]); };
  const fonte = (size, estilo = 'normal', f = T.fonte) => { doc.setFont(f, estilo); doc.setFontSize(size); };
  const larg = (s, cs = 0) => doc.getTextWidth(s) + cs * Math.max(0, s.length - 1);
  /** Escreve uma linha. align: left | right | center. cs = espaço entre letras. */
  function linha(s, x, yy, { align = 'left', cs = 0 } = {}) {
    s = winAnsi(s);
    if (!s) return;
    let xx = x;
    if (align === 'right') xx = x - larg(s, cs);
    else if (align === 'center') xx = x - larg(s, cs) / 2;
    doc.text(s, xx, yy, cs ? { charSpace: cs } : undefined);
  }
  const quebrar = (s, w) => doc.splitTextToSize(winAnsi(s), w);
  /** Quebra o contato só entre as partes (o telefone nunca parte no meio). */
  function quebrarPartes(partes, w) {
    const ls = [];
    for (const p of partes) {
      const t = ls.length ? ls[ls.length - 1] + '  ·  ' + p : p;
      if (ls.length && larg(t) <= w) ls[ls.length - 1] = t; else ls.push(...(larg(p) <= w ? [p] : quebrar(p, w)));
    }
    return ls;
  }
  function traco(x1, y1, x2, y2, c, w = 0.3) { doc.setDrawColor(c[0], c[1], c[2]); doc.setLineWidth(w); doc.line(x1, y1, x2, y2); }
  function caixa(x, yy, w, h, c, r = 0) {
    doc.setFillColor(c[0], c[1], c[2]);
    if (r) doc.roundedRect(x, yy, w, h, r, r, 'F'); else doc.rect(x, yy, w, h, 'F');
  }
  function imagemLogo(x, yy) {
    try { doc.addImage(logo.data, logo.fmt, x, yy, logo.w, logo.h, 'logo', 'FAST'); }
    catch (e) { console.warn('[Print] logo no PDF', e); }
  }

  /* ---------- cabeçalho da primeira página ---------- */
  function cabClassico() {
    y = 13;
    if (logo) { imagemLogo((W - logo.w) / 2, y); y += logo.h + 4; }
    if (empresa) {
      fonte(15, 'bold'); cor(T.acc);
      for (const l of quebrar(empresa, CW)) { y += alt(15, 0.95); linha(l, W / 2, y, { align: 'center' }); }
      y += 1;
    }
    if (contato) {
      fonte(9.5); cor(T.muted);
      for (const l of quebrarPartes(partesContato, CW)) { y += alt(9.5); linha(l, W / 2, y, { align: 'center' }); }
    }
    y += 8.5;
    fonte(22); cor(T.acc); linha('ORÇAMENTO', W / 2, y, { align: 'center', cs: 1.4 });
    y += 6.5;
    fonte(10.5); cor(T.ink); linha(meta, W / 2, y, { align: 'center' });
    y += 4.5;
    traco(M, y, W - M, y, T.acc, 0.7);
    traco(M, y + 1.2, W - M, y + 1.2, T.acc, 0.25);
    y += 9;
  }

  /** Faixa do Moderno e do Premium: logo num quadrinho claro + empresa à esquerda, título à direita. */
  function cabFaixa({ fundo, txt, txt2, titulo, tituloCor, tituloSize, tituloEstilo, tituloCs, quadro }) {
    const pad = 2.2;
    const logoBox = logo ? { w: logo.w + pad * 2, h: logo.h + pad * 2 } : null;
    const larTit = 62;
    const xTxt = M + (logoBox ? logoBox.w + 6 : 0);
    const wTxt = W - M - larTit - xTxt - 4;
    fonte(14, 'bold');
    const linhasEmp = empresa ? quebrar(empresa, wTxt).slice(0, 2) : [];
    fonte(9);
    const linhasCont = contato ? quebrarPartes(partesContato, wTxt).slice(0, 3) : [];
    const hTxt = linhasEmp.length * alt(14, 0.95) + linhasCont.length * alt(9) + (linhasEmp.length && linhasCont.length ? 1.5 : 0);
    const hb = Math.max(36, (logoBox ? logoBox.h : 0) + 16, hTxt + 16);
    caixa(0, 0, W, hb, fundo);
    if (quadro) caixa(0, hb, W, 0.9, quadro);
    if (logoBox) {
      const ly = (hb - logoBox.h) / 2;
      caixa(M, ly, logoBox.w, logoBox.h, [255, 255, 255], 2);
      imagemLogo(M + pad, ly + pad);
    }
    let ty = (hb - hTxt) / 2;
    fonte(14, 'bold'); cor(txt);
    for (const l of linhasEmp) { ty += alt(14, 0.95); linha(l, xTxt, ty - 0.8); }
    if (linhasEmp.length && linhasCont.length) ty += 1.5;
    fonte(9); cor(txt2);
    for (const l of linhasCont) { ty += alt(9); linha(l, xTxt, ty - 0.8); }
    fonte(tituloSize, tituloEstilo); cor(tituloCor);
    linha(titulo, W - M, hb / 2 - 0.5, { align: 'right', cs: tituloCs });
    fonte(9.5); cor(txt2);
    linha(meta, W - M, hb / 2 + 6, { align: 'right' });
    y = hb + 11;
  }

  function cabecalho() {
    if (T.nome === 'moderno') {
      const s = T.sobreFaixa;
      cabFaixa({ fundo: T.faixa, txt: s, txt2: s, titulo: 'Orçamento', tituloCor: s, tituloSize: 24, tituloEstilo: 'bold', tituloCs: 0 });
    } else if (T.nome === 'premium') {
      cabFaixa({ fundo: T.escuro, txt: T.creme, txt2: [205, 196, 178], titulo: 'ORÇAMENTO', tituloCor: T.ouro, tituloSize: 19, tituloEstilo: 'normal', tituloCs: 1.6, quadro: T.ouro });
    } else cabClassico();
  }

  /** Topo das páginas 2 em diante. */
  function cabContinua() {
    const txt = winAnsi((numero ? 'Orçamento Nº ' + numero : 'Orçamento') + (empresa ? '  ·  ' + empresa : '') + '  ·  continuação');
    if (T.nome === 'moderno') {
      caixa(0, 0, W, 6, T.faixa);
      fonte(9); cor(T.muted); linha(txt, M, 14);
      y = 22;
    } else if (T.nome === 'premium') {
      caixa(0, 0, W, 11, T.escuro); caixa(0, 11, W, 0.7, T.ouro);
      fonte(9); cor(T.creme); linha(txt, M, 7);
      y = 21;
    } else {
      fonte(9.5, 'italic'); cor(T.muted); linha(txt, M, 14);
      traco(M, 16.5, W - M, 16.5, T.acc, 0.4);
      y = 25;
    }
  }

  /** Garante espaço; se não couber, abre página nova (e redesenha o que for preciso). */
  function cabe(h, aoQuebrar) {
    if (y + h <= LIM) return false;
    doc.addPage();
    cabContinua();
    if (aoQuebrar) aoQuebrar();
    return true;
  }

  /* ---------- blocos ---------- */
  function rotulo(s) {
    fonte(8, 'bold'); cor(T.muted);
    linha(s.toUpperCase(), M, y, { cs: 0.5 });
  }

  function blocoCliente() {
    cabe(18);
    rotulo('Cliente');
    y += alt(13, 1.05);
    fonte(13, 'bold'); cor(T.ink);
    for (const l of quebrar(o.clienteNome || 'Cliente', CW)) { linha(l, M, y); y += alt(13, 1.05); }
    const w = formatarFone(o.clienteWhats);
    if (w) { fonte(10); cor(T.muted); linha('WhatsApp ' + w, M, y); y += alt(10); }
    y += 5;
  }

  // Colunas da tabela
  const X_NOME = M + 2, W_NOME = 112, X_QTD = M + 146, X_VAL = W - M - 2;

  function tituloFase(a) {
    cabe(22);
    fonte(12.5, 'bold'); cor(T.acc);
    linha(NOME_AREA[a], M, y);
    y += 2.2;
    traco(M, y, W - M, y, T.acc, T.nome === 'classico' ? 0.5 : 0.35);
    y += 5.5;
  }

  function cabTabela() {
    const h = 7.5;
    if (T.nome === 'premium') caixa(M, y - 5, CW, h, T.escuro);
    fonte(8.5, 'bold'); cor(T.nome === 'premium' ? T.ouro : T.acc);
    linha('SERVIÇO', X_NOME, y, { cs: 0.3 });
    linha('QUANTIDADE', X_QTD, y, { align: 'right', cs: 0.3 });
    linha('VALOR', X_VAL, y, { align: 'right', cs: 0.3 });
    if (T.nome !== 'premium') traco(M, y + 2, W - M, y + 2, T.acc, T.nome === 'classico' ? 0.5 : 0.6);
    y += h - 0.5;
  }

  function fase(a, mostrarSubtotal) {
    tituloFase(a);
    const ar = areas[a];
    if (ar.modo === 'fechado') {
      fonte(9.5);
      const inc = String(ar.inclui || '').trim() ? quebrar('Incluso: ' + String(ar.inclui).trim(), W_NOME + 20) : [];
      cabe(alt(11) + Math.min(inc.length, 3) * alt(9.5) + 4);
      fonte(11, 'bold'); cor(T.ink); linha('Valor fechado, tudo incluso', X_NOME, y);
      linha(moeda(vFase(a)), X_VAL, y, { align: 'right' });
      for (const l of inc) {
        y += alt(9.5);
        cabe(alt(9.5));
        fonte(9.5); cor(T.muted); linha(l, X_NOME, y);
      }
      y += 4;
      traco(M, y - 1.5, W - M, y - 1.5, T.line, 0.25);
      y += 4;
    } else {
      const lista = itens.filter(i => i.area === a);
      cabTabela();
      lista.forEach((it, idx) => {
        fonte(10);
        const ls = quebrar(it.nome || 'Serviço', W_NOME);
        const h = ls.length * alt(10) + 3.2;
        cabe(h, cabTabela);
        if (T.zebra && idx % 2 === 1) caixa(M, y - 4.4, CW, h, T.zebra);
        fonte(10); cor(T.ink);
        let yy = y;
        ls.forEach((l, k) => { linha(l, X_NOME, yy); if (k < ls.length - 1) yy += alt(10); });
        const q = it.cobr === 'fechado' ? 'valor fechado' : fmtQtd.format(num(it.qtd)) + ' ' + (it.un || 'm²');
        cor(it.cobr === 'fechado' ? T.muted : T.ink);
        fonte(it.cobr === 'fechado' ? 9 : 10);
        linha(q, X_QTD, y, { align: 'right' });
        fonte(10); cor(T.ink);
        linha(moeda(vLinha(it)), X_VAL, y, { align: 'right' });
        y += h;
        traco(M, y - 4.4, W - M, y - 4.4, T.line, 0.2);
      });
      if (!lista.length) { cabe(8); fonte(9.5, 'italic'); cor(T.muted); linha('Nenhum serviço nesta parte.', X_NOME, y); y += 7; }
    }
    if (mostrarSubtotal) {
      cabe(9);
      fonte(10.5, 'bold'); cor(T.ink);
      linha('Subtotal ' + NOME_AREA[a].replace('Serviço ', ''), X_NOME, y);
      linha(moeda(vFase(a)), X_VAL, y, { align: 'right' });
      y += 3;
    }
    y += 7;
  }

  function blocoTotal() {
    cabe(descPct ? 34 : 22);
    if (descPct) {
      fonte(10.5); cor(T.muted);
      linha('Subtotal', X_QTD, y, { align: 'right' }); linha(moeda(subtotal), X_VAL, y, { align: 'right' });
      y += alt(10.5) + 1;
      linha('Desconto (' + fmtQtd.format(descPct) + '%)', X_QTD, y, { align: 'right' });
      linha('- ' + moeda(Math.max(0, subtotal - total)), X_VAL, y, { align: 'right' });
      y += 5;
    }
    const valor = moeda(total);
    if (T.nome === 'classico') {
      traco(M + CW / 2, y, W - M, y, T.acc, 0.7);
      traco(M + CW / 2, y + 1.2, W - M, y + 1.2, T.acc, 0.25);
      y += 9;
      fonte(12); cor(T.acc); linha('TOTAL', W - M - 66, y, { cs: 1 });
      fonte(18, 'bold'); linha(valor, X_VAL, y + 0.3, { align: 'right' });
      y += 9;
    } else {
      const h = 15, x = M + CW * 0.38, w = W - M - x;
      caixa(x, y - 1, w, h, T.nome === 'moderno' ? T.faixa : T.escuro, 2.5);
      const c = T.nome === 'moderno' ? T.sobreFaixa : T.ouro;
      fonte(10.5, T.nome === 'moderno' ? 'bold' : 'normal'); cor(c);
      linha(T.nome === 'moderno' ? 'Total' : 'TOTAL', x + 5, y + 8.2, { cs: T.nome === 'premium' ? 1.2 : 0 });
      fonte(18, 'bold'); cor(c);
      linha(valor, x + w - 5, y + 8.8, { align: 'right' });
      y += h + 6;
    }
    const pd = Math.max(0, Math.min(999, Math.round(num(o.prazoDias))));
    if (pd > 0) {
      const t = pd + (pd === 1 ? (o.prazoUteis ? ' dia útil' : ' dia') : (o.prazoUteis ? ' dias úteis' : ' dias'));
      cabe(8);
      fonte(10.5, 'bold'); cor(T.ink);
      const rot = 'Prazo estimado: ';
      const wt = larg(winAnsi(rot));
      fonte(10.5); const wv = larg(winAnsi(t));
      fonte(10.5, 'bold'); linha(rot, X_VAL - wt - wv, y);
      fonte(10.5); linha(t, X_VAL, y, { align: 'right' });
      y += 6;
    }
    y += 4;
  }

  /** Bloco de texto com título (observação, condições…). Quebra entre páginas linha a linha. */
  function blocoTexto(titulo, texto, { inline = false } = {}) {
    texto = String(texto ?? '').trim();
    if (!texto) return;
    if (inline) {
      fonte(10.5, 'bold');
      const wt = larg(winAnsi(titulo + ' '));
      fonte(10.5);
      const ls = quebrar(texto, CW - wt);
      cabe(alt(10.5) * Math.min(ls.length, 2) + 3);
      fonte(10.5, 'bold'); cor(T.acc); linha(titulo, M, y);
      fonte(10.5); cor(T.ink);
      ls.forEach((l, k) => { if (k) { y += alt(10.5); cabe(alt(10.5)); } linha(l, M + wt, y); });
      y += alt(10.5) + 3;
      return;
    }
    fonte(10);
    const ls = [];
    for (const par of texto.split('\n')) ls.push(...(par.trim() ? quebrar(par, CW - 4) : ['']));
    cabe(alt(10.5) + alt(10) * Math.min(ls.length, 3) + 2);
    fonte(10.5, 'bold'); cor(T.acc); linha(titulo, M, y);
    y += alt(10) + 0.5;
    fonte(10); cor(T.ink);
    for (const l of ls) {
      if (cabe(alt(10))) { fonte(10); cor(T.ink); }
      linha(l, M, y);
      y += alt(10);
    }
    y += 4;
  }

  function rodapeTexto() {
    const r = String(perfil.rodape || '').trim();
    if (!r) return;
    fonte(10, 'italic');
    const ls = quebrar(r, CW - 10);
    cabe(ls.length * alt(10) + 8);
    y += 4;
    if (T.nome !== 'moderno') traco(W / 2 - 20, y - 4, W / 2 + 20, y - 4, T.nome === 'premium' ? T.ouro : T.line, 0.3);
    fonte(10, 'italic'); cor(T.muted);
    for (const l of ls) { y += alt(10); linha(l, W / 2, y, { align: 'center' }); }
  }

  /** Rodapé de cada página: número da página (e faixa escura no Premium). */
  function rodapesDasPaginas() {
    const n = doc.getNumberOfPages();
    for (let i = 1; i <= n; i++) {
      doc.setPage(i);
      const txt = n > 1 ? 'Página ' + i + ' de ' + n : '';
      if (T.nome === 'premium') {
        caixa(0, H - 11, W, 11, T.escuro); caixa(0, H - 11.7, W, 0.7, T.ouro);
        fonte(8.5); cor(T.creme);
        if (txt) linha(txt, W - M, H - 4.6, { align: 'right' });
        if (empresa) linha(empresa, M, H - 4.6);
      } else {
        if (T.nome === 'moderno') caixa(0, H - 3, W, 3, T.faixa);
        fonte(8.5); cor(T.muted);
        if (txt) linha(txt, W - M, H - 7.5, { align: 'right' });
      }
    }
  }

  /* ---------- montagem, na ordem da ordem de serviço ---------- */
  cabecalho();
  blocoCliente();
  const varias = ativas.length > 1;
  ativas.forEach(a => fase(a, varias));
  blocoTotal();
  blocoTexto('Observações', o.observacao);
  blocoTexto('Validade:', 'Válido até ' + dataBR(validoAte), { inline: true });
  blocoTexto('Condições de pagamento', perfil.condicoes);
  blocoTexto('PIX:', perfil.pix, { inline: true });
  rodapeTexto();
  rodapesDasPaginas();

  doc.setProperties({
    title: winAnsi((numero ? 'Orçamento Nº ' + numero : 'Orçamento') + (o.clienteNome ? ' - ' + o.clienteNome : '')),
    author: empresa, creator: empresa
  });
  return doc.output('blob');
}

/* ============================================================
   6. Entrega: compartilhar (celular) ou baixar e abrir (computador)
   ============================================================ */
function ehCelular() {
  const ua = navigator.userAgent || '';
  if (navigator.userAgentData && typeof navigator.userAgentData.mobile === 'boolean' && navigator.userAgentData.mobile) return true;
  return /Android|iPhone|iPad|iPod|Mobile/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

function baixar(blob, nome, abrir = false) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = nome;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  if (abrir) { try { window.open(url, '_blank', 'noopener'); } catch (e) { /* bloqueado: já baixou */ } }
  setTimeout(() => URL.revokeObjectURL(url), 120000);
}

async function compartilhar(file) {
  await navigator.share({ files: [file], title: file.name });
}

async function entregar(blob, nome, o) {
  if (ehCelular()) {
    const file = new File([blob], nome, { type: 'application/pdf' });
    let podeArquivo = false;
    try { podeArquivo = !!navigator.canShare?.({ files: [file] }); } catch (e) { podeArquivo = false; }
    if (podeArquivo) {
      try {
        await compartilhar(file);
        perguntarEnviado(o);
        return;
      } catch (e) {
        if (e?.name === 'AbortError') return;                     // fechou o menu sem escolher
        if (e?.name === 'NotAllowedError') { folhaPronto(file, blob, o); return; } // demorou e o celular pediu novo toque
        console.warn('[Print] compartilhar falhou, baixando', e);
      }
    }
    baixar(blob, nome);
    toast('PDF salvo em Downloads', 'ok');
    perguntarEnviado(o);
    return;
  }
  baixar(blob, nome, true);
  toast('PDF baixado ✓', 'ok');
  perguntarEnviado(o);
}

/* ============================================================
   7. Folhas (nunca alert/confirm)
   ============================================================ */
const jaMarcados = new Set(); // não perguntar de novo nesta abertura do app

function abrirFolha(html, aoResponder) {
  document.querySelector('.pdf-ov')?.remove();
  const ov = document.createElement('div');
  ov.className = 'ov pdf-ov';
  ov.setAttribute('role', 'dialog');
  ov.setAttribute('aria-modal', 'true');
  ov.setAttribute('aria-labelledby', 'pdf-folha-tit');
  ov.innerHTML = '<div class="sheet pdf-folha">' + html + '</div>';
  const fechar = r => {
    document.removeEventListener('keydown', tecla);
    ov.remove();
    aoResponder(r);
  };
  const tecla = ev => { if (ev.key === 'Escape') fechar('nao'); };
  ov.addEventListener('click', ev => {
    if (ev.target === ov) return fechar('nao');
    const b = ev.target.closest('[data-r]');
    if (b) fechar(b.dataset.r);
  });
  document.addEventListener('keydown', tecla);
  document.body.appendChild(ov);
  ov.querySelector('button')?.focus();
}

function perguntarEnviado(o) {
  if (!o?.id || jaMarcados.has(o.id)) return;
  if (o.status && o.status !== 'rascunho') return; // já está Enviado, Aprovado ou Recusado
  abrirFolha(
    '<h2 id="pdf-folha-tit">Marcar como Enviado?</h2>' +
    '<p class="muted">Assim você vê no Histórico quais orçamentos já foram para o cliente.</p>' +
    '<button type="button" class="big primary" data-r="sim">✔ Sim, marcar como Enviado</button>' +
    '<button type="button" class="big" data-r="nao">Agora não</button>',
    r => { if (r === 'sim') marcarEnviado(o); }
  );
}

function marcarEnviado(o) {
  const uid = auth.currentUser?.uid;
  if (!uid || !o.id) { toast('Não deu para marcar. Entre de novo na conta.', 'erro'); return; }
  jaMarcados.add(o.id);
  fs.updateDoc(fs.doc(db, 'users', uid, 'orcamentos', o.id), { status: 'enviado', atualizadoEm: fs.serverTimestamp() })
    .catch(e => { jaMarcados.delete(o.id); console.error('[Print] marcar enviado', e); toast(traduzErro(e), 'erro'); });
  toast(navigator.onLine ? 'Status: Enviado' : 'Enviado ✓ (salvo no aparelho)', 'ok');
}

/** Quando o celular exige um toque novo para abrir o menu de compartilhar. */
function folhaPronto(file, blob, o) {
  abrirFolha(
    '<h2 id="pdf-folha-tit">PDF pronto ✓</h2>' +
    '<p class="muted">Toque em Enviar e escolha o WhatsApp (ou outro app).</p>' +
    '<button type="button" class="big primary" data-r="enviar">📤 Enviar PDF</button>' +
    '<button type="button" class="big" data-r="baixar">⬇️ Só baixar</button>' +
    '<button type="button" class="big" data-r="nao">Fechar</button>',
    async r => {
      if (r === 'enviar') {
        try { await compartilhar(file); perguntarEnviado(o); }
        catch (e) {
          if (e?.name === 'AbortError') return;
          baixar(blob, file.name); toast('PDF salvo em Downloads', 'ok'); perguntarEnviado(o);
        }
      } else if (r === 'baixar') {
        baixar(blob, file.name); toast('PDF salvo em Downloads', 'ok'); perguntarEnviado(o);
      }
    }
  );
}

/* ============================================================
   8. Função do contrato
   ============================================================ */
let ocupado = false;

/**
 * Gera e entrega o PDF. Recebe o orçamento já concluído (a tela conclui antes).
 * Em erro, lança (a tela Orçamento mostra em toast).
 */
export async function gerarPdf({ orcamento, perfil, usuario } = {}) {
  if (ocupado) return;
  ocupado = true;
  try {
    garantirCss();
    const o = orcamento || {};
    const jaTem = !!window.jspdf?.jsPDF;
    toast(jaTem ? 'Gerando o PDF…' : 'Preparando o PDF…');
    const JsPDF = await carregarJsPdf();
    const blob = await montarPdf(JsPDF, o, perfil || {}, usuario || {});
    await entregar(blob, nomeArquivo(o), o);
  } finally {
    ocupado = false;
  }
}
