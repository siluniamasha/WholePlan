# Demonstration and completion plan

This document records the original submission plan. See the [current setup and verification instructions](../README.md) for the implemented app.

## The opening sentence

“A ticket without a room is not a trip. WholePlan checks the cancellation consequences of the complete purchase, then shows exactly what happened if a seller or payment fails.”

## Under-three-minute walkthrough

| Time | Action | Say |
| --- | --- | --- |
| 0:00–0:20 | State the specific buyer and show the brief | “This is for an event-trip organizer coordinating three cooperating sellers.” Treat that audience as a hypothesis until interviewed. |
| 0:20–0:45 | Show actual Gemini interpretation, then the two bundle totals | “The model interprets the request. Code compares verified demonstration prices and accepted cancellation terms. $25 more avoids $35 in declared cancellation penalties in this example.” |
| 0:45–1:15 | Show real Sandbox approvals and resulting provider references | Explain the separate seller approvals. Use pre-recorded transitions for brevity, but retain footage proving actual actions. Do not replace them with simulated references. |
| 1:15–1:50 | Switch clearly to the labelled fault simulator: shuttle confirmation fails after payment | Compare recovery for the $220/$35-penalty bundle against the $245/$0-penalty bundle. Supplier failures and cancellation terms here are fictional. |
| 1:50–2:20 | Show lost response and reconciliation | “A timeout is not a failed payment. We find the existing capture before continuing.” Show its unchanged operation ID. |
| 2:20–2:40 | Show pending or rejected refund | “Recovery is a state we verify. This amount is still unresolved.” |
| 2:40–2:55 | Close on boundaries and next supplier pilot | “Separate merchant payments are not atomic. Our prototype makes the consequences and remaining recovery work inspectable.” |

Record only capabilities actually verified. If Gemini or Sandbox is still unavailable, keep those sections explicitly marked outstanding rather than representing the entry as complete.

## Work split for two people

**Builder one:** Sandbox seller apps and buyer flow, amount/status checks, operation persistence, real void/refund verification, redacted API evidence. Understand every payment state well enough to explain it without the UI.

**Builder two:** customer conversations, actual-model extraction evaluation, desktop/mobile browser testing, accessibility, concise pitch and screen recording. Both members should rehearse the failed-refund scene and explain what the system cannot reverse.

## Next milestones

1. Configure `.env` locally with test-only seller credentials and a Gemini key. Prove the actual APIs before adding more features.
2. Run the five-buyer/two-organizer validation in `VALIDATION.md`. Keep a dated record of what was learned. No fabricated testimonials or savings metrics.
3. Test browser layout, keyboard flow, loading/failure states, and all seven scenarios. The backend suite does not verify appearance or browser behavior.
4. Improve the AI's role only against evidence: supplier-policy extraction with exact quotations and explicit human verification is a useful candidate; it is not implemented yet. Do not let an unverified model result become a refund promise.
5. Create a public repository only after inspecting the outgoing files for `.env`, database data, account identifiers, and secrets. Include the MIT license and credit tools used, including AI-assisted development.
6. Make the demo reproducible from a fresh checkout; keep required testing access available for judging. Choose a supported hosting arrangement with persistence if hosting rather than relying on local run instructions.
7. Record, review, and submit before the deadline. The prototype has not been published, entered, or submitted by this build session.

## Suggested submission description draft

WholePlan explores recovery-aware buying across cooperating merchants. A buyer requests an event ticket, accommodation, and a return shuttle, then reviews complete bundles against a budget and an accepted cancellation-penalty allowance. A deterministic engine coordinates supplier reservations and separate PayPal authorizations/captures, while durable operation records support reconciliation and compensation after partial failure.

The present prototype includes optional Gemini request extraction, a PayPal Sandbox adapter, and a clearly labelled local fault simulator. Fictional supplier quotes let judges inspect a price-versus-cancellation trade-off and reproduce lost responses, pending refunds, failed refunds, and expired reservations. The interface keeps unresolved money visible. Actual external integration verification is still outstanding at the time of this draft and must be updated before submission.

We use established compensation techniques rather than claiming atomic payments. The research hypothesis is that explicit whole-bundle cancellation consequences and trustworthy recovery state are useful to organizers who already coordinate independent sellers. Customer demand and supplier participation still require pilot validation.
