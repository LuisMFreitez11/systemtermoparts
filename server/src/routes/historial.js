/**
 * Endpoint `/api_historial.php`: auditoría de acciones de usuario.
 */
import express from 'express';
import { query } from '../db.js';
import { json, error, parametro, entero, texto, mbsub, esFecha } from '../http.js';
import { requireSession } from '../auth.js';

const router = express.Router();

router.all('/', requireSession, async (req, res) => {
    const accion = parametro(req, 'accion', 'listar');
    const esAdmin = req.usuario.rol === 'ADMIN';

    if (!['listar', 'usuarios'].includes(accion)) {
        error(res, 400, 'Acción no válida.');
        return;
    }

    if (accion === 'usuarios') {
        if (esAdmin) {
            const { rows } = await query('SELECT usuario FROM usuarios ORDER BY usuario ASC');
            json(res, 200, rows.map(fila => fila.usuario));
            return;
        }

        json(res, 200, [req.usuario.usuario]);
        return;
    }

    const buscar = mbsub(texto(req.query.buscar), 100);
    const usuarioFiltro = mbsub(texto(req.query.usuario), 50);
    const desde = texto(req.query.desde);
    const hasta = texto(req.query.hasta);
    let limite = entero(req.query.limite ?? 300);

    if (limite === null) {
        limite = 300;
    }

    limite = Math.max(1, Math.min(limite, 1000));

    let sql = `SELECT historial_id, usuario_id, usuario, accion, detalle, ip, creado_en
               FROM historial_usuario
               WHERE 1 = 1`;
    const parametros = [];

    if (!esAdmin) {
        parametros.push(Number(req.usuario.usuario_id));
        sql += ` AND usuario_id = $${parametros.length}`;
    } else if (usuarioFiltro !== '') {
        parametros.push(usuarioFiltro);
        sql += ` AND usuario = $${parametros.length}`;
    }

    if (buscar !== '') {
        parametros.push(buscar);
        const p = `$${parametros.length}`;

        sql += ` AND (POSITION(LOWER(${p}) IN LOWER(accion)) > 0
                    OR POSITION(LOWER(${p}) IN LOWER(detalle)) > 0
                    OR POSITION(LOWER(${p}) IN LOWER(usuario)) > 0
                    OR POSITION(LOWER(${p}) IN LOWER(ip)) > 0)`;
    }

    if (desde !== '') {
        if (!esFecha(desde)) {
            error(res, 422, 'La fecha "desde" no es válida.');
            return;
        }

        parametros.push(`${desde} 00:00:00`);
        sql += ` AND creado_en >= $${parametros.length}`;
    }

    if (hasta !== '') {
        if (!esFecha(hasta)) {
            error(res, 422, 'La fecha "hasta" no es válida.');
            return;
        }

        parametros.push(`${hasta} 23:59:59`);
        sql += ` AND creado_en <= $${parametros.length}`;
    }

    sql += ` ORDER BY creado_en DESC, historial_id DESC LIMIT ${limite}`;

    const { rows } = await query(sql, parametros);
    json(res, 200, rows);
});

export default router;
