<?php
declare(strict_types=1);

/**
 * Punto de arranque único del backend.
 *
 * Todos los endpoints incluyen este archivo. Aquí se cargan las clases, se
 * configura la aplicación, se resuelve CORS, se abre la conexión y se prepara
 * la sesión y la idempotencia.
 */

require_once __DIR__ . '/Config.php';
require_once __DIR__ . '/Http.php';
require_once __DIR__ . '/Database.php';
require_once __DIR__ . '/Idempotency.php';
require_once __DIR__ . '/Audit.php';
require_once __DIR__ . '/Auth.php';

Config::inicializar();
Http::cors();

$pdo = Database::conexion();

Auth::iniciarSesion();
Idempotency::iniciar($pdo, basename((string) ($_SERVER['SCRIPT_NAME'] ?? 'api')));
