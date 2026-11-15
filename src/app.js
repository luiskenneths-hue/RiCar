import './styles.css';
import '@fontsource/barlow-condensed/600.css';
import '@fontsource/barlow-condensed/700.css';
import '@fontsource/barlow/400.css';
import '@fontsource/barlow/600.css';

import { initializeApp } from 'firebase/app';
import { getAuth, signInWithEmailAndPassword, onAuthStateChanged, signOut } from 'firebase/auth';
import {
  initializeFirestore, persistentLocalCache, persistentSingleTabManager,
  collection, doc, getDocs, setDoc, updateDoc, onSnapshot, query, where, orderBy, limit,
  writeBatch, increment
} from 'firebase/firestore';
import { App as CapApp } from '@capacitor/app';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { jsPDF } from 'jspdf';
import { firebaseConfig, OWNER_EMAIL, ADMIN_EMAIL } from './firebase-config.js';
import { MARCAS } from './vehiculos.js';

/* ---------- Utilidades ---------- */
const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const money = (n) => '₡' + String(Math.round(Math.abs(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
const signed = (n) => (n < 0 ? '−' : '') + money(n);
const toNum = (s) => Number(String(s || '').replace(/[^\d.]/g, '')) || 0;
const plateNorm = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const slug = (s) => String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, '-');
const sum = (arr, k) => arr.reduce((a, x) => a + (Number(x[k]) || 0), 0);
const MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
const mesLabel = (m) => { const [y, mm] = m.split('-'); return `${MESES[+mm - 1]} ${y}`; };
const fechaCorta = (f) => { const [, m, d] = f.split('-'); return `${+d} ${MESES[+m - 1].slice(0, 3).toLowerCase()}`; };
const shiftMes = (m, delta) => { const [y, mm] = m.split('-').map(Number); const d = new Date(y, mm - 1 + delta, 1); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; };

const APP_VERSION = '1.0.0';
const ESTADOS = ['Recibido', 'En reparación', 'Listo', 'Entregado'];
const METODOS = ['Efectivo', 'SINPE Móvil', 'Tarjeta', 'Transferencia'];
const CATEGORIAS = ['Repuestos y materiales', 'Herramientas', 'Alquiler', 'Electricidad, agua e internet', 'Planilla y CCSS', 'INS', 'Combustible', 'Publicidad', 'Mantenimiento del local', 'Impuestos', 'Otros'];

// Categorías que se ofrecen al anotar un gasto (las de Firestore, o las de fábrica si aún no se personalizan)
const catsActivas = () => (S.categorias.length ? S.categorias.filter((c) => c.activa !== false).map((c) => c.nombre) : CATEGORIAS);

const toQty = (s) => Number(String(s ?? '').replace(',', '.').replace(/[^\d.]/g, '')) || 0;
const lineasTotal = (ls) => (ls || []).reduce((a, l) => a + Math.round((Number(l.cant) || 0) * (Number(l.precio) || 0)), 0);
const fechaLarga = (f) => { const [y, m, d] = f.split('-'); return `${+d} de ${MESES[+m - 1].toLowerCase()} de ${y}`; };
const sumarDias = (f, n) => { const [y, m, d] = f.split('-').map(Number); return ymd(new Date(y, m - 1, d + n)); };
const COT_CLASE = { Pendiente: 'en-reparacion', Aprobada: 'listo', Rechazada: 'cancelado' };

const saldo = (o) => Math.max(0, (Number(o.total) || 0) - (Number(o.pagado) || 0));
const abierta = (o) => o.estado !== 'Entregado' && o.estado !== 'Cancelado';

function nuevoNumero(prefijo = 'OT') {
  const d = new Date();
  const r = pad(Math.floor(Math.random() * 100));
  return `${prefijo}-${String(d.getFullYear()).slice(2)}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}-${r}`;
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('on'), 2600);
}
function fail(err) {
  console.error(err);
  const c = err && err.code;
  toast(c === 'permission-denied' ? 'No tienes permiso para esta acción' : 'Algo salió mal. Intenta de nuevo');
}

/* ---------- Estado ---------- */
const S = {
  user: null, isOwner: false, isAdmin: false, tab: 'inicio', mes: ymd().slice(0, 7),
  ordenes: [], pagos: [], gastos: [], vehiculos: {}, categorias: [], sembrando: false, cotizaciones: [], taller: {}, vistaOrd: 'ordenes', docPages: null, docNombre: '',
  filtro: 'abiertas', busqueda: '', unsubs: [], unsubMov: null, movDia: ymd(),
  online: navigator.onLine, cierre: null
};

const configurado = !String(firebaseConfig.apiKey).startsWith('PEGAR');
let auth, db;
if (configurado) {
  const fb = initializeApp(firebaseConfig);
  auth = getAuth(fb);
  db = initializeFirestore(fb, { localCache: persistentLocalCache({ tabManager: persistentSingleTabManager({}) }) });
}

/* ---------- Datos en vivo ---------- */
function stopAll() {
  S.unsubs.forEach((u) => u());
  S.unsubs = [];
  if (S.unsubMov) S.unsubMov();
  S.unsubMov = null;
}

function startListeners() {
  stopAll();
  S.unsubs.push(onSnapshot(
    query(collection(db, 'ordenes'), orderBy('creadoEn', 'desc'), limit(300)),
    (snap) => { S.ordenes = snap.docs.map((d) => ({ id: d.id, ...d.data() })); render(); },
    fail
  ));
  S.unsubs.push(onSnapshot(collection(db, 'vehiculos'), (snap) => {
    S.vehiculos = {};
    snap.forEach((d) => { S.vehiculos[d.id] = d.data(); });
  }, fail));
  S.unsubs.push(onSnapshot(
    query(collection(db, 'cotizaciones'), orderBy('creadoEn', 'desc'), limit(200)),
    (snap) => { S.cotizaciones = snap.docs.map((d) => ({ id: d.id, ...d.data() })); render(); },
    fail
  ));
  S.unsubs.push(onSnapshot(doc(db, 'config', 'taller'), (snap) => { S.taller = snap.exists() ? snap.data() : {}; }, fail));
  S.unsubs.push(onSnapshot(
    query(collection(db, 'categorias'), orderBy('creadoEn', 'asc')),
    (snap) => {
      S.categorias = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      if (S.categorias.length) S.sembrando = false;
      refrescarCats();
    },
    fail
  ));
  subscribeMov();
}

function subscribeMov() {
  if (S.unsubMov) S.unsubMov();
  S.movDia = ymd();
  const filtros = S.isOwner
    ? [where('fecha', '>=', S.mes + '-01'), where('fecha', '<=', S.mes + '-31')]
    : [where('creadoPor', '==', S.user.uid), where('fecha', '==', S.movDia)];
  const u1 = onSnapshot(query(collection(db, 'pagos'), ...filtros), (snap) => {
    S.pagos = snap.docs.map((d) => ({ id: d.id, ...d.data() })); render();
  }, fail);
  const u2 = onSnapshot(query(collection(db, 'gastos'), ...filtros), (snap) => {
    S.gastos = snap.docs.map((d) => ({ id: d.id, ...d.data() })); render();
  }, fail);
  S.unsubMov = () => { u1(); u2(); };
}

/* ---------- Render ---------- */
const ICONOS = {
  inicio: '<path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/>',
  ordenes: '<path d="M9 4h6l1 2h3v14H5V6h3z"/><path d="M9 12h6M9 16h4"/>',
  mov: '<path d="M7 4v14M3 14l4 4 4-4"/><path d="M17 20V6M13 10l4-4 4 4"/>',
  mas: '<path d="M4 7h16M4 12h16M4 17h16"/>'
};

function render() {
  if (!configurado) return renderSetup();
  if (!S.user) return renderLogin();
  const y = window.scrollY;
  const vistas = { inicio: vInicio, ordenes: vOrdenes, mov: vMov, mas: vMas };
  const tabs = [['inicio', 'Inicio'], ['ordenes', 'Órdenes'], ['mov', S.isOwner ? 'Movimientos' : 'Mis registros'], ['mas', 'Más']];
  $('#app').innerHTML = `
    <header class="top">
      <div class="marca">RiCar <span>Solutions</span></div>
      <span class="pill ${S.online ? '' : 'off'}">${S.online ? (S.isAdmin ? 'Admin' : S.isOwner ? 'Dueño' : 'Taller') : 'Sin conexión'}</span>
    </header>
    <main>${vistas[S.tab]()}</main>
    <button class="fab" data-act="nuevo" aria-label="Agregar">+</button>
    <nav class="nav"><div class="navin">
      ${tabs.map(([k, l]) => `<button data-act="tab" data-k="${k}" class="${S.tab === k ? 'on' : ''}"><svg viewBox="0 0 24 24">${ICONOS[k]}</svg>${l}</button>`).join('')}
    </div></nav>`;
  window.scrollTo(0, y);
}

function renderSetup() {
  $('#app').innerHTML = `<div class="login"><div class="marca">RiCar Solutions</div>
    <p>Falta conectar la app con Firebase. Abre <b>src/firebase-config.js</b>, pega la configuración de tu proyecto, sube los cambios a GitHub y vuelve a compilar el APK.</p></div>`;
}

function renderLogin(error = '') {
  $('#app').innerHTML = `<form class="login" data-form="login">
    <div class="marca"><span>RiCar</span> Solutions</div>
    <p>Entra con tu correo para ver el taller.</p>
    <div class="campo"><label for="em">Correo</label><input id="em" name="email" type="email" autocomplete="username" required></div>
    <div class="campo"><label for="pw">Contraseña</label><input id="pw" name="password" type="password" autocomplete="current-password" required></div>
    <div class="error" id="err">${esc(error)}</div>
    <button class="btn" type="submit">Entrar</button></form>`;
}

function filaOrden(o) {
  const s = saldo(o);
  const estado = o.estado || 'Recibido';
  let cobro = '<span class="sub">Sin monto</span>';
  if (o.estado === 'Cancelado') cobro = '<span class="sub">Cancelada</span>';
  else if (o.total > 0) cobro = s > 0 ? `<span class="deuda">Debe ${money(s)}</span>` : '<span class="ok">Pagada</span>';
  const quien = [o.cliente, o.marca].filter(Boolean).join(' · ') || 'Sin nombre';
  return `<button class="fila e-l-${slug(estado)}" data-act="orden" data-id="${o.id}">
    <div class="fila-a"><span class="placa">${esc(o.placa)}</span><span class="badge e-${slug(estado)}">${esc(estado)}</span></div>
    <div class="fila-b"><strong>${esc(quien)}</strong><span>${esc(o.problema)}</span></div>
    <div class="fila-c">${cobro}</div></button>`;
}

function selectorMes() {
  return `<div class="mes"><button data-act="mes" data-d="-1" aria-label="Mes anterior">‹</button><strong>${mesLabel(S.mes)}</strong>
    <button data-act="mes" data-d="1" aria-label="Mes siguiente">›</button></div>`;
}

function vInicio() {
  const abiertas = S.ordenes.filter(abierta);
  const enTaller = abiertas.length
    ? `<div class="lista">${abiertas.slice(0, 6).map(filaOrden).join('')}</div>`
    : '<div class="vacio">No hay vehículos en el taller. Toca + para recibir uno.</div>';

  if (!S.isOwner) {
    const nombre = (S.user.email || '').split('@')[0];
    return `<h1 class="titulo">Hola, ${esc(nombre)}</h1>
      <div class="libro">
        <div><span>Vehículos en el taller</span><b>${abiertas.length}</b></div>
        <div><span>Cobros que registraste hoy</span><b>${money(sum(S.pagos, 'monto'))}</b></div>
        <div><span>Gastos que registraste hoy</span><b>${money(sum(S.gastos, 'monto'))}</b></div>
      </div>
      <h3 class="sec">En el taller</h3>${enTaller}`;
  }

  const ing = sum(S.pagos, 'monto');
  const gas = sum(S.gastos, 'monto');
  const ut = ing - gas;
  const porCobrar = S.ordenes.filter((o) => o.estado !== 'Cancelado').reduce((a, o) => a + saldo(o), 0);
  const cats = {};
  S.gastos.forEach((g) => { cats[g.categoria] = (cats[g.categoria] || 0) + g.monto; });
  const catList = Object.entries(cats).sort((a, b) => b[1] - a[1]);
  const max = catList.length ? catList[0][1] : 1;

  return `${selectorMes()}
    <div class="hero"><small>Utilidad de ${mesLabel(S.mes)}</small><div class="cifra ${ut < 0 ? 'neg' : ''}">${signed(ut)}</div></div>
    <div class="libro">
      <div><span>Ingresos</span><b class="ok">${money(ing)}</b></div>
      <div><span>Gastos</span><b class="deuda">${money(gas)}</b></div>
      <div><span>Por cobrar (todas las órdenes)</span><b>${money(porCobrar)}</b></div>
      <div><span>Vehículos en el taller</span><b>${abiertas.length}</b></div>
    </div>
    <h3 class="sec">Gastos por categoría</h3>
    ${catList.length ? `<div class="barras">${catList.map(([c, v]) => `<div><div class="barra-t"><span>${esc(c)}</span><b>${money(v)}</b></div><div class="barra"><i style="width:${Math.max(3, v / max * 100)}%"></i></div></div>`).join('')}</div>` : '<div class="vacio">Sin gastos este mes.</div>'}
    <h3 class="sec">En el taller</h3>${enTaller}`;
}

function ordenesFiltradas() {
  const q = S.busqueda.trim().toLowerCase();
  const qp = plateNorm(S.busqueda);
  return S.ordenes.filter((o) => {
    if (S.filtro === 'abiertas' && !abierta(o)) return false;
    if (S.filtro === 'listas' && o.estado !== 'Listo') return false;
    if (S.filtro === 'cobrar' && !(o.estado !== 'Cancelado' && saldo(o) > 0)) return false;
    if (!q) return true;
    return (qp && o.placa.includes(qp)) || (o.cliente || '').toLowerCase().includes(q) ||
      (o.problema || '').toLowerCase().includes(q) || (o.numero || '').toLowerCase().includes(q);
  });
}

function filaCot(c) {
  const k = COT_CLASE[c.estado] || 'recibido';
  const quien = [c.cliente, c.marca].filter(Boolean).join(' · ') || 'Sin nombre';
  const detalle = c.descripcion || (c.lineas || []).map((l) => l.desc).join(', ');
  return `<button class="fila e-l-${k}" data-act="cot" data-id="${c.id}">
    <div class="fila-a"><span class="placa">${esc(c.placa)}</span><span class="badge e-${k}">${esc(c.estado)}</span></div>
    <div class="fila-b"><strong>${esc(quien)}</strong><span>${esc(detalle)}</span></div>
    <div class="fila-c">${money(c.total)} <span class="sub">· ${esc(c.numero)}</span></div></button>`;
}

function htmlLista() {
  if (S.vistaOrd === 'cotizaciones') {
    const q = S.busqueda.trim().toLowerCase();
    const qp = plateNorm(S.busqueda);
    const l = S.cotizaciones.filter((c) => !q || (qp && c.placa.includes(qp)) || (c.cliente || '').toLowerCase().includes(q) ||
      (c.numero || '').toLowerCase().includes(q) || (c.descripcion || '').toLowerCase().includes(q));
    return l.length ? `<div class="lista">${l.map(filaCot).join('')}</div>` : '<div class="vacio">Aún no hay cotizaciones. Toca + para crear una proforma.</div>';
  }
  const l = ordenesFiltradas();
  return l.length ? `<div class="lista">${l.map(filaOrden).join('')}</div>` : '<div class="vacio">No hay órdenes con este filtro.</div>';
}

function vOrdenes() {
  const cot = S.vistaOrd === 'cotizaciones';
  const f = [['abiertas', 'Abiertas'], ['listas', 'Listas'], ['cobrar', 'Por cobrar'], ['todas', 'Todas']];
  const pend = S.cotizaciones.filter((c) => c.estado === 'Pendiente').length;
  return `<h1 class="titulo">${cot ? 'Cotizaciones' : 'Órdenes'}</h1>
    <div class="chips">
      <button class="chip ${cot ? '' : 'on'}" data-act="vista-ord" data-k="ordenes">Órdenes</button>
      <button class="chip ${cot ? 'on' : ''}" data-act="vista-ord" data-k="cotizaciones">Cotizaciones${pend ? ` (${pend})` : ''}</button>
    </div>
    <div class="campo"><input id="buscar" type="search" placeholder="${cot ? 'Buscar por placa, cliente o número' : 'Buscar por placa, cliente o problema'}" value="${esc(S.busqueda)}"></div>
    ${cot ? '' : `<div class="chips">${f.map(([k, l]) => `<button class="chip ${S.filtro === k ? 'on' : ''}" data-act="filtro" data-k="${k}">${l}</button>`).join('')}</div>`}
    <div id="lista-ordenes">${htmlLista()}</div>`;
}

function vMov() {
  const items = [
    ...S.pagos.map((p) => ({ ...p, t: 'pago' })),
    ...S.gastos.map((g) => ({ ...g, t: 'gasto' }))
  ].sort((a, b) => (b.fecha + String(b.creadoEn).padStart(15, '0')).localeCompare(a.fecha + String(a.creadoEn).padStart(15, '0')));
  const filas = items.map((m) => {
    const entra = m.t === 'pago';
    const desc = entra ? (m.placa ? `Cobro · ${m.placa}` : `Ingreso · ${m.concepto || 'Venta suelta'}`) : (m.categoria || 'Gasto');
    const det = [fechaCorta(m.fecha), m.metodo, (m.porEmail || '').split('@')[0]].filter(Boolean).join(' · ');
    return `<button class="fila mov ${entra ? 'in' : 'out'}" data-act="mov" data-t="${m.t}" data-id="${m.id}">
      <div class="fila-b"><strong>${esc(desc)}</strong><span>${esc(det)}</span></div>
      <div class="monto">${entra ? '+' : '−'}${money(m.monto)}</div></button>`;
  }).join('');
  return `<h1 class="titulo">${S.isOwner ? 'Movimientos' : 'Lo que registré hoy'}</h1>
    ${S.isOwner ? selectorMes() : ''}
    ${items.length ? `<div class="lista">${filas}</div>` : '<div class="vacio">Todavía no hay movimientos. Toca + para registrar un cobro o un gasto.</div>'}`;
}

function vMas() {
  const botones = [];
  if (S.isOwner) {
    botones.push('<button class="btn oscuro" data-act="cierre">Cierre de caja</button>');
    botones.push('<button class="btn sec" data-act="categorias">Categorías de gastos</button>');
    botones.push('<button class="btn sec" data-act="taller">Datos del taller (para proformas)</button>');
    botones.push('<button class="btn sec" data-act="exportar">Exportar el mes a Excel (CSV)</button>');
  }
  if (S.isAdmin) botones.push('<button class="btn oscuro" data-act="desarrollo">Desarrollo (solo Admin)</button>');
  botones.push('<button class="btn sec" data-act="salir">Cerrar sesión</button>');
  return `<h1 class="titulo">Más</h1>
    <div class="libro"><div><span>Sesión</span><b style="font-size:17px">${esc(S.user.email)}</b></div></div>
    <div class="btns">${botones.join('')}</div>`;
}

/* ---------- Hoja inferior ---------- */
function openSheet(titulo, html) {
  $('#sheet').innerHTML = `<div class="scrim" data-act="cerrar"></div><div class="sheet" role="dialog" aria-modal="true"><div class="grab"></div><h2>${titulo}</h2>${html}</div>`;
}
function closeSheet() { $('#sheet').innerHTML = ''; }
const sheetAbierta = () => !!$('#sheet').firstChild;

function opcionesOrden(sel, soloConSaldo) {
  const l = S.ordenes.filter((o) => o.estado !== 'Cancelado' && (soloConSaldo ? saldo(o) > 0 : true)).slice(0, 60);
  return l.map((o) => `<option value="${o.id}" data-saldo="${saldo(o)}" ${o.id === sel ? 'selected' : ''}>${esc(o.placa)} · ${esc(o.cliente || 'Sin nombre')}${saldo(o) > 0 ? ' · debe ' + money(saldo(o)) : ''}</option>`).join('');
}
const opcionesMetodo = () => METODOS.map((m) => `<option>${m}</option>`).join('');

/* ---------- Vehículo: marca, modelo y año ---------- */
const OTRA = '__otra';

function estadoVeh(v = {}) {
  const e = { marca: '', marcaTxt: '', modelo: '', modeloTxt: '', anio: v.anio || '' };
  if (v.marcaV && MARCAS[v.marcaV]) {
    e.marca = v.marcaV;
    if (v.modelo && MARCAS[v.marcaV].includes(v.modelo)) e.modelo = v.modelo;
    else if (v.modelo) { e.modelo = OTRA; e.modeloTxt = v.modelo; }
  } else if (v.marcaV) {
    e.marca = OTRA; e.marcaTxt = v.marcaV; e.modeloTxt = v.modelo || '';
  } else if (v.marca) {
    e.marca = OTRA; e.marcaTxt = v.marca; // registros anteriores: texto libre
  }
  return e;
}

function opcionesModelo(marca, sel) {
  const l = MARCAS[marca];
  if (!l) return '<option value="">Primero elige la marca</option>';
  return '<option value="">Elegir…</option>' + l.map((m) => `<option ${m === sel ? 'selected' : ''}>${esc(m)}</option>`).join('') +
    `<option value="${OTRA}" ${sel === OTRA ? 'selected' : ''}>Otro modelo…</option>`;
}

function vehiculoHtml(v) {
  const e = estadoVeh(v);
  const marcas = Object.keys(MARCAS).map((m) => `<option ${m === e.marca ? 'selected' : ''}>${esc(m)}</option>`).join('');
  const otraM = e.marca === OTRA;
  return `<div class="fila-2">
      <div class="campo"><label for="v-marca">Marca</label>
        <select id="v-marca" name="vMarca"><option value="">Elegir…</option>${marcas}<option value="${OTRA}" ${otraM ? 'selected' : ''}>Otra marca…</option></select>
        <input name="vMarcaTxt" placeholder="Escribe la marca" value="${esc(e.marcaTxt)}" ${otraM ? '' : 'hidden'}></div>
      <div class="campo"><label for="v-modelo">Modelo</label>
        <select id="v-modelo" name="vModelo" ${otraM ? 'hidden' : ''}>${opcionesModelo(e.marca, e.modelo)}</select>
        <input name="vModeloTxt" placeholder="Escribe el modelo" value="${esc(e.modeloTxt)}" ${otraM || e.modelo === OTRA ? '' : 'hidden'}></div>
    </div>
    <div class="campo"><label for="v-anio">Año (opcional)</label><input id="v-anio" name="vAnio" inputmode="numeric" placeholder="Ej: 2018" value="${esc(e.anio)}"></div>`;
}

function syncVeh(f, marcaCambio) {
  const m = f.vMarca.value;
  if (marcaCambio) f.vModelo.innerHTML = opcionesModelo(m, '');
  f.vMarcaTxt.hidden = m !== OTRA;
  f.vModelo.hidden = m === OTRA;
  f.vModeloTxt.hidden = !(m === OTRA || f.vModelo.value === OTRA);
}

function aplicarVeh(f, v) {
  const e = estadoVeh(v);
  f.vMarca.value = e.marca;
  f.vModelo.innerHTML = opcionesModelo(e.marca, e.modelo);
  f.vMarcaTxt.value = e.marcaTxt;
  f.vModeloTxt.value = e.modeloTxt;
  f.vAnio.value = e.anio;
  syncVeh(f, false);
}

function leerVeh(d) {
  const marcaV = d.vMarca === OTRA ? (d.vMarcaTxt || '').trim() : (d.vMarca || '');
  const modelo = (d.vMarca === OTRA || d.vModelo === OTRA) ? (d.vModeloTxt || '').trim() : (d.vModelo || '');
  const anio = String(d.vAnio || '').replace(/\D/g, '').slice(0, 4);
  return { marcaV, modelo, anio, marca: [marcaV, modelo, anio].filter(Boolean).join(' ') };
}

/* ---------- Repuesto de un gasto -> línea de la orden ---------- */
function htmlLineaGasto() {
  return `<div id="g-linea" hidden>
    <label class="check"><input type="checkbox" name="agregarLinea" checked> Agregar este repuesto al detalle de la orden</label>
    <div class="campo"><label for="g-ld">Descripción en la orden</label><input id="g-ld" name="lineaDesc" placeholder="Ej: Pastillas de freno delanteras" autocomplete="off"></div>
    <div class="campo"><label for="g-pc">Precio al cliente</label><input id="g-pc" name="precioCli" inputmode="numeric" placeholder="₡0"><span class="sub" id="g-gan"></span></div>
  </div>`;
}

function actualizarLineaGasto(f) {
  const blk = f.querySelector('#g-linea');
  if (blk) blk.hidden = !f.ordenId.value || f.ordenId.value === (f.dataset.actual || '');
}

function precioSugerido(f) {
  if (!f.precioCli) return;
  const costo = toNum(f.monto.value);
  const pct = S.taller.margenRepuestos ?? 25;
  if (!f.precioCli.dataset.manual) f.precioCli.value = costo ? Math.round(costo * (1 + pct / 100) / 100) * 100 : '';
  const el = f.querySelector('#g-gan');
  if (el) el.textContent = costo && f.precioCli.value ? `Ganancia en este repuesto: ${signed(toNum(f.precioCli.value) - costo)}` : `Se sugiere ${pct}% sobre el costo; puedes cambiarlo.`;
}

function agregarLineaOrden(b, o, d) {
  const precio = toNum(d.precioCli);
  if (precio <= 0) return false;
  const base = o.lineas && o.lineas.length ? o.lineas : (o.total ? [{ desc: 'Servicio de reparación', cant: 1, precio: o.total }] : []);
  const lineas = [...base, { desc: (d.lineaDesc || '').trim() || 'Repuesto', cant: 1, precio }];
  b.update(doc(db, 'ordenes', o.id), { lineas, total: lineasTotal(lineas) });
  return true;
}

/* ---------- Formularios ---------- */
function formOrden(o) {
  const v = o || {};
  const tieneLineas = !!(v.lineas && v.lineas.length);
  openSheet(o ? 'Editar orden' : 'Nueva orden', `<form data-form="orden">
    <input type="hidden" name="id" value="${esc(v.id || '')}">
    <div class="campo"><label for="f-placa">Placa</label><input id="f-placa" class="placa-in" name="placa" value="${esc(v.placa || '')}" autocomplete="off" autocapitalize="characters" required></div>
    ${vehiculoHtml(v)}
    <div class="campo"><label for="f-tel">Teléfono</label><input id="f-tel" name="telefono" type="tel" value="${esc(v.telefono || '')}"></div>
    <div class="campo"><label for="f-cli">Cliente</label><input id="f-cli" name="cliente" value="${esc(v.cliente || '')}"></div>
    <div class="campo"><label for="f-prob">Problema</label><textarea id="f-prob" name="problema" required>${esc(v.problema || '')}</textarea></div>
    ${o ? `<div class="campo"><label for="f-trab">Trabajos realizados</label><textarea id="f-trab" name="trabajos">${esc(v.trabajos || '')}</textarea></div>` : ''}
    <div class="campo"><label for="f-total">Monto a cobrar</label><input id="f-total" name="total" inputmode="numeric" value="${v.total || ''}" placeholder="₡0" ${tieneLineas ? 'readonly' : ''}>${tieneLineas ? '<span class="sub">Se calcula con el detalle del trabajo.</span>' : ''}</div>
    <button class="btn" type="submit">Guardar orden</button></form>`);
}

function formCobro(ordenId) {
  const o = S.ordenes.find((x) => x.id === ordenId);
  openSheet('Registrar cobro', `<form data-form="cobro">
    <div class="campo"><label for="c-or">Orden</label><select id="c-or" name="ordenId"><option value="" data-saldo="">Venta suelta (sin orden)</option>${opcionesOrden(ordenId, true)}</select></div>
    <div class="campo"><label for="c-mo">Monto cobrado</label><input id="c-mo" name="monto" inputmode="numeric" value="${o ? saldo(o) : ''}" placeholder="₡0" required></div>
    <div class="campo"><label for="c-me">Método de pago</label><select id="c-me" name="metodo">${opcionesMetodo()}</select></div>
    <div class="campo"><label for="c-co">Detalle (opcional)</label><input id="c-co" name="concepto" placeholder="Ej: venta de aceite"></div>
    <button class="btn" type="submit">Registrar cobro</button></form>`);
}

function formGasto() {
  openSheet('Anotar gasto', `<form data-form="gasto">
    <div class="campo"><label for="g-mo">Monto</label><input id="g-mo" name="monto" inputmode="numeric" placeholder="₡0" required></div>
    <div class="campo"><label for="g-ca">Categoría</label><select id="g-ca" name="categoria">${catsActivas().map((c) => `<option>${esc(c)}</option>`).join('')}</select></div>
    <div class="fila-2">
      <div class="campo"><label for="g-me">Pagado con</label><select id="g-me" name="metodo">${opcionesMetodo()}</select></div>
      <div class="campo"><label for="g-fe">Fecha</label><input id="g-fe" name="fecha" type="date" value="${ymd()}" required></div>
    </div>
    <div class="campo"><label for="g-pr">Proveedor</label><input id="g-pr" name="proveedor"></div>
    <div class="campo"><label for="g-no">Detalle</label><input id="g-no" name="nota" placeholder="Ej: filtro de aceite"></div>
    <div class="campo"><label for="g-or">Asociar a una orden (opcional)</label><select id="g-or" name="ordenId"><option value="">Ninguna</option>${opcionesOrden('', false)}</select></div>
    ${htmlLineaGasto()}
    <button class="btn" type="submit">Guardar gasto</button></form>`);
}

const FORMS = {
  login: async (f) => {
    const d = Object.fromEntries(new FormData(f));
    const btn = f.querySelector('button');
    btn.disabled = true;
    try {
      await signInWithEmailAndPassword(auth, d.email.trim(), d.password);
    } catch (e) {
      const msg = e.code === 'auth/network-request-failed' ? 'Sin internet. Conéctate para entrar por primera vez.' : 'Correo o contraseña incorrectos.';
      renderLogin(msg);
    }
  },

  orden: (f) => {
    const d = Object.fromEntries(new FormData(f));
    const placa = plateNorm(d.placa);
    if (placa.length < 3) return toast('Escribe la placa del vehículo');
    if (!d.problema.trim()) return toast('Describe el problema');
    const veh = { placa, ...leerVeh(d), cliente: d.cliente.trim(), telefono: d.telefono.trim() };
    const b = writeBatch(db);
    b.set(doc(db, 'vehiculos', placa), veh, { merge: true });
    if (d.id) {
      const ex = S.ordenes.find((x) => x.id === d.id);
      const patch = { ...veh, problema: d.problema.trim(), trabajos: (d.trabajos || '').trim() };
      if (!(ex && ex.lineas && ex.lineas.length)) patch.total = toNum(d.total);
      b.update(doc(db, 'ordenes', d.id), patch);
    } else {
      b.set(doc(collection(db, 'ordenes')), {
        numero: nuevoNumero(), ...veh, problema: d.problema.trim(), trabajos: '', estado: 'Recibido',
        total: toNum(d.total), pagado: 0, creadoPor: S.user.uid, porEmail: S.user.email, creadoEn: Date.now()
      });
    }
    b.commit().catch(fail);
    closeSheet();
    toast('Orden guardada');
  },

  cobro: (f) => {
    const d = Object.fromEntries(new FormData(f));
    const monto = toNum(d.monto);
    if (monto <= 0) return toast('Escribe el monto cobrado');
    const o = S.ordenes.find((x) => x.id === d.ordenId);
    if (o && monto > saldo(o) && !confirm(`El monto es mayor al saldo (${money(saldo(o))}). ¿Registrar de todos modos?`)) return;
    const b = writeBatch(db);
    b.set(doc(collection(db, 'pagos')), {
      ordenId: o ? o.id : null, numero: o ? o.numero : null, placa: o ? o.placa : null,
      concepto: d.concepto.trim(), monto, metodo: d.metodo, fecha: ymd(),
      creadoPor: S.user.uid, porEmail: S.user.email, creadoEn: Date.now()
    });
    if (o) b.update(doc(db, 'ordenes', o.id), { pagado: increment(monto) });
    b.commit().catch(fail);
    closeSheet();
    toast('Cobro registrado');
  },

  gasto: (f) => {
    const d = Object.fromEntries(new FormData(f));
    const monto = toNum(d.monto);
    if (monto <= 0) return toast('Escribe el monto del gasto');
    const o = S.ordenes.find((x) => x.id === d.ordenId);
    const b = writeBatch(db);
    b.set(doc(collection(db, 'gastos')), {
      monto, categoria: d.categoria, metodo: d.metodo, fecha: d.fecha, proveedor: d.proveedor.trim(), nota: d.nota.trim(),
      ordenId: o ? o.id : null, placa: o ? o.placa : null,
      creadoPor: S.user.uid, porEmail: S.user.email, creadoEn: Date.now()
    });
    const agregado = !!(o && d.agregarLinea && agregarLineaOrden(b, o, d));
    b.commit().catch(fail);
    closeSheet();
    toast(agregado ? 'Gasto guardado y repuesto agregado a la orden' : 'Gasto guardado');
  },

  'gasto-orden': (f) => {
    const d = Object.fromEntries(new FormData(f));
    const g = S.gastos.find((x) => x.id === d.id);
    if (!g) return;
    const o = S.ordenes.find((x) => x.id === d.ordenId);
    const b = writeBatch(db);
    b.update(doc(db, 'gastos', g.id), { ordenId: o ? o.id : null, placa: o ? o.placa : null });
    const agregado = !!(o && o.id !== (g.ordenId || '') && d.agregarLinea && agregarLineaOrden(b, o, d));
    b.commit().catch(fail);
    closeSheet();
    toast(agregado ? 'Orden asociada y repuesto agregado al detalle' : 'Orden asociada actualizada');
  },

  detalle: (f) => {
    const id = new FormData(f).get('id');
    const lineas = leerLineas(f);
    updateDoc(doc(db, 'ordenes', id), { lineas, total: lineasTotal(lineas) }).catch(fail);
    closeSheet();
    toast('Detalle guardado');
  },

  cot: (f) => {
    const d = Object.fromEntries(new FormData(f));
    const placa = plateNorm(d.placa);
    if (placa.length < 3) return toast('Escribe la placa del vehículo');
    const lineas = leerLineas(f);
    if (!lineas.length || lineasTotal(lineas) <= 0) return toast('Agrega al menos una línea con su precio');
    const veh = { placa, ...leerVeh(d), cliente: d.cliente.trim(), telefono: d.telefono.trim() };
    const datos = { ...veh, descripcion: d.descripcion.trim(), lineas, total: lineasTotal(lineas), validez: Math.max(1, Math.round(toNum(d.validez)) || 8) };
    const b = writeBatch(db);
    b.set(doc(db, 'vehiculos', placa), veh, { merge: true });
    if (d.id) b.update(doc(db, 'cotizaciones', d.id), datos);
    else {
      b.set(doc(collection(db, 'cotizaciones')), {
        numero: nuevoNumero('CO'), ...datos, estado: 'Pendiente', fecha: ymd(), ordenId: null,
        creadoPor: S.user.uid, porEmail: S.user.email, creadoEn: Date.now()
      });
    }
    b.commit().catch(fail);
    closeSheet();
    toast('Cotización guardada');
  },

  taller: (f) => {
    const d = Object.fromEntries(new FormData(f));
    setDoc(doc(db, 'config', 'taller'), {
      nombre: d.nombre.trim(), cedula: d.cedula.trim(), telefono: d.telefono.trim(), correo: d.correo.trim(),
      direccion: d.direccion.trim(), notaPie: d.notaPie.trim(), validezDias: Math.max(1, Math.round(toNum(d.validezDias)) || 8),
      margenRepuestos: d.margenRepuestos === '' ? 25 : toNum(d.margenRepuestos)
    }).catch(fail);
    closeSheet();
    toast('Datos del taller guardados');
  },

  'dev-borrar': (f) => {
    if (!S.isAdmin) return;
    if (f.confirmar.value.trim().toUpperCase() !== 'BORRAR') return toast('Escribe BORRAR para confirmar');
    f.confirmar.value = '';
    borrarDatosPrueba();
  },

  'cat-nueva': (f) => {
    const nombre = new FormData(f).get('nombre').trim();
    if (!nombre) return toast('Escribe el nombre de la categoría');
    if (catExiste(nombre)) return toast('Ya existe una categoría con ese nombre');
    setDoc(doc(collection(db, 'categorias')), { nombre, activa: true, creadoEn: Date.now() }).catch(fail);
    f.reset();
    toast('Categoría agregada');
  },

  cierre: (f) => {
    const d = Object.fromEntries(new FormData(f));
    if (!S.cierre || S.cierre.fecha !== d.fecha) return toast('Espera a que cargue el resumen del día');
    const contado = toNum(d.contado);
    const esperado = toNum(d.inicial) + S.cierre.efIn - S.cierre.efOut;
    setDoc(doc(db, 'cierres', d.fecha), {
      fecha: d.fecha, inicial: toNum(d.inicial), efectivoCobrado: S.cierre.efIn, efectivoGastado: S.cierre.efOut,
      esperado, contado, diferencia: contado - esperado, nota: d.nota.trim(), por: S.user.email, creadoEn: Date.now()
    }).catch(fail);
    closeSheet();
    toast('Cierre de caja guardado');
  }
};

/* ---------- Detalle de orden ---------- */
async function verOrden(id) {
  const o = S.ordenes.find((x) => x.id === id);
  if (!o) return;
  const i = ESTADOS.indexOf(o.estado);
  const sig = i >= 0 && i < ESTADOS.length - 1 ? ESTADOS[i + 1] : null;
  const s = saldo(o);
  const cerrada = !abierta(o);
  openSheet(`<span class="placa grande">${esc(o.placa)}</span>`, `
    <span class="badge e-${slug(o.estado)}">${esc(o.estado)}</span> <span class="sub">${esc(o.numero || '')}</span>
    <dl class="kv">
      <dt>Cliente</dt><dd>${esc(o.cliente || '—')}</dd>
      <dt>Vehículo</dt><dd>${esc(o.marca || '—')}</dd>
      <dt>Teléfono</dt><dd>${o.telefono ? `<a href="tel:${esc(o.telefono)}">${esc(o.telefono)}</a>` : '—'}</dd>
      <dt>Problema</dt><dd>${esc(o.problema)}</dd>
      ${o.trabajos ? `<dt>Trabajos</dt><dd>${esc(o.trabajos)}</dd>` : ''}
      <dt>Monto</dt><dd>${o.total ? money(o.total) : '—'}</dd>
      <dt>Pagado</dt><dd>${money(o.pagado)}</dd>
      <dt>Saldo</dt><dd class="${s > 0 ? 'deuda' : 'ok'}">${money(s)}</dd>
    </dl>
    ${lineasResumen(o.lineas)}
    <div id="extra"></div>
    <div class="btns">
      ${s > 0 && o.estado !== 'Cancelado' ? `<button class="btn" data-act="cobrar" data-id="${o.id}">Cobrar ${money(s)}</button>` : ''}
      ${sig ? `<button class="btn oscuro" data-act="estado" data-id="${o.id}" data-val="${sig}">Pasar a ${sig.toLowerCase()}</button>` : ''}
      ${o.telefono ? `<a class="btn sec" style="text-decoration:none;display:grid;place-items:center" href="https://wa.me/506${esc(o.telefono.replace(/\D/g, '').replace(/^506/, ''))}">WhatsApp al cliente</a>` : ''}
      <button class="btn sec" data-act="detalle" data-id="${o.id}">Detalle y precio (repuestos y mano de obra)</button>
      <button class="btn sec" data-act="doc-orden" data-id="${o.id}">Ver comprobante del trabajo</button>
      <button class="btn sec" data-act="editar" data-id="${o.id}">Editar datos</button>
      ${!cerrada ? `<button class="link" data-act="estado" data-id="${o.id}" data-val="Cancelado">Cancelar orden</button>` : ''}
    </div>`);

  if (S.isOwner) {
    try {
      const [p, g] = await Promise.all([
        getDocs(query(collection(db, 'pagos'), where('ordenId', '==', id))),
        getDocs(query(collection(db, 'gastos'), where('ordenId', '==', id)))
      ]);
      const pagos = p.docs.map((d) => d.data());
      const gastos = g.docs.map((d) => d.data());
      const gasto = sum(gastos, 'monto');
      const el = $('#extra');
      if (el && (pagos.length || gastos.length)) {
        el.innerHTML = `<h3 class="sec" style="margin-top:6px">Cuentas de la orden</h3><div class="pagos-l">
          ${pagos.map((x) => `<div><span>Cobro ${fechaCorta(x.fecha)} · ${esc(x.metodo)}</span><b>${money(x.monto)}</b></div>`).join('')}
          ${gastos.map((x) => `<div><span>${esc(x.categoria)}${x.nota ? ' · ' + esc(x.nota) : ''}</span><b class="deuda">−${money(x.monto)}</b></div>`).join('')}
          <div><span><b>Ganancia de esta orden</b></span><b class="${sum(pagos, 'monto') - gasto < 0 ? 'deuda' : 'ok'}">${signed(sum(pagos, 'monto') - gasto)}</b></div></div>`;
      }
    } catch (e) { /* sin conexión: se omite el detalle financiero */ }
  }
}

function verMov(t, id) {
  const m = (t === 'pago' ? S.pagos : S.gastos).find((x) => x.id === id);
  if (!m) return;
  const filas = t === 'pago'
    ? [['Fecha', fechaCorta(m.fecha)], ['Monto', money(m.monto)], ['Método', m.metodo], ['Orden', m.placa || 'Venta suelta'], ['Detalle', m.concepto || '—'], ['Registrado por', m.porEmail]]
    : [['Fecha', fechaCorta(m.fecha)], ['Monto', money(m.monto)], ['Categoría', m.categoria], ['Pagado con', m.metodo], ['Proveedor', m.proveedor || '—'], ['Detalle', m.nota || '—'], ['Orden', m.placa || '—'], ['Registrado por', m.porEmail]];
  const asociar = t === 'gasto' ? `<form data-form="gasto-orden" data-actual="${esc(m.ordenId || '')}">
      <input type="hidden" name="id" value="${esc(m.id)}"><input type="hidden" name="monto" value="${esc(m.monto)}">
      <div class="campo"><label for="g-or">Orden asociada</label><select id="g-or" name="ordenId"><option value="">Ninguna</option>${opcionesOrden(m.ordenId, false)}</select></div>
      ${htmlLineaGasto()}
      <button class="btn sec" type="submit">Guardar orden asociada</button></form>` : '';
  openSheet(t === 'pago' ? 'Cobro' : 'Gasto', `<dl class="kv">${filas.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
    ${asociar}
    ${S.isOwner ? `<div class="btns"><button class="btn peligro" data-act="borrar-mov" data-t="${t}" data-id="${id}">Eliminar</button></div>` : ''}`);
  const fa = document.querySelector('form[data-form="gasto-orden"]');
  if (fa) { fa.lineaDesc.value = m.nota || m.categoria || 'Repuesto'; precioSugerido(fa); }
}

/* ---------- Cierre de caja y exportación ---------- */
function abrirCierre() {
  S.cierre = null;
  openSheet('Cierre de caja', `<form data-form="cierre">
    <div class="campo"><label for="ci-f">Día</label><input id="ci-f" name="fecha" type="date" value="${ymd()}" data-cierre required></div>
    <div id="ci-res" class="libro"><div><span>Calculando…</span></div></div>
    <div class="campo"><label for="ci-i">Efectivo con el que abrió la caja</label><input id="ci-i" name="inicial" inputmode="numeric" placeholder="₡0" data-cierre></div>
    <div class="campo"><label for="ci-c">Efectivo contado ahora</label><input id="ci-c" name="contado" inputmode="numeric" placeholder="₡0" data-cierre required></div>
    <div class="campo"><label for="ci-n">Nota (opcional)</label><input id="ci-n" name="nota"></div>
    <div id="ci-dif" class="sub" style="margin-bottom:12px"></div>
    <button class="btn" type="submit">Guardar cierre</button></form>`);
  calcCierre(ymd());
}

async function calcCierre(fecha) {
  try {
    const [p, g] = await Promise.all([
      getDocs(query(collection(db, 'pagos'), where('fecha', '==', fecha))),
      getDocs(query(collection(db, 'gastos'), where('fecha', '==', fecha)))
    ]);
    const pagos = p.docs.map((d) => d.data());
    const gastos = g.docs.map((d) => d.data());
    const efIn = sum(pagos.filter((x) => x.metodo === 'Efectivo'), 'monto');
    const efOut = sum(gastos.filter((x) => x.metodo === 'Efectivo'), 'monto');
    S.cierre = { fecha, efIn, efOut };
    const otros = METODOS.slice(1).map((m) => [m, sum(pagos.filter((x) => x.metodo === m), 'monto')]);
    const res = $('#ci-res');
    if (!res) return;
    res.innerHTML = `<div><span>Cobrado en efectivo</span><b class="ok">${money(efIn)}</b></div>
      <div><span>Gastado en efectivo</span><b class="deuda">${money(efOut)}</b></div>
      ${otros.map(([m, v]) => `<div><span>${m}</span><b>${money(v)}</b></div>`).join('')}`;
    updCierre();
  } catch (e) {
    const res = $('#ci-res');
    if (res) res.innerHTML = '<div><span>No se pudo calcular. Revisa tu conexión.</span></div>';
  }
}

function updCierre() {
  const f = document.querySelector('form[data-form="cierre"]');
  if (!f || !S.cierre) return;
  const esperado = toNum(f.inicial.value) + S.cierre.efIn - S.cierre.efOut;
  const dif = toNum(f.contado.value) - esperado;
  $('#ci-dif').innerHTML = f.contado.value
    ? `Efectivo esperado: <b>${money(esperado)}</b> · Diferencia: <b class="${dif === 0 ? 'ok' : 'deuda'}">${dif === 0 ? 'cuadra' : signed(dif)}</b>`
    : `Efectivo esperado: <b>${money(esperado)}</b>`;
}

async function exportar() {
  const filas = [['Tipo', 'Fecha', 'Detalle', 'Categoría / Orden', 'Método', 'Monto', 'Registrado por']];
  const items = [
    ...S.pagos.map((p) => ['Ingreso', p.fecha, p.concepto || (p.placa ? 'Cobro de orden' : 'Venta suelta'), p.placa || '', p.metodo, p.monto, p.porEmail]),
    ...S.gastos.map((g) => ['Gasto', g.fecha, [g.proveedor, g.nota].filter(Boolean).join(' - '), g.categoria, g.metodo, -g.monto, g.porEmail])
  ].sort((a, b) => a[1].localeCompare(b[1]));
  const csv = '\ufeff' + [...filas, ...items].map((r) => r.map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
  const nombre = `RiCar-${S.mes}.csv`;
  try {
    const r = await Filesystem.writeFile({ path: nombre, data: csv, directory: Directory.Cache, encoding: Encoding.UTF8 });
    await Share.share({ title: nombre, url: r.uri });
  } catch (e) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = nombre;
    a.click();
  }
}

/* ---------- Detalle por líneas ---------- */
function lineasResumen(ls) {
  if (!ls || !ls.length) return '';
  return `<div class="pagos-l">${ls.map((l) => `<div><span>${esc(l.desc)}${Number(l.cant) !== 1 ? ' × ' + l.cant : ''}</span><b>${money(Math.round(l.cant * l.precio))}</b></div>`).join('')}</div>`;
}

function lineaHtml(l = {}) {
  return `<div class="linea">
    <input name="l-desc" placeholder="Descripción (repuesto o trabajo)" value="${esc(l.desc || '')}" autocomplete="off">
    <div class="linea-n">
      <input name="l-cant" inputmode="decimal" value="${l.cant ?? 1}" aria-label="Cantidad">
      <input name="l-precio" inputmode="numeric" placeholder="Precio c/u" value="${l.precio || ''}" aria-label="Precio unitario">
      <button type="button" class="chip" data-act="linea-" aria-label="Quitar línea">✕</button>
    </div></div>`;
}

function editorLineas(ls) {
  return `<div id="lineas">${(ls && ls.length ? ls : [{}]).map(lineaHtml).join('')}</div>
    <button type="button" class="btn sec" data-act="linea+" style="margin:4px 0 12px">Agregar línea</button>
    <div class="libro"><div><span>Total</span><b id="lineas-total">${money(lineasTotal(ls))}</b></div></div>`;
}

function leerLineas(f) {
  const fd = new FormData(f);
  const d = fd.getAll('l-desc'), c = fd.getAll('l-cant'), p = fd.getAll('l-precio');
  return d.map((desc, i) => ({ desc: String(desc).trim(), cant: toQty(c[i]) || 1, precio: toNum(p[i]) })).filter((l) => l.desc || l.precio);
}

function recalcLineas(f) {
  const el = $('#lineas-total');
  if (el && f) el.textContent = money(lineasTotal(leerLineas(f)));
}

function formDetalle(id) {
  const o = S.ordenes.find((x) => x.id === id);
  if (!o) return;
  const base = o.lineas && o.lineas.length ? o.lineas : (o.total ? [{ desc: 'Servicio de reparación', cant: 1, precio: o.total }] : []);
  openSheet('Detalle y precio', `<form data-form="detalle"><input type="hidden" name="id" value="${o.id}">
    <p class="sub">Anota cada repuesto y la mano de obra con su precio final. El monto de la orden se calcula solo.</p>
    ${editorLineas(base)}
    <button class="btn" type="submit">Guardar detalle</button></form>`);
}

/* ---------- Cotizaciones (proformas) ---------- */
function formCot(c) {
  const v = c || {};
  openSheet(c ? 'Editar cotización' : 'Nueva cotización', `<form data-form="cot"><input type="hidden" name="id" value="${esc(v.id || '')}">
    <div class="campo"><label for="f-placa">Placa</label><input id="f-placa" class="placa-in" name="placa" value="${esc(v.placa || '')}" autocomplete="off" autocapitalize="characters" required></div>
    ${vehiculoHtml(v)}
    <div class="campo"><label for="f-tel">Teléfono</label><input id="f-tel" name="telefono" type="tel" value="${esc(v.telefono || '')}"></div>
    <div class="campo"><label for="f-cli">Cliente</label><input id="f-cli" name="cliente" value="${esc(v.cliente || '')}"></div>
    <div class="campo"><label for="f-desc">Trabajo a realizar</label><textarea id="f-desc" name="descripcion">${esc(v.descripcion || '')}</textarea></div>
    <label style="font-weight:600;font-size:15px">Detalle de la cotización</label>
    ${editorLineas(v.lineas)}
    <div class="campo"><label for="f-val">Válida por (días)</label><input id="f-val" name="validez" inputmode="numeric" value="${v.validez || S.taller.validezDias || 8}"></div>
    <button class="btn" type="submit">Guardar cotización</button></form>`);
}

function verCot(id) {
  const c = S.cotizaciones.find((x) => x.id === id);
  if (!c) return;
  const k = COT_CLASE[c.estado] || 'recibido';
  openSheet(`<span class="placa grande">${esc(c.placa)}</span>`, `
    <span class="badge e-${k}">${esc(c.estado)}</span> <span class="sub">${esc(c.numero)}</span>
    <dl class="kv">
      <dt>Cliente</dt><dd>${esc(c.cliente || '—')}</dd>
      <dt>Vehículo</dt><dd>${esc(c.marca || '—')}</dd>
      <dt>Teléfono</dt><dd>${c.telefono ? `<a href="tel:${esc(c.telefono)}">${esc(c.telefono)}</a>` : '—'}</dd>
      <dt>Trabajo</dt><dd>${esc(c.descripcion || '—')}</dd>
      <dt>Total</dt><dd>${money(c.total)}</dd>
      <dt>Válida hasta</dt><dd>${fechaCorta(sumarDias(c.fecha, c.validez || 8))}</dd>
    </dl>
    ${lineasResumen(c.lineas)}
    <div class="btns">
      <button class="btn" data-act="doc-cot" data-id="${c.id}">Ver y enviar proforma</button>
      ${c.estado === 'Pendiente' ? `<button class="btn oscuro" data-act="cot-aprobar" data-id="${c.id}">Aprobar y crear orden</button>
        <button class="btn sec" data-act="editar-cot" data-id="${c.id}">Editar cotización</button>
        <button class="link" data-act="cot-estado" data-id="${c.id}" data-val="Rechazada">Marcar como rechazada</button>` : ''}
      ${c.estado === 'Rechazada' ? `<button class="btn sec" data-act="cot-estado" data-id="${c.id}" data-val="Pendiente">Volver a pendiente</button>` : ''}
      ${c.ordenId ? `<button class="btn sec" data-act="orden" data-id="${c.ordenId}">Ver la orden</button>` : ''}
    </div>`);
}

function aprobarCot(id) {
  const c = S.cotizaciones.find((x) => x.id === id);
  if (!c || c.ordenId) return;
  const ref = doc(collection(db, 'ordenes'));
  const b = writeBatch(db);
  b.set(doc(db, 'vehiculos', c.placa), { placa: c.placa, marca: c.marca || '', cliente: c.cliente || '', telefono: c.telefono || '' }, { merge: true });
  b.set(ref, {
    numero: nuevoNumero(), placa: c.placa, marca: c.marca || '', cliente: c.cliente || '', telefono: c.telefono || '',
    problema: c.descripcion || `Trabajo según cotización ${c.numero}`, trabajos: '', estado: 'Recibido',
    lineas: c.lineas, total: c.total, pagado: 0, cotizacionId: c.id,
    creadoPor: S.user.uid, porEmail: S.user.email, creadoEn: Date.now()
  });
  b.update(doc(db, 'cotizaciones', c.id), { estado: 'Aprobada', ordenId: ref.id });
  b.commit().catch(fail);
  closeSheet();
  toast('Orden creada desde la cotización');
}

/* ---------- Documentos: proforma y comprobante ---------- */
async function crearDocumento(d) {
  try {
    await Promise.all([document.fonts.load('700 40px "Barlow Condensed"'), document.fonts.load('600 24px "Barlow"'), document.fonts.load('400 24px "Barlow"')]);
  } catch (e) { /* se usa la fuente de respaldo */ }
  const W = 1240, H = 1754, M = 88, R = W - M;
  const INK = '#1d2227', MUTED = '#646d76', LINE = '#c9cfd4', YEL = '#f4b400';
  const DISP = '"Barlow Condensed", "Arial Narrow", Arial, sans-serif';
  const TXT = '"Barlow", Arial, sans-serif';
  const t = S.taller || {};
  const pages = [];
  let g, y;
  const nueva = () => {
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, W, H);
    g.fillStyle = YEL; g.fillRect(0, 0, W, 16);
    pages.push(c);
    y = M;
  };
  const txt = (s, x, yy, font, color = INK, align = 'left') => {
    g.font = font; g.fillStyle = color; g.textAlign = align; g.textBaseline = 'alphabetic';
    g.fillText(String(s), x, yy);
  };
  const envolver = (s, maxW, font) => {
    g.font = font;
    const out = [];
    String(s || '').split('\n').forEach((par) => {
      let cur = '';
      par.split(/\s+/).forEach((w) => {
        const test = cur ? cur + ' ' + w : w;
        if (g.measureText(test).width > maxW && cur) { out.push(cur); cur = w; } else cur = test;
      });
      out.push(cur);
    });
    return out;
  };
  const barra = (yy, color, h) => { g.fillStyle = color; g.fillRect(M, yy, R - M, h); };

  nueva();
  // Encabezado: datos del taller a la izquierda, documento a la derecha
  y = M + 30;
  txt(t.nombre || 'RiCar Solutions', M, y + 36, `700 66px ${DISP}`);
  let yi = y + 76;
  [t.cedula && `Cédula: ${t.cedula}`, t.telefono && `Tel. ${t.telefono}`, t.correo, t.direccion].filter(Boolean).forEach((s) => {
    envolver(s, 600, `400 26px ${TXT}`).forEach((l) => { txt(l, M, yi, `400 26px ${TXT}`, MUTED); yi += 34; });
  });
  const proforma = d.tipo === 'proforma';
  txt(proforma ? 'PROFORMA' : 'COMPROBANTE DE TRABAJO', R, y + 36, `700 ${proforma ? 60 : 44}px ${DISP}`, INK, 'right');
  txt(`N.º ${d.numero}`, R, y + 82, `600 28px ${TXT}`, INK, 'right');
  txt(`Fecha: ${fechaLarga(d.fecha)}`, R, y + 118, `400 26px ${TXT}`, MUTED, 'right');
  if (proforma) txt(`Válida hasta: ${fechaLarga(sumarDias(d.fecha, d.validez || 8))}`, R, y + 152, `400 26px ${TXT}`, MUTED, 'right');
  y = Math.max(yi, y + 170) + 16;
  barra(y, INK, 4);
  y += 40;

  // Cliente y vehículo
  txt('Cliente', M, y + 22, `600 22px ${TXT}`, MUTED);
  txt(d.cliente || 'Sin nombre', M, y + 62, `700 40px ${DISP}`);
  if (d.telefono) txt(`Tel. ${d.telefono}`, M, y + 98, `400 26px ${TXT}`, MUTED);
  txt('Vehículo', R, y + 22, `600 22px ${TXT}`, MUTED, 'right');
  g.font = `700 52px ${DISP}`;
  const pw = g.measureText(d.placa).width + 44;
  g.fillStyle = '#fff'; g.strokeStyle = INK; g.lineWidth = 4;
  g.beginPath();
  if (g.roundRect) g.roundRect(R - pw, y + 34, pw, 66, 8); else g.rect(R - pw, y + 34, pw, 66);
  g.fill(); g.stroke();
  txt(d.placa, R - pw / 2, y + 86, `700 52px ${DISP}`, INK, 'center');
  if (d.marca) txt(d.marca, R, y + 134, `400 26px ${TXT}`, MUTED, 'right');
  y += 164;

  // Descripción del trabajo
  if (d.descripcion) {
    txt(proforma ? 'Trabajo a realizar' : 'Trabajo realizado', M, y + 22, `600 22px ${TXT}`, MUTED);
    y += 38;
    envolver(d.descripcion, R - M, `400 28px ${TXT}`).slice(0, 8).forEach((l) => { txt(l, M, y + 24, `400 28px ${TXT}`); y += 38; });
    y += 16;
  }

  // Tabla de líneas
  const X = { cant: 700, precio: 940, imp: R - 16 };
  const cabecera = () => {
    barra(y, INK, 52);
    txt('Descripción', M + 16, y + 36, `600 24px ${TXT}`, '#fff');
    txt('Cant.', X.cant, y + 36, `600 24px ${TXT}`, '#fff', 'right');
    txt('Precio', X.precio, y + 36, `600 24px ${TXT}`, '#fff', 'right');
    txt('Importe', X.imp, y + 36, `600 24px ${TXT}`, '#fff', 'right');
    y += 52;
  };
  cabecera();
  d.lineas.forEach((l, i) => {
    const filas = envolver(l.desc || '—', X.cant - M - 150, `400 27px ${TXT}`);
    const h = filas.length * 36 + 24;
    if (y + h > H - M - 120) { nueva(); cabecera(); }
    if (i % 2) barra(y, '#f3f4f5', h);
    filas.forEach((f, k) => txt(f, M + 16, y + 38 + k * 36, `400 27px ${TXT}`));
    txt(String(Number(l.cant)), X.cant, y + 38, `400 27px ${TXT}`, INK, 'right');
    txt(money(l.precio), X.precio, y + 38, `400 27px ${TXT}`, INK, 'right');
    txt(money(Math.round(l.cant * l.precio)), X.imp, y + 38, `600 27px ${TXT}`, INK, 'right');
    y += h;
  });
  barra(y, LINE, 2);
  y += 30;

  // Total de la orden (sin desglose de impuestos por ahora)
  if (y + 300 > H - M) nueva();
  g.fillStyle = INK; g.fillRect(740, y, R - 740, 74);
  txt('TOTAL', 764, y + 52, `700 38px ${DISP}`, YEL);
  txt(money(d.total), X.imp, y + 52, `700 46px ${DISP}`, '#fff', 'right');
  y += 74 + 22;
  if (!proforma) {
    const pagado = Number(d.pagado) || 0;
    [['Pagado', money(pagado)], ['Saldo pendiente', money(Math.max(0, d.total - pagado))]].forEach(([k, v]) => {
      txt(k, 780, y + 30, `600 28px ${TXT}`, INK);
      txt(v, X.imp, y + 30, `600 28px ${TXT}`, INK, 'right');
      y += 42;
    });
  }

  // Notas al pie
  y += 24;
  const notas = [proforma ? 'Esta proforma es una cotización y no constituye una factura.' : 'Documento informativo del trabajo realizado. No es una factura electrónica.'];
  if (t.notaPie) notas.push(t.notaPie);
  notas.forEach((n) => envolver(n, R - M, `400 24px ${TXT}`).forEach((l) => {
    if (y + 34 > H - M) nueva();
    txt(l, M, y + 24, `400 24px ${TXT}`, MUTED);
    y += 32;
  }));
  if (pages.length > 1) {
    pages.forEach((c, i) => {
      const gg = c.getContext('2d');
      gg.font = `400 22px ${TXT}`; gg.fillStyle = MUTED; gg.textAlign = 'center';
      gg.fillText(`Página ${i + 1} de ${pages.length}`, W / 2, H - 36);
    });
  }
  return pages;
}

