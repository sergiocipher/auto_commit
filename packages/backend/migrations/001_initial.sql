-- Initial schema. Timestamps that core reasons about (submittedAt,
-- nextAttemptAt, ...) are epoch milliseconds (bigint) so rows map 1:1 to
-- core's UploadJob; bookkeeping columns use timestamptz.

CREATE TABLE users (
  id          text PRIMARY KEY,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- One row per paired browser install. Only the SHA-256 of the bearer token is stored.
CREATE TABLE installs (
  id            uuid PRIMARY KEY,
  user_id       text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name          text NOT NULL,
  token_hash    text NOT NULL UNIQUE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz
);

-- Short-lived one-time pairing codes, stored hashed.
CREATE TABLE pairing_codes (
  code_hash   text PRIMARY KEY,
  user_id     text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz
);

CREATE TABLE settings (
  user_id     text PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  data        jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- GitHub token sealed with AES-256-GCM (key_id names the key for rotation).
CREATE TABLE github_connections (
  user_id           text PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  key_id            text NOT NULL,
  token_ciphertext  text NOT NULL,
  scopes            text[] NOT NULL DEFAULT '{}',
  login             text NOT NULL,
  connected_at      bigint NOT NULL
);

-- In-progress device flow; the device code is sealed like the token.
CREATE TABLE github_device_pending (
  user_id          text PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  key_id           text NOT NULL,
  data_ciphertext  text NOT NULL,
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- What the platform reported. Source code lives on the job (and is purged).
CREATE TABLE submissions (
  id                   uuid PRIMARY KEY,
  user_id              text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  platform             text NOT NULL CHECK (platform IN ('leetcode', 'codeforces', 'codechef')),
  submission_id        text NOT NULL,
  problem_key          text NOT NULL,
  problem_slug         text NOT NULL,
  problem_id           text,
  problem_title        text NOT NULL,
  problem_url          text NOT NULL,
  language             text NOT NULL,
  language_normalized  text,
  verdict              text NOT NULL,
  source_sha256        text NOT NULL,
  submitted_at         bigint NOT NULL,
  detected_at          bigint NOT NULL,
  contest              jsonb,
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (platform, submission_id)
);

CREATE TABLE upload_jobs (
  id                  text PRIMARY KEY,
  user_id             text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  submission_row_id   uuid NOT NULL UNIQUE REFERENCES submissions (id) ON DELETE CASCADE,
  platform            text NOT NULL,
  submission_id       text NOT NULL,
  problem_key         text NOT NULL,
  problem_title       text NOT NULL,
  language            text NOT NULL,
  submitted_at        bigint NOT NULL,
  status              text NOT NULL CHECK (status IN (
                        'RECEIVED', 'SKIPPED_DUPLICATE', 'SKIPPED_NOT_ELIGIBLE', 'HELD',
                        'QUEUED', 'UPLOADING', 'RETRYING', 'SUCCESS', 'FAILED_PERMANENT',
                        'NEEDS_AUTH')),
  attempts            integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  force               boolean NOT NULL DEFAULT false,
  next_attempt_at     bigint,
  repository          text,
  branch              text,
  file_path           text,
  commit_message      text,
  commit_sha          text,
  uploaded_at         bigint,
  last_error          text,
  source_code         text,
  reservation_bucket  text,
  created_at          bigint NOT NULL,
  updated_at          bigint NOT NULL,
  UNIQUE (platform, submission_id)
);

CREATE INDEX upload_jobs_problem ON upload_jobs (user_id, platform, problem_key);
CREATE INDEX upload_jobs_active ON upload_jobs (status, next_attempt_at)
  WHERE status IN ('QUEUED', 'UPLOADING', 'RETRYING');
CREATE INDEX upload_jobs_created ON upload_jobs (user_id, created_at DESC);

-- At most one active reservation per problem and window bucket (calendar
-- and permanent policies). Backs up the advisory lock taken in ingest.
CREATE UNIQUE INDEX upload_jobs_one_reservation
  ON upload_jobs (user_id, platform, problem_key, reservation_bucket)
  WHERE reservation_bucket IS NOT NULL
    AND status IN ('RECEIVED', 'QUEUED', 'UPLOADING', 'RETRYING', 'NEEDS_AUTH');
