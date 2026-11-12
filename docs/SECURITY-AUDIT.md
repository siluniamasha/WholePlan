# WholePlan security review

The review covered the redesign and security changes based on GitHub commit `eb663ffc169a39f0d6c4964f80794783ac988db1`.

## Scope and method

The review covered the server, browser scripts, payment engine, SQLite access, provider adapters, command-line payment helper and configuration. Verification included source review, automated regressions, private-file access checks against a temporary local server and all seven simulated payment scenarios. The application has zero third-party npm runtime dependencies.

The upstream README reports team verification of Gemini and a three-seller Sandbox checkout. This audit checked provider behavior through mocks and exercised checkout and recovery through local HTTP. The prior redesign included browser checks. Browser access was unavailable for a fresh interactive run. A fresh three-seller PayPal Sandbox and Gemini run is still required for external integration sign-off.

Production infrastructure, provider account permissions, operating-system security and external supplier systems require their own assessments.

## Findings addressed

Severity describes the potential effect within this application.

| Finding | Severity | Change and evidence |
| --- | --- | --- |
| An audit log failure could mark a confirmed capture as failed and leave recovery unaware of the charge | High | Save the provider result separately from audit logging. Display confirmed amounts from the operation record even when the run update stops. Recovery recognizes both new confirmations and older records with a saved result. |
| The final capture could outlast the inventory hold | Medium | Recheck supplier hold deadlines after the last capture and before confirming bookings. The regression confirms that all three payments remain recoverable. |
| A declined capture hid a remaining authorization and could leave recovery stuck | Medium | Recognize terminal declines, keep the hold visible until it is voided, and unwind earlier completed captures. |
| Reconciliation could use a different capture or attempt another refund after a provider-reported refund | Medium | Pending captures retain their original reference. An unknown PayPal capture must match the saved order, purchase unit and invoice. Prior refunds without a local refund record require manual verification. |
| Provider responses could consume unbounded memory and Gemini output was uncapped | Medium | Cap each decoded response at 256 KiB and Gemini generation at 4,096 output tokens. Validate all plan inputs before consuming model quota. An oversized payment POST response remains uncertain. |
| Provider response fields unrelated to the payment were stored internally | Medium | New payment operation records retain the reference, status, amount and approval URL. Earlier database rows may contain historical provider payloads. |
| Reading an error template could fail during request error handling | Low | Load the template at startup. The server can return a safe JSON error if the template is unavailable. Oversized input closes the connection after the error response. |
| Exported plans included the session owner identifier, which was also the bearer cookie value | High | Removed the owner from every public run representation, including downloads. A regression checks that the serialized response excludes the exact cookie value. |
| Raw order payloads could carry payer information and callback context into public records | Medium | Public payment objects now expose an allowlisted ID, status, amount and approval link. A test injects payer data and callback state and verifies their removal. Internal provider records remain private in SQLite. |
| Cookie resets bypassed the per-session mutation limit | Medium | Limits now use the direct socket address. Separate budgets cover requests, mutations, new sessions and model requests. Caller-supplied forwarding headers are ignored. Rate-window and capacity behavior are tested. |
| Sessions persisted indefinitely | Medium | Server-side sessions expire after 24 hours. New cookies have a matching lifetime. Expired records are pruned on session creation. Session expiry has a dedicated regression. |
| Invalid JSON roots and inherited scenario names could reach application logic | Medium | JSON input must be an object. Scenarios use an own-property allowlist. Budget, fee allowance, traveler count and scenario checks run before any model request. HTTP tests cover malformed JSON, null, arrays, primitives, oversized bodies and prototype-property names. |
| Refund polling trusted updated provider results without rechecking their amount and identity | Medium | Each polled refund must match the accepted USD amount and saved refund ID. A mismatched result keeps the previous pending record and moves recovery to attention. |
| Approved-term checks covered only some immutable fields and allowed a shorter leg array | Medium | The engine validates the leg count and every frozen supplier-term field before provider actions. Tests alter hold duration, policy wording and leg count. No holds are created. |
| Unknown URL probes created persistent sessions | Low | Explicit routing and session creation rules reject private-file probes before writing sessions. Tests cover environment files, Git configuration, source, the database and the backup directory. |
| Content type, fetch origin and provider redirects were loosely constrained | Low | Strict JSON media-type matching, cross-site fetch rejection, existing CSRF validation, and provider fetches with redirect rejection are enforced. API base URLs remain fixed to Sandbox and Gemini. |
| Example model configuration contained a repeated assignment prefix | Low | Corrected the example value so copying the configuration produces a usable model identifier. Actual model availability remains dependent on the configured provider project. |

