/* ============================================================
   firebase-config.js — спільний модуль Firebase для SchoolKingdom
   Підключення на будь-якій сторінці:
       <script type="module" src="firebase-config.js"></script>
   CDN-імпорти — працюють на GitHub Pages без build-інструментів.

   СТРУКТУРА БАЗИ (пласка, як у консолі):
     users/{uid} ........ батьки:  { email, name, role:"parent" }
     children/{autoId} .. діти:    { name, avatar, age, grade, pin,
                                     parentEmail, heroID, HP, coins,
                                     level, xp, progress:{...} }
     heroes/{autoId} .... герої:   { name, title, health, mana,
                                     agility, accuracy, level, xp,
                                     coins, parentEmail }
   Зв'язки: дитина→батьки через parentEmail; дитина→герой через heroID.

   Модель доступу: один сімейний акаунт (email+пароль батьків).
   «Вхід дитини» = вибір профілю + перевірка PIN усередині сесії сім'ї.
   ============================================================ */

import { initializeApp }
  from "https://www.gstatic.com/firebasejs/11.1.0/firebase-app.js";
import {
  getAuth, setPersistence, browserLocalPersistence,
  createUserWithEmailAndPassword, signInWithEmailAndPassword,
  signOut, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/11.1.0/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, updateDoc, addDoc,
  collection, getDocs, query, where, serverTimestamp, runTransaction
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

try { await setPersistence(auth, browserLocalPersistence); } catch (e) {}

try {
  const { getAnalytics, isSupported } =
    await import("https://www.gstatic.com/firebasejs/11.1.0/firebase-analytics.js");
  if (await isSupported()) getAnalytics(app);
} catch (e) {}

/* ---------- допоміжне ---------- */
function progressKeys() {
  const keys = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k) continue;
    if (k === 'sk_active_family' || k === 'sk_active_child') continue;
    keys.push(k);
  }
  return keys;
}

// початкові характеристики героя (повний набір, як у базі)
function defaultHero(name, email) {
  return {
    name: name || 'Герой',
    title: 'Лицар Знань',
    health: 50, mana: 10, agility: 1, accuracy: 1,
    strength: 2, defense: 1, intelligence: 1, wisdom: 1,
    luck: 1, memory: 1, charisma: 1,
    level: 1, xp: 0, coins: 600,
    parentEmail: email,
    createdAt: serverTimestamp()
  };
}

