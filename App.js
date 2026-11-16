import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, FlatList, ScrollView, Image,
  StyleSheet, Platform, Linking,
} from 'react-native';
import { SQLiteProvider, useSQLiteContext } from 'expo-sqlite';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import * as ImagePicker from 'expo-image-picker';
// SDK 54: copyAsync, makeDirectoryAsync, documentDirectory, etc. viven en /legacy
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import * as DocumentPicker from 'expo-document-picker';
// npx expo install expo-clipboard
import * as Clipboard from 'expo-clipboard';
import {
  VERDE, AZUL, ROJO, GRIS, RD, fmtFecha, fmtFechaHora, fmtYMD, sumarDias,
  normalizarTelefono, avisar, confirmar, abrirWhatsApp, diferencias,
  PLANTILLAS, mensajeMov, mensajeRecordatorio, evaluarLicencia,
  ADMIN_PASS, generarCodigoActivacion, validarCodigoActivacion,
} from './utils';
import { iniciarDB, leerConfig, guardarConfig, auditar, calcularCliente } from './db';
import { construirComprobante, imprimir, balancesDe } from './comprobante';
import * as Notifications from 'expo-notifications';

const DIAS_DE_PRUEBA = 30;

// Ruta real de la base SQLite de expo-sqlite (con file://)
const DB_NOMBRE = 'fiadoapp.db';

