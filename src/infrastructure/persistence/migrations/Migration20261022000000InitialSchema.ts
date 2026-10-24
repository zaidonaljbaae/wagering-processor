import { Migration } from '@mikro-orm/migrations';

/**
 * Initial schema. The guarantees from the challenge (uniqueness, ledger
 * immutability, non-negative balances, balance == ledger) are enforced here,
 * so a bug in application code fails loudly instead of corrupting money.
 *
 * Note: knex treats `?` as a binding placeholder, so this SQL must not contain one.
 */
export class Migration20261022000000InitialSchema extends Migration {
  override async up(): Promise<void> {
    // ------------------------------------------------------------------ wallets
    this.addSql(`
      CREATE TABLE wallets (
        id              uuid          PRIMARY KEY,
        player_id       uuid          NOT NULL,
        currency        char(3)       NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
        balance_amount  numeric(20,2) NOT NULL CHECK (balance_amount >= 0),
        version         integer       NOT NULL CHECK (version >= 1),
        created_at      timestamptz   NOT NULL,
        updated_at      timestamptz   NOT NULL,
        CONSTRAINT uq_wallets_player_currency UNIQUE (player_id, currency)
      );
    `);

    // ------------------------------------------------------- wager_transactions
    this.addSql(`
      CREATE TABLE wager_transactions (
        id                                uuid          PRIMARY KEY,
        provider_id                       varchar(64)   NOT NULL,
        external_transaction_id           varchar(128)  NOT NULL,
        idempotency_key                   varchar(255)  NOT NULL,
        payload_hash                      char(64)      NOT NULL,
        wallet_id                         uuid          NOT NULL REFERENCES wallets(id),
        player_id                         uuid          NOT NULL,
        round_id                          varchar(128),
        game_id                           varchar(128),
        kind                              varchar(16)   NOT NULL
          CHECK (kind IN ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
        amount                            numeric(20,2) NOT NULL CHECK (amount >= 0),
        currency                          char(3)       NOT NULL,
        reference_external_transaction_id varchar(128),
        reference_transaction_id          uuid          REFERENCES wager_transactions(id),
        status                            varchar(32)   NOT NULL
          CHECK (status IN ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
        failure_code                      varchar(64),
        balance_after_amount              numeric(20,2) CHECK (balance_after_amount >= 0),
        attempts                          integer       NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        next_attempt_at                   timestamptz,
        created_at                        timestamptz   NOT NULL,
        updated_at                        timestamptz   NOT NULL,
        processed_at                      timestamptz,

        CONSTRAINT uq_tx_idempotency UNIQUE (provider_id, idempotency_key),
        CONSTRAINT uq_tx_external    UNIQUE (provider_id, external_transaction_id),
        CONSTRAINT ck_tx_round_required
          CHECK (kind = 'OPENING' OR (round_id IS NOT NULL AND game_id IS NOT NULL)),
        CONSTRAINT ck_tx_reference_required
          CHECK (kind NOT IN ('REFUND','ROLLBACK') OR reference_external_transaction_id IS NOT NULL),
        CONSTRAINT ck_tx_bet_has_no_reference
          CHECK (kind <> 'BET' OR reference_external_transaction_id IS NULL),
        CONSTRAINT ck_tx_positive_amount CHECK (kind = 'LOSS' OR amount > 0),
        CONSTRAINT ck_tx_failure_code
          CHECK ((status IN ('REJECTED','FAILED')) = (failure_code IS NOT NULL)),
        CONSTRAINT ck_tx_processed_at
          CHECK ((status = 'PROCESSED') = (processed_at IS NOT NULL)),
        CONSTRAINT ck_tx_pending_schedule
          CHECK (status <> 'PENDING_REFERENCE' OR next_attempt_at IS NOT NULL)
      );
    `);

    // A referenced transaction can be reversed at most once, whatever the kind
    // of reversal (REFUND + ROLLBACK of the same BET would credit it twice).
    this.addSql(`
      CREATE UNIQUE INDEX uq_tx_single_reversal
        ON wager_transactions (reference_transaction_id)
        WHERE kind IN ('REFUND','ROLLBACK') AND status = 'PROCESSED';
    `);
    this.addSql(`
      CREATE INDEX ix_tx_pending_reference
        ON wager_transactions (next_attempt_at)
        WHERE status = 'PENDING_REFERENCE';
    `);
    this.addSql(`CREATE INDEX ix_tx_wallet ON wager_transactions (wallet_id);`);

    // ---------------------------------------------------- wallet_ledger_entries
    this.addSql(`
      CREATE TABLE wallet_ledger_entries (
        id              uuid          PRIMARY KEY,
        seq             bigint        GENERATED ALWAYS AS IDENTITY UNIQUE,
        wallet_id       uuid          NOT NULL REFERENCES wallets(id),
        transaction_id  uuid          NOT NULL REFERENCES wager_transactions(id),
        direction       varchar(6)    NOT NULL CHECK (direction IN ('DEBIT','CREDIT')),
        amount          numeric(20,2) NOT NULL CHECK (amount > 0),
        currency        char(3)       NOT NULL,
        balance_before  numeric(20,2) NOT NULL CHECK (balance_before >= 0),
        balance_after   numeric(20,2) NOT NULL CHECK (balance_after >= 0),
        created_at      timestamptz   NOT NULL,
        CONSTRAINT uq_ledger_wallet_tx UNIQUE (wallet_id, transaction_id),
        CONSTRAINT ck_ledger_arithmetic CHECK (
             (direction = 'CREDIT' AND balance_after = balance_before + amount)
          OR (direction = 'DEBIT'  AND balance_after = balance_before - amount))
      );
    `);
    this.addSql(`CREATE INDEX ix_ledger_wallet_seq ON wallet_ledger_entries (wallet_id, seq);`);

    // ------------------------------------------------------------ inbox/outbox
    this.addSql(`
      CREATE TABLE inbox_messages (
        consumer_name varchar(64)  NOT NULL,
        message_id    varchar(128) NOT NULL,
        payload_hash  char(64)     NOT NULL,
        received_at   timestamptz  NOT NULL,
        processed_at  timestamptz,
        PRIMARY KEY (consumer_name, message_id)
      );
    `);
    this.addSql(`
      CREATE TABLE outbox_messages (
        id              uuid         PRIMARY KEY,
        aggregate_id    uuid         NOT NULL,
        event_type      varchar(64)  NOT NULL,
        payload         jsonb        NOT NULL,
        occurred_at     timestamptz  NOT NULL,
        attempts        integer      NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        next_attempt_at timestamptz  NOT NULL,
        locked_until    timestamptz,
        published_at    timestamptz,
        last_error      varchar(512)
      );
    `);
    this.addSql(`
      CREATE INDEX ix_outbox_due ON outbox_messages (next_attempt_at) WHERE published_at IS NULL;
    `);

    // ---------------------------------------------------------------- triggers
    this.addSql(`
      CREATE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION '% on % is not allowed', TG_OP, TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
      END $$;
    `);

    // Ledger is append-only.
    this.addSql(`
      CREATE TRIGGER trg_ledger_append_only BEFORE UPDATE OR DELETE ON wallet_ledger_entries
        FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
    `);
    this.addSql(`
      CREATE TRIGGER trg_ledger_no_truncate BEFORE TRUNCATE ON wallet_ledger_entries
        FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
    `);

    // Ledger is a chain: each entry starts where the previous one ended.
    this.addSql(`
      CREATE FUNCTION assert_ledger_chain() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE
        previous numeric(20,2);
      BEGIN
        SELECT balance_after INTO previous
          FROM wallet_ledger_entries
         WHERE wallet_id = NEW.wallet_id
         ORDER BY seq DESC
         LIMIT 1;
        IF COALESCE(previous, 0) <> NEW.balance_before THEN
          RAISE EXCEPTION 'ledger chain broken for wallet %: previous balance %, entry starts at %',
            NEW.wallet_id, COALESCE(previous, 0), NEW.balance_before USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END $$;
    `);
    this.addSql(`
      CREATE TRIGGER trg_ledger_chain BEFORE INSERT ON wallet_ledger_entries
        FOR EACH ROW EXECUTE FUNCTION assert_ledger_chain();
    `);

    // Wallets: identity is immutable, rows are never deleted, and a balance
    // change must bump the version by exactly one.
    this.addSql(`
      CREATE FUNCTION guard_wallet_update() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.id <> OLD.id OR NEW.player_id <> OLD.player_id OR NEW.currency <> OLD.currency
           OR NEW.created_at <> OLD.created_at THEN
          RAISE EXCEPTION 'wallet identity columns are immutable' USING ERRCODE = 'restrict_violation';
        END IF;
        IF NEW.balance_amount <> OLD.balance_amount AND NEW.version <> OLD.version + 1 THEN
          RAISE EXCEPTION 'wallet % balance changed without a version bump', NEW.id USING ERRCODE = 'check_violation';
        END IF;
        IF NEW.balance_amount = OLD.balance_amount AND NEW.version <> OLD.version THEN
          RAISE EXCEPTION 'wallet % version changed without a balance change', NEW.id USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END $$;
    `);
    this.addSql(`
      CREATE TRIGGER trg_wallet_guard BEFORE UPDATE ON wallets
        FOR EACH ROW EXECUTE FUNCTION guard_wallet_update();
    `);
    this.addSql(`
      CREATE TRIGGER trg_wallet_no_delete BEFORE DELETE ON wallets
        FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
    `);

    // At commit time the stored balance must equal the last ledger balance.
    // Deferred so the wallet, transaction and ledger rows can be written in any order.
    this.addSql(`
      CREATE FUNCTION assert_wallet_matches_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE
        stored numeric(20,2);
        ledger numeric(20,2);
      BEGIN
        SELECT balance_amount INTO stored FROM wallets WHERE id = NEW.id;
        SELECT balance_after INTO ledger
          FROM wallet_ledger_entries
         WHERE wallet_id = NEW.id
         ORDER BY seq DESC
         LIMIT 1;
        IF stored <> COALESCE(ledger, 0) THEN
          RAISE EXCEPTION 'wallet % balance % does not match ledger %', NEW.id, stored, COALESCE(ledger, 0)
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN NULL;
      END $$;
    `);
    this.addSql(`
      CREATE CONSTRAINT TRIGGER trg_wallet_matches_ledger AFTER INSERT OR UPDATE ON wallets
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION assert_wallet_matches_ledger();
    `);

    // Transactions: business columns are immutable, terminal rows are frozen,
    // nothing is ever deleted.
    this.addSql(`
      CREATE FUNCTION guard_wager_transaction_update() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.status IN ('PROCESSED','REJECTED','FAILED') THEN
          RAISE EXCEPTION 'transaction % is terminal (%)', OLD.id, OLD.status USING ERRCODE = 'restrict_violation';
        END IF;
        IF ROW(NEW.id, NEW.provider_id, NEW.external_transaction_id, NEW.idempotency_key, NEW.payload_hash,
               NEW.wallet_id, NEW.player_id, NEW.round_id, NEW.game_id, NEW.kind, NEW.amount, NEW.currency,
               NEW.reference_external_transaction_id, NEW.created_at)
           IS DISTINCT FROM
           ROW(OLD.id, OLD.provider_id, OLD.external_transaction_id, OLD.idempotency_key, OLD.payload_hash,
               OLD.wallet_id, OLD.player_id, OLD.round_id, OLD.game_id, OLD.kind, OLD.amount, OLD.currency,
               OLD.reference_external_transaction_id, OLD.created_at) THEN
          RAISE EXCEPTION 'transaction % business columns are immutable', OLD.id USING ERRCODE = 'restrict_violation';
        END IF;
        RETURN NEW;
      END $$;
    `);
    this.addSql(`
      CREATE TRIGGER trg_tx_guard BEFORE UPDATE ON wager_transactions
        FOR EACH ROW EXECUTE FUNCTION guard_wager_transaction_update();
    `);
    this.addSql(`
      CREATE TRIGGER trg_tx_no_delete BEFORE DELETE ON wager_transactions
        FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
    `);
  }

  override async down(): Promise<void> {
    this.addSql('DROP TABLE IF EXISTS outbox_messages;');
    this.addSql('DROP TABLE IF EXISTS inbox_messages;');
    this.addSql('DROP TABLE IF EXISTS wallet_ledger_entries;');
    this.addSql('DROP TABLE IF EXISTS wager_transactions;');
    this.addSql('DROP TABLE IF EXISTS wallets;');
    this.addSql('DROP FUNCTION IF EXISTS guard_wager_transaction_update();');
    this.addSql('DROP FUNCTION IF EXISTS assert_wallet_matches_ledger();');
    this.addSql('DROP FUNCTION IF EXISTS guard_wallet_update();');
    this.addSql('DROP FUNCTION IF EXISTS assert_ledger_chain();');
    this.addSql('DROP FUNCTION IF EXISTS forbid_mutation();');
  }
}