async function verDocumento(tipo, id) {
  const proforma = tipo === 'proforma';
  const src = (proforma ? S.cotizaciones : S.ordenes).find((x) => x.id === id);
  if (!src) return;
  if (!(src.total > 0)) return toast('Agrega el detalle y el precio antes de generar el documento');
  const lineas = src.lineas && src.lineas.length ? src.lineas : [{ desc: 'Servicio de reparación', cant: 1, precio: src.total }];
  toast('Preparando documento…');
  const fecha = proforma ? src.fecha : (src.entregadoEn ? ymd(new Date(src.entregadoEn)) : ymd());
  try {
    S.docPages = await crearDocumento({
      tipo, numero: src.numero, fecha, cliente: src.cliente, telefono: src.telefono, placa: src.placa, marca: src.marca,
      descripcion: proforma ? src.descripcion : [src.problema, src.trabajos].filter(Boolean).join('. '),
      lineas, total: src.total, pagado: src.pagado, validez: src.validez
    });
  } catch (e) { return fail(e); }
  S.docNombre = `${proforma ? 'Proforma' : 'Comprobante'}-${src.placa}-${ymd()}`;
  openSheet(proforma ? 'Proforma' : 'Comprobante del trabajo', `
    <p class="sub">Así se verá el documento. Al compartir se envía como PDF (WhatsApp, correo, etc.).</p>
    ${S.docPages.map((c) => `<img class="doc-img" alt="Página del documento" src="${c.toDataURL('image/jpeg', 0.85)}">`).join('')}
    <div class="btns"><button class="btn" data-act="doc-compartir">Compartir PDF</button><button class="btn sec" data-act="cerrar">Cerrar</button></div>`);
}