/* ---------- публічний API: window.SK ---------- */
const SK = {
  _userResolve: null,
  ready: null,
  user: null,
  activeChildId: localStorage.getItem('sk_active_child') || null,
  activeHeroId: null,
  _userCbs: [],

  currentUser() { return auth.currentUser; },

  // Режим визначає активний профіль дитини (акаунт у сім'ї один — батьківський).
  // Це клієнтський перемикач UX, а не захист даних (див. примітку нижче).
  isChildMode() { return !!localStorage.getItem('sk_active_child'); },

  // Гейт сторінки батьків. Викликати всередині SK.ready.then().
  // true → можна показувати кабінет; false → вже зроблено редірект, треба return.
  requireParent() {
    if (!auth.currentUser) { location.replace('auth.html?mode=login'); return false; }
    if (SK.isChildMode())  { location.replace('child.html');           return false; }
    return true;
  },

  // Гейт дитячої сторінки: достатньо бути в сесії сім'ї.
  requireChild() {
    if (!auth.currentUser) { location.replace('auth.html?mode=login&next=child'); return false; }
    return true;
  },

  // Реєстрація батьків → users/{uid}
  async registerFamily({ parentName, parentRole, email, password }) {
    const cred = await createUserWithEmailAndPassword(auth, email, password);
    const uid = cred.user.uid;
    await setDoc(doc(db, 'users', uid), {
      email: email,
      name: parentName || '',
      role: parentRole || 'parent',
      createdAt: serverTimestamp()
    });
    return uid;
  },

  async login(email, password) {
    const cred = await signInWithEmailAndPassword(auth, email, password);
    SK.setActiveChild(null);   // скинути «активну дитину» попередньої сесії на цьому браузері
    return cred.user.uid;
  },

  async logout() {
    SK.activeChildId = null;
    SK.activeHeroId = null;
    localStorage.removeItem('sk_active_child');
    await signOut(auth);
  },

  async getParent() {
    const u = auth.currentUser;
    if (!u) return null;
    const s = await getDoc(doc(db, 'users', u.uid));
    return s.exists() ? s.data() : null;
  },

  // Усі діти поточних батьків (за parentEmail)
  async getChildren() {
    const u = auth.currentUser;
    if (!u) return {};
    const q = query(collection(db, 'children'), where('parentEmail', '==', u.email));
    const snap = await getDocs(q);
    const out = {};
    snap.forEach(d => { out[d.id] = d.data(); });
    return out;
  },

  // Сумісність зі старим кодом: { parent, children }
  async getFamily() {
    const parent = await SK.getParent();
    const children = await SK.getChildren();
    return { parent, children };
  },

  // наступний код героя: Hero001, Hero002… (глобальний лічильник)
  async nextHeroCode() {
    const counterRef = doc(db, 'meta', 'counters');
    let seq;
    await runTransaction(db, async (tx) => {
      const s = await tx.get(counterRef);
      seq = (s.exists() ? (s.data().heroSeq || 0) : 0) + 1;
      tx.set(counterRef, { heroSeq: seq }, { merge: true });
    });
    return 'Hero' + String(seq).padStart(3, '0');
  },

  // Додати дитину: герой heroes/HeroNNN + запис у children
  async addChild({ name, avatar, age, grade, pin }) {
    const u = auth.currentUser;
    if (!u) throw new Error('Немає сесії сім\'ї');
    // 1) герой з кодом-ідентифікатором HeroNNN
    const heroCode = await SK.nextHeroCode();
    await setDoc(doc(db, 'heroes', heroCode), defaultHero(name, u.email));
    // 2) дитина
    const childRef = await addDoc(collection(db, 'children'), {
      name: name || 'Дитина',
      avatar: avatar || '🙂',
      age: Number(age) || 7,
      grade: Number(grade) || 1,
      pin: String(pin || ''),
      parentEmail: u.email,
      heroID: heroCode,
      HP: 50, coins: 600, level: 1, xp: 0,
      progress: {},
      createdAt: serverTimestamp()
    });
    return childRef.id;
  },

  // Перевірка PIN дитини за іменем (у межах поточних батьків)
  async verifyChildPin(childName, pin) {
    const children = await SK.getChildren();
    for (const [id, c] of Object.entries(children)) {
      if (c.name === childName && String(c.pin) === String(pin)) {
        SK.activeHeroId = c.heroID || null;
        return id;
      }
    }
    return null;
  },

  setActiveChild(childId) {
    if (childId !== SK.activeChildId) SK.activeHeroId = null;
    SK.activeChildId = childId;
    if (childId) localStorage.setItem('sk_active_child', childId);
    else localStorage.removeItem('sk_active_child');
  },

  // знайти heroID активної дитини (читає children/{id}, якщо ще не кешовано)
  async _resolveHero() {
    if (SK.activeHeroId) return SK.activeHeroId;
    const cid = SK.activeChildId;
    if (!auth.currentUser || !cid) return null;
    const s = await getDoc(doc(db, 'children', cid));
    if (s.exists()) SK.activeHeroId = s.data().heroID || null;
    return SK.activeHeroId;
  },

  // Повний документ героя активної дитини (для відображення всіх характеристик)
  async getHero() {
    const heroId = await SK._resolveHero();
    if (!heroId) return null;
    const s = await getDoc(doc(db, 'heroes', heroId));
    return s.exists() ? s.data() : null;
  },

  // Профіль активної дитини: children/{activeChildId} (name, avatar, grade…)
  async getActiveChild() {
    const cid = SK.activeChildId;
    if (!auth.currentUser || !cid) return null;
    const s = await getDoc(doc(db, 'children', cid));
    return s.exists() ? Object.assign({ id: cid }, s.data()) : null;
  },

  // Зберегти характеристики героя активної дитини (похідні від прогресу).
  // Монети НЕ чіпаємо — ними керує система нагород, а не XP.
  async saveHeroStats(stats) {
    const cid = SK.activeChildId;
    if (!auth.currentUser || !cid || !stats) return false;
    // дзеркало в children
    const childPatch = {};
    if (stats.health != null) childPatch.HP = stats.health;
    if (stats.level  != null) childPatch.level = stats.level;
    if (stats.xp     != null) childPatch.xp = stats.xp;
    if (Object.keys(childPatch).length)
      await setDoc(doc(db, 'children', cid), childPatch, { merge: true });
    // запис у heroes (тільки активні характеристики 1 класу)
    const heroId = await SK._resolveHero();
    if (heroId) {
      const heroPatch = {};
      ['health','mana','agility','accuracy','level','xp']
        .forEach(k => { if (stats[k] != null) heroPatch[k] = stats[k]; });
      heroPatch.updatedAt = serverTimestamp();
      await setDoc(doc(db, 'heroes', heroId), heroPatch, { merge: true });
    }
    return true;
  },

  // localStorage → children/{id}.progress
  async pushLocal(childId) {
    const cid = childId || SK.activeChildId;
    if (!auth.currentUser || !cid) return false;
    const progress = {};
    progressKeys().forEach(k => { progress[k] = localStorage.getItem(k); });
    await setDoc(doc(db, 'children', cid), { progress }, { merge: true });
    return true;
  },

  // children/{id}.progress → localStorage
  async pullLocal(childId) {
    const cid = childId || SK.activeChildId;
    if (!auth.currentUser || !cid) return false;
    const snap = await getDoc(doc(db, 'children', cid));
    if (!snap.exists()) return false;
    const progress = snap.data().progress || {};
    progressKeys().forEach(k => localStorage.removeItem(k));
    Object.entries(progress).forEach(([k, v]) => {
      if (v != null) localStorage.setItem(k, v);
    });
    return true;
  },

  onUser(cb) { if (typeof cb === 'function') SK._userCbs.push(cb); }
};

SK.ready = new Promise(res => { SK._userResolve = res; });

onAuthStateChanged(auth, (user) => {
  SK.user = user;
  if (SK._userResolve) { SK._userResolve(user); SK._userResolve = null; }
  SK._userCbs.forEach(cb => { try { cb(user); } catch (e) {} });
});

window.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') SK.pushLocal().catch(() => {});
});

window.SK = SK;
