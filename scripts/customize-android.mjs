// Personaliza el proyecto Android generado por Capacitor
import fs from 'node:fs';

const manifest = 'android/app/src/main/AndroidManifest.xml';
let xml = fs.readFileSync(manifest, 'utf8');

// App solo en vertical (más cómodo en el taller)
if (!xml.includes('screenOrientation')) {
  xml = xml.replace('<activity', '<activity android:screenOrientation="portrait"');
}
fs.writeFileSync(manifest, xml);
console.log('AndroidManifest personalizado');
