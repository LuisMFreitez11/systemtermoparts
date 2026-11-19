/**
 * Guardia de configuración para producción.
 *
 * En Vercel, un error lanzado al importar el módulo se convierte en un 500
 * `FUNCTION_INVOCATION_FAILED` con el cuerpo vacío, imposible de diagnosticar
 * desde fuera. Esta guardia responde 503 con un JSON que solo nombra las
 * variables faltantes (nunca sus valores) para que el fallo sea accionable.
 */
import { json } from './http.js';

export function guardiaConfiguracion(faltantes) {
    const lista = Array.isArray(faltantes) ? faltantes.filter(Boolean) : [];

    if (lista.length === 0) {
        return (_req, _res, next) => next();
    }

    const mensaje = `Configuración incompleta: falta ${lista.join(', ')}. `
        + 'Defínela en Vercel → Settings → Environment Variables y vuelve a desplegar.';

    return (req, res) => {
        json(res, 503, {
            exito: false,
            mensaje,
            faltantes: lista,
            documentacion: 'docs/DESPLIEGUE_VERCEL.md',
        });
    };
}
