import './styles.css';
import '@fontsource/barlow-condensed/600.css';
import '@fontsource/barlow-condensed/700.css';
import '@fontsource/barlow/400.css';
import '@fontsource/barlow/600.css';

import { initializeApp } from 'firebase/app';
import { getAuth, signInWithEmailAndPassword, onAuthStateChanged, signOut } from 'firebase/auth';
import {
  initializeFirestore, persistentLocalCache, persistentSingleTabManager,
  collection, doc, getDoc, getDocs, setDoc, updateDoc, onSnapshot, query, where, orderBy, limit,
  writeBatch, increment
} from 'firebase/firestore';
import { App as CapApp } from '@capacitor/app';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { LocalNotifications } from '@capacitor/local-notifications';
import { jsPDF } from 'jspdf';
import { firebaseConfig, OWNER_EMAIL, ADMIN_EMAIL } from './firebase-config.js';
import { MARCAS } from './vehiculos.js';
import logoUrl from './logo.png';

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

const APP_VERSION = '1.3.0';
const COMBUSTIBLE = ['Vacío', '1/4', '1/2', '3/4', 'Lleno'];
const kmTxt = (n) => String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ' km';
const CONDICIONES_DEFECTO = 'El cliente autoriza al taller a revisar el vehículo según el problema reportado. El kilometraje, el nivel de combustible y el estado del vehículo quedan registrados al momento del ingreso. Cualquier trabajo adicional será consultado con el cliente antes de realizarse.';
const horaTxt = (ms) => { const d = new Date(ms); const h = d.getHours(); return `${h % 12 || 12}:${pad(d.getMinutes())} ${h >= 12 ? 'p. m.' : 'a. m.'}`; };
const esperarOrden = (id) => new Promise((res) => {
  let n = 0;
  const t = setInterval(() => {
    const o = S.ordenes.find((x) => x.id === id);
    if (o || ++n > 25) { clearInterval(t); res(o || null); }
  }, 100);
});
const FIRMA = { dibujando: false, vacio: true };
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
  ordenes: [], pagos: [], gastos: [], vehiculos: {}, categorias: [], sembrando: false, cotizaciones: [], taller: {}, repuestos: [], costos: {}, credito: [], creditoTodos: [], credFiltro: 'pendientes', credBusqueda: '', invBusqueda: '', invFiltro: 'todos', vistaOrd: 'ordenes', docPages: null, docNombre: '',
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
  S.unsubs.push(onSnapshot(collection(db, 'repuestos'), (snap) => {
    S.repuestos = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (a.nombre || '').localeCompare(b.nombre || ''));
    render();
  }, fail));
  if (S.isOwner) {
    S.unsubs.push(onSnapshot(collection(db, 'repuestosCosto'), (snap) => {
      S.costos = {};
      snap.forEach((d) => { S.costos[d.id] = d.data().costo || 0; });
      render();
    }, fail));
    S.unsubs.push(onSnapshot(query(collection(db, 'gastos'), where('credito', '==', true)), (snap) => {
      S.creditoTodos = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      S.credito = S.creditoTodos.filter((g) => g.pendientePago === true).sort((a, b) => (a.fechaVence || '').localeCompare(b.fechaVence || ''));
      render();
      programarAvisos();
    }, fail));
  }
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
  inv: '<path d="M3 7l9-4 9 4-9 4-9-4z"/><path d="M3 7v10l9 4 9-4V7"/><path d="M12 11v10"/>',
  mas: '<path d="M4 7h16M4 12h16M4 17h16"/>'
};

