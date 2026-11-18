<?php
declare(strict_types=1);

/**
 * Comprobación de salud del backend (pensada para monitoreo y despliegue).
 * No requiere sesión y no expone datos de negocio.
 */

require_once __DIR__ . '/../src/bootstrap.php';

Http::json([
    'exito' => true,
    'servicio' => 'wms-termo-part',
    'hora' => date('c'),
    'motor' => Config::obtener('driver', 'pgsql'),
]);
