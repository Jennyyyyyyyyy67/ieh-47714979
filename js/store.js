// 資料存放：有填 Firebase 設定就用 Firebase（正式版），沒填就用「本機試用模式」。
// 每位老師一個「抽屜」：users/{老師的uid}/{collection}/{id}
import { FIREBASE_CONFIG } from '../firebase-config.js';
import { uid as newId, sha256 } from './utils.js';

const FB_VER = '10.12.2';
const COLLECTIONS = ['trips', 'meetings', 'reports', 'places', 'plans'];

function firebaseConfigured() {
  return !!(FIREBASE_CONFIG && FIREBASE_CONFIG.apiKey && !String(FIREBASE_CONFIG.apiKey).startsWith('請'));
}

function friendlyAuthError(e) {
  const code = e?.code || '';
  const map = {
    'auth/invalid-email': '帳號格式不正確（請用英文或數字）',
    'auth/email-already-in-use': '這個帳號已經註冊過了，請直接按「登入」',
    'auth/weak-password': '密碼太短，至少要 6 個字',
    'auth/invalid-credential': '帳號或密碼錯誤',
    'auth/wrong-password': '帳號或密碼錯誤',
    'auth/user-not-found': '找不到這個帳號，請先註冊',
    'auth/too-many-requests': '嘗試太多次了，請稍後再試',
    'auth/network-request-failed': '網路連線失敗，請檢查網路',
  };
  return new Error(map[code] || e?.message || '發生錯誤');
}

