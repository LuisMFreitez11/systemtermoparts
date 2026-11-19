/**
 * Punto de entrada serverless de Vercel.
 *
 * `vercel.json` reescribe las rutas PHP (`/api.php`, `/api_activos.php`, ...)
 * hacia `/api/<recurso>`, y la app Express conoce ambos nombres.
 */
import app from '../server/src/app.js';

export default app;
