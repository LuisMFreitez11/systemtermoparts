/**
 * Arranque local del backend Node.
 *   node src/server.js
 */
import app from './app.js';
import { config } from './config.js';
import { cerrar } from './db.js';

const servidor = app.listen(config.puerto, () => {
    console.log(`[WMS] API Node escuchando en http://localhost:${config.puerto}`);
    console.log(`[WMS] Motor: ${config.driver} · Zona: ${config.zonaHoraria}`);
});

async function apagar(senal) {
    console.log(`[WMS] ${senal} recibido, cerrando...`);

    servidor.close(async () => {
        try {
            await cerrar();
        } finally {
            process.exit(0);
        }
    });

    // Si algo queda colgado, se fuerza la salida.
    setTimeout(() => process.exit(1), 10000).unref();
}

process.on('SIGINT', () => apagar('SIGINT'));
process.on('SIGTERM', () => apagar('SIGTERM'));

export default servidor;
