# Critical validation — 3 November 2026

## Decision

Build a narrow, inspectable CommitPay prototype under the working name WholePlan. Do not describe it as the first multi-seller checkout, a new atomic-payment protocol, a proven business, or a likely prize winner. It is a technically plausible hypothesis with useful failure demonstrations and substantial commercial uncertainty.

The pitch worth testing: **“Before an agent buys the pieces of your plan, show the cancellation consequences of the whole bundle and keep every unresolved payment visible if a step fails.”**

## What people actually report

Public posts and comments are directional evidence, not verified merchant incident reports, customer interviews, or estimates of prevalence. The following discussion content was read; no one was contacted.

| Evidence | What the post and comments support | What it does not establish |
| --- | --- | --- |
| [Concert hotel booking questions](https://www.reddit.com/r/concertsPH/comments/1ui0l1p/hotel_booking_tips_for_firsttimers_need_somewhere/) | The poster asks whether to secure the room or tickets first. Commenters disagree: some book early because rooms disappear; others wait to avoid cancellation work. Flexible/pay-later reservations are already a workaround. | That buyers would pay for another app, or that simultaneous 20-minute holds solve planning weeks before ticket release. |
| [Repeated booking payment errors](https://www.reddit.com/r/Bookingcom/comments/1oo5ak8/) | The poster reports three apparent debits after repeated checkout attempts. Commenters ask whether these are pending authorizations or settled charges. That distinction itself is confusing to buyers. | Three proven settled charges, provider fault, or proof that existing platforms lack idempotency. |
| [Race-ticket checkout timeout](https://www.reddit.com/r/GrandPrixTravel/comments/1vn787e/payment_successful_but_didnt_get_receipt/) | The poster reports a timeout and later receipt. Comments describe pending charges, repeated attempts, and support uncertainty. This directly motivates an explicit unknown state and reconciliation before retry. | Access to that merchant's payment records or the ability for our app to reconcile purchases made outside our integration. |
| [Concert cancelled after hotel cutoff](https://www.reddit.com/r/hotels/comments/1eow45x/) | The poster cannot easily cancel the hotel after an event reschedule. Comments emphasize independent policies, discretionary exceptions, and contacting the hotel. | That our short checkout-recovery window covers an event cancellation months after booking. It does not. |

**Inference:** some event travelers need help reasoning about purchase order, flexibility, and uncertain payment states. A useful initial customer may be a small event-trip organizer that already has relationships with ticket, accommodation, and transport sellers. That customer hypothesis remains untested.

## Existing work that changes our pitch

- [CartConductor](https://devpost.com/software/cart-conductor) describes multi-merchant optimization, PayPal-oriented compensating checkout, fault injection, and operation records. Its public project page is enough to reject a claim that multi-merchant recovery itself is new. We have not independently audited its implementation or claims.
- [Mandat](https://devpost.com/software/mandat) describes agents booking and paying within explicit constraints, with holds, captures, refunds, and receipts. A generic “AI makes purchases with a budget” pitch is weak differentiation. Its marketing and reported metrics are not independently verified here.
- The [saga pattern](https://temporal.io/blog/saga-pattern-made-easy) already coordinates actions and compensations across services. WholePlan uses that family of ideas; it does not invent distributed rollback.

**Differentiation hypothesis:** cancellation consequences are a selection constraint before execution, and recovery completion is defined by provider-confirmed state rather than a reassuring message. This is a product focus we can demonstrate, not verified worldwide novelty. A six-quote catalog and eight combinations are not a new optimization algorithm.

## Feasibility versus the dangerous interpretation

| Claim | Assessment |
| --- | --- |
| Authorize each cooperating seller, then capture separately | Supported API architecture; actual Sandbox cycle still needs credentials and end-to-end verification. |
| Keep one reviewed bundle and persist stable operation IDs | Implemented and locally tested, including restart and concurrent requests. |
| Undo every purchase unconditionally | False. Refund eligibility, retained fees, provider state, and merchant cooperation matter. |
| An authorisation guarantees inventory | False. Inventory reservation is a separate supplier operation. |
| Refund confirmation means money is instantly spendable | False. The app deliberately distinguishes refund state from bank availability. |
| Use arbitrary retail websites without seller participation | Not provided. Supplier APIs/agreements are a major distribution obstacle. |
| The AI safely controls a wallet on its own | Not provided. Human-entered limits and buyer approval constrain the current build. |

The supplier cancellation-fee sum is a conservative comparison of declared sample terms. It is not expected financial loss: no failure probabilities were measured. Deferring expensive-to-cancel captures is a heuristic, not an optimal execution proof. A future optimizer needs time-varying policies, reservation expiry, supplier confirmation ordering, recovery cost, and measured reliability.

## Current evidence strength

- **Problem signals:** present in the public discussions above. No representative survey, market sizing, revenue evidence, or willingness-to-pay result.
- **Technical logic:** automated simulator and local HTTP tests pass. The suite includes loss of response after a simulated capture, preserved provider effects across restart, pending refunds, and failed refunds.
- **PayPal/AI integration:** code plus mock contract tests. External services not yet verified.
- **Product quality:** functioning API and interface code. Visual/browser accessibility verification remains outstanding because local browser automation is disabled.
- **AI value:** currently modest. Structured interpretation helps a buyer express intent, but the financial contribution comes from deterministic rules. Do not claim autonomous negotiation, real supplier-policy understanding, or fraud intelligence.

## Validation to do before expanding

These are proposed decision thresholds, not completed results:

1. Show five people who have booked event travel the cheapest and flexible bundle, without explaining the product first. At least four should identify the trade-off and explain what remains charged after a failed-refund scene. Record mistakes, not compliments.
2. Interview two independent organizers using their last actual failed or changed booking. Ask which seller failed, what was held/charged, time spent, who paid the loss, and whether they control supplier reservations. Do not ask leading questions such as “Would you use this amazing app?”
3. Obtain one supplier's explicit willingness to expose a temporary hold plus a cancellation/confirmation API. A brochure or generic affiliate link does not satisfy this gate.
4. Have a buyer complete three Sandbox approvals without coaching. If they abandon, show that friction honestly and investigate a legitimate approved platform flow. Do not invent a single approval capability.
5. Complete actual Sandbox create/authorize/capture and separate void/refund verification; run actual Gemini briefs and retain redacted evidence. Compare resulting records with the providers' dashboards.

**Continue** if real operators have recurring coordination work and can bring cooperating suppliers. **Narrow or pivot** if the workaround is simply one refundable room booking, if failures happen only long after checkout, or if no supplier can offer controllable reservations. The current public evidence does not resolve those gates.

## Business hypothesis

The plausible distribution is B2B software embedded by organizers, rather than asking travelers to install a universal wallet. The organizer could pay a software fee for coordination and support visibility while sellers receive their own payments. Pricing and lower support cost have not been measured. Avoid an outcome guarantee or insurance premium without the corresponding legal, contractual, and financial basis. Production seller onboarding requires an appropriate PayPal platform integration; three manually configured test accounts are only a demonstration.

## Competition strategy

The [official rules](https://paypalaihackathon.devpost.com/rules) use equally weighted implementation, design, impact, innovation, and presentation criteria. The deadline is 12 November 2026, noon PST: **13 November, 01:30 in Sri Lanka**. The submission needs PayPal Sandbox plus AI, a functional build, an English explanation, a public licensed source repository, and a public YouTube demonstration under three minutes. Confirm the current rules again before submission.

WholePlan currently has useful implementation evidence. Impact, distinctiveness, actual integrations, and visual polish remain the work that can materially improve the entry. Sponsor tools should be included only where they improve this core demonstration.
