# Owner administration API

The admin portal is for the single configured Solana wallet. Wallet message
signing is authentication only; no transaction or transfer is requested.
Keep the existing public site and trading layout unchanged.

- `GET /api/admin/identity`: `{walletAddress, configured}` (public wallet only).
- `POST /api/mainnet/admin/challenge`: `{walletAddress}` → `{message}`.
- `POST /api/mainnet/admin/verify`: `{walletAddress,message,signature}` where
  signature is Base64 → `{adminToken,expiresAt}` and an HttpOnly admin cookie.
- `POST /api/admin/logout`: authenticated; ends the admin session and cookie.
- `GET /api/admin/overview`: authenticated, returns the object below.
- `POST /api/admin/trading`: authenticated **Bearer** token required, body
  `{enabled:boolean}`. Pausing blocks new positions, increases, limit orders,
  and automatic limit fills across all three chains. Existing positions can
  still be closed/reduced, and orders cancelled. Risk exits remain active.
- `GET /api/admin/export`: authenticated, downloadable JSON containing
  Solana ledger, EVM accounts and settings. Never includes session tokens.
- `POST /api/admin/import`: authenticated Bearer, body
  `{backup:parsedJSON,confirmation:"IMPORT VERIFIED PRODUCTION BACKUP"}`.
  Only allowed when storage.migrationRequired is true and no account
  documents exist. Never overwrites accounts. Imported trading starts paused.

`overview` fields:

```
{
  generatedAt, trading: {enabled,updatedAt,updatedBy},
  storage: {mode,ready,pendingWrites,lastSavedAt,healthy,migrationRequired},
  metrics: {
    accounts,openPositions,pendingOrders,closedTrades,signups,
    realizedPnlUsd,notionalUsd,totalVisits,uniqueVisitors,
    todayVisits,todayUniqueVisitors,liveVisitors,liveSessions,
    authenticatedLiveUsers
  },
  accounts: [{wallet,chain,balanceNative,currency,positions,orders,realizedPnlUsd}],
  positions: [{wallet,chain,symbol,side,marginNative,currency,leverage,entry,quantity}],
  orders: [{wallet,chain,symbol,side,limitPrice,marginNative,currency}],
  activity: [{wallet,chain,type,message,createdAt}],
  signups: [{email,createdAt}],
  markets: [{symbol,address,price,updatedAt}],
  providers: {rpcConfigured,birdeyeConfigured}
}
```

Use `/admin/login` for the wallet gate and `/admin` for the authenticated
portal. The latter is server-protected; unauthenticated visits redirect to the
login gate. On successful login store adminToken in sessionStorage, then
navigate to /admin. The API client sends Authorization: Bearer for every admin
request. Never put tokens in URLs. Clear sessionStorage on logout or a 401/403.
Request overview on load and every 15 seconds while visible; stop polling on
logout. No mock metrics or simulated live users.

Visitor counts represent anonymous browser IDs, not identified people.
Live counts mean a visible-page heartbeat within 60 seconds. Historical
tracking starts only when this update is published. Do not imply earlier
traffic was measured. No charts are required: use numbers and readable data
lists/tables without inventing analytics history.
Today's totals use UTC. When migrationRequired is true, clearly say the
previous published data is not imported yet, do not present empty counts as
historical totals, disable export and trading toggles, and provide a verified
backup JSON upload with an explicit confirmation before calling /import.

Only public login HTML and generic code/styles may be public. All private
data is behind server authorization. Do not show signed-in dashboard content
before authorization succeeds.