function render() {
  if (!configurado) return renderSetup();
  if (!S.user) return renderLogin();
  const y = window.scrollY;
  const vistas = { inicio: vInicio, ordenes: vOrdenes, inv: vInv, mov: vMov, mas: vMas, cred: vCreditos };
  const tabs = [['inicio', 'Inicio'], ['ordenes', 'Órdenes'], ['inv', 'Inventario'], ['mov', S.isOwner ? 'Dinero' : 'Registros'], ['mas', 'Más']];
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

  return `${alertaCredito()}${selectorMes()}
    <div class="hero"><small>Utilidad de ${mesLabel(S.mes)}</small><div class="cifra ${ut < 0 ? 'neg' : ''}">${signed(ut)}</div></div>
    <div class="libro">
      <div><span>Ingresos</span><b class="ok">${money(ing)}</b></div>
      <div><span>Gastos</span><b class="deuda">${money(gas)}</b></div>
      <div><span>Por cobrar (todas las órdenes)</span><b>${money(porCobrar)}</b></div>
      <div><span>Vehículos en el taller</span><b>${abiertas.length}</b></div>
      <div><span>Repuestos con stock bajo</span><b>${S.repuestos.filter(stockBajo).length}</b></div>
    </div>
    ${listaPorPagar()}
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
    const cred = !entra && m.credito ? (m.pendientePago ? textoVence(m) : 'Pagado') : '';
    const det = [fechaCorta(m.fecha), m.metodo, cred, (m.porEmail || '').split('@')[0]].filter(Boolean).join(' · ');
    return `<button class="fila mov ${entra ? 'in' : 'out'}${!entra && m.pendientePago && diasPara(m.fechaVence) < 0 ? ' venc' : ''}" data-act="mov" data-t="${m.t}" data-id="${m.id}">
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
    botones.push('<button class="btn oscuro" data-act="ir-cred">Cuentas por pagar (créditos)</button>');
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
    <div class="fila-2">
      <div class="campo"><label for="f-km">Kilometraje actual</label><input id="f-km" name="km" inputmode="numeric" value="${v.km || ''}" placeholder="Ej: 85400"></div>
      <div class="campo"><label for="f-comb">Combustible</label><select id="f-comb" name="combustible"><option value="">Elegir…</option>${COMBUSTIBLE.map((c) => `<option ${c === v.combustible ? 'selected' : ''}>${c}</option>`).join('')}</select></div>
    </div>
    <div class="campo"><label for="f-prob">Problema</label><textarea id="f-prob" name="problema" required>${esc(v.problema || '')}</textarea></div>
    ${o ? `<div class="campo"><label for="f-trab">Trabajos realizados</label><textarea id="f-trab" name="trabajos">${esc(v.trabajos || '')}</textarea></div>` : ''}
    <div class="campo"><label for="f-total">Monto a cobrar</label><input id="f-total" name="total" inputmode="numeric" value="${v.total || ''}" placeholder="₡0" ${tieneLineas ? 'readonly' : ''}>${tieneLineas ? '<span class="sub">Se calcula con el detalle del trabajo.</span>' : ''}</div>
    ${o ? '' : '<label class="check"><input type="checkbox" name="pedirFirma" checked> Pedir la firma de recepción al guardar</label>'}
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
    ${htmlCredito()}
    <div class="campo"><label for="g-or">Asociar a una orden (opcional)</label><select id="g-or" name="ordenId"><option value="">Ninguna</option>${opcionesOrden('', false)}</select></div>
    ${htmlLineaGasto()}
    ${S.isOwner ? htmlIngresoInv(false) : ''}
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
    let nuevaRef = null;
    b.set(doc(db, 'vehiculos', placa), veh, { merge: true });
    if (d.id) {
      const ex = S.ordenes.find((x) => x.id === d.id);
      const patch = { ...veh, km: String(d.km || '').trim() ? toNum(d.km) : null, combustible: d.combustible || '', problema: d.problema.trim(), trabajos: (d.trabajos || '').trim() };
      if (!(ex && ex.lineas && ex.lineas.length)) patch.total = toNum(d.total);
      b.update(doc(db, 'ordenes', d.id), patch);
    } else {
      nuevaRef = doc(collection(db, 'ordenes'));
      b.set(nuevaRef, {
        numero: nuevoNumero(), ...veh, km: String(d.km || '').trim() ? toNum(d.km) : null, combustible: d.combustible || '', problema: d.problema.trim(), trabajos: '', estado: 'Recibido',
        total: toNum(d.total), pagado: 0, creadoPor: S.user.uid, porEmail: S.user.email, creadoEn: Date.now()
      });
    }
    b.commit().catch(fail);
    closeSheet();
    toast('Orden guardada');
    if (nuevaRef && d.pedirFirma) esperarOrden(nuevaRef.id).then((o) => { if (o) abrirRecepcion(o.id); });
  },

  recepcion: (f) => {
    const d = Object.fromEntries(new FormData(f));
    const o = S.ordenes.find((x) => x.id === d.id);
    if (!o) return;
    if (FIRMA.vacio) return toast('Pide al cliente que firme en el recuadro');
    const firma = $('#firma').toDataURL('image/png');
    const obs = (d.observaciones || '').trim();
    const firmante = (d.firmante || '').trim();
    const ahora = Date.now();
    const quien = (S.user.email || '').split('@')[0];
    const b = writeBatch(db);
    b.set(doc(db, 'recepciones', o.id), { ordenId: o.id, firma, firmante, observaciones: obs, recepcionEn: ahora, recepcionPor: quien });
    b.update(doc(db, 'ordenes', o.id), { observaciones: obs, recepcionFirmada: true, recepcionEn: ahora });
    b.commit().catch(fail);
    verRecepcionDoc(o.id, { firma, firmante, observaciones: obs, recepcionEn: ahora, recepcionPor: quien });
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
    const credito = !!d.credito;
    if (credito && !d.proveedor.trim()) return toast('Escribe el proveedor de la compra a crédito');
    if (d.inv && d.ordenId) return toast('Un gasto no puede ir a una orden y al inventario a la vez');
    const o = S.ordenes.find((x) => x.id === d.ordenId);
    const b = writeBatch(db);
    const gref = doc(collection(db, 'gastos'));
    const gasto = {
      monto, categoria: d.categoria, metodo: credito ? 'Crédito' : d.metodo, fecha: d.fecha, proveedor: d.proveedor.trim(), nota: d.nota.trim(),
      ordenId: o ? o.id : null, placa: o ? o.placa : null,
      creadoPor: S.user.uid, porEmail: S.user.email, creadoEn: Date.now()
    };
    if (credito) {
      const plazo = Math.max(1, Math.round(toNum(d.plazoDias)) || 30);
      Object.assign(gasto, { credito: true, plazoDias: plazo, fechaVence: sumarDias(d.fecha, plazo), pendientePago: true });
    }
    let ing = null;
    if (d.inv && S.isOwner) {
      ing = aplicarIngreso(b, d, monto, gref.id);
      if (ing.error) return toast(ing.error);
      gasto.inventario = { repuestoId: ing.id, cantidad: ing.cant };
    }
    b.set(gref, gasto);
    const agregado = !!(o && d.agregarLinea && agregarLineaOrden(b, o, d));
    b.commit().catch(fail);
    closeSheet();
    toast(ing ? 'Gasto guardado y repuesto ingresado al inventario' : agregado ? 'Gasto guardado y repuesto agregado a la orden' : credito ? 'Gasto a crédito guardado' : 'Gasto guardado');
  },

  'gasto-pagar': (f) => {
    const d = Object.fromEntries(new FormData(f));
    updateDoc(doc(db, 'gastos', d.id), { pendientePago: false, pagadoEn: d.pagadoEn || ymd(), metodoPago: d.metodoPago }).catch(fail);
    closeSheet();
    toast('Pago registrado');
  },

  'gasto-inv': (f) => {
    const d = Object.fromEntries(new FormData(f));
    const g = buscarGasto(d.id);
    if (!g || !S.isOwner) return;
    const b = writeBatch(db);
    const ing = aplicarIngreso(b, d, g.monto, g.id);
    if (ing.error) return toast(ing.error);
    b.update(doc(db, 'gastos', g.id), { inventario: { repuestoId: ing.id, cantidad: ing.cant } });
    b.commit().catch(fail);
    closeSheet();
    toast('Repuesto ingresado al inventario');
  },

  repuesto: (f) => {
    const d = Object.fromEntries(new FormData(f));
    const nombre = d.nombre.trim();
    if (!nombre) return toast('Escribe el nombre del repuesto');
    if (!S.isOwner) return;
    const b = writeBatch(db);
    const base = { nombre, codigo: d.codigo.trim(), precioVenta: toNum(d.precioVenta), stockMin: toNum(d.stockMin) };
    let id = d.id;
    if (id) b.update(doc(db, 'repuestos', id), base);
    else {
      const ref = doc(collection(db, 'repuestos'));
      id = ref.id;
      const stock = toQty(d.stock);
      b.set(ref, { ...base, stock, activo: true, creadoEn: Date.now() });
      if (stock > 0) {
        b.set(doc(collection(db, 'movimientosInv')), {
          repuestoId: id, nombre, tipo: 'entrada', cantidad: stock, nota: 'Inventario inicial', fecha: ymd(),
          creadoPor: S.user.uid, porEmail: S.user.email, creadoEn: Date.now()
        });
      }
    }
    if (String(d.costo).trim() !== '') b.set(doc(db, 'repuestosCosto', id), { costo: toNum(d.costo), actualizado: Date.now() }, { merge: true });
    b.commit().catch(fail);
    closeSheet();
    toast('Repuesto guardado');
  },

  ajuste: (f) => {
    const d = Object.fromEntries(new FormData(f));
    const r = S.repuestos.find((x) => x.id === d.id);
    if (!r || !S.isOwner) return;
    if (String(d.conteo).trim() === '') return toast('Escribe lo que contaste');
    const delta = Math.round((toQty(d.conteo) - (Number(r.stock) || 0)) * 1000) / 1000;
    if (!delta) { closeSheet(); return toast('Las existencias ya coinciden'); }
    const b = writeBatch(db);
    b.update(doc(db, 'repuestos', r.id), { stock: increment(delta) });
    b.set(doc(collection(db, 'movimientosInv')), {
      repuestoId: r.id, nombre: r.nombre, tipo: 'ajuste', cantidad: delta, nota: d.nota.trim(), fecha: ymd(),
      creadoPor: S.user.uid, porEmail: S.user.email, creadoEn: Date.now()
    });
    b.commit().catch(fail);
    closeSheet();
    toast('Existencias ajustadas');
  },

  'gasto-orden': (f) => {
    const d = Object.fromEntries(new FormData(f));
    const g = buscarGasto(d.id);
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
    const o = S.ordenes.find((x) => x.id === id);
    const lineas = leerLineas(f);
    const b = writeBatch(db);
    if (o) aplicarInventario(b, o.lineas, lineas, { ordenId: o.id, placa: o.placa });
    b.update(doc(db, 'ordenes', id), { lineas, total: lineasTotal(lineas) });
    b.commit().catch(fail);
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
      margenRepuestos: d.margenRepuestos === '' ? 25 : toNum(d.margenRepuestos),
      condicionesRecepcion: (d.condicionesRecepcion || '').trim()
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
      <dt>Kilometraje</dt><dd>${o.km ? kmTxt(o.km) : '—'}</dd>
      <dt>Combustible</dt><dd>${esc(o.combustible || '—')}</dd>
      <dt>Recepción</dt><dd>${o.recepcionFirmada ? 'Firmada el ' + fechaCorta(ymd(new Date(o.recepcionEn))) : 'Sin firmar'}</dd>
      ${o.observaciones ? `<dt>Estado al recibir</dt><dd>${esc(o.observaciones)}</dd>` : ''}
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
      <button class="btn sec" data-act="recepcion" data-id="${o.id}">Hoja de recepción${o.recepcionFirmada ? ' (firmada)' : ''}</button>
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
      const costoInv = (o.lineas || []).reduce((a, l) => a + (l.rid ? (Number(l.cant) || 0) * (S.costos[l.rid] || 0) : 0), 0);
      const gasto = sum(gastos, 'monto') + costoInv;
      const el = $('#extra');
      if (el && (pagos.length || gastos.length || costoInv)) {
        el.innerHTML = `<h3 class="sec" style="margin-top:6px">Cuentas de la orden</h3><div class="pagos-l">
          ${pagos.map((x) => `<div><span>Cobro ${fechaCorta(x.fecha)} · ${esc(x.metodo)}</span><b>${money(x.monto)}</b></div>`).join('')}
          ${gastos.map((x) => `<div><span>${esc(x.categoria)}${x.nota ? ' · ' + esc(x.nota) : ''}</span><b class="deuda">−${money(x.monto)}</b></div>`).join('')}
          ${costoInv ? `<div><span>Repuestos del inventario (costo)</span><b class="deuda">−${money(costoInv)}</b></div>` : ''}
          <div><span><b>Ganancia de esta orden</b></span><b class="${sum(pagos, 'monto') - gasto < 0 ? 'deuda' : 'ok'}">${signed(sum(pagos, 'monto') - gasto)}</b></div></div>`;
      }
    } catch (e) { /* sin conexión: se omite el detalle financiero */ }
  }
}

