// Personaliza el proyecto Android generado por Capacitor:
// orientación vertical, ícono de la app y pantalla de arranque con el logo de RiCar Solutions.
import fs from 'node:fs';
import path from 'node:path';

/* ---- Orientación: solo vertical (más cómodo en el taller) ---- */
const manifest = 'android/app/src/main/AndroidManifest.xml';
let xml = fs.readFileSync(manifest, 'utf8');
if (!xml.includes('screenOrientation')) {
  xml = xml.replace('<activity', '<activity android:screenOrientation="portrait"');
}
// Permiso para mostrar avisos (Android 13 en adelante): vencimientos de pagos a proveedores
if (!xml.includes('POST_NOTIFICATIONS')) {
  xml = xml.replace('<application', '<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />\n    <application');
}
fs.writeFileSync(manifest, xml);
console.log('AndroidManifest personalizado');

/* ---- Número de versión: sube en cada compilación para que Android la instale encima de la anterior ---- */
try {
  const gradle = 'android/app/build.gradle';
  let g = fs.readFileSync(gradle, 'utf8');
  const antes = g;
  g = g.replace(/versionCode\s+\d+/, 'versionCode Integer.parseInt(System.getenv("VERSION_CODE") ?: "1")');
  g = g.replace(/versionName\s+"[^"]*"/, 'versionName "1.2.${System.getenv("VERSION_CODE") ?: "0"}"');
  if (g === antes) console.warn('AVISO: no se encontró versionCode en build.gradle; la versión no sube sola.');
  else { fs.writeFileSync(gradle, g); console.log('Versión automática configurada'); }
} catch (e) {
  console.warn('AVISO: no se pudo configurar la versión automática:', e.message);
}

/* ---- Ícono y pantalla de arranque ---- */
const res = 'android/app/src/main/res';
const densidades = ['mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi'];

try {
  // Íconos: clásico (Android 7 y anteriores) y primer plano del ícono adaptable
  for (const d of densidades) {
    const dir = path.join(res, `mipmap-${d}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(`brand/legacy-${d}.png`, path.join(dir, 'ic_launcher.png'));
    fs.copyFileSync(`brand/legacy-${d}.png`, path.join(dir, 'ic_launcher_round.png'));
    fs.copyFileSync(`brand/foreground-${d}.png`, path.join(dir, 'ricar_icon_foreground.png'));
  }

  // Ícono adaptable (Android 8 en adelante): fondo negro + logo
  const adaptable = `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ricar_icon_background"/>
    <foreground android:drawable="@mipmap/ricar_icon_foreground"/>
</adaptive-icon>
`;
  const anydpi = path.join(res, 'mipmap-anydpi-v26');
  fs.mkdirSync(anydpi, { recursive: true });
  fs.writeFileSync(path.join(anydpi, 'ic_launcher.xml'), adaptable);
  fs.writeFileSync(path.join(anydpi, 'ic_launcher_round.xml'), adaptable);

  const values = path.join(res, 'values');
  fs.mkdirSync(values, { recursive: true });
  fs.writeFileSync(path.join(values, 'ricar_colors.xml'),
    `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="ricar_icon_background">#000000</color>
</resources>
`);

  // Pantalla de arranque: se reemplaza cualquier splash.png del proyecto
  let reemplazados = 0;
  const recorrer = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) recorrer(p);
      else if (e.name === 'splash.png') { fs.copyFileSync('brand/splash.png', p); reemplazados++; }
    }
  };
  recorrer(res);
  console.log(`Ícono personalizado. Pantallas de arranque reemplazadas: ${reemplazados}`);
} catch (e) {
  // No se detiene la compilación: la app saldría con el ícono por defecto
  console.warn('AVISO: no se pudo personalizar el ícono:', e.message);
}
