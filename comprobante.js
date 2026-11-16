import { Platform } from 'react-native';
import * as Print from 'expo-print';
import { RD, fmtFechaHora, fmtYMD } from './utils';

const esc = (t) =>
  String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Balance del cliente antes y después de un movimiento
export function balancesDe(movsCliente, mov) {
  let despues = 0;
  for (const m of movsCliente) {
    if (m.anulado || m.id > mov.id) continue;
    despues += m.tipo === 'fiao' ? m.monto : -m.monto;
  }
  const antes = mov.anulado ? despues : despues - (mov.tipo === 'fiao' ? mov.monto : -mov.monto);
  return { antes, despues };
}

export function construirComprobante({ cfg, cliente, mov, balanceAntes, balanceDespues }) {
  const papel = cfg.comprobante_ancho === '80' ? 80 : 58;
  const util = papel === 80 ? 72 : 48; // mm realmente imprimibles
  const esFiado = mov.tipo === 'fiao';
  const num = String(mov.id).padStart(6, '0');
  const logo =
    cfg.negocio_logo && cfg.comprobante_logo === '1'
      ? `<img class="logo" src="${cfg.negocio_logo}" />`
      : '';

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<title>Comprobante ${num}</title>
<style>
  @page { size: ${papel}mm auto; margin: 2mm; }
  * { box-sizing: border-box; }
  body { width: ${util}mm; margin: 0 auto; font-family: 'Courier New', monospace; font-size: 12px; color: #000; }
  .c { text-align: center; }
  .b { font-weight: bold; }
  .logo { max-width: 40mm; max-height: 20mm; display: block; margin: 0 auto 4px; filter: grayscale(1) contrast(1.4); }
  hr { border: 0; border-top: 1px dashed #000; margin: 6px 0; }
  .f { display: flex; justify-content: space-between; gap: 6px; }
  .t { font-size: 14px; font-weight: bold; }
</style></head><body>
  ${logo}
  <div class="c b" style="font-size:14px">${esc(cfg.negocio_nombre)}</div>
  ${cfg.negocio_telefono ? `<div class="c">Tel: ${esc(cfg.negocio_telefono)}</div>` : ''}
  ${cfg.negocio_direccion ? `<div class="c">${esc(cfg.negocio_direccion)}</div>` : ''}
  <hr>
  <div class="c b">COMPROBANTE DE ${esFiado ? 'FIADO' : 'ABONO'}</div>
  <div class="c">No. ${num}</div>
  <hr>
  <div class="f"><span>Fecha:</span><span>${fmtFechaHora(mov.fecha)}</span></div>
  <div>Cliente: ${esc(cliente.nombre)}</div>
  ${mov.nota ? `<div>Detalle: ${esc(mov.nota)}</div>` : ''}
  ${esFiado && mov.fecha_limite ? `<div>Vence: ${fmtYMD(mov.fecha_limite)}</div>` : ''}
  ${!esFiado && mov.metodo ? `<div>Pago: ${esc(mov.metodo)}</div>` : ''}
  <hr>
  <div class="f"><span>Balance anterior:</span><span>${RD(balanceAntes)}</span></div>
  <div class="f t"><span>${esFiado ? 'FIADO' : 'ABONO'}:</span><span>${RD(mov.monto)}</span></div>
  <div class="f t"><span>BALANCE:</span><span>${RD(balanceDespues)}</span></div>
  <hr>
  ${mov.creado_por ? `<div>Atendido por: ${esc(mov.creado_por)}</div>` : ''}
  ${mov.anulado ? '<div class="c b">*** ANULADO ***</div>' : ''}
  <div class="c">${esc(cfg.comprobante_pie)}</div>
  <br>
</body></html>`;
}

export async function imprimir(html, cfg) {
  if (Platform.OS === 'web') {
    const w = window.open('', '_blank', 'width=380,height=640');
    if (!w) throw new Error('Permite las ventanas emergentes del navegador para poder imprimir.');
    w.document.write(html);
    w.document.close();
    w.focus();
    setTimeout(() => w.print(), 500);
    return;
  }
  // 58 mm ≈ 164 puntos, 80 mm ≈ 227 puntos
  const ancho = cfg.comprobante_ancho === '80' ? 227 : 164;
  await Print.printAsync({ html, width: ancho });
}