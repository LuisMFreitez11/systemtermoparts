-- ============================================================================
-- WMS Termo Part - Idempotencia de escrituras (Supabase / PostgreSQL)
-- ----------------------------------------------------------------------------
-- Permite que la cola offline reintente operaciones sin duplicar consumos,
-- entradas, ajustes ni movimientos. Cada escritura del cliente lleva una
-- cabecera X-Idempotency-Key única.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.operaciones_idempotencia (
    clave         VARCHAR(120) PRIMARY KEY,
    huella        CHAR(64) NOT NULL,
    endpoint      VARCHAR(120) NOT NULL,
    usuario_id    INTEGER NULL,
    estado        VARCHAR(20) NOT NULL DEFAULT 'EN_PROCESO',
    codigo_http   SMALLINT NOT NULL DEFAULT 200,
    respuesta     TEXT NULL,
    creado_en     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    actualizado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_idempotencia_actualizado
    ON public.operaciones_idempotencia (actualizado_en);

COMMENT ON TABLE public.operaciones_idempotencia IS
    'Registro de operaciones de escritura idempotentes del WMS.';
