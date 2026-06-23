import { initializeApp }
from "https://www.gstatic.com/firebasejs/12.0.0/firebase-app.js";

import { getFirestore }
from "https://www.gstatic.com/firebasejs/12.0.0/firebase-firestore.js";

import { getAuth }
from "https://www.gstatic.com/firebasejs/12.0.0/firebase-auth.js";

import { getStorage }
from "https://www.gstatic.com/firebasejs/12.0.0/firebase-storage.js";


const firebaseConfig = {

  apiKey: "AIzaSyALZtXycA1CI1WvbSfNXMyMYuPpWTp6JzA",
  authDomain: "schoolkingdom-d46bc.firebaseapp.com",
  projectId: "schoolkingdom-d46bc",
  storageBucket: "schoolkingdom-d46bc.firebasestorage.app",
  messagingSenderId: "253979875433",
  appId: "1:253979875433:web:db79507d2398e0d0502af8",
  measurementId: "G-X67FH9BPM3"
};


const app = initializeApp(firebaseConfig);

export const db = getFirestore(app);
export const auth = getAuth(app);
export const storage = getStorage(app);