async function compartirDoc() {
  if (!S.docPages) return;
  const pdf = new jsPDF({ unit: 'pt', format: 'a4', compress: true });
  S.docPages.forEach((c, i) => {
    if (i) pdf.addPage();
    pdf.addImage(c.toDataURL('image/jpeg', 0.92), 'JPEG', 0, 0, 595.28, 841.89);
  });
  const nombre = `${S.docNombre}.pdf`;
  let uri;
  try {
    const r = await Filesystem.writeFile({ path: nombre, data: pdf.output('datauristring').split(',')[1], directory: Directory.Cache });
    uri = r.uri;
  } catch (e) { pdf.save(nombre); return; }
  try { await Share.share({ title: nombre, url: uri, dialogTitle: 'Enviar documento' }); } catch (e) { /* el usuario canceló */ }
}

/* ---------- Desarrollo (solo Admin) ---------- */
const COLS_DATOS = [['ordenes', 'Órdenes'], ['cotizaciones', 'Cotizaciones'], ['pagos', 'Cobros'], ['gastos', 'Gastos'], ['cierres', 'Cierres de caja'], ['vehiculos', 'Vehículos']];

function abrirDesarrollo() {
  if (!S.isAdmin) return;
  openSheet('Desarrollo', `
    <dl class="kv">
      <dt>Versión de la app</dt><dd>${APP_VERSION}</dd>
      <dt>Perfil</dt><dd>Admin</dd>
      <dt>Correo</dt><dd>${esc(S.user.email)}</dd>
      <dt>Proyecto Firebase</dt><dd>${esc(firebaseConfig.projectId)}</dd>
      <dt>Conexión</dt><dd>${S.online ? 'En línea' : 'Sin conexión'}</dd>
    </dl>
    <h3 class="sec" style="margin-top:6px">Datos guardados</h3>
    <div id="dev-cuentas" class="libro"><div><span>Contando…</span></div></div>
    <p class="sub">Borrar los datos de prueba elimina órdenes, cotizaciones, cobros, gastos, cierres de caja y vehículos. No toca las categorías, los datos del taller ni los usuarios. No se puede deshacer.</p>
    <form data-form="dev-borrar">
      <div class="campo"><label for="dev-c">Para confirmar, escribe BORRAR</label><input id="dev-c" name="confirmar" autocomplete="off" autocapitalize="characters"></div>
      <button class="btn peligro" type="submit">Borrar datos de prueba</button>
    </form>`);
  contarDatos();
}

