-- ============================================================================
-- WMS Termo Part - Idempotencia de escrituras (MariaDB)
-- ============================================================================

CREATE TABLE IF NOT EXISTS operaciones_idempotencia (
    clave          VARCHAR(120) NOT NULL,
    huella         CHAR(64) NOT NULL,
    endpoint       VARCHAR(120) NOT NULL,
    usuario_id     INT NULL,
    estado         VARCHAR(20) NOT NULL DEFAULT 'EN_PROCESO',
    codigo_http    SMALLINT NOT NULL DEFAULT 200,
    respuesta      MEDIUMTEXT NULL,
    creado_en      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    actualizado_en DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (clave),
    KEY idx_idempotencia_actualizado (actualizado_en)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