const resolverRutaBD = async (db) => {
  const paths = [];
  if (db?.databasePath) {
    paths.push(db.databasePath, db.databasePath.replace(/^file:\/\//, ''));
  }
  const base = `${FileSystem.documentDirectory}SQLite/${DB_NOMBRE}`;
  paths.push(base, base.replace(/^file:\/\//, ''));
  for (const path of paths) {
    try {
      const info = await FileSystem.getInfoAsync(path);
      if (info.exists) return path;
    } catch (_) {
      // Ignora rutas no válidas y sigue con la siguiente.
    }
  }
  return base;
};

// Nunca guardar la clave maestra dentro de la configuración de la base de datos
const sinSecretos = (obj) => {
  const { admin_key, ...resto } = obj;
  return resto;
};

// ---------- Pantalla de auditoría ----------
function Auditoria({ ctx, volver }) {
  const { db } = ctx;
  const [filas, setFilas] = useState([]);

  useEffect(() => {
    let activo = true;
    const cargar = async () => {
      const rows = await db.getAllAsync(
        'SELECT * FROM auditoria ORDER BY id DESC LIMIT 200'
      );
      if (activo) setFilas(rows);
    };
    void cargar();
    return () => {
      activo = false;
    };
  }, [db]);

  return (
    <ScrollView contentContainerStyle={s.contenido} keyboardShouldPersistTaps="handled">
      <TouchableOpacity onPress={volver}>
        <Text style={s.volver}>← Volver</Text>
      </TouchableOpacity>
      <Text style={s.titulo}>🧾 Auditoría</Text>
      {filas.length === 0 ? <Text style={s.vacio}>Sin registros.</Text> : filas.map((f) => (
        <View key={f.id} style={s.fila}>
          <View style={{ flex: 1 }}>
            <Text style={s.nombre}>{f.accion} · {f.usuario || 'Sistema'}</Text>
            <Text style={s.sub}>{fmtFechaHora(f.fecha)}</Text>
            <Text style={s.sub}>{f.entidad}#{f.entidad_id ?? 0}</Text>
            {!!f.detalle && <Text style={s.sub}>{f.detalle}</Text>}
          </View>
        </View>
      ))}
    </ScrollView>
  );
}

// ---------- Pantalla de bloqueo por licencia ----------
function PantallaLicencia({ ctx }) {
  const insets = useSafeAreaInsets();
  const licencia = evaluarLicencia(ctx.cfg);
  const [nombreCliente, setNombreCliente] = useState(ctx.cfg?.negocio_nombre || 'COLMADO');
  const [meses, setMeses] = useState('1');
  const [codigo, setCodigo] = useState('');
  const [adminKey, setAdminKey] = useState('');

  async function desbloquearPrueba() {
    if (!adminKey || adminKey !== ADMIN_PASS) {
      avisar('Clave incorrecta', 'Escribe la clave maestra para desbloquear la prueba.');
      return;
    }

    const nuevaFecha = new Date();
    nuevaFecha.setMonth(nuevaFecha.getMonth() + 1);

    const limpio = {
      ...sinSecretos(ctx.cfg),
      licencia_activa: true,
      licencia_expira: nuevaFecha.toISOString(),
      bloqueo_automatico: true,
      licencia_codigo: 'PRUEBA',
      admin_session: true,
    };

    await guardarConfig(ctx.db, limpio);
    await auditar(ctx.db, ctx.cfg.usuario_actual || 'Administrador', 'config', 0, 'licencia', 'Desbloqueo de prueba por clave maestra');
    await ctx.recargar();
    avisar('Prueba desbloqueada ✅', 'La app quedó activa nuevamente por 1 mes.');
  }

  async function activarCodigo() {
    const nombre = (nombreCliente || '').trim() || 'COLMADO';
    const mesesNum = Number(meses || 1);
    const codigoIngresado = (codigo || '').trim();

    if (!codigoIngresado) {
      avisar('Falta el código', 'Escribe el código de activación entregado por el administrador.');
      return;
    }
    if (!mesesNum || mesesNum < 1) {
      avisar('Meses inválidos', 'Escribe cuántos meses cubre el código.');
      return;
    }

    const valido = validarCodigoActivacion(codigoIngresado, nombre, mesesNum, ADMIN_PASS);
    if (!valido) {
      avisar('Código inválido', 'El código no coincide. Pide uno nuevo al administrador.');
      return;
    }

    const nuevaFecha = new Date();
    nuevaFecha.setMonth(nuevaFecha.getMonth() + mesesNum);

    const limpio = {
      ...sinSecretos(ctx.cfg),
      licencia_activa: true,
      licencia_expira: nuevaFecha.toISOString(),
      bloqueo_automatico: true,
      licencia_codigo: codigoIngresado.toUpperCase(),
      admin_session: false,
    };

    await guardarConfig(ctx.db, limpio);
    await auditar(ctx.db, ctx.cfg.usuario_actual || 'Cliente', 'config', 0, 'licencia', `Activación por código para ${nombre}`);
    await ctx.recargar();
    avisar('Licencia activada ✅', `La app quedó activa por ${mesesNum} mes(es).`);
  }

  return (
    <View style={[s.pantalla, { justifyContent: 'center', padding: 24, paddingTop: insets.top + 24 }]}>
      <View style={{ backgroundColor: '#fff', borderRadius: 16, padding: 20 }}>
        <Text style={s.titulo}>🔒 App suspendida</Text>
        <Text style={s.sub}>
          {licencia.expira
            ? `La licencia venció el ${fmtYMD(licencia.expira.slice(0, 10))}.`
            : 'La licencia de uso ya no está activa.'}
        </Text>
        <Text style={[s.sub, { marginTop: 8 }]}>
          Para seguir usando FiadoApp debe regularizar el pago mensual o ingresar su código de activación.
        </Text>

        <Text style={s.label}>Clave maestra</Text>
        <TextInput
          style={s.input}
          value={adminKey}
          onChangeText={setAdminKey}
          placeholder="Escriba su clave maestra"
          secureTextEntry
        />

        <Boton texto="Desbloquear prueba" color={AZUL} onPress={desbloquearPrueba} />

        <Text style={s.label}>Nombre del negocio</Text>
        <TextInput
          style={s.input}
          value={nombreCliente}
          onChangeText={setNombreCliente}
          placeholder="Nombre del negocio"
        />

        <Text style={s.label}>Meses</Text>
        <TextInput
          style={s.input}
          value={meses}
          onChangeText={setMeses}
          keyboardType="numeric"
          placeholder="1"
        />

        <Text style={s.label}>Código de activación</Text>
        <TextInput
          style={s.input}
          value={codigo}
          onChangeText={setCodigo}
          placeholder="FIADO-XXXXXX"
          autoCapitalize="characters"
        />

        <Boton texto="Activar app" color={VERDE} onPress={activarCodigo} />

        <Text style={[s.sub, { marginTop: 12, color: ROJO, fontWeight: '600' }]}>
          Contacta al proveedor para que te envíe el código de activación.
        </Text>
      </View>
    </View>
  );
}

// ---------- Componentes pequeños ----------
const Tarjeta = ({ label, valor, color, ancho }) => (
  <View style={[s.tarjeta, { backgroundColor: color, width: ancho ? '100%' : '48%' }]}>
    <Text style={s.tLabel}>{label}</Text>
    <Text style={s.tValor}>{valor}</Text>
  </View>
);

const Boton = ({ texto, color = VERDE, onPress, style }) => (
  <TouchableOpacity style={[s.boton, { backgroundColor: color }, style]} onPress={onPress}>
    <Text style={s.botonTxt}>{texto}</Text>
  </TouchableOpacity>
);

const Chip = ({ texto, activo, onPress }) => (
  <TouchableOpacity
    style={[s.chip, activo && { backgroundColor: VERDE, borderColor: VERDE }]}
    onPress={onPress}
  >
    <Text style={[s.chipTxt, activo && { color: '#fff' }]}>{texto}</Text>
  </TouchableOpacity>
);

const Campo = ({ label, ...props }) => (
  <View>
    <Text style={s.label}>{label}</Text>
    <TextInput style={s.input} {...props} />
  </View>
);

const FilaCliente = ({ c, onPress, extra }) => (
  <TouchableOpacity style={s.fila} onPress={onPress}>
    <View style={{ flex: 1 }}>
      <Text style={s.nombre}>{c.nombre}</Text>
      <Text style={s.sub}>{c.telefono}</Text>
      {c.vencido > 0 && <Text style={s.vencido}>⚠️ Vencido: {RD(c.vencido)}</Text>}
    </View>
    <Text style={[s.monto, { color: c.saldo > 0 ? ROJO : VERDE }]}>{RD(c.saldo)}</Text>
    {extra}
  </TouchableOpacity>
);

// Imprime el comprobante de un movimiento y deja registro en la auditoría
async function imprimirMov(ctx, c, m) {
  try {
    const { antes, despues } = balancesDe(c.movs, m);
    const html = construirComprobante({
      cfg: ctx.cfg, cliente: c, mov: m, balanceAntes: antes, balanceDespues: despues,
    });
    await imprimir(html, ctx.cfg);
    await ctx.audit('movimiento', m.id, 'imprimir', 'Comprobante impreso');
  } catch (e) {
    avisar('No se pudo imprimir', String(e.message || e));
  }
}

// ---------- App ----------
export default function App() {
  return (
    <SafeAreaProvider>
      <SQLiteProvider databaseName={DB_NOMBRE} onInit={iniciarDB}>
        <Principal />
      </SQLiteProvider>
    </SafeAreaProvider>
  );
}

function Principal() {
  const db = useSQLiteContext();
  const insets = useSafeAreaInsets();
  const [datos, setDatos] = useState({ clientes: [], movs: [] });
  const [cfg, setCfg] = useState(null);
  const [tab, setTab] = useState('inicio');
  const [sub, setSub] = useState(null);
  const [clienteId, setClienteId] = useState(null);
  const [movId, setMovId] = useState(null);
  const [intencion, setIntencion] = useState(null); // 'fiao' | 'abono' | 'nuevo' | null

  const recargar = useCallback(async () => {
    const cs = await db.getAllAsync('SELECT * FROM clientes ORDER BY nombre COLLATE NOCASE');
    const ms = await db.getAllAsync('SELECT * FROM movimientos ORDER BY id ASC');
    const cf = await leerConfig(db);
    setDatos({ clientes: cs, movs: ms });
    setCfg(cf);
  }, [db]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void recargar();
  }, [recargar]);

  const clientes = useMemo(
    () => datos.clientes.map((c) => calcularCliente(c, datos.movs)),
    [datos]
  );

  useEffect(() => {
    let cancelado = false;

    async function reprogramarNotificaciones() {
      if (!datos.clientes.length) return;
      try {
        const citas = datos.movs.filter((m) => !m.anulado && m.tipo === 'fiao' && m.fecha_limite);
        for (const c of datos.clientes) {
          const actuales = citas.filter((m) => m.cliente_id === c.id)
            .sort((a, b) => new Date(a.fecha_limite) - new Date(b.fecha_limite));
          const proximo = actuales[0];
          if (cancelado) return;
          if (!proximo) {
            await cancelarNotificacionesCliente(c.id);
            continue;
          }
          await programarNotificacionCliente(c, proximo.monto, proximo.fecha_limite);
        }
      } catch (e) {
        console.log('No se pudieron reprogramar notificaciones:', e);
      }
    }

    void reprogramarNotificaciones();
    return () => {
      cancelado = true;
    };
  }, [datos]);

  const ctx = {
    db, cfg, clientes, recargar,
    usuario: cfg?.usuario_actual || '',
    audit: (entidad, id, accion, detalle) =>
      auditar(db, cfg?.usuario_actual || 'Sin usuario', entidad, id, accion, detalle),
  };

  if (!cfg) {
    return (
      <View style={[s.pantalla, { paddingTop: insets.top + 8 }]}> 
        <Text style={s.vacio}>Cargando...</Text>
      </View>
    );
  }

  if (!cfg.usuario_actual) return <PedirUsuario ctx={ctx} />;

  // Bloqueo por licencia (antes de mostrar cualquier pantalla de la app)
  const licencia = evaluarLicencia(cfg);
  const adminActivo = Boolean(cfg.admin_session);
  if (!licencia.activa && !adminActivo) return <PantallaLicencia ctx={ctx} />;

  const cliente = clientes.find((c) => c.id === clienteId);
  const mov = cliente && movId ? cliente.movs.find((m) => m.id === movId) : null;

  const ir = (t, i = null) => {
    setTab(t);
    setIntencion(i);
    setClienteId(null);
    setMovId(null);
    setSub(null);
  };

  let pantalla;
  if (cliente && mov) {
    pantalla = (
      <MovimientoPantalla key={mov.id} ctx={ctx} c={cliente} m={mov} volver={() => setMovId(null)} />
    );
  } else if (cliente) {
    pantalla = (
      <Perfil
        key={cliente.id}
        ctx={ctx}
        c={cliente}
        modoInicial={intencion === 'abono' ? 'abono' : 'fiao'}
        abrirMov={setMovId}
        volver={() => {
          setClienteId(null);
          setMovId(null);
          setIntencion(null);
        }}
      />
    );
  } else if (tab === 'inicio') {
    pantalla = <Inicio ctx={ctx} movs={datos.movs} ir={ir} abrir={setClienteId} />;
  } else if (tab === 'clientes') {
    pantalla = <Clientes ctx={ctx} intencion={intencion} abrir={setClienteId} />;
  } else if (tab === 'deudores') {
    pantalla = <Deudores ctx={ctx} abrir={setClienteId} />;
  } else if (sub === 'auditoria') {
    pantalla = <Auditoria ctx={ctx} volver={() => setSub(null)} />;
  } else {
    pantalla = <Ajustes ctx={ctx} abrirAuditoria={() => setSub('auditoria')} />;
  }

  return (
    <View style={[s.pantalla, { paddingTop: insets.top + 8 }]}>
      <View style={{ flex: 1 }}>{pantalla}</View>
      {!cliente && (
        <View style={[s.tabs, { paddingBottom: insets.bottom + 8 }]}>
          {[
            ['inicio', '🏠', 'Inicio'],
            ['clientes', '👥', 'Clientes'],
            ['deudores', '💰', 'Deudores'],
            ['ajustes', '⚙️', 'Ajustes'],
          ].map(([id, icono, nombre]) => (
            <TouchableOpacity key={id} style={s.tab} onPress={() => ir(id)}>
              <Text style={{ fontSize: 22 }}>{icono}</Text>
              <Text style={[s.tabTxt, tab === id && { color: VERDE, fontWeight: 'bold' }]}>
                {nombre}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      )}
    </View>
  );
}

// ---------- Pedir usuario (primera vez) ----------
function PedirUsuario({ ctx }) {
  const insets = useSafeAreaInsets();
  const [nombre, setNombre] = useState('');

  async function guardar() {
    if (!nombre.trim()) {
      avisar('Faltan datos', 'Escribe tu nombre para continuar.');
      return;
    }
    await guardarConfig(ctx.db, { usuario_actual: nombre.trim() });
    await auditar(ctx.db, nombre.trim(), 'config', 0, 'usuario', 'Inicio de uso con este usuario');
    ctx.recargar();
  }

  return (
    <View
      style={[s.pantalla, { justifyContent: 'center', padding: 24, paddingTop: insets.top + 24 }]}
    >
      <Text style={s.titulo}>📒 FiadoApp</Text>
      <Text style={[s.sub, { marginBottom: 16 }]}>
        ¿Quién va a usar la app? Su nombre quedará registrado en cada fiado, abono y cambio.
      </Text>
      <Campo label="Tu nombre" value={nombre} onChangeText={setNombre} placeholder="Ej: Juan" />
      <Boton texto="Continuar" onPress={guardar} />
    </View>
  );
}

// ---------- Inicio (Dashboard) ----------
function Inicio({ ctx, movs, ir, abrir }) {
  const { cfg, clientes } = ctx;
  const hoy = new Date();
  const [calc, setCalc] = useState('');
  const [calcResult, setCalcResult] = useState('');
  const activos = movs.filter((m) => !m.anulado);
  const totalPendiente = clientes.reduce((t, c) => t + Math.max(c.saldo, 0), 0);

  const actualizarCalc = (valor) => {
    const next = valor;
    setCalc(next);
    if (!next) {
      setCalcResult('');
      return;
    }
    try {
      const safe = next.replace(/×/g, '*').replace(/÷/g, '/');
      setCalcResult(Function(`"use strict"; return (${safe});`)());
    } catch {
      setCalcResult('');
    }
  };

  const agregarCalc = (valor) => {
    actualizarCalc(`${calc}${valor}`);
  };

  const borrarCalc = () => {
    setCalc('');
    setCalcResult('');
  };

  const borrarUltimoCalc = () => {
    const next = calc.slice(0, -1);
    actualizarCalc(next);
  };

  const ejecutarCalc = () => {
    if (!calc) return;
    try {
      const safe = calc.replace(/×/g, '*').replace(/÷/g, '/');
      const valor = Function(`"use strict"; return (${safe});`)();
      setCalc(String(valor));
      setCalcResult(String(valor));
    } catch {
      avisar('Cuenta inválida', 'Escribe una operación válida.');
    }
  };

  const recuperado = activos
    .filter((m) => {
      if (m.tipo !== 'abono') return false;
      const d = new Date(m.fecha);
      return d.getMonth() === hoy.getMonth() && d.getFullYear() === hoy.getFullYear();
    })
    .reduce((t, m) => t + m.monto, 0);
  const deben = clientes.filter((c) => c.saldo > 0).length;
  const vencidos = clientes.filter((c) => c.vencido > 0).length;
  const mayores = clientes
    .filter((c) => c.saldo > 0)
    .sort((a, b) => b.saldo - a.saldo)
    .slice(0, 3);
  const ultimos = [...activos].reverse().slice(0, 5);
  const nombreDe = (id) => (clientes.find((c) => c.id === id) || {}).nombre || '';

  return (
    <ScrollView contentContainerStyle={s.contenido}>
      <View style={s.headerRow}>
        {!!cfg.negocio_logo && <Image source={{ uri: cfg.negocio_logo }} style={s.logoMini} resizeMode="contain" />}
        <View style={{ flex: 1 }}>
          <Text style={s.titulo}>📒 FiadoApp</Text>
          <Text style={s.sub}>{cfg.negocio_nombre}</Text>
        </View>
      </View>

      <View style={[s.grid, { marginTop: 10 }]}> 
        <Tarjeta label="Total fiado pendiente" valor={RD(totalPendiente)} color={AZUL} ancho />
        <Tarjeta label="Recuperado este mes" valor={RD(recuperado)} color={VERDE} />
        <Tarjeta label="Clientes que deben" valor={String(deben)} color="#1D4ED8" />
        <Tarjeta label="Deudas vencidas" valor={String(vencidos)} color={vencidos > 0 ? ROJO : GRIS} ancho />
      </View>

      <Text style={s.seccion}>Accesos rápidos</Text>
      <View style={s.grid}>
        <Boton texto="＋ Nuevo fiado" color={ROJO} style={s.mitad} onPress={() => ir('clientes', 'fiao')} />
        <Boton texto="− Registrar abono" color={VERDE} style={s.mitad} onPress={() => ir('clientes', 'abono')} />
        <Boton texto="👤 Agregar cliente" color={AZUL} style={s.mitad} onPress={() => ir('clientes', 'nuevo')} />
        <Boton texto="💰 Ver deudores" color="#1D4ED8" style={s.mitad} onPress={() => ir('deudores')} />
        <Boton texto="💬 Enviar recordatorios" color="#25D366" style={s.lleno} onPress={() => ir('deudores')} />
      </View>

      <Text style={s.seccion}>Calculadora rápida</Text>
      <View style={s.calcCard}>
        <TextInput
          value={calc}
          onChangeText={(t) => actualizarCalc(t)}
          placeholder="Escribe una operación"
          keyboardType="numeric"
          style={s.calcInput}
        />
        {!!calcResult && <Text style={s.calcResultado}>{calcResult}</Text>}

        <View style={s.calcGrid}>
          {['7','8','9','÷','4','5','6','×','1','2','3','-','0','.','=','+'].map((btn) => (
            <TouchableOpacity
              key={btn}
              style={[s.calcButton, btn === '=' && s.calcButtonEqual]}
              onPress={() => {
                if (btn === '=') ejecutarCalc();
                else if (btn === 'C') borrarCalc();
                else agregarCalc(btn);
              }}
            >
              <Text style={s.calcButtonText}>{btn === 'C' ? 'C' : btn}</Text>
            </TouchableOpacity>
          ))}
        </View>

        <View style={{ flexDirection: 'row', gap: 10, marginTop: 10 }}>
          <TouchableOpacity style={[s.calcButton, s.calcButtonWide, { flex: 1 }]} onPress={borrarUltimoCalc}>
            <Text style={s.calcButtonText}>⌫</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[s.calcButton, s.calcButtonWide, { flex: 1, backgroundColor: '#ef4444' }]} onPress={borrarCalc}>
            <Text style={s.calcButtonText}>C</Text>
          </TouchableOpacity>
        </View>
      </View>

      <Text style={s.seccion}>Clientes con mayor deuda</Text>
      {mayores.length === 0 && <Text style={s.vacio}>Nadie debe nada 🎉</Text>}
      {mayores.map((c) => (
        <FilaCliente key={c.id} c={c} onPress={() => abrir(c.id)} />
      ))}

      <Text style={s.seccion}>Últimos movimientos</Text>
      {ultimos.length === 0 && <Text style={s.vacio}>Sin movimientos todavía.</Text>}
      {ultimos.map((m) => (
        <TouchableOpacity key={m.id} style={s.fila} onPress={() => abrir(m.cliente_id)}>
          <View style={{ flex: 1 }}>
            <Text style={s.nombre}>{nombreDe(m.cliente_id)}</Text>
            <Text style={s.sub}>
              {m.tipo === 'fiao' ? 'Fiao' : 'Abono'} · {fmtFecha(m.fecha)}
            </Text>
          </View>
          <Text style={[s.monto, { color: m.tipo === 'fiao' ? ROJO : VERDE }]}>
            {m.tipo === 'fiao' ? '+' : '−'}
            {RD(m.monto)}
          </Text>
        </TouchableOpacity>
      ))}
    </ScrollView>
  );
}

// ---------- Clientes ----------
function Clientes({ ctx, intencion, abrir }) {
  const { db, clientes } = ctx;
  const [busqueda, setBusqueda] = useState('');
  const [mostrarForm, setMostrarForm] = useState(intencion === 'nuevo');
  const [f, setF] = useState({ nombre: '', telefono: '', direccion: '', observaciones: '' });

  async function agregar() {
    if (!f.nombre.trim() || !f.telefono.trim()) {
      avisar('Faltan datos', 'Escribe el nombre y el WhatsApp.');
      return;
    }
    const tel = normalizarTelefono(f.telefono);
    if (clientes.some((c) => normalizarTelefono(c.telefono) === tel)) {
      avisar('Cliente repetido', 'Ya existe un cliente con ese número.');
      return;
    }
    const r = await db.runAsync(
      'INSERT INTO clientes (nombre, telefono, direccion, observaciones, creado) VALUES (?, ?, ?, ?, ?)',
      [f.nombre.trim(), f.telefono.trim(), f.direccion.trim(), f.observaciones.trim(), new Date().toISOString()]
    );
    await ctx.audit('cliente', r.lastInsertRowId, 'crear', f.nombre.trim());
    setF({ nombre: '', telefono: '', direccion: '', observaciones: '' });
    setMostrarForm(false);
    ctx.recargar();
  }

  const q = busqueda.toLowerCase();
  const visibles = clientes.filter(
    (c) => c.nombre.toLowerCase().includes(q) || c.telefono.includes(busqueda)
  );

  const encabezado = (
    <View>
      <Text style={s.titulo}>👥 Clientes</Text>
      {(intencion === 'fiao' || intencion === 'abono') && (
        <Text style={s.banner}>
          Toca un cliente para registrar un {intencion === 'fiao' ? 'fiado' : 'abono'}
        </Text>
      )}
      <TextInput
        style={s.input}
        placeholder="Buscar por nombre o teléfono..."
        value={busqueda}
        onChangeText={setBusqueda}
      />
      <Boton
        texto={mostrarForm ? 'Cancelar' : '+ Nuevo cliente'}
        color={AZUL}
        onPress={() => setMostrarForm(!mostrarForm)}
        style={{ marginBottom: 8 }}
      />
      {mostrarForm && (
        <View style={{ marginBottom: 8 }}>
          <Campo label="Nombre completo" value={f.nombre} onChangeText={(t) => setF({ ...f, nombre: t })} />
          <Campo label="WhatsApp (ej: 8091234567)" keyboardType="phone-pad" value={f.telefono}
            onChangeText={(t) => setF({ ...f, telefono: t })} />
          <Campo label="Dirección (opcional)" value={f.direccion}
            onChangeText={(t) => setF({ ...f, direccion: t })} />
          <Campo label="Observaciones (opcional)" value={f.observaciones}
            onChangeText={(t) => setF({ ...f, observaciones: t })} />
          <Boton texto="Guardar cliente" onPress={agregar} />
        </View>
      )}
    </View>
  );

  return (
    <FlatList
      contentContainerStyle={s.contenido}
      keyboardShouldPersistTaps="handled"
      data={visibles}
      keyExtractor={(c) => String(c.id)}
      ListHeaderComponent={encabezado}
      ListEmptyComponent={<Text style={s.vacio}>No hay clientes todavía.</Text>}
      renderItem={({ item }) => <FilaCliente c={item} onPress={() => abrir(item.id)} />}
    />
  );
}

// ---------- Deudores ----------
function Deudores({ ctx, abrir }) {
  const deudores = ctx.clientes
    .filter((c) => c.saldo > 0)
    .sort((a, b) => (b.vencido > 0) - (a.vencido > 0) || b.saldo - a.saldo);

  return (
    <FlatList
      contentContainerStyle={s.contenido}
      data={deudores}
      keyExtractor={(c) => String(c.id)}
      ListHeaderComponent={
        <View>
          <Text style={s.titulo}>💰 Deudores</Text>
          <Text style={s.sub}>Primero los que tienen deuda vencida.</Text>
        </View>
      }
      ListEmptyComponent={<Text style={s.vacio}>Nadie debe nada 🎉</Text>}
      renderItem={({ item }) => (
        <FilaCliente
          c={item}
          onPress={() => abrir(item.id)}
          extra={
            <TouchableOpacity
              style={s.wa}
              onPress={() => abrirWhatsApp(item.telefono, mensajeRecordatorio(ctx.cfg, item))}
            >
              <Text style={{ fontSize: 20 }}>💬</Text>
            </TouchableOpacity>
          }
        />
      )}
    />
  );
}

// ---------- Perfil del cliente ----------
function Perfil({ ctx, c, modoInicial, volver, abrirMov }) {
  const { db, cfg } = ctx;
  const [modo, setModo] = useState(modoInicial);
  const [monto, setMonto] = useState('');
  const [nota, setNota] = useState('');
  const [dias, setDias] = useState(7); // null = sin fecha límite
  const [metodo, setMetodo] = useState('Efectivo');
  const [guardando, setGuardando] = useState(false);
  const [ultimo, setUltimo] = useState(null);
  const [editando, setEditando] = useState(false);
  const [f, setF] = useState({ nombre: '', telefono: '', direccion: '', observaciones: '' });

  const mUltimo = ultimo ? c.movs.find((m) => m.id === ultimo) : null;

  async function guardar() {
    if (guardando) return;
    const valor = parseFloat(monto.replace(',', '.'));
    if (!valor || valor <= 0 || !isFinite(valor)) {
      avisar('Monto inválido', 'Escribe un monto mayor que cero.');
      return;
    }
    if (modo === 'abono' && valor > c.saldo + 0.001) {
      avisar('Abono mayor que la deuda', `${c.nombre} debe ${RD(c.saldo)}.`);
      return;
    }
    setGuardando(true);
    try {
      const limite = modo === 'fiao' && dias !== null ? sumarDias(dias) : null;
      const r = await db.runAsync(
        'INSERT INTO movimientos (cliente_id, tipo, monto, nota, fecha, fecha_limite, metodo, creado_por) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [c.id, modo, valor, nota.trim(), new Date().toISOString(), limite, modo === 'abono' ? metodo : null, ctx.usuario]
      );
      await ctx.audit(
        'movimiento', r.lastInsertRowId, 'crear',
        `${modo === 'fiao' ? 'Fiado' : 'Abono'} de ${RD(valor)}${nota.trim() ? ' (' + nota.trim() + ')' : ''}`
      );
      if (modo === 'fiao' && limite) {
        await programarNotificacionCliente(c, valor, limite);
      }
      setMonto('');
      setNota('');
      await ctx.recargar();
      setUltimo(r.lastInsertRowId);
    } finally {
      setGuardando(false);
    }
  }

  function abrirEdicion() {
    setF({
      nombre: c.nombre,
      telefono: c.telefono,
      direccion: c.direccion || '',
      observaciones: c.observaciones || '',
    });
    setEditando(true);
  }

  async function guardarCliente() {
    if (!f.nombre.trim() || !f.telefono.trim()) {
      avisar('Faltan datos', 'El nombre y el WhatsApp son obligatorios.');
      return;
    }
    const tel = normalizarTelefono(f.telefono);
    if (ctx.clientes.some((x) => x.id !== c.id && normalizarTelefono(x.telefono) === tel)) {
      avisar('Número repetido', 'Otro cliente ya tiene ese número.');
      return;
    }
    const antes = {
      nombre: c.nombre, telefono: c.telefono,
      direccion: c.direccion || '', observaciones: c.observaciones || '',
    };
    const despues = {
      nombre: f.nombre.trim(), telefono: f.telefono.trim(),
      direccion: f.direccion.trim(), observaciones: f.observaciones.trim(),
    };
    const cambios = diferencias(antes, despues, {
      nombre: 'Nombre', telefono: 'WhatsApp', direccion: 'Dirección', observaciones: 'Observaciones',
    });
    if (!cambios) {
      setEditando(false);
      return;
    }
    await db.runAsync(
      'UPDATE clientes SET nombre = ?, telefono = ?, direccion = ?, observaciones = ?, editado_por = ?, editado_en = ? WHERE id = ?',
      [despues.nombre, despues.telefono, despues.direccion, despues.observaciones, ctx.usuario, new Date().toISOString(), c.id]
    );
    await ctx.audit('cliente', c.id, 'editar', cambios);
    await ctx.recargar();
    setEditando(false);
  }

  function compartirEstado() {
    const lineas = c.movs
      .filter((m) => !m.anulado)
      .slice(-15)
      .reverse()
      .map(
        (m) =>
          `${fmtFecha(m.fecha)} ${m.tipo === 'fiao' ? 'Fiao +' : 'Abono -'}${RD(m.monto)}${m.nota ? ' (' + m.nota + ')' : ''}`
      );
    const msg =
      `*Estado de cuenta - ${cfg.negocio_nombre}*\n` +
      `Cliente: ${c.nombre}\n` +
      `Total fiado: ${RD(c.fiado)}\n` +
      `Total abonado: ${RD(c.abonado)}\n` +
      `*Balance pendiente: ${RD(c.saldo)}*\n\n` +
      `Últimos movimientos:\n${lineas.join('\n')}`;
    abrirWhatsApp(c.telefono, msg);
  }

  function eliminar() {
    confirmar(
      'Eliminar cliente',
      `¿Borrar a ${c.nombre} y todo su historial? Esto no se puede deshacer.`,
      'Eliminar',
      async () => {
        await db.runAsync('DELETE FROM movimientos WHERE cliente_id = ?', [c.id]);
        await db.runAsync('DELETE FROM clientes WHERE id = ?', [c.id]);
        await ctx.audit('cliente', c.id, 'eliminar', `${c.nombre} (${c.movs.length} movimientos)`);
        await ctx.recargar();
        volver();
      },
      true
    );
  }

  return (
    <ScrollView contentContainerStyle={s.contenido} keyboardShouldPersistTaps="handled">
      <TouchableOpacity onPress={volver}>
        <Text style={s.volver}>← Volver</Text>
      </TouchableOpacity>

      {editando ? (
        <View>
          <Text style={s.titulo}>Editar cliente</Text>
          <Campo label="Nombre completo" value={f.nombre} onChangeText={(t) => setF({ ...f, nombre: t })} />
          <Campo label="WhatsApp" keyboardType="phone-pad" value={f.telefono}
            onChangeText={(t) => setF({ ...f, telefono: t })} />
          <Campo label="Dirección" value={f.direccion} onChangeText={(t) => setF({ ...f, direccion: t })} />
          <Campo label="Observaciones" value={f.observaciones}
            onChangeText={(t) => setF({ ...f, observaciones: t })} />
          <Boton texto="Guardar cambios" onPress={guardarCliente} />
          <Boton texto="Cancelar" color={GRIS} onPress={() => setEditando(false)} />
        </View>
      ) : (
        <View>
          <Text style={s.titulo}>{c.nombre}</Text>
          <Text style={s.sub}>📱 {c.telefono}</Text>
          {!!c.direccion && <Text style={s.sub}>📍 {c.direccion}</Text>}
          {!!c.observaciones && <Text style={s.sub}>📝 {c.observaciones}</Text>}
          {!!c.editado_en && (
            <Text style={s.sub}>✏️ Editado por {c.editado_por} · {fmtFechaHora(c.editado_en)}</Text>
          )}
          <TouchableOpacity onPress={abrirEdicion}>
            <Text style={s.link}>✏️ Editar datos del cliente</Text>
          </TouchableOpacity>
        </View>
      )}

      <View style={[s.grid, { marginTop: 10 }]}>
        <Tarjeta label="Total fiado" valor={RD(c.fiado)} color={AZUL} />
        <Tarjeta label="Total abonado" valor={RD(c.abonado)} color={VERDE} />
        <Tarjeta label="Balance pendiente" valor={RD(c.saldo)} color={c.saldo > 0 ? ROJO : GRIS} ancho />
      </View>
      {c.vencido > 0 && <Text style={s.vencido}>⚠️ Vencido: {RD(c.vencido)}</Text>}

      {c.saldo > 0 && (
        <Boton
          texto="💬 Recordar por WhatsApp"
          color="#25D366"
          onPress={() => abrirWhatsApp(c.telefono, mensajeRecordatorio(cfg, c))}
        />
      )}
      <Boton texto="📄 Compartir estado de cuenta" color={AZUL} onPress={compartirEstado} />

      {mUltimo && (
        <View style={s.panelOk}>
          <Text style={s.panelOkTxt}>
            ✅ Guardado: {mUltimo.tipo === 'fiao' ? 'Fiado' : 'Abono'} de {RD(mUltimo.monto)}
          </Text>
          <Boton
            texto="💬 Avisar por WhatsApp"
            color="#25D366"
            onPress={() =>
              abrirWhatsApp(c.telefono, mensajeMov(cfg, c, mUltimo, balancesDe(c.movs, mUltimo).despues))
            }
          />
          <Boton texto="🖨️ Imprimir comprobante" color={AZUL} onPress={() => imprimirMov(ctx, c, mUltimo)} />
          <Boton texto="Cerrar" color={GRIS} onPress={() => setUltimo(null)} />
        </View>
      )}

      <Text style={s.seccion}>Nuevo movimiento</Text>
      <View style={s.filaChips}>
        <Chip texto="Nuevo fiado" activo={modo === 'fiao'} onPress={() => setModo('fiao')} />
        <Chip texto="Abono" activo={modo === 'abono'} onPress={() => setModo('abono')} />
      </View>

      <Campo label="Monto" placeholder="0.00" keyboardType="decimal-pad" value={monto} onChangeText={setMonto} />
      <Campo
        label={modo === 'fiao' ? 'Descripción (ej: arroz y aceite)' : 'Nota (opcional)'}
        value={nota}
        onChangeText={setNota}
      />

      {modo === 'fiao' ? (
        <View>
          <Text style={s.sub}>Fecha límite de pago:</Text>
          <View style={s.filaChips}>
            {[[7, '7 días'], [15, '15 días'], [30, '30 días'], [null, 'Sin fecha']].map(([d, t]) => (
              <Chip key={t} texto={t} activo={dias === d} onPress={() => setDias(d)} />
            ))}
          </View>
        </View>
      ) : (
        <View>
          <Text style={s.sub}>Método de pago:</Text>
          <View style={s.filaChips}>
            {['Efectivo', 'Transferencia', 'Otro'].map((t) => (
              <Chip key={t} texto={t} activo={metodo === t} onPress={() => setMetodo(t)} />
            ))}
          </View>
        </View>
      )}

      <Boton
        texto={modo === 'fiao' ? 'Guardar fiado' : 'Guardar abono'}
        color={modo === 'fiao' ? ROJO : VERDE}
        onPress={guardar}
      />

      <Text style={s.seccion}>Historial</Text>
      <Text style={s.sub}>Toca un movimiento para editarlo, anularlo o imprimirlo.</Text>
      {c.movs.length === 0 && <Text style={s.vacio}>Sin movimientos todavía.</Text>}
      {c.movs
        .slice()
        .reverse()
        .map((m) => (
          <TouchableOpacity
            key={m.id}
            style={[s.fila, { marginTop: 8 }, !!m.anulado && { opacity: 0.55 }]}
            onPress={() => abrirMov(m.id)}
          >
            <View style={{ flex: 1 }}>
              <Text style={s.nombre}>
                {m.tipo === 'fiao' ? 'Fiao' : 'Abono'}
                {m.anulado ? ' · ANULADO' : ''}
              </Text>
              <Text style={s.sub}>
                {fmtFechaHora(m.fecha)}
                {m.nota ? ` · ${m.nota}` : ''}
              </Text>
              {m.tipo === 'fiao' && !!m.fecha_limite && (
                <Text style={s.sub}>Vence: {fmtYMD(m.fecha_limite)}</Text>
              )}
              {m.tipo === 'abono' && !!m.metodo && <Text style={s.sub}>{m.metodo}</Text>}
              {!!m.creado_por && <Text style={s.sub}>Registrado por {m.creado_por}</Text>}
              {!!m.editado_en && (
                <Text style={s.editado}>
                  ✏️ Editado por {m.editado_por} · {fmtFechaHora(m.editado_en)}
                </Text>
              )}
            </View>
            <Text
              style={[
                s.monto,
                { color: m.tipo === 'fiao' ? ROJO : VERDE },
                !!m.anulado && { textDecorationLine: 'line-through' },
              ]}
            >
              {m.tipo === 'fiao' ? '+' : '−'}
              {RD(m.monto)}
            </Text>
          </TouchableOpacity>
        ))}

      <TouchableOpacity onPress={eliminar}>
        <Text style={s.eliminar}>Eliminar cliente</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

// ---------- Editar / anular / imprimir un movimiento ----------
function MovimientoPantalla({ ctx, c, m, volver }) {
  const { db } = ctx;
  const esFiado = m.tipo === 'fiao';
  const [monto, setMonto] = useState(String(m.monto));
  const [nota, setNota] = useState(m.nota || '');
  const [limite, setLimite] = useState(m.fecha_limite || null);
  const [metodo, setMetodo] = useState(m.metodo || 'Efectivo');
  const [cambios, setCambios] = useState([]);

  const cargarCambios = useCallback(async () => {
    const filas = await db.getAllAsync(
      "SELECT * FROM auditoria WHERE entidad = 'movimiento' AND entidad_id = ? ORDER BY id DESC",
      [m.id]
    );
    setCambios(filas);
  }, [db, m.id]);

  useEffect(() => {
    cargarCambios();
  }, [cargarCambios, m.editado_en, m.anulado]);

  // Opciones de fecha límite (incluye la actual si existe)
  const opcionesLimite = [
    ...(m.fecha_limite ? [{ t: `Actual (${fmtYMD(m.fecha_limite)})`, v: m.fecha_limite }] : []),
    { t: '7 días', v: sumarDias(7) },
    { t: '15 días', v: sumarDias(15) },
    { t: '30 días', v: sumarDias(30) },
    { t: 'Sin fecha', v: null },
  ];

  async function guardarCambios() {
    const valor = parseFloat(String(monto).replace(',', '.'));
    if (!valor || valor <= 0 || !isFinite(valor)) {
      avisar('Monto inválido', 'Escribe un monto mayor que cero.');
      return;
    }
    const base = c.saldo - (esFiado ? m.monto : -m.monto); // saldo sin este movimiento
    const nuevoSaldo = base + (esFiado ? valor : -valor);
    if (nuevoSaldo < -0.001) {
      avisar(
        'Monto no válido',
        esFiado
          ? 'Ese monto queda por debajo de lo que el cliente ya abonó.'
          : `El abono no puede ser mayor que la deuda (${RD(base)}).`
      );
      return;
    }
    const antes = {
      monto: RD(m.monto), nota: m.nota || '',
      fecha_limite: m.fecha_limite ? fmtYMD(m.fecha_limite) : '', metodo: m.metodo || '',
    };
    const despues = {
      monto: RD(valor), nota: nota.trim(),
      fecha_limite: esFiado && limite ? fmtYMD(limite) : '', metodo: esFiado ? '' : metodo,
    };
    const detalle = diferencias(antes, despues, {
      monto: 'Monto', nota: 'Nota', fecha_limite: 'Vence', metodo: 'Método',
    });
    if (!detalle) {
      avisar('Sin cambios', 'No modificaste nada.');
      return;
    }
    await db.runAsync(
      'UPDATE movimientos SET monto = ?, nota = ?, fecha_limite = ?, metodo = ?, editado_por = ?, editado_en = ? WHERE id = ?',
      [valor, nota.trim(), esFiado ? limite : null, esFiado ? null : metodo, ctx.usuario, new Date().toISOString(), m.id]
    );
    await ctx.audit('movimiento', m.id, 'editar', detalle);
    await ctx.recargar();
    avisar('Guardado ✅', 'El movimiento fue actualizado.');
  }

  function alternarAnulado() {
    const anulando = !m.anulado;
    if (!anulando && !esFiado && m.monto > c.saldo + 0.001) {
      avisar('No se puede restaurar', 'Ese abono sería mayor que la deuda actual.');
      return;
    }
    confirmar(
      anulando ? 'Anular movimiento' : 'Restaurar movimiento',
      anulando
        ? 'Dejará de contar en el balance, pero quedará en el historial. ¿Continuar?'
        : '¿Volver a contar este movimiento en el balance?',
      anulando ? 'Anular' : 'Restaurar',
      async () => {
        await db.runAsync(
          'UPDATE movimientos SET anulado = ?, editado_por = ?, editado_en = ? WHERE id = ?',
          [anulando ? 1 : 0, ctx.usuario, new Date().toISOString(), m.id]
        );
        await ctx.audit(
          'movimiento', m.id, anulando ? 'anular' : 'restaurar',
          `${esFiado ? 'Fiado' : 'Abono'} de ${RD(m.monto)}`
        );
        await ctx.recargar();
      },
      anulando
    );
  }

  async function onImprimir() {
    await imprimirMov(ctx, c, m);
    cargarCambios();
  }

  return (
    <ScrollView contentContainerStyle={s.contenido} keyboardShouldPersistTaps="handled">
      <TouchableOpacity onPress={volver}>
        <Text style={s.volver}>← Volver a {c.nombre}</Text>
      </TouchableOpacity>
      <Text style={s.titulo}>
        {esFiado ? 'Fiado' : 'Abono'} #{String(m.id).padStart(6, '0')}
        {m.anulado ? ' · ANULADO' : ''}
      </Text>
      <Text style={s.sub}>{fmtFechaHora(m.fecha)}</Text>
      {!!m.creado_por && <Text style={s.sub}>Registrado por {m.creado_por}</Text>}
      {!!m.editado_en && (
        <Text style={s.editado}>
          ✏️ Última edición: {m.editado_por} · {fmtFechaHora(m.editado_en)}
        </Text>
      )}

      <Boton texto="🖨️ Imprimir comprobante" color={AZUL} onPress={onImprimir} style={{ marginTop: 12 }} />

      {!m.anulado && (
        <View>
          <Text style={s.seccion}>Corregir datos</Text>
          <Campo label="Monto" keyboardType="decimal-pad" value={monto} onChangeText={setMonto} />
          <Campo label={esFiado ? 'Descripción' : 'Nota'} value={nota} onChangeText={setNota} />
          {esFiado ? (
            <View>
              <Text style={s.sub}>Fecha límite:</Text>
              <View style={s.filaChips}>
                {opcionesLimite.map((o) => (
                  <Chip key={o.t} texto={o.t} activo={limite === o.v} onPress={() => setLimite(o.v)} />
                ))}
              </View>
            </View>
          ) : (
            <View>
              <Text style={s.sub}>Método de pago:</Text>
              <View style={s.filaChips}>
                {['Efectivo', 'Transferencia', 'Otro'].map((t) => (
                  <Chip key={t} texto={t} activo={metodo === t} onPress={() => setMetodo(t)} />
                ))}
              </View>
            </View>
          )}
          <Boton texto="Guardar cambios" onPress={guardarCambios} />
        </View>
      )}

      <Boton
        texto={m.anulado ? '↩️ Restaurar movimiento' : '🚫 Anular movimiento'}
        color={m.anulado ? VERDE : ROJO}
        onPress={alternarAnulado}
        style={{ marginTop: 8 }}
      />

      <Text style={s.seccion}>Historial de cambios</Text>
      {cambios.length === 0 && <Text style={s.vacio}>Sin registros.</Text>}
      {cambios.map((a) => (
        <View key={a.id} style={s.fila}>
          <View style={{ flex: 1 }}>
            <Text style={s.nombre}>
              {a.accion} · {a.usuario}
            </Text>
            <Text style={s.sub}>{fmtFechaHora(a.fecha)}</Text>
            {!!a.detalle && <Text style={s.sub}>{a.detalle}</Text>}
          </View>
        </View>
      ))}
    </ScrollView>
  );
}

// ---------- Ajustes ----------
function Ajustes({ ctx, abrirAuditoria }) {
  const { db, cfg } = ctx;
  const [f, setF] = useState({ ...cfg });
  const [adminSession, setAdminSession] = useState(Boolean(cfg?.admin_session));

  const set = (k, v) => setF((p) => ({ ...p, [k]: v }));

  async function iniciarSesionAdmin() {
    const clave = (f.admin_key || '').trim();
    if (!clave || clave !== ADMIN_PASS) {
      avisar('Clave incorrecta', 'Escribe la clave maestra correcta para entrar como administrador.');
      return;
    }

    const limpio = {
      ...sinSecretos(f),
      admin_session: true,
      licencia_activa: true,
      bloqueo_automatico: false,
    };

    await guardarConfig(db, limpio);
    // Dejamos la clave solo en memoria del formulario para poder generar códigos
    setF({ ...limpio, admin_key: clave });
    setAdminSession(true);
    await ctx.recargar();
    avisar('Sesión de administrador activada ✅', 'Puedes generar códigos sin que la licencia se venza.');
  }

  async function cerrarSesionAdmin() {
    const limpio = {
      ...sinSecretos(f),
      admin_session: false,
    };
    await guardarConfig(db, limpio);
    setF(limpio);
    setAdminSession(false);
    await ctx.recargar();
  }

  async function elegirLogo() {
    const r = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsEditing: false,
      quality: 0.5,
      base64: true,
    });
    if (r.canceled) return;
    const a = r.assets[0];
    const uri =
      a.uri && a.uri.startsWith('data:')
        ? a.uri
        : a.base64
        ? `data:${a.mimeType || 'image/jpeg'};base64,${a.base64}`
        : a.uri;
    set('negocio_logo', uri);
  }

  async function guardar() {
    if (!f.negocio_nombre.trim() || !f.usuario_actual.trim()) {
      avisar('Faltan datos', 'El nombre del negocio y el usuario son obligatorios.');
      return;
    }
    const etiquetas = {
      usuario_actual: 'Usuario', negocio_nombre: 'Nombre del negocio',
      negocio_telefono: 'Teléfono', negocio_direccion: 'Dirección',
      msg_fiado: 'Mensaje de fiado', msg_abono: 'Mensaje de abono',
      msg_recordatorio: 'Mensaje de recordatorio', comprobante_pie: 'Pie del comprobante',
      comprobante_ancho: 'Papel (mm)', comprobante_logo: 'Logo en comprobante',
    };
    let cambios = diferencias(cfg, f, etiquetas);
    if (cfg.negocio_logo !== f.negocio_logo) cambios += (cambios ? '; ' : '') + 'Logo actualizado';
    if (!cambios) {
      avisar('Sin cambios', 'No hay nada nuevo que guardar.');
      return;
    }
    const limpio = {
      ...sinSecretos(f),
      usuario_actual: f.usuario_actual.trim(),
      negocio_nombre: f.negocio_nombre.trim(),
    };
    await guardarConfig(db, limpio);
    await auditar(db, limpio.usuario_actual, 'config', 0, 'editar', cambios);
    await ctx.recargar();
    avisar('Guardado ✅', 'La configuración se actualizó.');
  }

  async function imprimirPrueba() {
    try {
      const cfgPrueba = { ...cfg, ...f };
      const mov = {
        id: 0, tipo: 'fiao', monto: 500, nota: 'Comprobante de prueba',
        fecha: new Date().toISOString(), fecha_limite: sumarDias(7), creado_por: f.usuario_actual,
      };
      const html = construirComprobante({
        cfg: cfgPrueba, cliente: { nombre: 'Cliente de prueba' }, mov,
        balanceAntes: 0, balanceDespues: 500,
      });
      await imprimir(html, cfgPrueba);
    } catch (e) {
      avisar('No se pudo imprimir', String(e.message || e));
    }
  }

   async function exportarBase() {
    try {
      if (Platform.OS === 'web') {
        avisar('No disponible en web', 'La copia de seguridad local solo funciona en la app móvil.');
        return;
      }

      const dbPath = await resolverRutaBD(db);
      const info = await FileSystem.getInfoAsync(dbPath);
      if (!info.exists) {
        avisar('Sin base local', `No se encontró la base en:\n${dbPath}`);
        return;
      }

      try {
        await db.execAsync('PRAGMA wal_checkpoint(PASSIVE);');
      } catch (_) {
        // Si la base no usa WAL o ya está cerrada, no bloquea la exportación.
      }

      const dir = `${FileSystem.documentDirectory}backups/`;
      await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
      const dest = `${dir}fiadoapp-backup-${Date.now()}.db`;
      await FileSystem.copyAsync({ from: dbPath, to: dest });

      try {
        if (await Sharing.isAvailableAsync()) {
          await Sharing.shareAsync(dest, {
            mimeType: 'application/octet-stream',
            dialogTitle: 'Respaldar FiadoApp',
          });
        } else {
          avisar('Copia lista', `Archivo guardado en: ${dest}`);
        }
      } catch (shareErr) {
        avisar('Copia lista', `La copia quedó en: ${dest}.\n${String(shareErr?.message || shareErr)}`);
      }
    } catch (e) {
      avisar('No se pudo exportar', String(e.message || e));
    }
  }

    async function restaurarBase() {
    try {
      if (Platform.OS === 'web') {
        avisar('No disponible en web', 'La restauración de respaldo local solo funciona en la app móvil.');
        return;
      }

      const res = await DocumentPicker.getDocumentAsync({
        type: '*/*',
        copyToCacheDirectory: true,
      });
      if (res.canceled || !res.assets || res.assets.length === 0) return;

      const source = res.assets[0].uri;
      // Verifica que sea una base SQLite ("SQLite format 3") antes de tocar nada
      const cabecera = await FileSystem.readAsStringAsync(source, {
        encoding: FileSystem.EncodingType.Base64,
        length: 15,
        position: 0,
      });
      if (cabecera !== 'U1FMaXRlIGZvcm1hdCAz') {
        avisar('Archivo no válido', 'Ese archivo no es una copia de seguridad de FiadoApp.');
        return;
      }

      const dest = await resolverRutaBD(db);
      confirmar(
        'Restaurar copia',
        'Se reemplazarán TODOS los datos actuales por los de la copia. ¿Continuar?',
        'Restaurar',
        async () => {
          try {
            await db.closeAsync?.();
            await FileSystem.deleteAsync(dest, { idempotent: true });
            await FileSystem.deleteAsync(`${dest}-wal`, { idempotent: true });
            await FileSystem.deleteAsync(`${dest}-shm`, { idempotent: true });
            await FileSystem.copyAsync({ from: source, to: dest });
            avisar('Datos restaurados ✅', 'Cierra la app por completo (sácala de recientes) y ábrela de nuevo.');
          } catch (e) {
            avisar('No se pudo restaurar', String(e.message || e));
          }
        },
        true
      );
    } catch (e) {
      avisar('No se pudo restaurar', String(e.message || e));
    }
  }

  async function activarLicenciaMensual() {
    const expira = new Date();
    expira.setDate(expira.getDate() + DIAS_DE_PRUEBA);
    const limpio = {
      ...sinSecretos(f),
      licencia_activa: true,
      licencia_expira: expira.toISOString(),
      bloqueo_automatico: true,
    };
    await guardarConfig(db, limpio);
    await auditar(db, limpio.usuario_actual, 'config', 0, 'licencia', 'Suscripción mensual activada');
    setF((p) => ({ ...p, ...limpio }));
    await ctx.recargar();
    avisar('Licencia activa ✅', 'La app queda habilitada por 30 días más.');
  }

  async function bloquearLicencia() {
    const expira = new Date();
    expira.setDate(expira.getDate() - 1);
    const limpio = {
      ...sinSecretos(f),
      licencia_activa: false,
      licencia_expira: expira.toISOString(),
      bloqueo_automatico: true,
      admin_session: false,
    };
    await guardarConfig(db, limpio);
    await auditar(db, limpio.usuario_actual, 'config', 0, 'licencia', 'Límite vencido - app bloqueada');
    setF((p) => ({ ...p, ...limpio }));
    setAdminSession(false);
    await ctx.recargar();
    avisar('Licencia vencida', 'La app queda bloqueada.');
  }

  // Activa la licencia de ESTE teléfono con un código ya generado
  async function activarLicenciaConCodigo() {
    const nombreCliente = (f.licencia_cliente || '').trim() || 'COLMADO';
    const meses = Number(f.licencia_meses || 1);
    const codigoIngresado = (f.licencia_codigo || '').trim();

    if (!codigoIngresado) {
      avisar('Sin código', 'Escribe o genera un código de activación primero.');
      return;
    }
    if (!meses || meses < 1) {
      avisar('Meses inválidos', 'Escribe cuántos meses cubre el código.');
      return;
    }

    const valido = validarCodigoActivacion(codigoIngresado, nombreCliente, meses, ADMIN_PASS);
    if (!valido) {
      avisar('Código no válido', 'El código no coincide con el nombre del cliente y los meses indicados.');
      return;
    }

    const nuevaFecha = new Date();
    nuevaFecha.setMonth(nuevaFecha.getMonth() + meses);
    const limpio = {
      ...sinSecretos(f),
      licencia_activa: true,
      licencia_expira: nuevaFecha.toISOString(),
      bloqueo_automatico: true,
      licencia_codigo: codigoIngresado.toUpperCase(),
      admin_session: false,
    };

    await guardarConfig(db, limpio);
    await auditar(db, limpio.usuario_actual, 'config', 0, 'licencia', `Licencia activada por código para ${nombreCliente}`);
    setF((p) => ({ ...p, ...limpio }));
    setAdminSession(false);
    await ctx.recargar();
    avisar('Licencia activada ✅', `La app queda activa por ${meses} mes(es).`);
  }

  // Genera un código para un cliente (requiere la clave maestra)
  async function generarCodigoCliente() {
    const adminKey = (f.admin_key || '').trim();
    const nombreCliente = (f.licencia_cliente || '').trim();
    const meses = Number(f.licencia_meses || 1);

    if (!adminKey || adminKey !== ADMIN_PASS) {
      avisar('Clave incorrecta', 'Escribe la clave maestra (arriba, en Acceso administrador) para generar el código.');
      return;
    }
    if (!nombreCliente) {
      avisar('Falta nombre', 'Escribe el nombre del cliente antes de generar el código.');
      return;
    }
    if (!meses || meses < 1) {
      avisar('Meses inválidos', 'Escribe cuántos meses cubre el código.');
      return;
    }

    const codigo = generarCodigoActivacion(nombreCliente, meses, ADMIN_PASS);
    set('licencia_codigo', codigo);
    avisar('Código generado ✅', `Envíale este código al cliente: ${codigo}`);
  }

  async function enviarCodigoWhatsApp() {
    const codigo = (f.licencia_codigo || '').trim();
    if (!codigo) {
      avisar('Sin código', 'Primero genera o escribe un código de activación.');
      return;
    }

    const mensaje = `Código de activación de FiadoApp\n\n${codigo}`;
    // Sin número: WhatsApp deja elegir a qué contacto enviarlo
    const url = `https://wa.me/?text=${encodeURIComponent(mensaje)}`;
    try {
      await Linking.openURL(url);
    } catch (_) {
      await Clipboard.setStringAsync(codigo);
      avisar('No se pudo abrir WhatsApp', `El código ${codigo} fue copiado al portapapeles.`);
    }
  }

  async function copiarCodigoCliente() {
    const codigo = (f.licencia_codigo || '').trim();
    if (!codigo) {
      avisar('Sin código', 'Primero genera o escribe un código de activación.');
      return;
    }

    await Clipboard.setStringAsync(codigo);
    avisar('Código copiado ✅', `El código ${codigo} ya está en el portapapeles.`);
  }

  return (
    <ScrollView contentContainerStyle={s.contenido} keyboardShouldPersistTaps="handled">
      <Text style={s.titulo}>⚙️ Ajustes</Text>

      <Text style={s.seccion}>Acceso administrador</Text>
      <Campo label="Escriba su clave maestra" value={f.admin_key || ''}
        onChangeText={(t) => set('admin_key', t)} placeholder="Escriba su clave maestra" secureTextEntry />
      <View style={s.filaChips}>
        {!adminSession ? (
          <Boton texto="Iniciar sesión admin" color={AZUL} onPress={iniciarSesionAdmin} style={{ flex: 1 }} />
        ) : (
          <Boton texto="Cerrar sesión admin" color={GRIS} onPress={cerrarSesionAdmin} style={{ flex: 1 }} />
        )}
      </View>

      <Text style={s.seccion}>Usuario</Text>
      <Campo label="Quién está usando la app" value={f.usuario_actual}
        onChangeText={(t) => set('usuario_actual', t)} />
      <Text style={s.sub}>Este nombre queda registrado en cada fiado, abono y cambio.</Text>

      <Text style={s.seccion}>Datos del negocio</Text>
      <View style={s.headerRow}>
        {f.negocio_logo ? (
          <Image source={{ uri: f.negocio_logo }} style={s.logoGrande} resizeMode="contain" />
        ) : (
          <View style={[s.logoGrande, s.logoVacio]}>
            <Text style={s.sub}>Sin logo</Text>
          </View>
        )}
        <View style={s.logoActions}>
          <Boton texto="🖼️ Elegir logo" color={AZUL} onPress={elegirLogo} style={{ width: '100%' }} />
          {!!f.negocio_logo && (
            <Boton texto="Quitar logo" color={GRIS} onPress={() => set('negocio_logo', '')} style={{ width: '100%' }} />
          )}
        </View>
      </View>
      <Campo label="Nombre del negocio" value={f.negocio_nombre} onChangeText={(t) => set('negocio_nombre', t)} />
      <Campo label="Teléfono" keyboardType="phone-pad" value={f.negocio_telefono}
        onChangeText={(t) => set('negocio_telefono', t)} />
      <Campo label="Dirección" value={f.negocio_direccion} onChangeText={(t) => set('negocio_direccion', t)} />
      <Boton texto="Guardar configuración" color={AZUL} onPress={guardar} />

      <Text style={s.seccion}>Mensajes de WhatsApp</Text>
      <Text style={s.sub}>
        Variables que puedes usar: {'{nombre}'} {'{monto}'} {'{balance}'} {'{colmado}'} {'{vencido}'}
      </Text>
      <Campo label="Al registrar un fiado" multiline value={f.msg_fiado}
        onChangeText={(t) => set('msg_fiado', t)} style={[s.input, s.area]} />
      <Campo label="Al registrar un abono" multiline value={f.msg_abono}
        onChangeText={(t) => set('msg_abono', t)} style={[s.input, s.area]} />
      <Campo label="Recordatorio de deuda" multiline value={f.msg_recordatorio}
        onChangeText={(t) => set('msg_recordatorio', t)} style={[s.input, s.area]} />
      <Boton
        texto="Restaurar mensajes originales"
        color={GRIS}
        onPress={() => setF((p) => ({ ...p, ...PLANTILLAS }))}
      />

      <Text style={s.seccion}>Comprobante e impresora</Text>
      <Text style={s.label}>Ancho del papel</Text>
      <View style={s.filaChips}>
        <Chip texto="58 mm" activo={f.comprobante_ancho === '58'} onPress={() => set('comprobante_ancho', '58')} />
        <Chip texto="80 mm" activo={f.comprobante_ancho === '80'} onPress={() => set('comprobante_ancho', '80')} />
      </View>
      <Text style={s.label}>Mostrar logo en el comprobante</Text>
      <View style={s.filaChips}>
        <Chip texto="Sí" activo={f.comprobante_logo === '1'} onPress={() => set('comprobante_logo', '1')} />
        <Chip texto="No" activo={f.comprobante_logo !== '1'} onPress={() => set('comprobante_logo', '0')} />
      </View>
      <Campo label="Mensaje al pie del comprobante" value={f.comprobante_pie}
        onChangeText={(t) => set('comprobante_pie', t)} />
      <Boton texto="🖨️ Imprimir comprobante de prueba" color={AZUL} onPress={imprimirPrueba} />
      <Text style={s.nota}>
        Bluetooth: por ahora la impresión usa el diálogo de impresión del sistema. Si tu impresora de
        58 mm está emparejada con el teléfono (Ajustes de Bluetooth) y tienes un servicio de impresión
        para ella instalado, aparecerá como opción al imprimir. La conexión Bluetooth directa desde
        la app se agrega al compilar el APK.
      </Text>

      <Text style={s.seccion}>Respaldo y recuperación</Text>
      <Boton texto="💾 Exportar copia de seguridad" color={AZUL} onPress={exportarBase} />
      <Boton texto="📥 Restaurar copia de seguridad" color={GRIS} onPress={restaurarBase} />
      <Text style={s.nota}>
        La información queda en la base local SQLite del celular. Si el teléfono se daña, puedes restaurar la copia guardada en tu almacenamiento o compartirla a otro equipo.
      </Text>

      <Text style={s.seccion}>Licencia / pago mensual</Text>
      <Text style={s.sub}>Primero mes gratis. Luego, si no paga, la app se bloquea automáticamente.</Text>
      <View style={s.filaChips}>
        <Chip texto="Activar 30 días" activo={f.licencia_activa} onPress={activarLicenciaMensual} />
        <Chip texto="Simular vencido" activo={!f.licencia_activa} onPress={bloquearLicencia} />
      </View>
      <Text style={s.sub}>
        Estado: {f.licencia_activa ? 'Activa' : 'Inactiva'}
        {f.licencia_expira ? ` · vence ${fmtYMD(f.licencia_expira.slice(0, 10))}` : ''}
      </Text>

      <Campo label="Nombre del cliente" value={f.licencia_cliente || ''}
        onChangeText={(t) => set('licencia_cliente', t)} placeholder="Nombre del negocio o cliente" />
      <Campo label="Meses de activación" value={
        f.licencia_meses === undefined || f.licencia_meses === null ? '1' : String(f.licencia_meses)
      }
        onChangeText={(t) => set('licencia_meses', t.replace(/[^0-9]/g, ''))}
        placeholder="1" keyboardType="numeric" />
      <Boton texto="Generar código de activación" color={AZUL} onPress={generarCodigoCliente} />
      <Campo label="Código del cliente" value={f.licencia_codigo || ''}
        onChangeText={(t) => set('licencia_codigo', t)} placeholder="FIADO-XXXXXX" />
      <Boton texto="Activar con código" onPress={activarLicenciaConCodigo} />
      <Boton texto="📋 Copiar código" color={GRIS} onPress={copiarCodigoCliente} />
      <Boton texto="💬 Enviar por WhatsApp" color={AZUL} onPress={enviarCodigoWhatsApp} />
    </ScrollView>
  );
}

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

async function pedirPermisosNotificaciones() {
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('fiadoapp', {
      name: 'FiadoApp',
      importance: 5,
      sound: 'default',
    });
  }

  const { status } = await Notifications.requestPermissionsAsync();
  return status === 'granted';
}

async function programarNotificacionCliente(cliente, monto, fechaLimite) {
  if (!cliente || !fechaLimite || !monto) return;

  const permiso = await pedirPermisosNotificaciones();
  if (!permiso) return;

  const fecha = new Date(`${fechaLimite}T09:00:00`);
  if (Number.isNaN(fecha.getTime())) return;

  const identifier = `fiado-${cliente.id}-${fechaLimite}`;
  await Notifications.cancelScheduledNotificationAsync(identifier).catch(() => {});
  await Notifications.scheduleNotificationAsync({
    identifier,
    content: {
      title: `Fiado vencido: ${cliente.nombre}`,
      body: `Quedó pendiente ${RD(monto)}. Revisa la deuda.`,
      sound: 'default',
    },
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.DATE,
      date: fecha,
    },
  });
}

async function cancelarNotificacionesCliente(clienteId) {
   const todas = await Notifications.getAllScheduledNotificationsAsync();
  for (const nota of todas) {
    if (nota.identifier.startsWith(`fiado-${clienteId}-`)) {
      await Notifications.cancelScheduledNotificationAsync(nota.identifier).catch(() => {});
    }
  }
}

const s = StyleSheet.create({
  pantalla: {
    flex: 1,
    backgroundColor: '#F9FAFB',
    paddingTop: 8,
  },
  contenido: {
    flexGrow: 1,
    padding: 16,
    paddingBottom: 80,
  },
  vacio: {
    textAlign: 'center',
    color: GRIS,
    padding: 32,
  },
  titulo: {
    fontSize: 28,
    fontWeight: 'bold',
    color: '#111',
    marginBottom: 4,
  },
  seccion: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#111',
    marginTop: 16,
    marginBottom: 8,
  },
  nota: {
    fontSize: 13,
    color: GRIS,
    marginTop: 8,
    marginBottom: 8,
  },
  label: {
    fontSize: 14,
    color: '#111',
    marginBottom: 4,
  },
  input: {
    backgroundColor: '#fff',
    borderRadius: 8,
    padding: 12,
    fontSize: 16,
    color: '#111',
    marginBottom: 16,
    elevation: 2,
  },
  area: {
    minHeight: 80,
    textAlignVertical: 'top',
  },
  tLabel: {
    fontSize: 14,
    color: '#fff',
    fontWeight: '500',
  },
  tValor: {
    fontSize: 22,
    color: '#fff',
    fontWeight: 'bold',
  },
  tarjeta: {
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
    elevation: 4,
  },
  tabs: {
    flexDirection: 'row',
    borderTopWidth: 1,
    borderTopColor: GRIS,
    paddingTop: 8,
  },
  tab: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 8,
  },
  tabTxt: {
    fontSize: 12,
    color: GRIS,
    marginTop: 4,
  },
  headerRow: {
    flexDirection: 'column',
    alignItems: 'stretch',
    marginBottom: 16,
  },
  logoMini: {
    width: 40,
    height: 40,
    borderRadius: 20,
    marginRight: 12,
    resizeMode: 'contain',
  },
  logoGrande: {
    width: '100%',
    height: 120,
    borderRadius: 12,
    marginBottom: 12,
    overflow: 'hidden',
    resizeMode: 'contain',
    backgroundColor: '#fff',
  },
  logoVacio: {
    backgroundColor: '#E5E7EB',
    alignItems: 'center',
    justifyContent: 'center',
  },
  logoActions: {
    width: '100%',
    marginTop: 4,
  },
  banner: {
    backgroundColor: '#D1FAE5',
    color: '#065F46',
    padding: 12,
    borderRadius: 8,
    fontWeight: '500',
    marginBottom: 16,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
  },
  fila: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    borderRadius: 8,
    backgroundColor: '#fff',
    marginBottom: 12,
    elevation: 2,
  },
  nombre: {
    fontSize: 16,
    color: '#111',
    fontWeight: '500',
  },
  monto: {
    fontSize: 18,
    fontWeight: 'bold',
    textAlign: 'right',
    minWidth: 80,
  },
  sub: {
    fontSize: 14,
    color: GRIS,
    marginTop: 2,
  },
  vencido: {
    fontSize: 14,
    color: ROJO,
    marginTop: 4,
  },
  link: {
    color: VERDE,
    fontWeight: '500',
    marginTop: 8,
  },
  wa: {
    width: 40,
    height: 40,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: 20,
       backgroundColor: '#25D366',
    marginLeft: 8,
  },
  chip: {
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: 16,
    backgroundColor: '#E5E7EB',
    marginRight: 8,
    marginBottom: 8,
  },
  chipTxt: {
    fontSize: 14,
    color: '#111',
  },
  filaChips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginBottom: 16,
  },
  volver: {
    fontSize: 16,
    color: AZUL,
    marginBottom: 16,
  },
  eliminar: {
    color: ROJO,
    fontWeight: 'bold',
    marginTop: 16,
    textAlign: 'center',
  },
  panelOk: {
    backgroundColor: '#D1FAE5',
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
  },
  panelOkTxt: {
    color: '#065F46',
    fontWeight: '500',
    marginBottom: 8,
  },
  editado: {
    fontSize: 12,
    color: GRIS,
    marginTop: 4,
  },
  boton: {
    borderRadius: 10,
    paddingVertical: 14,
    paddingHorizontal: 16,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 12,
    marginBottom: 8,
  },
  botonTxt: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '700',
  },
  mitad: {
    width: '48%',
  },
  lleno: {
    width: '100%',
  },
  calcCard: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
    elevation: 4,
  },
  calcInput: {
    backgroundColor: '#F3F4F6',
    borderRadius: 8,
    padding: 12,
    fontSize: 18,
    color: '#111',
    marginBottom: 12,
  },
  calcResultado: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#111',
    marginBottom: 12,
    textAlign: 'right',
  },
  calcGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
  },
  calcButton: {
    width: '23%',
    backgroundColor: '#E5E7EB',
    borderRadius: 8,
    padding: 16,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12,
  },
  calcButtonEqual: {
    backgroundColor: VERDE,
  },
  calcButtonText: {
    fontSize: 18,
    fontWeight: '500',
    color: '#111',
  },
});