async function contarDatos() {
  try {
    const res = await Promise.all(COLS_DATOS.map(([c]) => getDocs(collection(db, c))));
    const el = $('#dev-cuentas');
    if (el) el.innerHTML = COLS_DATOS.map(([, n], i) => `<div><span>${n}</span><b>${res[i].docs.length}</b></div>`).join('');
  } catch (e) {
    const el = $('#dev-cuentas');
    if (el) el.innerHTML = '<div><span>No se pudo contar. Revisa la conexión.</span></div>';
  }
}

async function borrarDatosPrueba() {
  if (!S.online) return toast('Necesitas conexión para borrar datos');
  toast('Borrando datos de prueba…');
  try {
    for (const [c] of COLS_DATOS) {
      const snap = await getDocs(collection(db, c));
      for (let i = 0; i < snap.docs.length; i += 400) {
        const b = writeBatch(db);
        snap.docs.slice(i, i + 400).forEach((d) => b.delete(doc(db, c, d.id)));
        await b.commit();
      }
    }
    toast('Datos de prueba borrados');
    contarDatos();
  } catch (e) { fail(e); }
}

/* ---------- Datos del taller ---------- */
function formTaller() {
  const t = S.taller || {};
  openSheet('Datos del taller', `<form data-form="taller">
    <p class="sub">Salen en el encabezado de las proformas y los comprobantes.</p>
    <div class="campo"><label for="t-n">Nombre del taller</label><input id="t-n" name="nombre" value="${esc(t.nombre || 'RiCar Solutions')}" required></div>
    <div class="campo"><label for="t-c">Cédula física o jurídica</label><input id="t-c" name="cedula" value="${esc(t.cedula || '')}"></div>
    <div class="fila-2">
      <div class="campo"><label for="t-t">Teléfono</label><input id="t-t" name="telefono" type="tel" value="${esc(t.telefono || '')}"></div>
      <div class="campo"><label for="t-m">Ganancia sugerida en repuestos (%)</label><input id="t-m" name="margenRepuestos" inputmode="numeric" value="${t.margenRepuestos ?? 25}"></div>
      <div class="campo"><label for="t-v">Proforma válida (días)</label><input id="t-v" name="validezDias" inputmode="numeric" value="${t.validezDias || 8}"></div>
    </div>
    <div class="campo"><label for="t-e">Correo</label><input id="t-e" name="correo" type="email" value="${esc(t.correo || '')}"></div>
    <div class="campo"><label for="t-d">Dirección</label><input id="t-d" name="direccion" value="${esc(t.direccion || '')}"></div>
    <div class="campo"><label for="t-p">Nota al pie (opcional)</label><textarea id="t-p" name="notaPie" placeholder="Ej: Garantía de 30 días en mano de obra.">${esc(t.notaPie || '')}</textarea></div>
    <button class="btn" type="submit">Guardar datos</button></form>`);
}