function verMov(t, id) {
  const m = t === 'pago' ? S.pagos.find((x) => x.id === id) : buscarGasto(id);
  if (!m) return;
  const filas = t === 'pago'
    ? [['Fecha', fechaCorta(m.fecha)], ['Monto', money(m.monto)], ['Método', m.metodo], ['Orden', m.placa || 'Venta suelta'], ['Detalle', m.concepto || '—'], ['Registrado por', m.porEmail]]
    : [['Fecha', fechaCorta(m.fecha)], ['Monto', money(m.monto)], ['Categoría', m.categoria], ['Pagado con', m.metodo], ['Proveedor', m.proveedor || '—'], ['Detalle', m.nota || '—'], ['Orden', m.placa || '—'],
      ...(m.credito ? [['Compra a crédito', `${m.plazoDias} días`], ['Estado del pago', m.pendientePago ? textoVence(m) : `Pagado el ${fechaCorta(m.pagadoEn)} · ${m.metodoPago}`]] : []),
      ...(m.inventario ? [['Inventario', `Ingresó ${m.inventario.cantidad} al inventario`]] : []),
      ['Registrado por', m.porEmail]];
  const asociar = t === 'gasto' ? `<form data-form="gasto-orden" data-actual="${esc(m.ordenId || '')}">
      <input type="hidden" name="id" value="${esc(m.id)}"><input type="hidden" name="monto" value="${esc(m.monto)}">
      <div class="campo"><label for="g-or">Orden asociada</label><select id="g-or" name="ordenId"><option value="">Ninguna</option>${opcionesOrden(m.ordenId, false)}</select></div>
      ${htmlLineaGasto()}
      <button class="btn sec" type="submit">Guardar orden asociada</button></form>` : '';
  const pagar = (t === 'gasto' && m.pendientePago && S.isOwner) ? `<form data-form="gasto-pagar"><input type="hidden" name="id" value="${esc(m.id)}">
      <div class="fila-2"><div class="campo"><label for="gp-m">Pagado con</label><select id="gp-m" name="metodoPago">${opcionesMetodo()}</select></div>
      <div class="campo"><label for="gp-f">Fecha de pago</label><input id="gp-f" name="pagadoEn" type="date" value="${ymd()}" required></div></div>
      <button class="btn" type="submit">Marcar como pagado</button></form>` : '';
  const ingresar = (t === 'gasto' && S.isOwner && !m.inventario && !m.ordenId) ? `<details class="plegable"><summary>Ingresar este gasto al inventario</summary>
      <form data-form="gasto-inv"><input type="hidden" name="id" value="${esc(m.id)}"><input type="hidden" name="monto" value="${esc(m.monto)}">${htmlIngresoInv(true)}
      <button class="btn sec" type="submit">Ingresar al inventario</button></form></details>` : '';
  openSheet(t === 'pago' ? 'Cobro' : 'Gasto', `<dl class="kv">${filas.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
    ${pagar}
    ${asociar}
    ${ingresar}
    ${S.isOwner ? `<div class="btns"><button class="btn peligro" data-act="borrar-mov" data-t="${t}" data-id="${id}">Eliminar</button></div>` : ''}`);
  const fa = document.querySelector('form[data-form="gasto-orden"]');
  if (fa) { fa.lineaDesc.value = m.nota || m.categoria || 'Repuesto'; precioSugerido(fa); }
  const fi = document.querySelector('form[data-form="gasto-inv"]');
  if (fi) { fi.invNombre.value = m.nota || ''; gastoUI(fi); }
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
    const [p, g, gp] = await Promise.all([
      getDocs(query(collection(db, 'pagos'), where('fecha', '==', fecha))),
      getDocs(query(collection(db, 'gastos'), where('fecha', '==', fecha))),
      getDocs(query(collection(db, 'gastos'), where('pagadoEn', '==', fecha)))
    ]);
    const pagos = p.docs.map((d) => d.data());
    const gastos = g.docs.map((d) => d.data());
    const efIn = sum(pagos.filter((x) => x.metodo === 'Efectivo'), 'monto');
    const efOut = sum(gastos.filter((x) => x.metodo === 'Efectivo'), 'monto') + sum(gp.docs.map((d) => d.data()).filter((x) => x.metodoPago === 'Efectivo'), 'monto');
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
    <input type="hidden" name="l-rid" value="${esc(l.rid || '')}">${l.rid ? '<span class="sub">Del inventario: baja el stock al guardar</span>' : ''}
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
  const d = fd.getAll('l-desc'), c = fd.getAll('l-cant'), p = fd.getAll('l-precio'), r = fd.getAll('l-rid');
  return d.map((desc, i) => {
    const l = { desc: String(desc).trim(), cant: toQty(c[i]) || 1, precio: toNum(p[i]) };
    if (r[i]) l.rid = String(r[i]);
    return l;
  }).filter((l) => l.desc || l.precio);
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
    ${htmlPickerInv()}
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
    ${htmlPickerInv()}
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
  aplicarInventario(b, [], c.lineas, { ordenId: ref.id, placa: c.placa });
  b.update(doc(db, 'cotizaciones', c.id), { estado: 'Aprobada', ordenId: ref.id });
  b.commit().catch(fail);
  closeSheet();
  toast('Orden creada desde la cotización');
}

/* ---------- Documentos: proforma y comprobante ---------- */
function cargarImagen(url) {
  return new Promise((res) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = () => res(null);
    i.src = url;
  });
}

let logoImg; // se carga una sola vez; null si no se pudo cargar
function cargarLogo() {
  return new Promise((res) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = () => res(null);
    i.src = logoUrl;
  });
}

