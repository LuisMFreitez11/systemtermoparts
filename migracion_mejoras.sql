-- Migración: filtro por categoría, consumido/incrementado/dañado en stock, ajustes e historial, CRUD de herramientas, activos, entradas de almacén y materiales dañados
-- Ejecutar una sola vez sobre una base de datos termo_part_wms ya existente.
-- Importar desde phpMyAdmin o ejecutar: mysql -u root < migracion_mejoras.sql

USE termo_part_wms;

-- 1) Totales por producto: lo consumido y lo incrementado.
ALTER TABLE productos
    ADD COLUMN IF NOT EXISTS stock_consumido DECIMAL(12,3) NOT NULL DEFAULT 0.000 AFTER stock_minimo;

ALTER TABLE productos
    ADD COLUMN IF NOT EXISTS stock_incrementado DECIMAL(12,3) NOT NULL DEFAULT 0.000 AFTER stock_consumido;

ALTER TABLE productos
    ADD COLUMN IF NOT EXISTS stock_danado DECIMAL(12,3) NOT NULL DEFAULT 0.000 AFTER stock_incrementado;

-- 2) Categoría derivada de la primera palabra de la descripción (para filtrar, por ejemplo, todas las calcomanías).
ALTER TABLE productos
    ADD COLUMN IF NOT EXISTS categoria VARCHAR(50) NOT NULL DEFAULT '' AFTER nombre_descripcion;

UPDATE productos
SET categoria = UPPER(REGEXP_REPLACE(SUBSTRING_INDEX(TRIM(nombre_descripcion), ' ', 1), '[^A-Za-zÁÉÍÓÚÜÑáéíóúüñ]', ''))
WHERE categoria = '';

UPDATE productos
SET categoria = 'OTROS'
WHERE categoria = '';

ALTER TABLE productos
    MODIFY COLUMN categoria VARCHAR(50) NOT NULL DEFAULT 'OTROS';

-- 3) Historial de ajustes de inventario (restas e incrementos).
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

ALTER TABLE movimientos_inventario
    MODIFY COLUMN tipo ENUM('CONSUMO', 'INCREMENTO', 'DEVOLUCION', 'ENTRADA', 'DANADO') NOT NULL;

-- 4) CRUD de herramientas.
CREATE TABLE IF NOT EXISTS herramientas (
    herramienta_id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    codigo VARCHAR(50) NOT NULL,
    nombre VARCHAR(255) NOT NULL,
    marca VARCHAR(100) NOT NULL DEFAULT '',
    modelo VARCHAR(100) NOT NULL DEFAULT '',
    cantidad INT NOT NULL DEFAULT 1,
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

-- 5) Unidad de medida en las herramientas (materiales de consumo).
ALTER TABLE herramientas
    ADD COLUMN IF NOT EXISTS unidad_medida VARCHAR(20) NOT NULL DEFAULT 'UNIDAD' AFTER modelo;

-- 6) Activos (equipos intervenidos) y materiales del almacén usados en cada activo.
CREATE TABLE IF NOT EXISTS activos (
    activo_id INT UNSIGNED NOT NULL AUTO_INCREMENT,
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
    UNIQUE KEY uq_activos_activo_orden (activo, nro_orden),
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

-- 7) Entradas de material al almacén. Cada entrada incrementa el stock del producto
--    y conserva su propio historial (fecha, referencia, proveedor y observaciones).
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

-- 8) Materiales dañados. Cada registro descuenta stock disponible y acumula
--    la cantidad en el total dañado del producto.
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

-- 9) Sincronizar los totales de consumido/incrementado/dañado con el historial de movimientos.
UPDATE productos p
LEFT JOIN (
    SELECT producto_id,
           SUM(CASE WHEN tipo = 'CONSUMO' THEN cantidad WHEN tipo = 'DEVOLUCION' THEN -cantidad ELSE 0 END) AS total_consumido,
           SUM(CASE WHEN tipo IN ('INCREMENTO', 'ENTRADA') THEN cantidad ELSE 0 END) AS total_incrementado,
           SUM(CASE WHEN tipo = 'DANADO' THEN cantidad ELSE 0 END) AS total_danado
    FROM movimientos_inventario
    GROUP BY producto_id
) m ON m.producto_id = p.producto_id
SET p.stock_consumido = GREATEST(COALESCE(m.total_consumido, 0), 0),
    p.stock_incrementado = COALESCE(m.total_incrementado, 0),
    p.stock_danado = COALESCE(m.total_danado, 0);

-- 10) Toma física anterior: conteo físico inicial del producto, conservado como
--     referencia histórica. Se calcula una sola vez, al agregar la columna.
SET @tenia_toma_fisica := (
    SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'productos'
      AND COLUMN_NAME = 'toma_fisica_anterior'
);

