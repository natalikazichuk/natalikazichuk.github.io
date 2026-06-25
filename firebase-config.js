/* ============================================================
   firebase-config.js — спільний модуль Firebase для SchoolKingdom
   Підключення на будь-якій сторінці:
       <script type="module" src="firebase-config.js"></script>
   CDN-імпорти — працюють на GitHub Pages без build-інструментів.

   СТРУКТУРА БАЗИ (як у консолі):
     users/{id} ......... ЛЮДИ:
        батько → users/{AuthUID} = { email, name, familyName, children:[…] }
        дитина → users/{childId} = { name, login, avatar, class, pin,
                                     role:"child", parentUID }
     heroes/{childId} ... герой:  { childUid, class, hp, mana, strength,
                                    agility, accuracy, defense, intelligence,
                                    wisdom, luck, memory, charisma, level,
                                    currentXP, totalXP, xpToNextLevel, coins,
                                    booksRead, testsCompleted, achievements,
                                    createAt }
     tasks/{autoId} ..... завдання: { parentId, childId, title, description,
                                     subject, category, testId, rewardXP,
                                     rewardCoins, status, testCompleted,
                                     attempt, completedAt, dueDate, createdAt }

   Зв'язки:
     • батько → діти: масив users/{AuthUID}.children
     • дитина → батько: поле parentUID (= Auth UID батька)
     • дитина → герой: heroes/{childId} (той самий ID; поле childUid дублює)
     • документ батька ключований за Auth UID → users/{uid}

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
  collection, getDocs, query, where, serverTimestamp, arrayUnion
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

/* ── XP / РІВНІ (ЄДИНЕ місце для зміни формули) ──
   Зараз: рівень росте кожні 100 XP (плоско).
   • змінити поріг → поправ XP_PER_LEVEL;
   • зробити зростаючий поріг (напр. рівень×100) → перепиши levelInfo(). */
const XP_PER_LEVEL = 100;
function levelInfo(totalXP) {
  const t = Math.max(0, Math.floor(Number(totalXP) || 0));
  const level         = Math.floor(t / XP_PER_LEVEL) + 1; // 0–99→1, 100–199→2 …
  const currentXP     = t % XP_PER_LEVEL;                 // XP у межах рівня
  const xpToNextLevel = XP_PER_LEVEL;                     // розмір рівня
  return { level, currentXP, xpToNextLevel, totalXP: t };
}

// початкові характеристики героя (рівно як у базі: heroes/{childId})
function defaultHero(childId, cls) {
  return {
    childUid: childId,
    class: Number(cls) || 1,
    hp: 50, mana: 10,
    strength: 1, agility: 1, accuracy: 1, defense: 1,
    intelligence: 1, wisdom: 1, luck: 1, memory: 1, charisma: 1,
    level: 1, currentXP: 0, totalXP: 0, xpToNextLevel: XP_PER_LEVEL,
    coins: 0, booksRead: 0, testsCompleted: 0, achievements: 0,
    createAt: serverTimestamp()
  };
}