/* ---------- Categorías de gastos (solo dueño) ---------- */
function htmlCats() {
  if (!S.categorias.length) return '<div class="vacio">Cargando categorías…</div>';
  return S.categorias.map((c) => {
    const on = c.activa !== false;
    return `<div class="cat-fila ${on ? '' : 'off'}">
      <input data-cat="${c.id}" value="${esc(c.nombre)}" aria-label="Nombre de la categoría" autocomplete="off">
      <button class="chip" data-act="cat-toggle" data-id="${c.id}">${on ? 'Ocultar' : 'Mostrar'}</button></div>`;
  }).join('');
}

function refrescarCats() {
  const el = $('#cats-lista');
  if (el) el.innerHTML = htmlCats();
}

function abrirCategorias() {
  // La primera vez se copian las categorías de fábrica a Firestore para poder editarlas
  if (!S.categorias.length && !S.sembrando) {
    S.sembrando = true;
    const b = writeBatch(db);
    const t = Date.now();
    CATEGORIAS.forEach((n, i) => b.set(doc(collection(db, 'categorias')), { nombre: n, activa: true, creadoEn: t + i }));
    b.commit().catch(fail);
  }
  openSheet('Categorías de gastos', `
    <form data-form="cat-nueva">
      <div class="campo"><label for="cat-n">Nueva categoría</label>
        <div class="cat-fila"><input id="cat-n" name="nombre" placeholder="Ej: Lavado y limpieza" autocomplete="off" required>
        <button class="btn" type="submit" style="width:auto">Agregar</button></div></div>
    </form>
    <p class="sub">Toca un nombre para cambiarlo: los gastos anteriores se actualizan solos. Si ocultas una categoría, deja de aparecer al anotar gastos pero el historial se conserva.</p>
    <div id="cats-lista">${htmlCats()}</div>`);
}

