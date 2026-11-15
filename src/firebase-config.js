// Configuración del proyecto de Firebase "ricar-solutions".
// (Estas claves no son secretas: la seguridad la dan las reglas de Firestore y el inicio de sesión.)
export const firebaseConfig = {
  apiKey: 'AIzaSyAeMmTgSL57WgeGjZDT-WBEPurrTqI9GcY',
  authDomain: 'ricar-solutions.firebaseapp.com',
  projectId: 'ricar-solutions',
  storageBucket: 'ricar-solutions.firebasestorage.app',
  messagingSenderId: '801915838344',
  appId: '1:801915838344:web:adef33fb06cc8b019de43d'
};

// Correos de los perfiles (deben coincidir con los de firestore.rules).
// Cualquier otro usuario entra con el perfil Taller.
export const OWNER_EMAIL = 'ricarsolutions@gmail.com';
export const ADMIN_EMAIL = 'luiskenneths@gmail.com';