// ---------------- 本機試用模式 ----------------
class LocalStore {
  constructor() {
    this.mode = 'local';
    this.user = null;
    this.listeners = [];
    this.prefix = 'tripapp:v1:';
  }
  _read(key, fallback) {
    try { const v = localStorage.getItem(this.prefix + key); return v ? JSON.parse(v) : fallback; }
    catch { return fallback; }
  }
  _write(key, value) {
    localStorage.setItem(this.prefix + key, JSON.stringify(value));
  }
  async init() {
    const session = this._read('session', null);
    const users = this._read('users', {});
    if (session && Object.values(users).some(u => u.uid === session.uid)) this.user = session;
  }
  onAuth(cb) { this.listeners.push(cb); cb(this.user); }
  _emit() { this.listeners.forEach(cb => cb(this.user)); }
  async signUp(email, password) {
    email = (email || '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('帳號格式不正確（請用英文或數字）');
    if ((password || '').length < 6) throw new Error('密碼太短，至少要 6 個字');
    const users = this._read('users', {});
    if (users[email]) throw new Error('這個帳號已經註冊過了，請直接按「登入」');
    const salt = newId();
    users[email] = { uid: 'local-' + newId(), salt, hash: await sha256(salt + password) };
    this._write('users', users);
    this.user = { uid: users[email].uid, email };
    this._write('session', this.user);
    this._emit();
  }
  async signIn(email, password) {
    email = (email || '').trim().toLowerCase();
    const users = this._read('users', {});
    const u = users[email];
    if (!u || u.hash !== await sha256(u.salt + password)) throw new Error('帳號或密碼錯誤');
    this.user = { uid: u.uid, email };
    this._write('session', this.user);
    this._emit();
  }
  async signOut() {
    this.user = null;
    localStorage.removeItem(this.prefix + 'session');
    this._emit();
  }
  async resetPassword() {
    throw new Error('本機試用模式不能寄重設密碼信。正式版（Firebase）才可以。');
  }
  _key(col) { return `data:${this.user.uid}:${col}`; }
  async list(col) {
    if (!COLLECTIONS.includes(col)) throw new Error('unknown collection');
    return this._read(this._key(col), []).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }
  async save(col, obj) {
    const items = this._read(this._key(col), []);
    const item = { ...obj, id: obj.id || newId(), updatedAt: Date.now() };
    if (!item.createdAt) item.createdAt = item.updatedAt;
    const i = items.findIndex(x => x.id === item.id);
    if (i >= 0) items[i] = item; else items.push(item);
    this._write(this._key(col), items);
    return item;
  }
  async saveMany(col, objs) {
    const out = [];
    for (const o of objs) out.push(await this.save(col, o));
    return out;
  }
  async remove(col, id) {
    this._write(this._key(col), this._read(this._key(col), []).filter(x => x.id !== id));
  }
  async getSettings() { return this._read(`data:${this.user.uid}:settings`, {}); }
  async saveSettings(s) { this._write(`data:${this.user.uid}:settings`, s); }
}

// ---------------- Firebase 正式模式 ----------------
class FirebaseStore {
  constructor() { this.mode = 'firebase'; this.user = null; }
  async init() {
    const base = `https://www.gstatic.com/firebasejs/${FB_VER}`;
    const [{ initializeApp }, auth, fs] = await Promise.all([
      import(`${base}/firebase-app.js`),
      import(`${base}/firebase-auth.js`),
      import(`${base}/firebase-firestore.js`),
    ]);
    this.fa = auth; this.fs = fs;
    this.app = initializeApp(FIREBASE_CONFIG);
    this.auth = auth.getAuth(this.app);
    this.db = fs.getFirestore(this.app);
    await new Promise(resolve => {
      const off = auth.onAuthStateChanged(this.auth, u => { this.user = u ? { uid: u.uid, email: u.email } : null; off(); resolve(); });
    });
  }
  onAuth(cb) {
    this.fa.onAuthStateChanged(this.auth, u => { this.user = u ? { uid: u.uid, email: u.email } : null; cb(this.user); });
  }
  async signUp(email, password) {
    try { await this.fa.createUserWithEmailAndPassword(this.auth, email.trim(), password); }
    catch (e) { throw friendlyAuthError(e); }
  }
  async signIn(email, password) {
    try { await this.fa.signInWithEmailAndPassword(this.auth, email.trim(), password); }
    catch (e) { throw friendlyAuthError(e); }
  }
  async signOut() { await this.fa.signOut(this.auth); }
  async resetPassword(email) {
    try { await this.fa.sendPasswordResetEmail(this.auth, email.trim()); }
    catch (e) { throw friendlyAuthError(e); }
  }
  _col(col) {
    if (!COLLECTIONS.includes(col)) throw new Error('unknown collection');
    return this.fs.collection(this.db, 'users', this.user.uid, col);
  }
  async list(col) {
    const snap = await this.fs.getDocs(this._col(col));
    return snap.docs.map(d => ({ ...d.data(), id: d.id })).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }
  async save(col, obj) {
    const item = { ...obj, id: obj.id || newId(), updatedAt: Date.now() };
    if (!item.createdAt) item.createdAt = item.updatedAt;
    // Firestore 不接受 undefined
    const clean = JSON.parse(JSON.stringify(item));
    await this.fs.setDoc(this.fs.doc(this._col(col), item.id), clean);
    return item;
  }
  async saveMany(col, objs) {
    const out = [];
    const batch = this.fs.writeBatch(this.db);
    for (const obj of objs) {
      const item = { ...obj, id: obj.id || newId(), updatedAt: Date.now() };
      if (!item.createdAt) item.createdAt = item.updatedAt;
      batch.set(this.fs.doc(this._col(col), item.id), JSON.parse(JSON.stringify(item)));
      out.push(item);
    }
    await batch.commit();
    return out;
  }
  async remove(col, id) { await this.fs.deleteDoc(this.fs.doc(this._col(col), id)); }
  async getSettings() {
    const snap = await this.fs.getDoc(this.fs.doc(this.db, 'users', this.user.uid, 'settings', 'main'));
    return snap.exists() ? snap.data() : {};
  }
  async saveSettings(s) {
    await this.fs.setDoc(this.fs.doc(this.db, 'users', this.user.uid, 'settings', 'main'), JSON.parse(JSON.stringify(s)));
  }
}

export async function createStore() {
  const store = firebaseConfigured() ? new FirebaseStore() : new LocalStore();
  await store.init();
  return store;
}
