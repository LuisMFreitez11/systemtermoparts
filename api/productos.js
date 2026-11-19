/**
 * Función serverless de Vercel para `/api/productos` (y `/api.php` tras el
 * rewrite). Todas las funciones comparten la misma app Express.
 */
import app from '../server/src/app.js';

export default app;