const catExiste = (nombre, exceptoId) => S.categorias.some((c) => c.id !== exceptoId && c.nombre.toLowerCase() === nombre.toLowerCase());

async function renombrarCat(id, nuevo) {
  const c = S.categorias.find((x) => x.id === id);
  nuevo = nuevo.trim();
  if (!c || !nuevo || nuevo === c.nombre) return refrescarCats();
  if (catExiste(nuevo, id)) { toast('Ya existe una categoría con ese nombre'); return refrescarCats(); }
  try {
    const snap = await getDocs(query(collection(db, 'gastos'), where('categoria', '==', c.nombre)));
    const b = writeBatch(db);
    b.update(doc(db, 'categorias', id), { nombre: nuevo });
    snap.docs.slice(0, 450).forEach((d) => b.update(doc(db, 'gastos', d.id), { categoria: nuevo }));
    b.commit().catch(fail);
    toast('Categoría renombrada');
  } catch (e) { fail(e); refrescarCats(); }
}

/* ---------- Acciones ---------- */
const ACT = {
  tab: (d) => { S.tab = d.k; render(); window.scrollTo(0, 0); },
  mes: (d) => { S.mes = shiftMes(S.mes, Number(d.d)); subscribeMov(); render(); },
  filtro: (d) => { S.filtro = d.k; render(); },
  cerrar: closeSheet,
  nuevo: () => openSheet('¿Qué quieres registrar?', `<div class="btns">
    <button class="btn" data-act="nueva-orden">Recibir vehículo (nueva orden)</button>
    <button class="btn oscuro" data-act="cobrar">Registrar un cobro</button>
    <button class="btn sec" data-act="nueva-cot">Crear cotización (proforma)</button>
    <button class="btn sec" data-act="gasto">Anotar un gasto</button></div>`),
  'nueva-orden': () => formOrden(null),
  cobrar: (d) => formCobro(d.id),
  gasto: formGasto,
  orden: (d) => verOrden(d.id),
  editar: (d) => formOrden(S.ordenes.find((x) => x.id === d.id)),
  estado: (d) => {
    const o = S.ordenes.find((x) => x.id === d.id);
    if (!o) return;
    if (d.val === 'Cancelado' && !confirm('¿Cancelar esta orden?')) return;
    if (d.val === 'Entregado' && saldo(o) > 0 && !confirm(`Queda un saldo de ${money(saldo(o))}. ¿Entregar de todos modos?`)) return;
    const patch = { estado: d.val };
    if (d.val === 'Entregado') patch.entregadoEn = Date.now();
    updateDoc(doc(db, 'ordenes', d.id), patch).catch(fail);
    closeSheet();
    toast(`Orden: ${d.val.toLowerCase()}`);
  },
  mov: (d) => verMov(d.t, d.id),
  'borrar-mov': (d) => {
    if (!confirm('¿Eliminar este registro? No se puede deshacer.')) return;
    const m = (d.t === 'pago' ? S.pagos : S.gastos).find((x) => x.id === d.id);
    if (!m) return;
    const b = writeBatch(db);
    b.delete(doc(db, d.t === 'pago' ? 'pagos' : 'gastos', d.id));
    if (d.t === 'pago' && m.ordenId) b.update(doc(db, 'ordenes', m.ordenId), { pagado: increment(-m.monto) });
    b.commit().catch(fail);
    closeSheet();
    toast('Registro eliminado');
  },
  cierre: abrirCierre,
  categorias: abrirCategorias,
  taller: formTaller,
  desarrollo: abrirDesarrollo,
  'vista-ord': (d) => { S.vistaOrd = d.k; S.busqueda = ''; render(); },
  'nueva-cot': () => formCot(null),
  cot: (d) => verCot(d.id),
  'editar-cot': (d) => formCot(S.cotizaciones.find((x) => x.id === d.id)),
  'cot-aprobar': (d) => aprobarCot(d.id),
  'cot-estado': (d) => {
    if (d.val === 'Rechazada' && !confirm('¿Marcar esta cotización como rechazada?')) return;
    updateDoc(doc(db, 'cotizaciones', d.id), { estado: d.val }).catch(fail);
    closeSheet();
    toast(`Cotización: ${d.val.toLowerCase()}`);
  },
  detalle: (d) => formDetalle(d.id),
  'doc-orden': (d) => verDocumento('comprobante', d.id),
  'doc-cot': (d) => verDocumento('proforma', d.id),
  'doc-compartir': compartirDoc,
  'linea+': () => {
    $('#lineas').insertAdjacentHTML('beforeend', lineaHtml());
    $('#lineas').lastElementChild.querySelector('input').focus();
  },
  'linea-': (d, el) => {
    const f = el.closest('form');
    const row = el.closest('.linea');
    if ($('#lineas').children.length > 1) row.remove();
    else row.querySelectorAll('input').forEach((i) => { i.value = i.name === 'l-cant' ? 1 : ''; });
    recalcLineas(f);
  },
  'cat-toggle': (d) => {
    const c = S.categorias.find((x) => x.id === d.id);
    if (c) updateDoc(doc(db, 'categorias', d.id), { activa: c.activa === false }).catch(fail);
  },
  exportar,
  salir: () => { if (confirm('¿Cerrar sesión?')) signOut(auth); }
};