async function crearDocumento(d) {
  if (logoImg === undefined) logoImg = await cargarLogo();
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
  const LH = 190; // alto del logo
  const LW = logoImg ? Math.round(LH * logoImg.width / logoImg.height) : 0;
  const x0 = logoImg ? M + LW + 36 : M; // los datos del taller van a la derecha del logo
  if (logoImg) {
    g.save();
    g.beginPath();
    if (g.roundRect) g.roundRect(M, y, LW, LH, 12); else g.rect(M, y, LW, LH);
    g.clip();
    g.drawImage(logoImg, M, y, LW, LH);
    g.restore();
  }
  txt(t.nombre || 'RiCar Solutions', x0, y + 36, `700 ${logoImg ? 54 : 66}px ${DISP}`);
  let yi = y + 76;
  [t.cedula && `Cédula: ${t.cedula}`, t.telefono && `Tel. ${t.telefono}`, t.correo, t.direccion].filter(Boolean).forEach((s) => {
    envolver(s, logoImg ? 400 : 600, `400 26px ${TXT}`).forEach((l) => { txt(l, x0, yi, `400 26px ${TXT}`, MUTED); yi += 34; });
  });
  const proforma = d.tipo === 'proforma';
  const recepcion = d.tipo === 'recepcion';
  txt(proforma ? 'PROFORMA' : recepcion ? 'HOJA DE RECEPCIÓN' : 'COMPROBANTE DE TRABAJO', R, y + 36, `700 ${proforma ? 60 : recepcion ? 50 : 44}px ${DISP}`, INK, 'right');
  txt(`N.º ${d.numero}`, R, y + 82, `600 28px ${TXT}`, INK, 'right');
  txt(`Fecha: ${fechaLarga(d.fecha)}`, R, y + 118, `400 26px ${TXT}`, MUTED, 'right');
  if (recepcion && d.hora) txt(`Hora de ingreso: ${d.hora}`, R, y + 152, `400 26px ${TXT}`, MUTED, 'right');
  if (proforma) txt(`Válida hasta: ${fechaLarga(sumarDias(d.fecha, d.validez || 8))}`, R, y + 152, `400 26px ${TXT}`, MUTED, 'right');
  y = Math.max(yi, y + 170, logoImg ? y + LH : 0) + 16;
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
  let yv = y + 134;
  if (d.marca) { txt(d.marca, R, yv, `400 26px ${TXT}`, MUTED, 'right'); yv += 32; }
  const ingreso = [d.km ? kmTxt(d.km) : '', d.combustible ? `Combustible ${d.combustible}` : ''].filter(Boolean).join(' · ');
  if (ingreso) { txt(ingreso, R, yv, `400 26px ${TXT}`, MUTED, 'right'); yv += 32; }
  y = Math.max(y + 164, yv + 12);

  const firmaImg = recepcion && d.firma ? await cargarImagen(d.firma) : null;
  if (recepcion) {
    const parrafo = (titulo, texto, font, color, maxLineas) => {
      if (y + 80 > H - M) nueva();
      txt(titulo, M, y + 22, `600 22px ${TXT}`, MUTED);
      y += 38;
      envolver(texto, R - M, font).slice(0, maxLineas).forEach((l) => {
        if (y + 40 > H - M) nueva();
        txt(l, M, y + 24, font, color);
        y += 36;
      });
      y += 18;
    };
    // Datos de ingreso: kilometraje y medidor de combustible
    txt('Datos de ingreso', M, y + 22, `600 22px ${TXT}`, MUTED);
    y += 38;
    barra(y, '#f3f4f5', 128);
    txt('Kilometraje', M + 24, y + 40, `600 22px ${TXT}`, MUTED);
    txt(d.km ? kmTxt(d.km) : 'No registrado', M + 24, y + 96, `700 46px ${DISP}`);
    txt('Nivel de combustible', 640, y + 40, `600 22px ${TXT}`, MUTED);
    const niv = COMBUSTIBLE.indexOf(d.combustible);
    for (let i = 0; i < 4; i++) {
      g.fillStyle = niv > i ? INK : '#d4d9dd';
      g.fillRect(640 + i * 110, y + 56, 100, 30);
    }
    txt(d.combustible || 'No registrado', 640, y + 116, `600 26px ${TXT}`, INK);
    y += 128 + 30;
    parrafo('Problema reportado por el cliente', d.descripcion || 'No indicado', `400 28px ${TXT}`, INK, 8);
    parrafo('Estado del vehículo al recibirlo', d.observaciones || 'Sin observaciones registradas.', `400 28px ${TXT}`, INK, 8);
    parrafo('Condiciones', d.condiciones, `400 24px ${TXT}`, MUTED, 12);
    // Firma digital del cliente
    if (y + 320 > H - M) nueva();
    y += 10;
    const sw = 540, sh = Math.round(sw * 300 / 800);
    if (firmaImg) g.drawImage(firmaImg, M, y, sw, sh);
    g.fillStyle = INK;
    g.fillRect(M, y + sh + 8, sw, 3);
    txt(`Firma del cliente: ${d.firmante || d.cliente || ''}`, M, y + sh + 44, `600 26px ${TXT}`);
    txt(d.firmadoEn ? `Firmado digitalmente el ${fechaLarga(ymd(new Date(d.firmadoEn)))}, ${horaTxt(d.firmadoEn)}` : 'Firma pendiente', M, y + sh + 78, `400 22px ${TXT}`, MUTED);
    if (d.recibidoPor) txt(`Recibido por: ${d.recibidoPor}`, R, y + sh + 44, `600 26px ${TXT}`, INK, 'right');
    y += sh + 100;
  } else {
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
  }
  if (pages.length > 1) {
    pages.forEach((c, i) => {
      const gg = c.getContext('2d');
      gg.font = `400 22px ${TXT}`; gg.fillStyle = MUTED; gg.textAlign = 'center';
      gg.fillText(`Página ${i + 1} de ${pages.length}`, W / 2, H - 36);
    });
  }
  return pages;
}

async function verRecepcionDoc(id, extra = {}) {
  const base = S.ordenes.find((x) => x.id === id);
  if (!base) return;
  const pick = (k) => (k in extra ? extra[k] : base[k]);
  let firma = extra.firma, firmante = pick('firmante'), firmadoEn = pick('recepcionEn'), recibidoPor = pick('recepcionPor');
  if (firma === undefined) {
    firma = null;
    if (base.recepcionFirmada) {
      try {
        const snap = await getDoc(doc(db, 'recepciones', id));
        if (snap.exists()) {
          const r = snap.data();
          firma = r.firma || null; firmante = r.firmante; firmadoEn = r.recepcionEn; recibidoPor = r.recepcionPor;
          if (!('observaciones' in extra)) extra = { ...extra, observaciones: r.observaciones };
        }
      } catch (e) { /* sin conexión: se muestra sin la imagen de la firma */ }
    }
  }
  toast('Preparando hoja…');
  const ingreso = base.creadoEn || Date.now();
  try {
    S.docPages = await crearDocumento({
      tipo: 'recepcion', numero: base.numero, fecha: ymd(new Date(ingreso)), hora: horaTxt(ingreso),
      cliente: base.cliente, telefono: base.telefono, placa: base.placa, marca: base.marca,
      km: base.km, combustible: base.combustible, descripcion: base.problema,
      observaciones: 'observaciones' in extra ? extra.observaciones : base.observaciones,
      condiciones: S.taller.condicionesRecepcion || CONDICIONES_DEFECTO,
      firma, firmante, firmadoEn, recibidoPor
    });
  } catch (e) { return fail(e); }
  S.docNombre = `Recepcion-${base.placa}-${ymd()}`;
  openSheet('Hoja de recepción', `
    <p class="sub">Así se verá la hoja. Compártela como PDF por WhatsApp o correo.</p>
    ${S.docPages.map((c) => `<img class="doc-img" alt="Página del documento" src="${c.toDataURL('image/jpeg', 0.85)}">`).join('')}
    <div class="btns"><button class="btn" data-act="doc-compartir">Compartir PDF</button><button class="btn sec" data-act="cerrar">Cerrar</button></div>`);
}

