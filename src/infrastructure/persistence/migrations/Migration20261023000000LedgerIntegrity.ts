import { Migration } from '@mikro-orm/migrations';

/**
 * Closes two raw-SQL gaps left by the initial schema:
 *
 * 1. balance == ledger was only checked when the wallet row changed, so a
 *    ledger entry inserted without touching the wallet could commit. The same
 *    deferred check now also runs for every new ledger entry.
 * 2. Ownership and currency were not tied together: a ledger entry could point
 *    to another wallet's transaction or carry a different currency, and a
 *    PROCESSED transaction could carry a currency other than its wallet's.
 *    (A REJECTED one may: CURRENCY_MISMATCH is stored as such for audit.)
 *
 * Note: knex treats `?` as a binding placeholder, so this SQL must not contain one.
 */
export class Migration20261023000000LedgerIntegrity extends Migration {
  override async up(): Promise<void> {
    // ------------------------------------------------- ownership and currency
    this.addSql(`ALTER TABLE wallets ADD CONSTRAINT uq_wallets_id_currency UNIQUE (id, currency);`);
    this.addSql(`ALTER TABLE wager_transactions ADD CONSTRAINT uq_tx_id_wallet UNIQUE (id, wallet_id);`);
    this.addSql(`
      ALTER TABLE wallet_ledger_entries
        ADD CONSTRAINT fk_ledger_wallet_currency
          FOREIGN KEY (wallet_id, currency) REFERENCES wallets (id, currency),
        ADD CONSTRAINT fk_ledger_tx_wallet
          FOREIGN KEY (transaction_id, wallet_id) REFERENCES wager_transactions (id, wallet_id);
    `);

    this.addSql(`
      CREATE FUNCTION assert_processed_tx_currency() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE
        wallet_currency char(3);
      BEGIN
        IF NEW.status = 'PROCESSED' THEN
          SELECT currency INTO wallet_currency FROM wallets WHERE id = NEW.wallet_id;
          IF NEW.currency <> wallet_currency THEN
            RAISE EXCEPTION 'processed transaction % is in % but wallet % is in %',
              NEW.id, NEW.currency, NEW.wallet_id, wallet_currency USING ERRCODE = 'check_violation';
          END IF;
        END IF;
        RETURN NEW;
      END $$;
    `);
    this.addSql(`
      CREATE TRIGGER trg_tx_currency BEFORE INSERT OR UPDATE OF status ON wager_transactions
        FOR EACH ROW EXECUTE FUNCTION assert_processed_tx_currency();
    `);

    // ------------------------------------------- ledger entries at commit time
    // Deferred, because a pending transaction is promoted to PROCESSED in the
    // same unit of work and the ORM may flush the entry first.
    this.addSql(`
      CREATE FUNCTION assert_ledger_entry_settled() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE
        stored    numeric(20,2);
        ledger    numeric(20,2);
        tx_status varchar(32);
      BEGIN
        SELECT status INTO tx_status FROM wager_transactions WHERE id = NEW.transaction_id;
        IF tx_status <> 'PROCESSED' THEN
          RAISE EXCEPTION 'ledger entry % points to transaction % in status %', NEW.id, NEW.transaction_id, tx_status
            USING ERRCODE = 'check_violation';
        END IF;

        SELECT balance_amount INTO stored FROM wallets WHERE id = NEW.wallet_id;
        SELECT balance_after INTO ledger
          FROM wallet_ledger_entries
         WHERE wallet_id = NEW.wallet_id
         ORDER BY seq DESC
         LIMIT 1;
        IF stored <> ledger THEN
          RAISE EXCEPTION 'wallet % balance % does not match ledger %', NEW.wallet_id, stored, ledger
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN NULL;
      END $$;
    `);
    this.addSql(`
      CREATE CONSTRAINT TRIGGER trg_ledger_matches_wallet AFTER INSERT ON wallet_ledger_entries
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION assert_ledger_entry_settled();
    `);
  }

  override async down(): Promise<void> {
    this.addSql('DROP TRIGGER IF EXISTS trg_ledger_matches_wallet ON wallet_ledger_entries;');
    this.addSql('DROP FUNCTION IF EXISTS assert_ledger_entry_settled();');
    this.addSql('DROP TRIGGER IF EXISTS trg_tx_currency ON wager_transactions;');
    this.addSql('DROP FUNCTION IF EXISTS assert_processed_tx_currency();');
    this.addSql(`
      ALTER TABLE wallet_ledger_entries
        DROP CONSTRAINT IF EXISTS fk_ledger_tx_wallet,
        DROP CONSTRAINT IF EXISTS fk_ledger_wallet_currency;
    `);
    this.addSql('ALTER TABLE wager_transactions DROP CONSTRAINT IF EXISTS uq_tx_id_wallet;');
    this.addSql('ALTER TABLE wallets DROP CONSTRAINT IF EXISTS uq_wallets_id_currency;');
  }
}
