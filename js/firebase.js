/*
  Arquivo: js/firebase.js
  Versão: 1.0.0
  Sessão: 1 — Base do projeto
  Data: 14/10/2026
  Inicia o Firebase e exporta app, auth e db.
  Biblioteca modular pela CDN do Google (gstatic), versão fixa 12.19.0.
  Para trocar de versão no futuro, mude só a constante VERSAO_FIREBASE
  e as 3 linhas de import abaixo (o import não aceita variável).

  Extras (além do contrato): exporta também
    fs  -> todas as funções do Firestore (doc, getDoc, setDoc, increment...)
    fa  -> todas as funções do Authentication (signInWithEmailAndPassword...)
    modoCache -> 'persistente' (offline ligado) ou 'memoria' (sem offline)
  Assim os outros módulos importam tudo daqui e a versão fica num lugar só.
*/

import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js';
import * as fa from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';
import * as fs from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';
import { firebaseConfig } from './firebase-config.js';

export const VERSAO_FIREBASE = '12.19.0';

export const app = initializeApp(firebaseConfig);

export const auth = fa.getAuth(app);
auth.languageCode = 'pt';

// Firestore com persistência offline (guarda os dados no aparelho e
// sincroniza quando a internet volta). Funciona com várias abas abertas.
let banco;
let modo = 'persistente';
try {
  banco = fs.initializeFirestore(app, {
    localCache: fs.persistentLocalCache({ tabManager: fs.persistentMultipleTabManager() })
  });
} catch (e) {
  // Navegador sem suporte (ex.: aba anônima de alguns navegadores): segue sem offline.
  console.warn('[Print] Offline do Firestore indisponível, usando só memória.', e);
  banco = fs.getFirestore(app);
  modo = 'memoria';
}

export const db = banco;
export const modoCache = modo;
export { fa, fs };