document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-act]');
  if (t && ACT[t.dataset.act]) ACT[t.dataset.act](t.dataset, t);
});

document.addEventListener('submit', (e) => {
  const fn = FORMS[e.target.dataset.form];
  if (fn) { e.preventDefault(); fn(e.target); }
});

document.addEventListener('input', (e) => {
  if (e.target.id === 'buscar') {
    S.busqueda = e.target.value;
    $('#lista-ordenes').innerHTML = htmlLista();
  }
  if (e.target.id === 'f-placa') {
    const p = plateNorm(e.target.value);
    const v = S.vehiculos[p];
    const f = e.target.form;
    if (v && !f.id.value) {
      if (!f.vMarca.value && !f.vMarcaTxt.value) aplicarVeh(f, v);
      if (!f.cliente.value) f.cliente.value = v.cliente || '';
      if (!f.telefono.value) f.telefono.value = v.telefono || '';
    }
  }
  if (e.target.matches('[data-cierre]') && e.target.name !== 'fecha') updCierre();
  if (e.target.name === 'l-cant' || e.target.name === 'l-precio') recalcLineas(e.target.form);
  const gf = e.target.form;
  if (gf && ['gasto', 'gasto-orden'].includes(gf.dataset.form)) {
    if (e.target.name === 'monto') precioSugerido(gf);
    if (e.target.name === 'precioCli') { e.target.dataset.manual = '1'; precioSugerido(gf); }
    if (e.target.name === 'nota' && gf.lineaDesc && !gf.lineaDesc.dataset.manual) gf.lineaDesc.value = e.target.value;
    if (e.target.name === 'lineaDesc') e.target.dataset.manual = '1';
  }
});

