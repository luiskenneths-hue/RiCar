# RiCar Solutions

## 1. Firebase (una sola vez)
1. console.firebase.google.com > Crear proyecto "ricar-solutions".
2. Authentication > Comenzar > Correo y contraseña > Habilitar. En "Usuarios", crea tres usuarios: Admin (desarrollo), Dueño y Taller (tu empleado).
3. Firestore Database > Crear base de datos > modo producción.
4. Configuración del proyecto > Tus apps > Web (</>) > registra la app y copia el bloque de configuración.
5. Firestore > Reglas: pega el contenido de `firestore.rules` (cambia `dueno@correo.com` por tu correo) y publica.

## 2. Configurar la app
Abre `src/firebase-config.js`, pega las claves y escribe los correos en `OWNER_EMAIL` y `ADMIN_EMAIL` (los mismos de las reglas).

## 3. GitHub
Crea un repositorio nuevo, sube TODO el contenido de esta carpeta (incluida `.github`) a la rama `main`.
En la pestaña Actions se compila el APK; lo descargas desde Releases.

## Perfiles
- Admin (correo en `ADMIN_EMAIL`): mismos permisos de datos que el Dueño, más la pantalla "Desarrollo" (versión, conteo de datos y borrado de datos de prueba), que solo ve este perfil.
- Dueño (correo en `OWNER_EMAIL`): ve todo, incluida la utilidad, movimientos del mes, cierre de caja, categorías, datos del taller y exportación.
- Taller (cualquier otro usuario): crea órdenes, cobros y gastos, y solo ve lo que él registró hoy.
