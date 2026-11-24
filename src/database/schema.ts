/**
 * PostgreSQL sxemasi — Mongo kolleksiyalaridan ko'chirilgan.
 *
 * Nega .sql fayl emas: TypeScript bu matnni dist ichiga o'zi olib o'tadi.
 * Alohida fayl bo'lsa, uni build vaqtida nusxalash va ishlash vaqtida yo'lini
 * topish kerak bo'ladi — Railway'da ikkisi ham sezilmasdan buziladigan joy.
 *
 * Qoidalar:
 *   · birlamchi kalit nomi "_id" — kodda 69 joyda ._id ishlatiladi
 *   · Mongo'dagi Mixed va ichki hujjatlar -> jsonb
 *   · [String] / [Number] massivlari -> Postgres massivlari
 *   · hamma buyruq IF NOT EXISTS: har ishga tushishda xavfsiz bajariladi
 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS leads (
  "_id"                  TEXT PRIMARY KEY,
  "businessConnectionId" TEXT        NOT NULL,
  "chatId"               BIGINT      NOT NULL,
  "telegramId"           BIGINT      NOT NULL,
  "username"             TEXT,
  "firstName"            TEXT,
  "lastName"             TEXT,
  "name"                 TEXT,
  "language"             TEXT        NOT NULL DEFAULT 'uz',
  "uzScript"             TEXT        NOT NULL DEFAULT 'latn',
  "source"               TEXT        NOT NULL DEFAULT 'unknown',
  "sourceRaw"            TEXT,
  "answers"              JSONB       NOT NULL DEFAULT '{}'::jsonb,
  "bmi"                  DOUBLE PRECISION,
  "targetBmi"            DOUBLE PRECISION,
  "currentQuestion"      INTEGER     NOT NULL DEFAULT 1,
  "intent"               TEXT,
  "alwaysOn"             BOOLEAN     NOT NULL DEFAULT FALSE,
  "lastAskedStep"        INTEGER,
  "askCount"             INTEGER     NOT NULL DEFAULT 0,
  "skippedSteps"         INTEGER[]   NOT NULL DEFAULT '{}',
  "status"               TEXT        NOT NULL DEFAULT 'NEW',
  "mode"                 TEXT        NOT NULL DEFAULT 'AI',
  "urgent"               BOOLEAN     NOT NULL DEFAULT FALSE,
  "readyReason"          TEXT,
  "summary"              TEXT,
  "summaryMessageCount"  INTEGER     NOT NULL DEFAULT 0,
  "notes"                TEXT,
  "remindersSent"        INTEGER     NOT NULL DEFAULT 0,
  "pendingSince"         TIMESTAMPTZ,
  "aiFailures"           INTEGER     NOT NULL DEFAULT 0,
  "aiFailureNotifiedAt"  TIMESTAMPTZ,
  "adminCardMessageIds"  JSONB       NOT NULL DEFAULT '[]'::jsonb,
  "lastClientMessageAt"  TIMESTAMPTZ,
  "lastOutgoingAt"       TIMESTAMPTZ,
  "readyAt"              TIMESTAMPTZ,
  "answeredAt"           TIMESTAMPTZ,
  "paidAt"               TIMESTAMPTZ,
  "rejectedAt"           TIMESTAMPTZ,
  "createdAt"            TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt"            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS leads_conn_chat ON leads ("businessConnectionId", "chatId");
CREATE        INDEX IF NOT EXISTS leads_telegram  ON leads ("telegramId");
CREATE        INDEX IF NOT EXISTS leads_source    ON leads ("source");
CREATE        INDEX IF NOT EXISTS leads_status    ON leads ("status");
CREATE        INDEX IF NOT EXISTS leads_queue     ON leads ("status", "mode", "lastClientMessageAt");

CREATE TABLE IF NOT EXISTS messages (
  "_id"                TEXT PRIMARY KEY,
  "leadId"             TEXT        NOT NULL REFERENCES leads("_id") ON DELETE CASCADE,
  "telegramMessageId"  BIGINT,
  "telegramId"         BIGINT,
  "direction"          TEXT        NOT NULL,
  "sender"             TEXT        NOT NULL,
  "kind"               TEXT        NOT NULL DEFAULT 'text',
  "text"               TEXT        NOT NULL DEFAULT '',
  "processed"          BOOLEAN     NOT NULL DEFAULT TRUE,
  "meta"               JSONB,
  "createdAt"          TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt"          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS messages_lead_created ON messages ("leadId", "createdAt");

-- Takroriy Telegram update'larini filtrlash. Mongo'da TTL indeks bor edi;
-- Postgres'da TTL yo'q, shuning uchun eskisini fon ishi tozalaydi.
CREATE TABLE IF NOT EXISTS processed_updates (
  "_id"       TEXT PRIMARY KEY,
  "key"       TEXT        NOT NULL UNIQUE,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS processed_updates_created ON processed_updates ("createdAt");

CREATE TABLE IF NOT EXISTS business_connections (
  "_id"          TEXT PRIMARY KEY,
  "connectionId" TEXT        NOT NULL UNIQUE,
  "userId"       BIGINT      NOT NULL,
  "userChatId"   BIGINT,
  "isEnabled"    BOOLEAN     NOT NULL DEFAULT TRUE,
  "canReply"     BOOLEAN     NOT NULL DEFAULT TRUE,
  "createdAt"    TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt"    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS settings (
  "_id"       TEXT PRIMARY KEY,
  "values"    JSONB       NOT NULL DEFAULT '{}'::jsonb,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS style_examples (
  "_id"       TEXT PRIMARY KEY,
  "client"    TEXT        NOT NULL,
  "coach"     TEXT[]      NOT NULL DEFAULT '{}',
  "language"  TEXT        NOT NULL DEFAULT 'uz',
  "tokens"    TEXT[]      NOT NULL DEFAULT '{}',
  "source"    TEXT        NOT NULL DEFAULT 'import',
  "enabled"   BOOLEAN     NOT NULL DEFAULT TRUE,
  "kind"      TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS style_examples_enabled ON style_examples ("enabled");

CREATE TABLE IF NOT EXISTS style_profiles (
  "_id"          TEXT PRIMARY KEY,
  "profile"      JSONB       NOT NULL,
  "stats"        JSONB,
  "exampleCount" INTEGER,
  "active"       BOOLEAN     NOT NULL DEFAULT TRUE,
  "createdAt"    TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt"    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS campaigns (
  "_id"         TEXT PRIMARY KEY,
  "code"        TEXT        NOT NULL UNIQUE,
  "source"      TEXT        NOT NULL,
  "description" TEXT,
  "createdAt"   TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt"   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS reminders (
  "_id"    TEXT PRIMARY KEY,
  "leadId" TEXT        NOT NULL REFERENCES leads("_id") ON DELETE CASCADE,
  "number" INTEGER     NOT NULL,
  "sentAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "text"   TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS reminders_lead_number ON reminders ("leadId", "number");

CREATE TABLE IF NOT EXISTS admin_events (
  "_id"       TEXT PRIMARY KEY,
  "type"      TEXT        NOT NULL,
  "leadId"    TEXT,
  "actorId"   BIGINT,
  "data"      JSONB,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS admin_events_created ON admin_events ("createdAt");
`;

/** Jadvallar ro'yxati — testlar har sinovdan oldin tozalashi uchun. */
export const TABLES = [
  'messages',
  'reminders',
  'admin_events',
  'leads',
  'processed_updates',
  'business_connections',
  'settings',
  'style_examples',
  'style_profiles',
  'campaigns',
] as const;