async function abrirRecepcion(id) {
  const o = S.ordenes.find((x) => x.id === id);
  if (!o) return;
  const cond = S.taller.condicionesRecepcion || CONDICIONES_DEFECTO;
  openSheet('Recepción del vehículo', `<form data-form="recepcion">
    <input type="hidden" name="id" value="${esc(o.id)}">
    <span class="placa grande">${esc(o.placa)}</span>
    <dl class="kv">
      <dt>Cliente</dt><dd>${esc(o.cliente || '—')}</dd>
      <dt>Vehículo</dt><dd>${esc(o.marca || '—')}</dd>
      <dt>Kilometraje</dt><dd>${o.km ? kmTxt(o.km) : '—'}</dd>
      <dt>Combustible</dt><dd>${esc(o.combustible || '—')}</dd>
      <dt>Problema</dt><dd>${esc(o.problema)}</dd>
    </dl>
    ${o.recepcionFirmada ? `<div class="alerta ambar">Ya tiene una firma del ${fechaCorta(ymd(new Date(o.recepcionEn)))}. Si firmas de nuevo, reemplaza la anterior.<br><button type="button" class="link" data-act="recepcion-ver" data-id="${esc(o.id)}">Ver la hoja firmada</button></div>` : ''}
    <div class="campo"><label for="rc-o">Estado del vehículo al recibirlo</label><textarea id="rc-o" name="observaciones" placeholder="Ej: rayón en la puerta derecha, golpe en el parachoques trasero…">${esc(o.observaciones || '')}</textarea></div>
    <p class="sub"><b>Condiciones:</b> ${esc(cond)}</p>
    <label style="font-weight:600;font-size:15px">Firma del cliente (con el dedo)</label>
    <canvas id="firma" class="firma-pad" width="800" height="300"></canvas>
    <div class="campo"><label for="rc-n">Nombre de quien firma</label><input id="rc-n" name="firmante" value="${esc(o.firmante || o.cliente || '')}" autocomplete="off"></div>
    <div class="btns">
      <button type="button" class="btn sec" data-act="firma-borrar">Borrar firma</button>
      <button class="btn" type="submit">Guardar firma y ver hoja</button>
      <button type="button" class="link" data-act="recepcion-sinfirma" data-id="${esc(o.id)}">Ver la hoja sin firma</button>
    </div></form>`);
  FIRMA.vacio = true;
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
      km: proforma ? null : src.km, combustible: proforma ? '' : src.combustible,
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

/* ---------- Compras a crédito ---------- */
const diasPara = (f) => {
  const [y, m, d] = f.split('-').map(Number);
  const [y2, m2, d2] = ymd().split('-').map(Number);
  return Math.round((new Date(y, m - 1, d) - new Date(y2, m2 - 1, d2)) / 86400000);
};
const estadoCredito = (g) => {
  if (!g.credito) return null;
  if (!g.pendientePago) return 'pagado';
  const d = diasPara(g.fechaVence);
  return d < 0 ? 'vencido' : d <= 3 ? 'pronto' : 'pendiente';
};
function textoVence(g) {
  const d = diasPara(g.fechaVence);
  if (d < 0) return `Vencido hace ${-d} día${d === -1 ? '' : 's'}`;
  if (d === 0) return 'Vence hoy';
  if (d === 1) return 'Vence mañana';
  return `Vence en ${d} días (${fechaCorta(g.fechaVence)})`;
}
const buscarGasto = (id) => S.gastos.find((x) => x.id === id) || S.credito.find((x) => x.id === id);

function filaCredito(g) {
  const e = estadoCredito(g);
  return `<button class="fila mov out ${e === 'vencido' ? 'venc' : e === 'pronto' ? 'pronto' : ''}" data-act="mov" data-t="gasto" data-id="${g.id}">
    <div class="fila-b"><strong>${esc(g.proveedor || 'Proveedor')}</strong><span>${esc(g.pendientePago ? textoVence(g) : `Pagado el ${fechaCorta(g.pagadoEn || g.fecha)}${g.metodoPago ? ' · ' + g.metodoPago : ''}`)}${g.nota ? ' · ' + esc(g.nota) : ''}</span></div>
    <div class="monto">${money(g.monto)}</div></button>`;
}

function alertaCredito() {
  if (!S.credito.length) return '';
  const venc = S.credito.filter((g) => diasPara(g.fechaVence) < 0).length;
  const pronto = S.credito.filter((g) => { const d = diasPara(g.fechaVence); return d >= 0 && d <= 3; }).length;
  if (venc) return `<button class="alerta rojo" data-act="tab" data-k="inicio">${venc === 1 ? 'Hay 1 pago a proveedor vencido' : `Hay ${venc} pagos a proveedores vencidos`}</button>`;
  if (pronto) return `<div class="alerta ambar">${pronto === 1 ? '1 pago a proveedor vence' : `${pronto} pagos a proveedores vencen`} en los próximos 3 días</div>`;
  return '';
}

function listaPorPagar() {
  if (!S.creditoTodos.length) return '';
  const pendientes = S.credito.length
    ? `<div class="libro"><div><span>Total pendiente</span><b>${money(sum(S.credito, 'monto'))}</b></div></div>
       <div class="lista">${S.credito.slice(0, 5).map(filaCredito).join('')}</div>`
    : '<div class="vacio">No hay pagos pendientes a proveedores.</div>';
  return `<h3 class="sec">Por pagar a proveedores</h3>${pendientes}
    <button class="btn sec" data-act="ir-cred" style="margin-top:10px">Ver todos los créditos</button>`;
}

function listaCreditos() {
  const todos = S.creditoTodos;
  const q = S.credBusqueda.trim().toLowerCase();
  let l = todos;
  if (S.credFiltro === 'pendientes') l = todos.filter((g) => g.pendientePago);
  else if (S.credFiltro === 'vencidos') l = todos.filter((g) => g.pendientePago && diasPara(g.fechaVence) < 0);
  else if (S.credFiltro === 'pagados') l = todos.filter((g) => !g.pendientePago);
  if (q) l = l.filter((g) => (g.proveedor || '').toLowerCase().includes(q) || (g.nota || '').toLowerCase().includes(q));
  l = [...l].sort((a, b) => {
    if (!!a.pendientePago !== !!b.pendientePago) return a.pendientePago ? -1 : 1;
    return a.pendientePago ? (a.fechaVence || '').localeCompare(b.fechaVence || '') : (b.pagadoEn || '').localeCompare(a.pagadoEn || '');
  });
  if (!l.length) return '<div class="vacio">No hay créditos con este filtro.</div>';
  let porProv = '';
  if (S.credFiltro === 'pendientes' || S.credFiltro === 'vencidos') {
    const m = {};
    l.forEach((g) => { const k = g.proveedor || 'Sin proveedor'; m[k] = m[k] || { n: 0, t: 0 }; m[k].n++; m[k].t += g.monto; });
    porProv = `<h3 class="sec" style="margin-top:6px">Por proveedor</h3><div class="libro">${Object.entries(m).sort((a, b) => b[1].t - a[1].t)
      .map(([k, v]) => `<div><span>${esc(k)} <span class="sub">(${v.n})</span></span><b>${money(v.t)}</b></div>`).join('')}</div><h3 class="sec">Detalle</h3>`;
  }
  return `${porProv}<div class="lista">${l.map(filaCredito).join('')}</div>`;
}

function vCreditos() {
  const todos = S.creditoTodos;
  const pend = todos.filter((g) => g.pendientePago);
  const venc = pend.filter((g) => diasPara(g.fechaVence) < 0);
  const semana = pend.filter((g) => { const d = diasPara(g.fechaVence); return d >= 0 && d <= 7; });
  const f = [['pendientes', `Pendientes (${pend.length})`], ['vencidos', `Vencidos (${venc.length})`], ['pagados', 'Pagados'], ['todos', 'Todos']];
  return `<button class="link" data-act="tab" data-k="inicio" style="color:var(--ink)">‹ Volver al inicio</button>
    <h1 class="titulo">Cuentas por pagar</h1>
    <div class="libro">
      <div><span>Total pendiente</span><b>${money(sum(pend, 'monto'))}</b></div>
      <div><span>Vencido</span><b class="${venc.length ? 'deuda' : ''}">${money(sum(venc, 'monto'))}</b></div>
      <div><span>Vence en los próximos 7 días</span><b>${money(sum(semana, 'monto'))}</b></div>
    </div>
    <div class="campo"><input id="buscar-cred" type="search" placeholder="Buscar por proveedor o detalle" value="${esc(S.credBusqueda)}"></div>
    <div class="chips">${f.map(([k, l]) => `<button class="chip ${S.credFiltro === k ? 'on' : ''}" data-act="cred-filtro" data-k="${k}">${l}</button>`).join('')}</div>
    <div id="lista-cred">${listaCreditos()}</div>`;
}

function htmlCredito() {
  return `<label class="check"><input type="checkbox" name="credito"> Compra a crédito</label>
    <div id="g-credito" hidden>
      <div class="campo"><label for="g-pl">Plazo para pagar (días)</label><input id="g-pl" name="plazoDias" inputmode="numeric" value="30"><span class="sub" id="g-vence"></span></div>
    </div>`;
}

async function programarAvisos() {
  if (!S.isOwner) return;
  try {
    let perm = await LocalNotifications.checkPermissions();
    if (perm.display !== 'granted') perm = await LocalNotifications.requestPermissions();
    if (perm.display !== 'granted') return;
    const pend = await LocalNotifications.getPending();
    if (pend.notifications.length) await LocalNotifications.cancel({ notifications: pend.notifications.map((n) => ({ id: n.id })) });
    const idNum = (s) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 200000000; return h; };
    const ahora = Date.now();
    const lista = [];
    S.credito.forEach((g) => {
      const [y, m, d] = g.fechaVence.split('-').map(Number);
      const cuerpo = (t) => `${g.proveedor || 'Proveedor'}: ${money(g.monto)} ${t}`;
      [[-2, 1, 'vence en 2 días'], [0, 2, 'vence hoy'], [1, 3, 'está vencido']].forEach(([off, k, t]) => {
        const at = new Date(y, m - 1, d + off, 9, 0, 0);
        if (at.getTime() > ahora) lista.push({ id: idNum(g.id) * 10 + k, title: 'Pago a proveedor', body: cuerpo(t), schedule: { at, allowWhileIdle: true } });
      });
    });
    if (lista.length) await LocalNotifications.schedule({ notifications: lista });
  } catch (e) { /* navegador, sin permiso o plugin no disponible */ }
}

