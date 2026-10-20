# Security review — 2026-10-04

## Scope and release status

Reviewed and hardened the current practice-only workspace. No publishing,
production database writes, real-wallet transactions, token approvals or spending
permissions were performed. The published app has not received these fixes.

This is an engineering security pass, not a certification, penetration test or
guarantee that every vulnerability has been found.

## Verified issues addressed

| Priority | Finding | Fix |
| --- | --- | --- |
| High | External token metadata and legacy signup/search/position strings could enter HTML or JavaScript attributes without appropriate encoding. | Escaped text and attributes, restricted interpolated colors and addresses, encoded Solana action arguments for both JavaScript and HTML contexts, and removed string-interpolated ticker handlers. Rejected markup-style signup emails. |
| Medium | Two independently wallet-approved Solana closes could settle the same position after awaiting quotes. This affects practice-account integrity, not actual wallet funds. | Re-read the authoritative account after fetching prices; reject absent or changed positions before settlement; use the current position index. Refresh account references and position limits after open/quote awaits as well. |
| Medium | A new unauthenticated login challenge for a known wallet could replace an in-progress legitimate challenge. | Index Solana, owner and EVM challenges by wallet plus exact-message hash. Existing approvals remain valid until consumed or expired; successful proofs cannot be replayed. |
| Medium | Some authentication state was unbounded, some expired counters could keep capacity occupied, and some upstream provider requests had no deadline. | Bounded expiring stores that never evict active proofs or active rate limits to admit another caller; eight-second provider deadline; additional quote/event/EVM request limits and pending-order capacity. |
| Low / defense in depth | API caching, parser exception output and externally hosted SDK replacement risks. | API `no-store`, generic parser/server responses, removal of Express identification, baseline browser security headers, production HTTPS/framing restrictions, and version-pinned external scripts with SHA-384 integrity checks. |
| Privacy minimization | Signup entries unnecessarily persisted source IP addresses. | New signup entries no longer store source IPs. Existing records were preserved. |

## Verification

- Dependency audit: zero reported findings in configured project dependencies.
- Static analysis: complete scan, zero reported findings.
- Privacy/dataflow scan: zero reported findings.
- `npm test`: **127 passed; zero failed**.
- Regression checks cover hostile token/email rendering, safe action arguments,
  script syntax and integrity protection, authentication capacity/expiry,
  malformed and oversized requests, private-file restrictions, challenge
  interference/replay, and concurrent genuinely signed Solana closes.
- Tests use temporary account/session storage and do not run the production app's
  keepers or mutate real account records.
- Restarted the application once after the changes; startup logs were clean.
- The development-domain health endpoint returned HTTP 200 with the expected
  security headers.
- Public testnet page rendered successfully. Signed-in UI and approval dialogs
  were not visually reverified with real wallet extensions in this pass;
  protected endpoints and wallet safety behavior were checked by tests.

## Remaining security work and limitations

1. **Strict browser script policy.** The legacy desks still contain inline
   scripts and action handlers. The current policy restricts plugins, base URL
   changes, form destinations and production framing; it does not block all
   unauthorized JavaScript. Refactor handlers, inventory external resources,
   then enforce a restrictive script policy and test all wallet flows.
2. **External wallet SDK review.** Integrity checks protect the fetched pinned
   browser SDK from byte replacement. They do not prove that its bundled
   dependencies are vulnerability-free; the project dependency audit does not
   independently audit that CDN bundle.
3. **Production rollout remains blocked by data preservation.** Obtain and
   verify a live-data backup and complete the previously planned storage
   migration before publishing. Do not replace the published runtime merely to
   gain an export endpoint.
4. **Ongoing verification.** Re-run scans and adversarial tests after material
   changes; validate proxy-aware request limits before changing trust settings.
   An independent penetration test and reviewed risk/threat model are needed
   before any real-money execution is introduced.