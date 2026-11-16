<?php
$host = 'localhost';
$dbname = 'termo_part_wms';
$username = 'root';
$password = '';

try {
    $pdo = new PDO("mysql:host=$host;dbname=$dbname;charset=utf8mb4", $username, $password, [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_EMULATE_PREPARES => false,
    ]);
} catch (PDOException $e) {
    $mensaje = 'Error de conexión a MariaDB. Verifica que el servidor MySQL esté iniciado.';

    if (str_contains($e->getMessage(), 'Unknown database')) {
        $mensaje = 'La base de datos "termo_part_wms" no existe. Importa el archivo database.sql en phpMyAdmin.';
    }

    if (!headers_sent()) {
        header('Content-Type: application/json; charset=utf-8');
    }

    http_response_code(500);
    echo json_encode(['exito' => false, 'mensaje' => $mensaje], JSON_UNESCAPED_UNICODE);
    exit;
}