/* ---------- Inventario ---------- */
const MOV_ROT = { entrada: 'Entrada', salida: 'Salida (orden)', devolucion: 'Devolución (orden)', ajuste: 'Ajuste' };
const stockBajo = (r) => r.activo !== false && Number(r.stockMin) > 0 && Number(r.stock) <= Number(r.stockMin);

function filaRepuesto(r) {
  const stock = Number(r.stock) || 0;
  const k = stock <= 0 ? 'cancelado' : stockBajo(r) ? 'en-reparacion' : 'listo';
  const costo = S.isOwner ? ` · <span class="sub">costo ${S.costos[r.id] != null ? money(S.costos[r.id]) : '—'}</span>` : '';
  return `<button class="fila e-l-${k}" data-act="repuesto" data-id="${r.id}">
    <div class="fila-a"><strong>${esc(r.nombre)}</strong><span class="badge e-${k}">${stock <= 0 ? 'Agotado' : `${stock} en stock`}</span></div>
    <div class="fila-b"><span>${esc(r.codigo || 'Sin código')}${r.activo === false ? ' · Archivado' : ''}</span></div>
    <div class="fila-c">Venta ${money(r.precioVenta)}${costo}</div></button>`;
}

function repuestosFiltrados() {
  const q = S.invBusqueda.trim().toLowerCase();
  return S.repuestos.filter((r) => {
    if (S.invFiltro === 'archivados') return r.activo === false;
    if (r.activo === false) return false;
    if (S.invFiltro === 'bajo' && !(stockBajo(r) || Number(r.stock) <= 0)) return false;
    return !q || (r.nombre || '').toLowerCase().includes(q) || (r.codigo || '').toLowerCase().includes(q);
  });
}

function htmlListaInv() {
  const l = repuestosFiltrados();
  if (l.length) return `<div class="lista">${l.map(filaRepuesto).join('')}</div>`;
  return S.repuestos.length ? '<div class="vacio">No hay repuestos con este filtro.</div>'
    : `<div class="vacio">Todavía no hay repuestos en el inventario.${S.isOwner ? ' Toca "Nuevo repuesto" o registra un gasto con la opción "Ingresa al inventario".' : ''}</div>`;
}

function vInv() {
  const f = [['todos', 'Todos'], ['bajo', 'Stock bajo']];
  if (S.isOwner) f.push(['archivados', 'Archivados']);
  const valor = S.isOwner ? S.repuestos.filter((r) => r.activo !== false).reduce((a, r) => a + (Number(r.stock) || 0) * (S.costos[r.id] || 0), 0) : 0;
  return `<h1 class="titulo">Inventario</h1>
    ${S.isOwner ? `<div class="libro"><div><span>Valor del inventario (a costo)</span><b>${money(valor)}</b></div></div>
      <button class="btn oscuro" data-act="repuesto-nuevo" style="margin-bottom:12px">Nuevo repuesto</button>` : ''}
    <div class="campo"><input id="buscar-inv" type="search" placeholder="Buscar por nombre o código" value="${esc(S.invBusqueda)}"></div>
    <div class="chips">${f.map(([k, l]) => `<button class="chip ${S.invFiltro === k ? 'on' : ''}" data-act="inv-filtro" data-k="${k}">${l}</button>`).join('')}</div>
    <div id="lista-inv">${htmlListaInv()}</div>`;
}

async function verRepuesto(id) {
  const r = S.repuestos.find((x) => x.id === id);
  if (!r) return;
  const costo = S.costos[id];
  openSheet(esc(r.nombre), `
    <dl class="kv">
      <dt>Código</dt><dd>${esc(r.codigo || '—')}</dd>
      <dt>En stock</dt><dd>${Number(r.stock) || 0}</dd>
      <dt>Stock mínimo</dt><dd>${Number(r.stockMin) || 0}</dd>
      <dt>Precio de venta</dt><dd>${money(r.precioVenta)}</dd>
      ${S.isOwner ? `<dt>Costo (última compra)</dt><dd>${costo != null ? money(costo) : '—'}</dd>
        <dt>Valor en stock</dt><dd>${costo != null ? money((Number(r.stock) || 0) * costo) : '—'}</dd>` : ''}
    </dl>
    <h3 class="sec" style="margin-top:6px">Últimos movimientos</h3>
    <div id="movs-inv" class="pagos-l"><div><span>Cargando…</span></div></div>
    ${S.isOwner ? `<div class="btns">
      <button class="btn" data-act="repuesto-ajuste" data-id="${r.id}">Ajustar existencias (conteo)</button>
      <button class="btn sec" data-act="repuesto-editar" data-id="${r.id}">Editar repuesto</button>
      <button class="link" data-act="repuesto-archivar" data-id="${r.id}">${r.activo === false ? 'Reactivar repuesto' : 'Archivar repuesto'}</button></div>` : ''}`);
  try {
    const snap = await getDocs(query(collection(db, 'movimientosInv'), where('repuestoId', '==', id)));
    const l = snap.docs.map((d) => d.data()).sort((a, b) => (b.creadoEn || 0) - (a.creadoEn || 0)).slice(0, 10);
    const el = $('#movs-inv');
    if (!el) return;
    el.innerHTML = l.length ? l.map((m) => {
      const n = m.tipo === 'salida' ? -m.cantidad : m.cantidad;
      return `<div><span>${fechaCorta(m.fecha)} · ${MOV_ROT[m.tipo] || m.tipo}${m.placa ? ' · ' + esc(m.placa) : ''} · ${esc((m.porEmail || '').split('@')[0])}</span><b class="${n < 0 ? 'deuda' : 'ok'}">${n > 0 ? '+' : ''}${n}</b></div>`;
    }).join('') : '<div><span>Sin movimientos.</span></div>';
  } catch (e) {
    const el = $('#movs-inv');
    if (el) el.innerHTML = '<div><span>No se pudieron cargar. Revisa la conexión.</span></div>';
  }
}