ALTER TABLE productos
    ADD COLUMN IF NOT EXISTS toma_fisica_anterior DECIMAL(12,3) NOT NULL DEFAULT 0.000 AFTER stock_minimo;

SET @sql_toma_fisica := IF(
    @tenia_toma_fisica = 0,
    'UPDATE productos SET toma_fisica_anterior = GREATEST(stock_actual + stock_consumido - stock_incrementado + stock_danado, 0)',
    'SELECT 1'
);
PREPARE stmt_toma_fisica FROM @sql_toma_fisica;
EXECUTE stmt_toma_fisica;
DEALLOCATE PREPARE stmt_toma_fisica;

-- 11) Toma física: cada registro guarda una foto del stock de todos los materiales.
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

-- 12) Usuarios del sistema para inicio de sesión.
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

-- 13) Historial de acciones por usuario (auditoría).
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

-- 14) Entradas y salidas (préstamos) de herramientas.
ALTER TABLE herramientas
    ADD COLUMN IF NOT EXISTS cantidad_prestada INT NOT NULL DEFAULT 0 AFTER cantidad;

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

-- 15) Activos de calle y de taller: tipo de activo.
ALTER TABLE activos
    ADD COLUMN IF NOT EXISTS tipo ENUM('CALLE', 'TALLER') NOT NULL DEFAULT 'CALLE' AFTER activo_id;

-- Reemplazar el índice único antiguo (activo, nro_orden) por uno que incluye el tipo.
SET @tenia_indice_viejo := (
    SELECT COUNT(*) FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'activos'
      AND INDEX_NAME = 'uq_activos_activo_orden'
);
SET @sql_indice_viejo := IF(
    @tenia_indice_viejo > 0,
    'ALTER TABLE activos DROP INDEX uq_activos_activo_orden',
    'SELECT 1'
);
PREPARE stmt_indice_viejo FROM @sql_indice_viejo;
EXECUTE stmt_indice_viejo;
DEALLOCATE PREPARE stmt_indice_viejo;

SET @tenia_indice_nuevo := (
    SELECT COUNT(*) FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'activos'
      AND INDEX_NAME = 'uq_activos_tipo_activo_orden'
);
SET @sql_indice_nuevo := IF(
    @tenia_indice_nuevo = 0,
    'ALTER TABLE activos ADD UNIQUE KEY uq_activos_tipo_activo_orden (tipo, activo, nro_orden)',
    'SELECT 1'
);
PREPARE stmt_indice_nuevo FROM @sql_indice_nuevo;
EXECUTE stmt_indice_nuevo;
DEALLOCATE PREPARE stmt_indice_nuevo;

-- 16) Usuarios iniciales: admin/admin123 (ADMIN) y almacen/almacen123 (USUARIO).
--     Cambiar las claves desde el sistema después de la primera instalación.
INSERT INTO usuarios (usuario, nombre_completo, clave_hash, rol) VALUES
    ('admin', 'Administrador', '$2y$10$ZufiOJ6kAr7TeZSldC0DK.xx64gZHgNs9copgBAWKXxTNs59L9y4K', 'ADMIN'),
    ('almacen', 'Encargado de almacén', '$2y$10$kRp6JWAoN7luHLUwJbfFkebQnL2z7kEip/jYg.pBoTRn4/8TS.4pG', 'USUARIO')
ON DUPLICATE KEY UPDATE
    nombre_completo = VALUES(nombre_completo);

