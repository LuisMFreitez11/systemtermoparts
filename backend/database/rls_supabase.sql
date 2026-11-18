-- ============================================================================
-- WMS Termo Part - Row Level Security (Supabase / PostgreSQL)
-- ----------------------------------------------------------------------------
-- Estrategia: deny-by-default.
--
--   * Se activa RLS en todas las tablas de public.
--   * NO se crean políticas para anon ni para authenticated.
--   * Se revocan todos los privilegios de anon/authenticated.
--
-- El backend PHP se conecta con el rol propietario (postgres.<proyecto>) que es
-- dueño de las tablas y, por tanto, no queda bloqueado por RLS. La API pública
-- de Supabase (PostgREST con anon key) queda totalmente cerrada.
--
-- Importante: NO usar "FORCE ROW LEVEL SECURITY" porque también aplicaría RLS
-- al propietario y rompería el backend.
-- ============================================================================

BEGIN;

-- 1) Activar RLS tabla por tabla.
ALTER TABLE public.productos               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.movimientos_inventario  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.herramientas            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.activos                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.activo_materiales       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.usuarios                ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.historial_usuario       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.herramientas_movimientos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.entradas_almacen        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.materiales_danados      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tomas_fisicas           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.toma_fisica_detalle     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.operaciones_idempotencia ENABLE ROW LEVEL SECURITY;

-- 2) Revocar accesos públicos (anon = visitante, authenticated = usuario Supabase).
REVOKE ALL ON SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anon, authenticated;

-- 3) Que las tablas futuras también nazcan cerradas.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;

COMMIT;

-- 4) Verificación: todas deben mostrar rowsecurity = true.
-- SELECT tablename, rowsecurity
-- FROM pg_tables
-- WHERE schemaname = 'public'
-- ORDER BY tablename;