function formRepuesto(r) {
  const v = r || {};
  openSheet(r ? 'Editar repuesto' : 'Nuevo repuesto', `<form data-form="repuesto"><input type="hidden" name="id" value="${esc(v.id || '')}">
    <div class="campo"><label for="r-n">Nombre</label><input id="r-n" name="nombre" value="${esc(v.nombre || '')}" autocomplete="off" required></div>
    <div class="campo"><label for="r-c">Código (opcional)</label><input id="r-c" name="codigo" value="${esc(v.codigo || '')}" autocomplete="off"></div>
    <div class="fila-2">
      <div class="campo"><label for="r-p">Precio de venta</label><input id="r-p" name="precioVenta" inputmode="numeric" value="${v.precioVenta || ''}" placeholder="₡0"></div>
      <div class="campo"><label for="r-k">Costo por unidad</label><input id="r-k" name="costo" inputmode="numeric" value="${r && S.costos[r.id] != null ? S.costos[r.id] : ''}" placeholder="₡0"></div>
    </div>
    <div class="fila-2">
      ${r ? '' : '<div class="campo"><label for="r-s">Existencias iniciales</label><input id="r-s" name="stock" inputmode="decimal" value="0"></div>'}
      <div class="campo"><label for="r-m">Stock mínimo</label><input id="r-m" name="stockMin" inputmode="numeric" value="${v.stockMin ?? 1}"></div>
    </div>
    <button class="btn" type="submit">Guardar repuesto</button></form>`);
}

function formAjuste(id) {
  const r = S.repuestos.find((x) => x.id === id);
  if (!r) return;
  openSheet('Ajustar existencias', `<form data-form="ajuste"><input type="hidden" name="id" value="${r.id}">
    <p class="sub">${esc(r.nombre)}: el sistema dice que hay <b>${Number(r.stock) || 0}</b>. Escribe lo que contaste en la bodega.</p>
    <div class="campo"><label for="a-c">Existencias reales</label><input id="a-c" name="conteo" inputmode="decimal" required></div>
    <div class="campo"><label for="a-n">Motivo (opcional)</label><input id="a-n" name="nota" placeholder="Ej: conteo del mes"></div>
    <button class="btn" type="submit">Guardar ajuste</button></form>`);
}

function htmlPickerInv() {
  const l = S.repuestos.filter((r) => r.activo !== false);
  if (!l.length) return '';
  return `<div class="picker"><label for="pk-r">Agregar del inventario</label>
    <select id="pk-r"><option value="">Elegir repuesto…</option>${l.map((r) => `<option value="${r.id}">${esc(r.nombre)} · ${Number(r.stock) || 0} en stock · ${money(r.precioVenta)}</option>`).join('')}</select>
    <div class="picker-fila"><input id="pk-c" inputmode="decimal" value="1" aria-label="Cantidad"><button type="button" class="btn sec" data-act="pk-agregar">Agregar a la lista</button></div></div>`;
}

// Diferencia entre las líneas guardadas y las nuevas: baja o devuelve existencias y deja el movimiento
function aplicarInventario(b, antes, despues, ctx) {
  const suma = (ls) => { const m = {}; (ls || []).forEach((l) => { if (l.rid) m[l.rid] = (m[l.rid] || 0) + (Number(l.cant) || 0); }); return m; };
  const a = suma(antes), n = suma(despues);
  new Set([...Object.keys(a), ...Object.keys(n)]).forEach((id) => {
    const delta = Math.round(((n[id] || 0) - (a[id] || 0)) * 1000) / 1000;
    const r = S.repuestos.find((x) => x.id === id);
    if (!delta || !r) return;
    b.update(doc(db, 'repuestos', id), { stock: increment(-delta) });
    b.set(doc(collection(db, 'movimientosInv')), {
      repuestoId: id, nombre: r.nombre, tipo: delta > 0 ? 'salida' : 'devolucion', cantidad: Math.abs(delta),
      ordenId: ctx.ordenId || null, placa: ctx.placa || null, fecha: ymd(),
      creadoPor: S.user.uid, porEmail: S.user.email, creadoEn: Date.now()
    });
  });
}

/* ---------- Ingreso de un gasto al inventario (solo dueño y admin) ---------- */
function htmlIngresoInv(forzado) {
  const opts = S.repuestos.filter((r) => r.activo !== false).map((r) => `<option value="${r.id}">${esc(r.nombre)}${r.codigo ? ' · ' + esc(r.codigo) : ''} (hay ${Number(r.stock) || 0})</option>`).join('');
  return `${forzado ? '<input type="hidden" name="inv" value="on">' : '<label class="check"><input type="checkbox" name="inv"> Ingresa al inventario</label>'}
    <div id="g-inv" ${forzado ? '' : 'hidden'}>
      <div class="campo"><label for="g-ir">Repuesto</label><select id="g-ir" name="invRep"><option value="__nuevo">Crear repuesto nuevo…</option>${opts}</select></div>
      <div id="g-inuevo">
        <div class="campo"><label for="g-in">Nombre del repuesto</label><input id="g-in" name="invNombre" autocomplete="off"></div>
        <div class="fila-2">
          <div class="campo"><label for="g-ic">Código (opcional)</label><input id="g-ic" name="invCodigo" autocomplete="off"></div>
          <div class="campo"><label for="g-im">Stock mínimo</label><input id="g-im" name="invMin" inputmode="numeric" value="1"></div>
        </div>
        <div class="campo"><label for="g-ip">Precio de venta</label><input id="g-ip" name="invPrecio" inputmode="numeric" placeholder="₡0"></div>
      </div>
      <div class="campo"><label for="g-iq">Cantidad que ingresa</label><input id="g-iq" name="invCant" inputmode="decimal" value="1"><span class="sub" id="g-iu"></span></div>
    </div>`;
}

function aplicarIngreso(b, d, monto, gastoId) {
  const cant = toQty(d.invCant);
  if (cant <= 0) return { error: 'Escribe la cantidad que ingresa' };
  const unit = Math.round(monto / cant);
  let id = d.invRep, nombre;
  if (id === '__nuevo') {
    nombre = (d.invNombre || '').trim();
    if (!nombre) return { error: 'Escribe el nombre del repuesto' };
    const ref = doc(collection(db, 'repuestos'));
    id = ref.id;
    b.set(ref, { nombre, codigo: (d.invCodigo || '').trim(), precioVenta: toNum(d.invPrecio), stock: cant, stockMin: toNum(d.invMin), activo: true, creadoEn: Date.now() });
  } else {
    const r = S.repuestos.find((x) => x.id === id);
    if (!r) return { error: 'Elige el repuesto' };
    nombre = r.nombre;
    b.update(doc(db, 'repuestos', id), { stock: increment(cant) });
  }
  b.set(doc(db, 'repuestosCosto', id), { costo: unit, actualizado: Date.now() }, { merge: true });
  b.set(doc(collection(db, 'movimientosInv')), {
    repuestoId: id, nombre, tipo: 'entrada', cantidad: cant, gastoId, fecha: ymd(),
    creadoPor: S.user.uid, porEmail: S.user.email, creadoEn: Date.now()
  });
  return { id, cant, nombre };
}

// Muestra u oculta bloques del formulario de gasto y calcula textos de ayuda
function gastoUI(f) {
  if (f.credito) {
    const c = f.credito.checked;
    const blk = f.querySelector('#g-credito');
    if (blk) blk.hidden = !c;
    if (f.metodo) f.metodo.disabled = c;
    const pl = Math.max(1, Math.round(toNum(f.plazoDias.value)) || 30);
    const v = f.querySelector('#g-vence');
    if (v) v.textContent = c ? `Vence el ${fechaLarga(sumarDias(f.fecha.value || ymd(), pl))}` : '';
  }
  if (f.inv && f.inv.type === 'checkbox') {
    const on = f.inv.checked;
    f.querySelector('#g-inv').hidden = !on;
    if (f.ordenId) {
      f.ordenId.disabled = on;
      if (on) { f.ordenId.value = ''; actualizarLineaGasto(f); }
    }
  }
  const nuevo = f.invRep && f.invRep.value === '__nuevo';
  const bn = f.querySelector('#g-inuevo');
  if (bn) bn.hidden = !nuevo;
  if (f.invCant) {
    const q = toQty(f.invCant.value);
    const m = toNum(f.monto.value);
    const iu = f.querySelector('#g-iu');
    if (iu) iu.textContent = q > 0 && m > 0 ? `Costo por unidad: ${money(m / q)}` : '';
    if (f.invPrecio && !f.invPrecio.dataset.manual && q > 0 && m > 0) {
      const pct = S.taller.margenRepuestos ?? 25;
      f.invPrecio.value = Math.round((m / q) * (1 + pct / 100) / 100) * 100;
    }
  }
}