-- 17) Reparar tablas creadas con versiones antiguas del esquema.
--    Una tabla "legacy" puede no tener PRIMARY KEY, AUTO_INCREMENT ni índices.
--    Este procedimiento es idempotente: se puede ejecutar varias veces sin efectos secundarios.
DROP PROCEDURE IF EXISTS reparar_esquema_wms;
DELIMITER $$
CREATE PROCEDURE reparar_esquema_wms()
BEGIN
    DECLARE v_existe INT DEFAULT 0;
    DECLARE v_hay INT DEFAULT 0;

    -- 8.1) herramientas: PK + AUTO_INCREMENT en herramienta_id.
    SELECT COUNT(*) INTO v_existe
    FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'herramientas' AND INDEX_NAME = 'PRIMARY';

    IF v_existe = 0 THEN
        -- Renumerar todas las filas porque sin PK los IDs pueden estar repetidos o en cero.
        SET @n := 0;
        UPDATE herramientas
        SET herramienta_id = (@n := @n + 1)
        ORDER BY creado_en, herramienta_id, codigo;

        ALTER TABLE herramientas
            MODIFY COLUMN herramienta_id INT UNSIGNED NOT NULL AUTO_INCREMENT,
            ADD PRIMARY KEY (herramienta_id);
    ELSE
        -- Si ya hay PK, corregir únicamente las filas con id 0.
        SELECT COUNT(*) INTO v_hay FROM herramientas WHERE herramienta_id = 0;
        IF v_hay > 0 THEN
            SET @n := (SELECT COALESCE(MAX(herramienta_id), 0) FROM herramientas);
            UPDATE herramientas SET herramienta_id = (@n := @n + 1) WHERE herramienta_id = 0;
        END IF;
    END IF;

    -- 8.2) herramientas: índices.
    SELECT COUNT(*) INTO v_existe
    FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'herramientas' AND INDEX_NAME = 'uq_herramientas_codigo';

    IF v_existe = 0 THEN
        SELECT COUNT(*) INTO v_hay
        FROM (SELECT codigo FROM herramientas GROUP BY codigo HAVING COUNT(*) > 1) d;

        IF v_hay = 0 THEN
            ALTER TABLE herramientas ADD UNIQUE KEY uq_herramientas_codigo (codigo);
        ELSE
            SELECT CONCAT('Aviso: no se creó uq_herramientas_codigo, hay ', v_hay, ' códigos duplicados.') AS aviso;
        END IF;
    END IF;

    SELECT COUNT(*) INTO v_existe
    FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'herramientas' AND INDEX_NAME = 'idx_herramientas_nombre';

    IF v_existe = 0 THEN
        ALTER TABLE herramientas ADD KEY idx_herramientas_nombre (nombre);
    END IF;

    SELECT COUNT(*) INTO v_existe
    FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'herramientas' AND INDEX_NAME = 'idx_herramientas_estado';

    IF v_existe = 0 THEN
        ALTER TABLE herramientas ADD KEY idx_herramientas_estado (estado);
    END IF;

    -- 8.3) movimientos_inventario: limpiar filas huérfanas (producto ya eliminado)
    --      para poder crear la llave foránea.
    DELETE m FROM movimientos_inventario m
    LEFT JOIN productos p ON p.producto_id = m.producto_id
    WHERE p.producto_id IS NULL;

    -- 8.4) movimientos_inventario: PK + AUTO_INCREMENT en movimiento_id.
    SELECT COUNT(*) INTO v_existe
    FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'movimientos_inventario' AND INDEX_NAME = 'PRIMARY';

    IF v_existe = 0 THEN
        -- Renumerar todas las filas porque sin PK los IDs pueden estar repetidos o en cero.
        SET @m := 0;
        UPDATE movimientos_inventario
        SET movimiento_id = (@m := @m + 1)
        ORDER BY creado_en, producto_id, tipo;

        ALTER TABLE movimientos_inventario
            MODIFY COLUMN movimiento_id INT UNSIGNED NOT NULL AUTO_INCREMENT,
            ADD PRIMARY KEY (movimiento_id);
    ELSE
        SELECT COUNT(*) INTO v_hay FROM movimientos_inventario WHERE movimiento_id = 0;
        IF v_hay > 0 THEN
            SET @m := (SELECT COALESCE(MAX(movimiento_id), 0) FROM movimientos_inventario);
            UPDATE movimientos_inventario SET movimiento_id = (@m := @m + 1) WHERE movimiento_id = 0;
        END IF;
    END IF;

    -- 8.5) movimientos_inventario: índices y llave foránea.
    SELECT COUNT(*) INTO v_existe
    FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'movimientos_inventario' AND INDEX_NAME = 'idx_movimientos_producto';

    IF v_existe = 0 THEN
        ALTER TABLE movimientos_inventario ADD KEY idx_movimientos_producto (producto_id);
    END IF;

    SELECT COUNT(*) INTO v_existe
    FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'movimientos_inventario' AND INDEX_NAME = 'idx_movimientos_fecha';

    IF v_existe = 0 THEN
        ALTER TABLE movimientos_inventario ADD KEY idx_movimientos_fecha (creado_en);
    END IF;

    SELECT COUNT(*) INTO v_existe
    FROM information_schema.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = DATABASE()
      AND TABLE_NAME = 'movimientos_inventario'
      AND CONSTRAINT_NAME = 'fk_movimientos_producto'
      AND CONSTRAINT_TYPE = 'FOREIGN KEY';

    IF v_existe = 0 THEN
        ALTER TABLE movimientos_inventario
            ADD CONSTRAINT fk_movimientos_producto
            FOREIGN KEY (producto_id) REFERENCES productos (producto_id)
            ON DELETE CASCADE;
    END IF;
END$$
DELIMITER ;

CALL reparar_esquema_wms();
DROP PROCEDURE IF EXISTS reparar_esquema_wms;