/* ---------- публічний API: window.SK ---------- */
const SK = {
  _userResolve: null,
  ready: null,
  user: null,
  activeChildId: localStorage.getItem('sk_active_child') || null,
  activeHeroId: null,
  parentDocId: null,        // ID документа батька в users (кеш; шукається за email)
  _userCbs: [],

  currentUser() { return auth.currentUser; },

  // Документ батька = users/{Auth UID}
  async _resolveParent() {
    const u = auth.currentUser;
    if (!u) return null;
    const s = await getDoc(doc(db, 'users', u.uid));
    if (!s.exists()) return null;
    SK.parentDocId = u.uid;
    return { id: u.uid, data: s.data() };
  },

  currentParentId() { return SK.parentDocId; },

  // Реєстрація батьків → users/{uid} (ID документа = Auth UID)
  async registerFamily({ parentName, email, password, familyName }) {
    const cred = await createUserWithEmailAndPassword(auth, email, password);
    const uid = cred.user.uid;
    await setDoc(doc(db, 'users', uid), {
      email: email,
      name: parentName || '',
      familyName: familyName || '',
      children: []
    });
    SK.parentDocId = uid;
    return uid;
  },

  async login(email, password) {
    SK.parentDocId = null;
    const cred = await signInWithEmailAndPassword(auth, email, password);
    return cred.user.uid;
  },

  async logout() {
    SK.activeChildId = null;
    SK.activeHeroId = null;
    SK.parentDocId = null;
    localStorage.removeItem('sk_active_child');
    await signOut(auth);
  },

  async getParent() {
    const p = await SK._resolveParent();
    return p ? p.data : null;
  },

  // Усі діти поточних батьків (за масивом users/{parentId}.children → users/{childId})
  async getChildren() {
    const p = await SK._resolveParent();
    const ids = (p && Array.isArray(p.data.children)) ? p.data.children : [];
    const out = {};
    await Promise.all(ids.map(async (id) => {
      const s = await getDoc(doc(db, 'users', id));
      if (s.exists()) out[id] = s.data();
    }));
    return out;
  },

  // Сумісність зі старим кодом: { parent, children }
  async getFamily() {
    const parent = await SK.getParent();
    const children = await SK.getChildren();
    return { parent, children };
  },

  // Додати дитину: профіль users/{childId} + герой heroes/{childId} + у масив батьків.
  // (class — зарезервоване слово, тому читаємо через p.class/p.grade без деструктуризації)
  async addChild(p) {
    const u = auth.currentUser;
    if (!u) throw new Error('Немає сесії сім\'ї');
    const parent = await SK._resolveParent();
    if (!parent) throw new Error('Не знайдено профіль батьків');

    const childRef = doc(collection(db, 'users')); // згенерувати ID наперед
    const childId = childRef.id;

    const cls = Number(p.class != null ? p.class : p.grade) || 1;
    const pin = Number(p.pin) || 0;
    await setDoc(childRef, {
      name: p.name || 'Дитина',
      login: p.login || '',
      avatar: p.avatar || 'boy1',
      class: cls,
      pin: pin,
      role: 'child',
      parentUID: parent.id
    });
    await setDoc(doc(db, 'heroes', childId), defaultHero(childId, cls));
    await updateDoc(doc(db, 'users', parent.id), { children: arrayUnion(childId) });
    return { childId, pin };
  },

  // Перевірка PIN дитини за іменем або логіном (у межах поточних батьків)
  async verifyChildPin(childName, pin) {
    const kids = await SK.getChildren();
    for (const [id, c] of Object.entries(kids)) {
      if ((c.name === childName || c.login === childName) && String(c.pin) === String(pin)) {
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

  // Герой = heroes/{childId} (той самий ID, що й документ дитини)
  async _resolveHero() {
    if (!auth.currentUser || !SK.activeChildId) return null;
    SK.activeHeroId = SK.activeChildId;
    return SK.activeChildId;
  },

  // Повний документ героя активної дитини
  async getHero() {
    const cid = await SK._resolveHero();
    if (!cid) return null;
    const s = await getDoc(doc(db, 'heroes', cid));
    return s.exists() ? s.data() : null;
  },

  // Зберегти характеристики героя в heroes/{childId} (merge).
  // health → hp; xp/totalXP → авторозрахунок level, currentXP, xpToNextLevel.
  async saveHeroStats(stats) {
    const cid = await SK._resolveHero();
    if (!cid || !stats) return false;
    const allowed = ['hp','mana','strength','agility','accuracy','defense',
                     'intelligence','wisdom','luck','memory','charisma',
                     'coins','class','booksRead','testsCompleted','achievements'];
    const patch = {};
    if (stats.hp == null && stats.health != null) patch.hp = stats.health;  // health→hp
    allowed.forEach(k => { if (stats[k] != null) patch[k] = stats[k]; });

    // XP/рівень: визначаємо totalXP (xp — сумісність зі старим кодом тренажерів)
    const totalXP = (stats.totalXP != null) ? stats.totalXP
                  : (stats.xp != null)      ? stats.xp : null;
    if (totalXP != null) {
      const li = levelInfo(totalXP);          // рівень росте кожні XP_PER_LEVEL
      patch.totalXP       = li.totalXP;
      patch.currentXP     = li.currentXP;
      patch.level         = li.level;
      patch.xpToNextLevel = li.xpToNextLevel;
    } else {
      // якщо XP не передали — дозволяємо вручну оновити окремі поля
      ['currentXP','totalXP','level','xpToNextLevel'].forEach(k => {
        if (stats[k] != null) patch[k] = stats[k];
      });
    }

    if (!Object.keys(patch).length) return false;
    patch.updatedAt = serverTimestamp();
    await setDoc(doc(db, 'heroes', cid), patch, { merge: true });
    return true;
  },

  // Хелпер для UI: { level, currentXP, xpToNextLevel } з totalXP
  levelInfo(totalXP) { return levelInfo(totalXP); },

  /* ---------- ЗАВДАННЯ (tasks) ---------- */

  // Створити завдання дитині
  async assignTask(t) {
    const parent = await SK._resolveParent();
    if (!parent) throw new Error('Немає сесії сім\'ї');
    const ref = await addDoc(collection(db, 'tasks'), {
      parentId: parent.id,
      childId: t.childId,
      title: t.title || '',
      description: t.description || '',
      subject: t.subject || '',
      category: t.category || '',
      testId: t.testId || '',
      rewardXP: Number(t.rewardXP) || 0,
      rewardCoins: Number(t.rewardCoins) || 0,
      status: 'assigned',
      testCompleted: false,
      attempt: 1,
      completedAt: null,
      dueDate: t.dueDate || null,
      createdAt: serverTimestamp()
    });
    return ref.id;
  },

  // Усі завдання конкретної дитини
  async getTasksForChild(childId) {
    const cid = childId || SK.activeChildId;
    if (!cid) return {};
    const qs = await getDocs(query(collection(db, 'tasks'), where('childId', '==', cid)));
    const out = {};
    qs.forEach(d => { out[d.id] = d.data(); });
    return out;
  },

  // Усі завдання поточних батьків
  async getTasksByParent() {
    const parent = await SK._resolveParent();
    if (!parent) return {};
    const qs = await getDocs(query(collection(db, 'tasks'), where('parentId', '==', parent.id)));
    const out = {};
    qs.forEach(d => { out[d.id] = d.data(); });
    return out;
  },

  // Змінити статус завдання ('assigned' → 'completed'/'review' тощо)
  async setTaskStatus(taskId, status, extra) {
    if (!taskId || !status) return false;
    const patch = Object.assign({ status }, extra || {});
    if (status === 'completed' && patch.completedAt === undefined) patch.completedAt = serverTimestamp();
    await updateDoc(doc(db, 'tasks', taskId), patch);
    return true;
  },

  // Завершення тесту → нагорода герою активної дитини (дані-драйвер з tests/{testId}).
  // tests/{testId}: statReward (яку характеристику качати), statRewardValue,
  //   statMaxValue (ліміт), xpReward, coinsReward.
  // opts.taskId — якщо передано, завдання позначається виконаним.
  async completeTest(testId, opts = {}) {
    const cid = await SK._resolveHero();
    if (!cid || !testId) return null;

    const tSnap = await getDoc(doc(db, 'tests', testId));
    if (!tSnap.exists()) return null;
    const t = tSnap.data();

    const hSnap = await getDoc(doc(db, 'heroes', cid));
    const hero = hSnap.exists() ? hSnap.data() : {};

    const patch = {};
    // 1) характеристика (напр. accuracy) з лімітом statMaxValue
    const statKey = t.statReward;
    const inc = Number(t.statRewardValue) || 0;
    if (statKey && inc) {
      const cur = Number(hero[statKey]) || 0;
      const max = (t.statMaxValue != null) ? Number(t.statMaxValue) : Infinity;
      patch[statKey] = Math.min(max, cur + inc);
    }
    // 2) XP → totalXP + перерахунок рівня
    const xpAdd = Number(t.xpReward) || 0;
    if (xpAdd) {
      const li = levelInfo((Number(hero.totalXP) || 0) + xpAdd);
      patch.totalXP = li.totalXP;
      patch.currentXP = li.currentXP;
      patch.level = li.level;
      patch.xpToNextLevel = li.xpToNextLevel;
    }
    // 3) монети
    const coinsAdd = Number(t.coinsReward) || 0;
    if (coinsAdd) patch.coins = (Number(hero.coins) || 0) + coinsAdd;
    // 4) лічильник пройдених тестів
    patch.testsCompleted = (Number(hero.testsCompleted) || 0) + 1;
    patch.updatedAt = serverTimestamp();

    await setDoc(doc(db, 'heroes', cid), patch, { merge: true });

    // 5) позначити завдання виконаним
    if (opts.taskId) {
      try {
        await updateDoc(doc(db, 'tasks', opts.taskId),
          { status: 'completed', testCompleted: true, completedAt: serverTimestamp() });
      } catch (e) {}
    }

    return {
      stat: statKey || null,
      statValue: statKey ? patch[statKey] : null,
      statMax: (t.statMaxValue != null) ? Number(t.statMaxValue) : null,
      xpReward: xpAdd,
      coinsReward: coinsAdd,
      level: (patch.level != null) ? patch.level : (hero.level || 1)
    };
  },

  /* ---------- ПРОГРЕС (localStorage ↔ users/{childId}.progress) ---------- */
  async pushLocal(childId) {
    const cid = childId || SK.activeChildId;
    if (!auth.currentUser || !cid) return false;
    const progress = {};
    progressKeys().forEach(k => { progress[k] = localStorage.getItem(k); });
    await setDoc(doc(db, 'users', cid), { progress }, { merge: true });
    return true;
  },

  async pullLocal(childId) {
    const cid = childId || SK.activeChildId;
    if (!auth.currentUser || !cid) return false;
    const snap = await getDoc(doc(db, 'users', cid));
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
  SK.parentDocId = null; // скидаємо кеш батька при зміні сесії
  if (SK._userResolve) { SK._userResolve(user); SK._userResolve = null; }
  SK._userCbs.forEach(cb => { try { cb(user); } catch (e) {} });
});

window.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') SK.pushLocal().catch(() => {});
});

window.SK = SK;