/* ---------- Desarrollo (solo Admin) ---------- */
const COLS_DATOS = [['ordenes', 'Órdenes'], ['cotizaciones', 'Cotizaciones'], ['pagos', 'Cobros'], ['gastos', 'Gastos'], ['cierres', 'Cierres de caja'], ['vehiculos', 'Vehículos'], ['repuestos', 'Repuestos'], ['repuestosCosto', 'Costos de repuestos'], ['movimientosInv', 'Movimientos de inventario'], ['recepciones', 'Hojas de recepción']];

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
    <p class="sub">Borrar los datos de prueba elimina órdenes, cotizaciones, cobros, gastos, cierres de caja, vehículos y todo el inventario. No toca las categorías, los datos del taller ni los usuarios. No se puede deshacer.</p>
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
    <div class="campo"><label for="t-cr">Condiciones de la hoja de recepción</label><textarea id="t-cr" name="condicionesRecepcion" style="min-height:130px">${esc(t.condicionesRecepcion || CONDICIONES_DEFECTO)}</textarea><span class="sub">Es un texto genérico. Revísalo y ajústalo a lo que quieras que acepte el cliente; para temas de responsabilidad conviene consultarlo con tu abogado.</span></div>
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
    const m = d.t === 'pago' ? S.pagos.find((x) => x.id === d.id) : buscarGasto(d.id);
    if (!m) return;
    if (m.inventario && !confirm('Este gasto ingresó repuestos al inventario. Las existencias NO se descuentan al eliminarlo. ¿Continuar?')) return;
    const b = writeBatch(db);
    b.delete(doc(db, d.t === 'pago' ? 'pagos' : 'gastos', d.id));
    if (d.t === 'pago' && m.ordenId) b.update(doc(db, 'ordenes', m.ordenId), { pagado: increment(-m.monto) });
    b.commit().catch(fail);
    closeSheet();
    toast('Registro eliminado');
  },
  'ir-cred': () => { S.tab = 'cred'; render(); window.scrollTo(0, 0); },
  'cred-filtro': (d) => { S.credFiltro = d.k; render(); },
  recepcion: (d) => abrirRecepcion(d.id),
  'recepcion-ver': (d) => verRecepcionDoc(d.id),
  'recepcion-sinfirma': (d, el) => {
    const f = el.closest('form');
    verRecepcionDoc(d.id, { firma: null, recepcionEn: null, recepcionPor: null, observaciones: f.observaciones.value.trim() });
  },
  'firma-borrar': () => {
    const c = $('#firma');
    if (c) c.getContext('2d').clearRect(0, 0, c.width, c.height);
    FIRMA.vacio = true;
  },
  repuesto: (d) => verRepuesto(d.id),
  'repuesto-nuevo': () => formRepuesto(null),
  'repuesto-editar': (d) => formRepuesto(S.repuestos.find((x) => x.id === d.id)),
  'repuesto-ajuste': (d) => formAjuste(d.id),
  'repuesto-archivar': (d) => {
    const r = S.repuestos.find((x) => x.id === d.id);
    if (!r) return;
    updateDoc(doc(db, 'repuestos', d.id), { activo: r.activo === false }).catch(fail);
    closeSheet();
    toast(r.activo === false ? 'Repuesto reactivado' : 'Repuesto archivado');
  },
  'inv-filtro': (d) => { S.invFiltro = d.k; render(); },
  'pk-agregar': (d, el) => {
    const sel = $('#pk-r');
    const r = S.repuestos.find((x) => x.id === sel.value);
    if (!r) return toast('Elige un repuesto');
    const cant = toQty($('#pk-c').value) || 1;
    if (cant > (Number(r.stock) || 0) && !confirm(`Solo hay ${Number(r.stock) || 0} en stock. ¿Agregar de todos modos?`)) return;
    const filas = [...$('#lineas').querySelectorAll('.linea')];
    const ya = filas.find((row) => row.querySelector('[name="l-rid"]').value === r.id);
    if (ya) {
      const c = ya.querySelector('[name="l-cant"]');
      c.value = toQty(c.value) + cant;
    } else {
      if (filas.length === 1 && !filas[0].querySelector('[name="l-desc"]').value && !filas[0].querySelector('[name="l-precio"]').value) filas[0].remove();
      $('#lineas').insertAdjacentHTML('beforeend', lineaHtml({ desc: r.nombre, cant, precio: r.precioVenta, rid: r.id }));
    }
    sel.value = '';
    $('#pk-c').value = '1';
    recalcLineas(el.closest('form'));
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

function posFirma(e) {
  const c = $('#firma');
  const r = c.getBoundingClientRect();
  return [(e.clientX - r.left) * c.width / r.width, (e.clientY - r.top) * c.height / r.height];
}
document.addEventListener('pointerdown', (e) => {
  if (e.target.id !== 'firma') return;
  e.preventDefault();
  e.target.setPointerCapture(e.pointerId);
  const g = e.target.getContext('2d');
  g.lineWidth = 5; g.lineCap = 'round'; g.lineJoin = 'round'; g.strokeStyle = '#1d2227';
  const [x, y] = posFirma(e);
  g.beginPath(); g.moveTo(x, y); g.lineTo(x + 0.1, y); g.stroke();
  FIRMA.dibujando = true;
  FIRMA.vacio = false;
});
document.addEventListener('pointermove', (e) => {
  if (!FIRMA.dibujando || e.target.id !== 'firma') return;
  const g = e.target.getContext('2d');
  const [x, y] = posFirma(e);
  g.lineTo(x, y); g.stroke();
});
['pointerup', 'pointercancel'].forEach((ev) => document.addEventListener(ev, () => { FIRMA.dibujando = false; }));

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
  if (e.target.id === 'buscar-cred') {
    S.credBusqueda = e.target.value;
    $('#lista-cred').innerHTML = listaCreditos();
  }
  if (e.target.id === 'buscar-inv') {
    S.invBusqueda = e.target.value;
    $('#lista-inv').innerHTML = htmlListaInv();
  }
  const hf = e.target.form;
  if (hf && ['gasto', 'gasto-inv'].includes(hf.dataset.form)) {
    if (e.target.name === 'invPrecio') e.target.dataset.manual = '1';
    if (e.target.name === 'invNombre') e.target.dataset.manual = '1';
    if (e.target.name === 'nota' && hf.invNombre && !hf.invNombre.dataset.manual) hf.invNombre.value = e.target.value;
    gastoUI(hf);
  }
  const gf = e.target.form;
  if (gf && ['gasto', 'gasto-orden'].includes(gf.dataset.form)) {
    if (e.target.name === 'monto') precioSugerido(gf);
    if (e.target.name === 'precioCli') { e.target.dataset.manual = '1'; precioSugerido(gf); }
    if (e.target.name === 'nota' && gf.lineaDesc && !gf.lineaDesc.dataset.manual) gf.lineaDesc.value = e.target.value;
    if (e.target.name === 'lineaDesc') e.target.dataset.manual = '1';
  }
});

document.addEventListener('change', (e) => {
  if (e.target.form && ['gasto', 'gasto-inv'].includes(e.target.form.dataset.form)) gastoUI(e.target.form);
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
    S.ordenes = []; S.pagos = []; S.gastos = []; S.categorias = []; S.cotizaciones = []; S.taller = {}; S.repuestos = []; S.costos = {}; S.credito = []; S.creditoTodos = [];
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
