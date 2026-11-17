import { Platform } from 'react-native';
import { hoyYMD, CONFIG_DEFECTO } from './utils';

// ---------- Base de datos (con migraciones) ----------
export async function iniciarDB(db) {
  if (Platform.OS === 'web') {
    await db.execAsync('PRAGMA journal_mode = DELETE;');
  } else {
    await db.execAsync('PRAGMA journal_mode = WAL;');
  }
  const fila = await db.getFirstAsync('PRAGMA user_version');
  const version = fila ? fila.user_version : 0;

  if (version < 1) {
    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS clientes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nombre TEXT NOT NULL,
        telefono TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS movimientos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cliente_id INTEGER NOT NULL,
        tipo TEXT NOT NULL,
        monto REAL NOT NULL,
        nota TEXT,
        fecha TEXT NOT NULL
      );
    `);
  }
  if (version < 2) {
    await db.execAsync(`
      ALTER TABLE clientes ADD COLUMN direccion TEXT;
      ALTER TABLE clientes ADD COLUMN observaciones TEXT;
      ALTER TABLE clientes ADD COLUMN creado TEXT;
      ALTER TABLE movimientos ADD COLUMN fecha_limite TEXT;
      ALTER TABLE movimientos ADD COLUMN metodo TEXT;
      PRAGMA user_version = 2;
    `);
  }
  if (version < 3) {
    await db.execAsync(`
      ALTER TABLE movimientos ADD COLUMN anulado INTEGER DEFAULT 0;
      ALTER TABLE movimientos ADD COLUMN creado_por TEXT;
      ALTER TABLE movimientos ADD COLUMN editado_por TEXT;
      ALTER TABLE movimientos ADD COLUMN editado_en TEXT;
      ALTER TABLE clientes ADD COLUMN editado_por TEXT;
      ALTER TABLE clientes ADD COLUMN editado_en TEXT;
      CREATE TABLE IF NOT EXISTS config (
        clave TEXT PRIMARY KEY,
        valor TEXT
      );
      CREATE TABLE IF NOT EXISTS auditoria (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        fecha TEXT NOT NULL,
        usuario TEXT,
        entidad TEXT,
        entidad_id INTEGER,
        accion TEXT,
        detalle TEXT
      );
      PRAGMA user_version = 3;
    `);
  }
}

// ---------- Configuración ----------
export async function leerConfig(db) {
  const filas = await db.getAllAsync('SELECT clave, valor FROM config');
  const cfg = { ...CONFIG_DEFECTO };
  filas.forEach((f) => {
    cfg[f.clave] = f.valor;
  });
  return cfg;
}

export async function guardarConfig(db, obj) {
  for (const [k, v] of Object.entries(obj)) {
    await db.runAsync('INSERT OR REPLACE INTO config (clave, valor) VALUES (?, ?)', [
      k,
      String(v ?? ''),
    ]);
  }
}

// ---------- Auditoría ----------
export async function auditar(db, usuario, entidad, entidadId, accion, detalle) {
  await db.runAsync(
    'INSERT INTO auditoria (fecha, usuario, entidad, entidad_id, accion, detalle) VALUES (?, ?, ?, ?, ?, ?)',
    [new Date().toISOString(), usuario || 'Sin usuario', entidad, entidadId, accion, detalle || '']
  );
}

// ---------- Cálculo de saldos ----------
// Los movimientos anulados no cuentan. Los abonos se aplican a los fiados más viejos primero.
export function calcularCliente(c, movs) {
  const mios = movs.filter((m) => m.cliente_id === c.id);
  const activos = mios.filter((m) => !m.anulado);
  const fiado = activos.filter((m) => m.tipo === 'fiao').reduce((t, m) => t + m.monto, 0);
  const abonado = activos.filter((m) => m.tipo === 'abono').reduce((t, m) => t + m.monto, 0);
  let resto = abonado;
  let vencido = 0;
  const hoy = hoyYMD();
  for (const m of activos) {
    if (m.tipo !== 'fiao') continue;
    const pagado = Math.min(resto, m.monto);
    resto -= pagado;
    const pendiente = m.monto - pagado;
    if (pendiente > 0.001 && m.fecha_limite && m.fecha_limite < hoy) vencido += pendiente;
  }
  return { ...c, fiado, abonado, saldo: fiado - abonado, vencido, movs: mios };
}