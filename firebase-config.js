/* ============================================================
   firebase-config.js — спільний модуль Firebase для SchoolKingdom
   Підключення (на будь-якій сторінці, у <head> або перед </body>):
       <script type="module" src="firebase-config.js"></script>
   CDN-імпорти — працюють на GitHub Pages без build-інструментів.

   Дані в хмарі (Cloud Firestore):
     families/{uid} .......... акаунт батьків:
            { parentName, parentRole, email, childrenOrder:[], createdAt }
     families/{uid}/children/{childId} ... профіль дитини:
            { name, avatar, age, grade, pin, progress:{ ключ:значення } }

   Модель доступу:
     • Один сімейний акаунт (email+пароль батьків).
     • «Вхід дитини» = вибір профілю + перевірка PIN усередині сесії сім'ї.
       Сесія Firebase зберігається на пристрої, тож після першого входу
       батьків дитина заходить лише за PIN.
   ============================================================ */

import { initializeApp }
  from "https://www.gstatic.com/firebasejs/11.1.0/firebase-app.js";
import {
  getAuth, setPersistence, browserLocalPersistence,
  createUserWithEmailAndPassword, signInWithEmailAndPassword,
  signOut, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/11.1.0/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, updateDoc,
  collection, getDocs, serverTimestamp, deleteField
} from "https://www.gstatic.com/firebasejs/11.1.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyALZtXycA1CI1WvbSfNXMyMYuPpWTp6JzA",
  authDomain: "schoolkingdom-d46bc.firebaseapp.com",
  projectId: "schoolkingdom-d46bc",
  storageBucket: "schoolkingdom-d46bc.firebasestorage.app",
  messagingSenderId: "253979875433",
  appId: "1:253979875433:web:db79507d2398e0d0502af8",
  measurementId: "G-X67FH9BPM3"
};

const app  = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db   = getFirestore(app);

// Зберігати сесію між заходами (за замовчуванням так і є, але робимо явно)
try { await setPersistence(auth, browserLocalPersistence); } catch (e) {}

// Analytics — необов'язково; у деяких середовищах падає, тому в try/catch
try {
  const { getAnalytics, isSupported } =
    await import("https://www.gstatic.com/firebasejs/11.1.0/firebase-analytics.js");
  if (await isSupported()) getAnalytics(app);
} catch (e) {}

/* ---------- допоміжне ---------- */

// які ключі localStorage синхронізуємо з хмарою (увесь прогрес)
function progressKeys() {
  const keys = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k) continue;
    if (k === 'sk_active_family' || k === 'sk_active_child') continue; // службові
    keys.push(k);
  }
  return keys;
}

function genId(name) {
  return 'c_' + (name || 'child').toLowerCase()
    .replace(/[^a-zа-яіїєґ0-9]+/gi, '_').slice(0, 20) + '_' + Date.now().toString(36);
}

/* ---------- публічний API: window.SK ---------- */

const SK = {
  _userResolve: null,
  ready: null,              // проміс, який резолвиться після першої перевірки auth
  user: null,               // поточний Firebase-користувач (батьки) або null
  activeChildId: localStorage.getItem('sk_active_child') || null,

  currentUser() { return auth.currentUser; },

  // Реєстрація сім'ї: створює акаунт + документ families/{uid}
  async registerFamily({ parentName, parentRole, email, password }) {
    const cred = await createUserWithEmailAndPassword(auth, email, password);
    const uid = cred.user.uid;
    await setDoc(doc(db, 'families', uid), {
      parentName: parentName || '',
      parentRole: parentRole || 'mama',
      email: email,
      childrenOrder: [],
      createdAt: serverTimestamp()
    });
    return uid;
  },

  async login(email, password) {
    const cred = await signInWithEmailAndPassword(auth, email, password);
    return cred.user.uid;
  },

  async logout() {
    SK.activeChildId = null;
    localStorage.removeItem('sk_active_child');
    await signOut(auth);
  },

  // Повна модель сім'ї: { parent:{...}, children:{ id:{...} } }
  async getFamily() {
    const u = auth.currentUser;
    if (!u) return null;
    const fSnap = await getDoc(doc(db, 'families', u.uid));
    const parent = fSnap.exists() ? fSnap.data() : null;
    const children = {};
    const cSnap = await getDocs(collection(db, 'families', u.uid, 'children'));
    cSnap.forEach(d => { children[d.id] = d.data(); });
    return { parent, children };
  },

  // Додати дитину
  async addChild({ name, avatar, age, grade, pin }) {
    const u = auth.currentUser;
    if (!u) throw new Error('Немає сесії сім\'ї');
    const id = genId(name);
    await setDoc(doc(db, 'families', u.uid, 'children', id), {
      name: name || 'Дитина',
      avatar: avatar || '🙂',
      age: Number(age) || 7,
      grade: Number(grade) || 1,
      pin: String(pin || ''),
      progress: {}
    });
    // оновити порядок
    const fRef = doc(db, 'families', u.uid);
    const fSnap = await getDoc(fRef);
    const order = (fSnap.exists() && fSnap.data().childrenOrder) || [];
    order.push(id);
    await updateDoc(fRef, { childrenOrder: order });
    return id;
  },

  // Перевірити PIN дитини (за іменем) у межах поточної сім'ї
  async verifyChildPin(childName, pin) {
    const fam = await SK.getFamily();
    if (!fam) return null;
    for (const [id, c] of Object.entries(fam.children)) {
      if (c.name === childName && String(c.pin) === String(pin)) return id;
    }
    return null;
  },

  setActiveChild(childId) {
    SK.activeChildId = childId;
    if (childId) localStorage.setItem('sk_active_child', childId);
    else localStorage.removeItem('sk_active_child');
  },

  // localStorage → хмара (для активної дитини)
  async pushLocal(childId) {
    const u = auth.currentUser;
    const cid = childId || SK.activeChildId;
    if (!u || !cid) return false;
    const progress = {};
    progressKeys().forEach(k => { progress[k] = localStorage.getItem(k); });
    await setDoc(doc(db, 'families', u.uid, 'children', cid),
                 { progress }, { merge: true });
    return true;
  },

  // хмара → localStorage (для активної дитини)
  async pullLocal(childId) {
    const u = auth.currentUser;
    const cid = childId || SK.activeChildId;
    if (!u || !cid) return false;
    const snap = await getDoc(doc(db, 'families', u.uid, 'children', cid));
    if (!snap.exists()) return false;
    const progress = snap.data().progress || {};
    // прибираємо старий прогрес цього пристрою, лишаючи службові ключі
    progressKeys().forEach(k => localStorage.removeItem(k));
    Object.entries(progress).forEach(([k, v]) => {
      if (v != null) localStorage.setItem(k, v);
    });
    return true;
  },

  // підписка на зміну стану входу
  onUser(cb) {
    if (typeof cb === 'function') SK._userCbs.push(cb);
  },
  _userCbs: []
};

SK.ready = new Promise(res => { SK._userResolve = res; });

onAuthStateChanged(auth, (user) => {
  SK.user = user;
  if (SK._userResolve) { SK._userResolve(user); SK._userResolve = null; }
  SK._userCbs.forEach(cb => { try { cb(user); } catch (e) {} });
});

// автозбереження прогресу в хмару, коли дитина закриває/ховає вкладку
window.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    SK.pushLocal().catch(() => {});
  }
});

window.SK = SK;
