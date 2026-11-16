-- Base de datos del sistema de inventario TERMO PART (WMS)
-- Importar desde phpMyAdmin o ejecutar: mysql -u root < database.sql

CREATE DATABASE IF NOT EXISTS termo_part_wms
    CHARACTER SET utf8mb4
    COLLATE utf8mb4_unicode_ci;

USE termo_part_wms;

CREATE TABLE IF NOT EXISTS productos (
    producto_id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    sku_codigo VARCHAR(50) NOT NULL,
    nombre_descripcion VARCHAR(255) NOT NULL,
    categoria VARCHAR(50) NOT NULL DEFAULT 'OTROS',
    lote_condicion VARCHAR(50) NOT NULL DEFAULT 'STOCK',
    unidad_medida VARCHAR(20) NOT NULL DEFAULT 'PZA',
    stock_actual DECIMAL(12,3) NOT NULL DEFAULT 0.000,
    stock_minimo DECIMAL(12,3) NOT NULL DEFAULT 0.000,
    toma_fisica_anterior DECIMAL(12,3) NOT NULL DEFAULT 0.000,
    stock_consumido DECIMAL(12,3) NOT NULL DEFAULT 0.000,
    stock_incrementado DECIMAL(12,3) NOT NULL DEFAULT 0.000,
    stock_danado DECIMAL(12,3) NOT NULL DEFAULT 0.000,
    creado_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    actualizado_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (producto_id),
    UNIQUE KEY uq_productos_sku_lote_desc (sku_codigo, lote_condicion, nombre_descripcion),
    KEY idx_productos_lote (lote_condicion),
    KEY idx_productos_nombre (nombre_descripcion),
    KEY idx_productos_categoria (categoria)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Historial de movimientos de inventario (consumos, incrementos, devoluciones y entradas).
CREATE TABLE IF NOT EXISTS movimientos_inventario (
    movimiento_id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    producto_id INT UNSIGNED NOT NULL,
    tipo ENUM('CONSUMO', 'INCREMENTO', 'DEVOLUCION', 'ENTRADA', 'DANADO') NOT NULL,
    cantidad DECIMAL(12,3) NOT NULL,
    stock_anterior DECIMAL(12,3) NOT NULL,
    stock_nuevo DECIMAL(12,3) NOT NULL,
    motivo VARCHAR(255) NULL,
    creado_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (movimiento_id),
    KEY idx_movimientos_producto (producto_id),
    KEY idx_movimientos_fecha (creado_en),
    CONSTRAINT fk_movimientos_producto
        FOREIGN KEY (producto_id) REFERENCES productos (producto_id)
        ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- CRUD de herramientas.
CREATE TABLE IF NOT EXISTS herramientas (
    herramienta_id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    codigo VARCHAR(50) NOT NULL,
    nombre VARCHAR(255) NOT NULL,
    marca VARCHAR(100) NOT NULL DEFAULT '',
    modelo VARCHAR(100) NOT NULL DEFAULT '',
    unidad_medida VARCHAR(20) NOT NULL DEFAULT 'UNIDAD',
    cantidad INT NOT NULL DEFAULT 1,
    cantidad_prestada INT NOT NULL DEFAULT 0,
    estado ENUM('DISPONIBLE', 'ASIGNADA', 'EN REPARACION', 'BAJA') NOT NULL DEFAULT 'DISPONIBLE',
    ubicacion VARCHAR(150) NOT NULL DEFAULT '',
    responsable VARCHAR(150) NOT NULL DEFAULT '',
    observaciones TEXT NULL,
    creado_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    actualizado_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (herramienta_id),
    UNIQUE KEY uq_herramientas_codigo (codigo),
    KEY idx_herramientas_nombre (nombre),
    KEY idx_herramientas_estado (estado)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Activos (equipos intervenidos) y materiales del almacén usados en cada activo.
CREATE TABLE IF NOT EXISTS activos (
    activo_id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    tipo ENUM('CALLE', 'TALLER') NOT NULL DEFAULT 'CALLE',
    fecha_ruta DATE NULL,
    activo VARCHAR(50) NOT NULL,
    modelo VARCHAR(120) NOT NULL DEFAULT '',
    nro_orden VARCHAR(50) NOT NULL DEFAULT '',
    numero_reporte VARCHAR(50) NOT NULL DEFAULT '',
    nombre_cliente VARCHAR(255) NOT NULL DEFAULT '',
    reparacion TEXT NULL,
    creado_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    actualizado_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (activo_id),
    UNIQUE KEY uq_activos_tipo_activo_orden (tipo, activo, nro_orden),
    KEY idx_activos_fecha (fecha_ruta),
    KEY idx_activos_cliente (nombre_cliente)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS activo_materiales (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    activo_id INT UNSIGNED NOT NULL,
    producto_id INT UNSIGNED NOT NULL,
    cantidad DECIMAL(12,3) NOT NULL DEFAULT 0.000,
    cantidad_descontada DECIMAL(12,3) NOT NULL DEFAULT 0.000,
    creado_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_activo_material (activo_id, producto_id),
    KEY idx_activo_material_producto (producto_id),
    CONSTRAINT fk_activo_material_activo
        FOREIGN KEY (activo_id) REFERENCES activos (activo_id)
        ON DELETE CASCADE,
    CONSTRAINT fk_activo_material_producto
        FOREIGN KEY (producto_id) REFERENCES productos (producto_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Usuarios del sistema. Las claves se guardan con password_hash de PHP.
CREATE TABLE IF NOT EXISTS usuarios (
    usuario_id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    usuario VARCHAR(50) NOT NULL,
    nombre_completo VARCHAR(150) NOT NULL DEFAULT '',
    clave_hash VARCHAR(255) NOT NULL,
    rol ENUM('ADMIN', 'USUARIO') NOT NULL DEFAULT 'USUARIO',
    activo TINYINT(1) NOT NULL DEFAULT 1,
    ultimo_acceso DATETIME NULL,
    creado_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (usuario_id),
    UNIQUE KEY uq_usuarios_usuario (usuario)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Historial de acciones por usuario (auditoría).
CREATE TABLE IF NOT EXISTS historial_usuario (
    historial_id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    usuario_id INT UNSIGNED NULL,
    usuario VARCHAR(50) NOT NULL DEFAULT '',
    accion VARCHAR(80) NOT NULL,
    detalle VARCHAR(500) NOT NULL DEFAULT '',
    ip VARCHAR(45) NOT NULL DEFAULT '',
    creado_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (historial_id),
    KEY idx_historial_usuario (usuario_id),
    KEY idx_historial_fecha (creado_en),
    CONSTRAINT fk_historial_usuario
        FOREIGN KEY (usuario_id) REFERENCES usuarios (usuario_id)
        ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Entradas y salidas (préstamos) de herramientas.
CREATE TABLE IF NOT EXISTS herramientas_movimientos (
    movimiento_id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    herramienta_id INT UNSIGNED NOT NULL,
    tipo ENUM('SALIDA', 'ENTRADA') NOT NULL,
    cantidad INT NOT NULL,
    fecha DATE NOT NULL,
    responsable VARCHAR(150) NOT NULL DEFAULT '',
    destino VARCHAR(150) NOT NULL DEFAULT '',
    observaciones TEXT NULL,
    usuario_id INT UNSIGNED NULL,
    creado_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (movimiento_id),
    KEY idx_hmov_herramienta (herramienta_id),
    KEY idx_hmov_fecha (fecha),
    CONSTRAINT fk_hmov_herramienta
        FOREIGN KEY (herramienta_id) REFERENCES herramientas (herramienta_id)
        ON DELETE CASCADE,
    CONSTRAINT fk_hmov_usuario
        FOREIGN KEY (usuario_id) REFERENCES usuarios (usuario_id)
        ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Entradas de material al almacén. Cada entrada incrementa el stock del producto
-- y conserva su propio historial (fecha, referencia, proveedor y observaciones).
CREATE TABLE IF NOT EXISTS entradas_almacen (
    entrada_id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    producto_id INT UNSIGNED NOT NULL,
    cantidad DECIMAL(12,3) NOT NULL,
    fecha_entrada DATE NOT NULL,
    referencia VARCHAR(100) NOT NULL DEFAULT '',
    proveedor VARCHAR(150) NOT NULL DEFAULT '',
    observaciones TEXT NULL,
    stock_anterior DECIMAL(12,3) NOT NULL,
    stock_nuevo DECIMAL(12,3) NOT NULL,
    movimiento_id INT UNSIGNED NULL,
    creado_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (entrada_id),
    KEY idx_entradas_producto (producto_id),
    KEY idx_entradas_fecha (fecha_entrada),
    CONSTRAINT fk_entradas_producto
        FOREIGN KEY (producto_id) REFERENCES productos (producto_id),
    CONSTRAINT fk_entradas_movimiento
        FOREIGN KEY (movimiento_id) REFERENCES movimientos_inventario (movimiento_id)
        ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Materiales dañados. Cada registro descuenta stock disponible y acumula
-- la cantidad en el total dañado del producto.
CREATE TABLE IF NOT EXISTS materiales_danados (
    danado_id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    producto_id INT UNSIGNED NOT NULL,
    cantidad DECIMAL(12,3) NOT NULL,
    fecha_dano DATE NOT NULL,
    motivo VARCHAR(150) NOT NULL DEFAULT '',
    observaciones TEXT NULL,
    stock_anterior DECIMAL(12,3) NOT NULL,
    stock_nuevo DECIMAL(12,3) NOT NULL,
    movimiento_id INT UNSIGNED NULL,
    creado_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (danado_id),
    KEY idx_danados_producto (producto_id),
    KEY idx_danados_fecha (fecha_dano),
    CONSTRAINT fk_danados_producto
        FOREIGN KEY (producto_id) REFERENCES productos (producto_id),
    CONSTRAINT fk_danados_movimiento
        FOREIGN KEY (movimiento_id) REFERENCES movimientos_inventario (movimiento_id)
        ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Toma física: cada registro guarda una foto del stock de todos los materiales.
CREATE TABLE IF NOT EXISTS tomas_fisicas (
    toma_id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    registrada_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    total_productos INT UNSIGNED NOT NULL DEFAULT 0,
    total_unidades DECIMAL(14,3) NOT NULL DEFAULT 0.000,
    PRIMARY KEY (toma_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS toma_fisica_detalle (
    detalle_id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    toma_id INT UNSIGNED NOT NULL,
    producto_id INT UNSIGNED NOT NULL,
    cantidad DECIMAL(12,3) NOT NULL DEFAULT 0.000,
    PRIMARY KEY (detalle_id),
    KEY idx_toma_detalle_toma (toma_id),
    KEY idx_toma_detalle_producto (producto_id),
    CONSTRAINT fk_toma_detalle_toma
        FOREIGN KEY (toma_id) REFERENCES tomas_fisicas (toma_id)
        ON DELETE CASCADE,
    CONSTRAINT fk_toma_detalle_producto
        FOREIGN KEY (producto_id) REFERENCES productos (producto_id)
        ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- El inventario real se cargó desde la hoja "ALMACEN ORDEN ALFABETICO"
-- del archivo ALMACEN REPUESTOS NUEVOS DESDE 15-10-2026.xlsx.
-- La tabla queda vacía al crear el esquema; los productos se gestionan desde la aplicación.

-- Usuarios iniciales: admin/admin123 (ADMIN) y almacen/almacen123 (USUARIO).
-- Cambiar las claves desde el sistema después de la primera instalación.
INSERT INTO usuarios (usuario, nombre_completo, clave_hash, rol) VALUES
    ('admin', 'Administrador', '$2y$10$ZufiOJ6kAr7TeZSldC0DK.xx64gZHgNs9copgBAWKXxTNs59L9y4K', 'ADMIN'),
    ('almacen', 'Encargado de almacén', '$2y$10$kRp6JWAoN7luHLUwJbfFkebQnL2z7kEip/jYg.pBoTRn4/8TS.4pG', 'USUARIO')
ON DUPLICATE KEY UPDATE
    nombre_completo = VALUES(nombre_completo);
