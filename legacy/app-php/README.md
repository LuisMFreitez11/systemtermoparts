# Aplicación PHP original (archivada)

Copia plana del WMS anterior: HTML, CSS, JS y endpoints PHP en la misma carpeta.
Se conserva para no perder el trabajo, pero **no forma parte del despliegue**.

- Endpoints: `api.php`, `api_activos.php`, `api_herramientas.php`,
  `api_entradas.php`, `api_danados.php`, `api_historial.php`, `api_sesion.php`.
- Conexión: `conexion.php` + `sesion.php`.
- Reportes: `exportar_pdf.php`, `exportar_excel.php`.
- Esquemas: `database.sql`, `migracion_mejoras.sql`, `termo_part_wms.sql`.
- El `index.html` de esta carpeta es la app plana; el `index.html` de la raíz
  solo redirige a `frontend/`.

Para revivirla: cópiala a un hosting con PHP 8.1+, Apache y `pdo_pgsql`, crea
`conexion.php` con las credenciales y apunta el dominio a esta carpeta.