## Controls verified

- Session ownership is checked for every plan operation and downloadable record. Another session receives an unavailable-resource response.
- CSRF tokens use a timing-safe comparison. Mutation requests carry a custom header. Origin and Fetch Metadata checks add browser context.
- Cookies use HttpOnly and SameSite=Lax. Secure and HSTS are enabled when the configured public origin uses HTTPS. Lax supports the top-level PayPal return.
- CSP restricts scripts, styles and network connections to the app origin. Objects, framing and base URL changes are denied. Static files come from an explicit asset map.
- Briefs, model output and provider messages are escaped before HTML insertion or assigned through textContent. PayPal approval links have an HTTPS Sandbox origin allowlist.
- SQL values use prepared statements. Public routes cannot retrieve SQLite files or local backups.
- Integer-cent amounts, immutable reviewed terms, separate seller approvals, stable saved operation identifiers, per-run serialization and reconciliation remain enforced.
- Unknown captures and pending refunds retain distinct states. Pending refunds are excluded from confirmed returned money.
- AI extraction requires supported categories, bounded non-empty source quotations and a bounded summary. Financial values and payment permission come from application rules and buyer review.
- API errors omit tokens and provider response bodies. The local secret check scanned the working tree, Git index and all reachable commits using credential patterns and exact comparisons with configured credentials. It found zero candidates. Private environment files, databases, preview files and backups are ignored. The published screenshot shows the public landing page.
- SQLite indexes cover per-run event and operation lookups and expired session cleanup.

The implementation follows the token, origin and input-validation approaches described in the [OWASP CSRF guidance](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html) and [OWASP input-validation guidance](https://cheatsheetseries.owasp.org/cheatsheets/Input_Validation_Cheat_Sheet.html). Saved request identifiers follow [PayPal's idempotency guidance](https://developer.paypal.com/api/rest/reference/idempotency/). Each API's supported retention window governs real retries.

## Deployment boundaries requiring further work

1. **Session access and recovery.** A browser session is the access boundary. Account sign-in, cross-device recovery, revocation and an operator recovery workflow are still needed before real-customer operation. Old downloads containing session owner values should be handled as sensitive.
2. **Single-process operation.** Locks and rate counters reside in one Node process. Multi-instance hosting needs shared locks, durable abuse limits and coordinated recovery workers. Session and transaction data need a persistent volume with backup and access controls.
3. **Proxy configuration.** Address budgets intentionally trust the socket address. A reverse proxy shares a budget unless trusted-proxy handling is explicitly designed for that deployment.
4. **Spending and storage limits.** Real AI has a default global ceiling of 30 requests per hour and six per address per minute. Counters reset on process restart. Durable quotas and transaction-data retention are deployment work. Configure `AI_REQUESTS_PER_HOUR` to the permitted budget.
5. **External provider verification.** The callback route, PayPal order and invoice fields, and the Gemini output cap still need a fresh provider run. Webhook verification and unattended recovery remain future work. An unknown refund without a saved ID or a capture without a matching invoice remains unresolved.
6. **Merchant fulfillment.** Inventory and booking confirmations use controlled sample suppliers. Production integration needs supplier authentication, verified reservation policies, confirmation APIs and failure handling.
7. **Privacy.** Briefs can contain user-entered personal information. Deployment needs a documented retention policy, privacy explanation and appropriate handling of model-provider data. The current payment adapter supports test funds.

## Verification and repository cleanup

The prior redesign checked the interface at 320 px, 390 px, 768 px and 1440 px. The old local project is archived in the ignored `.local-backup/before-redesign-2026-11-12` folder. Its environment file and data remain private.

Run `npm test` for automated checks, including the HTTP journey. Run `npm run demo:evidence` to execute all seven simulator scenarios. The rejected-refund scenario should report `NEEDS_ATTENTION` and an $80 outstanding charge.

| Item | Disposition | Compatibility |
| --- | --- | --- |
| Existing static assets, brand sources and historical documents | Keep | Existing URLs and paths remain usable. The documentation index labels the original demo and research. |
| README, documentation index, landing screenshot and package metadata | Update | Existing setup and script names work. Package metadata describes the repository without changing dependency resolution. |
| SQLite lookup indexes | Add | Existing databases gain indexes on startup. Table and row formats are preserved. |
| Local environment, backup and generated evidence | Keep private | Git ignores these paths. |
