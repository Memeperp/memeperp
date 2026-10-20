# MemePerp Engine Integration

## Current architecture

The runnable trading product uses a server-backed simulation:

```text
testnet.html
    ↓
engine/memePerpEngine.js
    ↓
/api/testnet/*
    ↓
shared simulation ledger + price keeper + liquidation keeper
```

`MemePerpEngineClient` is the frontend boundary for:

- Account state
- Quotes
- Opening positions
- Closing and reducing positions
- Cancelling orders
- TP/SL updates
- Simulated liquidation

## Mainnet rule

Mainnet perpetual trading remains disabled until a settlement protocol is selected.
The future adapter must implement the same operations as `MemePerpEngineClient`
while treating confirmed protocol state as the source of truth.

Do not route spot swaps through the perpetual position interface or represent
spot purchases as leveraged futures.

## Adapter requirements

A mainnet settlement adapter must provide:

1. Supported perpetual market discovery
2. Quote and oracle validation
3. Collateral and margin account state
4. Open, close, reduce, and cancel operations
5. Transaction signing, submission, and confirmation
6. Position and order reconciliation
7. Funding, fees, liquidation, and risk limits
8. Idempotency and stale-price protection

## Go-live sequence

1. Keep simulation behavior stable behind the engine client.
2. Select a Solana perpetual settlement protocol.
3. Implement a separate mainnet adapter.
4. Test with restricted markets and low risk limits.
5. Reconcile every order against confirmed protocol state.
6. Enable mainnet only after security and economic review.