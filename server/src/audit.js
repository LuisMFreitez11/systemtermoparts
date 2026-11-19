/**
 * Auditoría en `historial_usuario`.
 *
 * Nunca lanza: un fallo de auditoría no debe tumbar la operación de negocio,
 * igual que en el backend PHP.
 */
import { mbsub } from './http.js';

async function registrar(db, { accion, detalle = '', usuario, ip = '' }) {
    if (!usuario) {
        return;
    }

    try {
        await db.query(
            `INSERT INTO historial_usuario (usuario_id, usuario, accion, detalle, ip)
             VALUES ($1, $2, $3, $4, $5)`,
            [
                Number(usuario.usuario_id),
                usuario.usuario,
                mbsub(accion, 80),
                mbsub(detalle, 500),
                mbsub(ip, 45),
            ]
        );
    } catch (error) {
        console.error('[WMS] No se pudo guardar el historial:', error.message);
    }
}

/** IP del cliente respetando proxies (Vercel, ngrok, cloudflared). */
function ipCliente(req) {
    const reenviada = String(req.get('x-forwarded-for') ?? '').split(',')[0].trim();

    return reenviada || req.ip || req.socket?.remoteAddress || '';
}

export { registrar, ipCliente };
