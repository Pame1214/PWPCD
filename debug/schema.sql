BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;

CREATE TABLE IF NOT EXISTS public.debug_registros (
  id BIGSERIAL PRIMARY KEY,
  mensagem TEXT NOT NULL,
  origem TEXT,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.app_users (
  id BIGSERIAL PRIMARY KEY,
  username VARCHAR(80) NOT NULL UNIQUE,
  password_hash TEXT,
  legacy_password TEXT,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT app_users_one_password CHECK (password_hash IS NOT NULL OR legacy_password IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS public.app_sessions (
  token TEXT PRIMARY KEY,
  username VARCHAR(80) NOT NULL,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS app_sessions_expires_at_idx ON public.app_sessions (expires_at);

COMMIT;
