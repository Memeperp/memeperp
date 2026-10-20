# Persistent storage and publishing safety

The application now uses PostgreSQL when a database connection is configured.
The document schema retains the existing Solana ledger and EVM account shapes;
legacy Solana account keys are preserved, not rewritten into guessed public
keys. Account writes are queued with revision checks. Success responses wait
for database writes, and failures stop further changes rather than silently
falling back to local files.

Development's initial import saves a private, ignored backup under
`.local/backups/`. Authentication sessions are excluded from downloadable
backups. These are **development records, not evidence of the published
website's records**.

## Before publishing this migration

1. Obtain and verify the current published Solana ledger, EVM account file,
   and signup records. A workspace copy is not a production backup.
2. Preserve the original files and compare wallet/account/signup counts.
3. Review the development schema in `database/schema.sql`. Production schema
   changes are applied by the hosting Publish flow, never app-startup DDL.
4. Do **not** choose to overwrite production data with development data.
5. Once a verified backup is secured, publish. An uninitialized production
   database blocks trading and new signup writes; it does not auto-import
   bundled workspace account records.
6. Sign in at `/admin/login` using the configured owner wallet, review the
   backup, and import it from the protected dashboard. The supported wrapper
   is `{format:"memeperp-backup",version:1,solana:ledger,evm:{accounts},settings}`.
   The exact typed confirmation is required. Import refuses existing account
   documents and excludes old authentication sessions.
7. Verify account, balance, position, order, history and signup counts before
   enabling trading. Imports start paused. Keep the backup until verification
   is complete.

Pausing trading stops new positions, increases, new orders and automatic
pending-order fills on Solana, BNB and Robinhood. Closing/reducing positions,
cancelling orders and automated TP/SL/liquidation protection remain available.
Database failures are different: changes must stop if they cannot be saved.

Visitor tracking is first-party. It stores hashed random browser/session
identifiers, page paths and timestamps, not raw IP addresses. Live counts use
visible-page heartbeats within 60 seconds, and signed-in users are distinct
verified wallet estimates. Today means UTC. Counts start with this deployment;
there is no invented earlier visitor history.

Private administration pages require an authenticated owner cookie. Private
API data requires owner authorization, mutations additionally require a
Bearer header, and responses are not cached. Admin sessions require a fresh
sign-in after a server restart. No administration action enables real-money
mainnet execution.