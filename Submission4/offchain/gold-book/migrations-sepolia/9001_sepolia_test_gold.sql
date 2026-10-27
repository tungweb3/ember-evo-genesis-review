-- SEPOLIA REHEARSAL BOOK ONLY. migrations-sepolia/ is the production migrations/ (byte for byte, tests check it) plus
-- this file, applied only to the imd-world-gold-sepolia D1 of wrangler.gold-sepolia.jsonc. Never copy it into
-- migrations/: the production book has no way to create GOLD except paid top-ups, rewards and refunds.
--
-- A fresh database starts with every control enabled (0014). The rehearsal book only holds GOLD for Genesis mints.
UPDATE world_gold_controls SET enabled=0,version=version+1 WHERE feature IN ('topup','service');
-- Test GOLD: only for listed test wallets, each grant carrying a source and a batch, at most `cap` per wallet in total,
-- immutable once written. The balance moves only through the AFTER INSERT trigger, like every other GOLD journal.
CREATE TABLE test_gold_wallets (
 wallet TEXT PRIMARY KEY CHECK(length(wallet)=42 AND wallet GLOB '0x*' AND wallet=lower(wallet) AND substr(wallet,3) NOT GLOB '*[^0-9a-f]*'),
 cap INTEGER NOT NULL CHECK(typeof(cap)='integer' AND cap>0 AND cap<=1000000),
 note TEXT NOT NULL CHECK(length(note) BETWEEN 3 AND 200),
 created_ms INTEGER NOT NULL CHECK(typeof(created_ms)='integer' AND created_ms>0)
);
CREATE TABLE test_gold_grants (
 id TEXT PRIMARY KEY,
 batch TEXT NOT NULL CHECK(length(batch) BETWEEN 3 AND 64),
 wallet TEXT NOT NULL REFERENCES test_gold_wallets(wallet),
 amount INTEGER NOT NULL CHECK(typeof(amount)='integer' AND amount>0),
 source TEXT NOT NULL CHECK(length(source) BETWEEN 3 AND 200),
 created_ms INTEGER NOT NULL CHECK(typeof(created_ms)='integer' AND created_ms>0),
 CHECK(id=batch||':'||wallet)
);
-- BEFORE INSERT fires even for a row ON CONFLICT DO NOTHING will skip, so a re-run of a seed file is exempt here.
CREATE TRIGGER test_gold_grant_cap BEFORE INSERT ON test_gold_grants WHEN NOT EXISTS(SELECT 1 FROM test_gold_grants WHERE id=NEW.id) BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM test_gold_wallets WHERE wallet=NEW.wallet) THEN RAISE(ABORT,'TEST_GOLD_WALLET_UNLISTED')
  WHEN COALESCE((SELECT SUM(amount) FROM test_gold_grants WHERE wallet=NEW.wallet),0)+NEW.amount>(SELECT cap FROM test_gold_wallets WHERE wallet=NEW.wallet)
  THEN RAISE(ABORT,'TEST_GOLD_CAP') END;
END;
CREATE TRIGGER test_gold_grant_apply AFTER INSERT ON test_gold_grants BEGIN
 INSERT INTO economy_gold_accounts(wallet,balance) VALUES(NEW.wallet,0) ON CONFLICT(wallet) DO NOTHING;
 UPDATE economy_gold_accounts SET balance=balance+NEW.amount WHERE wallet=NEW.wallet;
END;
CREATE TRIGGER test_gold_grant_no_update BEFORE UPDATE ON test_gold_grants BEGIN SELECT RAISE(ABORT,'TEST_GOLD_IMMUTABLE'); END;
CREATE TRIGGER test_gold_grant_no_delete BEFORE DELETE ON test_gold_grants BEGIN SELECT RAISE(ABORT,'TEST_GOLD_IMMUTABLE'); END;
CREATE TRIGGER test_gold_wallet_no_update BEFORE UPDATE ON test_gold_wallets BEGIN SELECT RAISE(ABORT,'TEST_GOLD_IMMUTABLE'); END;
CREATE TRIGGER test_gold_wallet_no_delete BEFORE DELETE ON test_gold_wallets BEGIN SELECT RAISE(ABORT,'TEST_GOLD_IMMUTABLE'); END;
-- The history view stays the whole ledger: balance = sum of its deltas, test grants included and labelled.
DROP VIEW world_gold_history;
CREATE VIEW world_gold_history AS
 SELECT id,wallet,CAST(delta AS TEXT) delta,kind,reference,created_ms FROM economy_gold_journal
 UNION ALL SELECT id,wallet,CAST(delta AS TEXT),kind,reference,created_ms FROM world_gold_entries
 UNION ALL SELECT 'test-gold:'||id,wallet,CAST(amount AS TEXT),'test-gold',batch,created_ms FROM test_gold_grants;
