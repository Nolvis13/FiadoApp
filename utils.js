import { Alert, Linking, Platform } from 'react-native';

export const VERDE = '#16A34A';
export const AZUL = '#0B1F4B';
export const ROJO = '#DC2626';
export const GRIS = '#6B7280';

// ---------- Formato ----------
export const RD = (n) =>
  'RD$' + Number(n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const pad = (n) => String(n).padStart(2, '0');
export const aYMD = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const hoyYMD = () => aYMD(new Date());
export const sumarDias = (n) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return aYMD(d);
};
export const fmtFecha = (iso) => {
  const d = new Date(iso);
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
};
export const fmtFechaHora = (iso) => {
  const d = new Date(iso);
  return `${fmtFecha(iso)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
export const fmtYMD = (ymd) => ymd.split('-').reverse().join('/');

// 8091234567 -> 18091234567 (formato que pide wa.me)
export function normalizarTelefono(t) {
  const d = String(t).replace(/\D/g, '');
  return d.length === 10 ? '1' + d : d;
}

// ---------- Avisos que funcionan en web y en teléfono ----------
export function avisar(titulo, mensaje = '') {
  if (Platform.OS === 'web') window.alert(mensaje ? `${titulo}\n\n${mensaje}` : titulo);
  else Alert.alert(titulo, mensaje);
}

export function confirmar(titulo, mensaje, textoOk, onOk, destructivo = false) {
  if (Platform.OS === 'web') {
    if (window.confirm(`${titulo}\n\n${mensaje}`)) onOk();
  } else {
    Alert.alert(titulo, mensaje, [
      { text: 'Cancelar', style: 'cancel' },
      { text: textoOk, style: destructivo ? 'destructive' : 'default', onPress: onOk },
    ]);
  }
}

// Hoy abre WhatsApp con el mensaje listo.
// En la Fase 4 solo cambias esta función para llamar a tu API (WhatsApp Cloud API).
export function abrirWhatsApp(telefono, mensaje) {
  const url = `https://wa.me/${normalizarTelefono(telefono)}?text=${encodeURIComponent(mensaje)}`;
  Linking.openURL(url).catch(() => avisar('Error', 'No se pudo abrir WhatsApp'));
}

// ---------- Mensajes de WhatsApp (plantillas editables) ----------
// Variables: {nombre} {monto} {balance} {colmado} {vencido}
export const PLANTILLAS = {
  msg_fiado:
    'Hola, {nombre}. Te informamos que has realizado un fiado de {monto} en {colmado}. Tu balance pendiente es {balance}. ¡Gracias por preferirnos!',
  msg_abono:
    'Hola, {nombre}. Hemos recibido tu abono de {monto}. Tu balance pendiente es {balance}. ¡Muchas gracias!',
  msg_recordatorio:
    'Hola {nombre}, te recordamos que tienes un saldo pendiente de {balance} en {colmado}. {vencido}¡Gracias!',
};

export const CONFIG_DEFECTO = {
  usuario_actual: '',
  negocio_nombre: 'Mi Colmado',
  negocio_telefono: '',
  negocio_direccion: '',
  negocio_logo: '',
  licencia_activa: true,
  licencia_expira: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
  bloqueo_automatico: true,
  licencia_codigo: 'PAGADO',
  ...PLANTILLAS,
  comprobante_pie: '¡Gracias por su preferencia!',
  comprobante_ancho: '58',
  comprobante_logo: '1',
};

export function parseBoolean(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    return ['1', 'true', 'yes', 'si', 'on'].includes(v) ? true : false;
  }
  return fallback;
}

export function evaluarLicencia(cfg) {
  const activa = parseBoolean(cfg?.licencia_activa, false);
  const expira = cfg?.licencia_expira || '';
  const fechaExpira = expira ? new Date(expira) : null;
  const hoy = new Date();
  const vencida = !!fechaExpira && fechaExpira < hoy && !activa;
  const diasRestantes = fechaExpira ? Math.ceil((fechaExpira.getTime() - hoy.getTime()) / 86400000) : null;

  return {
    activa,
    expira,
    vencida,
    diasRestantes,
    bloqueada:
      parseBoolean(cfg?.bloqueo_automatico, true) && !activa && !!fechaExpira && vencida,
  };
}

export const aplicarPlantilla = (tpl, vars) =>
  tpl.replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? vars[k] : m));

export const mensajeMov = (cfg, c, m, balance) =>
  aplicarPlantilla(m.tipo === 'fiao' ? cfg.msg_fiado : cfg.msg_abono, {
    nombre: c.nombre,
    colmado: cfg.negocio_nombre,
    monto: RD(m.monto),
    balance: RD(balance),
    vencido: '',
  });

export const mensajeRecordatorio = (cfg, c) =>
  aplicarPlantilla(cfg.msg_recordatorio, {
    nombre: c.nombre,
    colmado: cfg.negocio_nombre,
    monto: RD(c.saldo),
    balance: RD(c.saldo),
    vencido: c.vencido > 0 ? `De ese monto, ${RD(c.vencido)} ya está vencido. ` : '',
  });

// Describe qué cambió entre dos versiones de un registro (para la auditoría)
export function diferencias(antes, despues, etiquetas) {
  const partes = [];
  for (const k of Object.keys(etiquetas)) {
    const a = antes[k] ?? '';
    const b = despues[k] ?? '';
    if (String(a) !== String(b)) {
      partes.push(`${etiquetas[k]}: ${a === '' ? '(vacío)' : a} → ${b === '' ? '(vacío)' : b}`);
    }
  }
  return partes.join('; ');
}

export const ADMIN_PASS = 'nolvis123';

export function normalizarCodigo(codigo) {
  return String(codigo || '').replace(/[^A-Z0-9]/gi, '').toUpperCase();
}

export function generarCodigoActivacion(cliente, meses = 1, pass = ADMIN_PASS) {
  const nombre = String(cliente || '').trim().toUpperCase();
  const periodo = Number(meses) || 1;
  const seed = `${nombre}|${periodo}|${String(pass || ADMIN_PASS).trim().toLowerCase()}`;
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const codigo = ((hash >>> 0) % 36 ** 10).toString(36).toUpperCase();
  return `FIADO-${(codigo + '0000000000').slice(0, 10)}`;
}

export function validarCodigoActivacion(codigo, cliente, meses = 1, pass = ADMIN_PASS) {
  return normalizarCodigo(codigo) === normalizarCodigo(generarCodigoActivacion(cliente, meses, pass));
}