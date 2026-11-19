/**
 * Endpoint `/health.php`: comprobación de salud para monitoreo y despliegue.
 * No requiere sesión y no expone datos de negocio.
 */
import express from 'express';
import { config } from '../config.js';
import { json, ahoraIso } from '../http.js';

const router = express.Router();

router.get('/', (req, res) => {
    json(res, 200, {
        exito: true,
        servicio: 'wms-termo-part',
        hora: ahoraIso(),
        motor: config.driver,
    });
});

export default router;
