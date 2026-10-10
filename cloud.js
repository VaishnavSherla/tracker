// Firebase layer. Data model (matches firestore.rules):
//   users/{uid}                    { username, displayName, createdAt }
//   usernames/{username}           { uid }                    (uniqueness lock)
//   solved/{uid}/entries/{slug}    { status: 0|1|2, star: bool }  <- ONLY problems you touched
//   leaderboard/{uid}              { username, solved, review, starred, updatedAt }
// The problem list itself never goes to Firestore; it ships with the app (problems.json).
import { firebaseConfig } from "./firebase-config.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js";
import {
  getAuth, onAuthStateChanged, GoogleAuthProvider, signInWithPopup, signInWithRedirect,
  getRedirectResult, createUserWithEmailAndPassword, signInWithEmailAndPassword,
  sendPasswordResetEmail, signOut,
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js";
import {
  initializeFirestore, getFirestore, persistentLocalCache, persistentMultipleTabManager,
  doc, getDoc, setDoc, deleteDoc, collection, onSnapshot, writeBatch,
  query, orderBy, limit, getDocs, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js";

export const enabled = Boolean(firebaseConfig.apiKey && firebaseConfig.projectId && firebaseConfig.appId);

let app, auth, db;
if (enabled) {
  app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  try {
    // Offline cache: toggles made offline are queued and sync when you're back online.
    db = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });
  } catch (err) {
    console.warn("Firestore persistence unavailable, using memory cache.", err);
    db = getFirestore(app);
  }
}

export const USERNAME_RE = /^[a-z0-9_]{3,20}$/;

export function onUser(cb) {
  if (!enabled) return () => {};
  getRedirectResult(auth).catch(err => console.warn("Redirect sign-in failed:", err));
  return onAuthStateChanged(auth, cb);
}

export async function signInGoogle() {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });
  const standalone = window.matchMedia?.("(display-mode: standalone)").matches || navigator.standalone;
  if (standalone) return signInWithRedirect(auth, provider); // popups are unreliable in installed PWAs
  try {
    return await signInWithPopup(auth, provider);
  } catch (err) {
    if (err.code === "auth/popup-blocked") return signInWithRedirect(auth, provider);
    throw err;
  }
}
export const signUpEmail = (email, pw) => createUserWithEmailAndPassword(auth, email, pw);
export const signInEmail = (email, pw) => signInWithEmailAndPassword(auth, email, pw);
export const resetPassword = email => sendPasswordResetEmail(auth, email);
export const logout = () => signOut(auth);

export function friendlyError(err) {
  const map = {
    "auth/invalid-email": "That email address doesn't look right.",
    "auth/missing-password": "Enter your password.",
    "auth/weak-password": "Password must be at least 6 characters.",
    "auth/email-already-in-use": "An account with this email already exists. Try signing in.",
    "auth/invalid-credential": "Wrong email or password.",
    "auth/user-not-found": "Wrong email or password.",
    "auth/wrong-password": "Wrong email or password.",
    "auth/too-many-requests": "Too many attempts. Wait a bit and try again.",
    "auth/network-request-failed": "Network error. Check your connection.",
    "auth/popup-closed-by-user": "Sign-in was cancelled.",
    "auth/cancelled-popup-request": "Sign-in was cancelled.",
    "auth/unauthorized-domain": "This site's domain isn't authorized in Firebase (Authentication → Settings → Authorized domains).",
    "auth/operation-not-allowed": "This sign-in method isn't enabled in Firebase.",
    "permission-denied": "Permission denied by Firestore rules.",
  };
  return map[err?.code] || err?.message || "Something went wrong.";
}

// ---- Profile / username ----
export async function loadProfile(uid) {
  const snap = await getDoc(doc(db, "users", uid));
  return snap.exists() ? snap.data() : null;
}

/** Atomically claims the username and creates the profile + leaderboard row. Throws "taken" if already used. */
export async function claimUsername(user, username) {
  if (!USERNAME_RE.test(username)) throw Object.assign(new Error("Use 3–20 characters: a–z, 0–9, underscore."), { code: "invalid-username" });
  const batch = writeBatch(db);
  batch.set(doc(db, "usernames", username), { uid: user.uid }); // fails (as an "update") if already taken
  batch.set(doc(db, "users", user.uid), {
    username, displayName: (user.displayName || username).slice(0, 60), createdAt: serverTimestamp(),
  });
  batch.set(doc(db, "leaderboard", user.uid), { username, solved: 0, review: 0, starred: 0, updatedAt: serverTimestamp() });
  try {
    await batch.commit();
  } catch (err) {
    if (err.code === "permission-denied") throw Object.assign(new Error("That username is taken."), { code: "taken" });
    throw err;
  }
  return { username };
}

// ---- Progress ----
const entryRef = (uid, slug) => doc(db, "solved", uid, "entries", slug);

/** Live listener; cache-first, then server. Only changed docs are re-read after the first load. */
export function watchEntries(uid, onSnap, onErr) {
  return onSnapshot(collection(db, "solved", uid, "entries"), { includeMetadataChanges: true }, onSnap, onErr);
}

/** rec = {status, star} to store, or null to delete (back to untouched). */
export function saveEntry(uid, slug, rec) {
  return rec ? setDoc(entryRef(uid, slug), { status: rec.status, star: !!rec.star }) : deleteDoc(entryRef(uid, slug));
}

/** entries: { slug: {status, star} | null }. Chunked to Firestore's 500-op batch limit. */
export async function saveMany(uid, entries) {
  const pairs = Object.entries(entries);
  for (let i = 0; i < pairs.length; i += 400) {
    const batch = writeBatch(db);
    pairs.slice(i, i + 400).forEach(([slug, rec]) => {
      if (rec) batch.set(entryRef(uid, slug), { status: rec.status, star: !!rec.star });
      else batch.delete(entryRef(uid, slug));
    });
    await batch.commit();
  }
}

// ---- Leaderboard ----
export function pushLeaderboard(uid, username, counts) {
  return setDoc(doc(db, "leaderboard", uid), {
    username, solved: counts.solved, review: counts.review, starred: counts.starred, updatedAt: serverTimestamp(),
  });
}

export async function topUsers(n = 50) {
  const snap = await getDocs(query(collection(db, "leaderboard"), orderBy("solved", "desc"), limit(n)));
  return snap.docs.map(d => ({ uid: d.id, ...d.data() }));
}