document.addEventListener('change', (e) => {
  if (e.target.name === 'ordenId' && e.target.form && ['gasto', 'gasto-orden'].includes(e.target.form.dataset.form)) {
    const f = e.target.form;
    actualizarLineaGasto(f);
    if (!f.lineaDesc.value) f.lineaDesc.value = (f.nota && f.nota.value) || 'Repuesto';
    precioSugerido(f);
  }
  if (e.target.name === 'vMarca') syncVeh(e.target.form, true);
  if (e.target.name === 'vModelo') syncVeh(e.target.form, false);
  if (e.target.dataset && e.target.dataset.cat) renombrarCat(e.target.dataset.cat, e.target.value);
  if (e.target.name === 'ordenId' && e.target.form && e.target.form.dataset.form === 'cobro') {
    e.target.form.monto.value = e.target.selectedOptions[0].dataset.saldo || '';
  }
  if (e.target.matches('[data-cierre]') && e.target.name === 'fecha' && e.target.value) {
    $('#ci-res').innerHTML = '<div><span>Calculando…</span></div>';
    S.cierre = null;
    calcCierre(e.target.value);
  }
});

window.addEventListener('online', () => { S.online = true; render(); });
window.addEventListener('offline', () => { S.online = false; render(); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && S.user && !S.isOwner && S.movDia !== ymd()) subscribeMov();
});

try {
  CapApp.addListener('backButton', () => {
    if (sheetAbierta()) closeSheet();
    else if (S.tab !== 'inicio') { S.tab = 'inicio'; render(); }
    else CapApp.exitApp();
  });
} catch (e) { /* navegador */ }

/* ---------- Arranque ---------- */
if (configurado) {
  onAuthStateChanged(auth, (u) => {
    stopAll();
    S.user = u;
    S.ordenes = []; S.pagos = []; S.gastos = []; S.categorias = []; S.cotizaciones = []; S.taller = {};
    if (u) {
      const em = (u.email || '').toLowerCase();
      S.isAdmin = em === ADMIN_EMAIL.toLowerCase();
      S.isOwner = S.isAdmin || em === OWNER_EMAIL.toLowerCase(); // el Admin tiene los mismos permisos de datos que el Dueño
      S.tab = 'inicio';
      startListeners();
    }
    render();
  });
}
if (!configurado) render();
