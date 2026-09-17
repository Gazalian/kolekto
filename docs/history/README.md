# History

Documents carried from the previous Kolekto repositories. They are here because
they explain *why* rules in this repository exist. None of them describes code
that runs here.

| Document | Why it is kept |
|---|---|
| `incident_2026-08-06_tiered-payment-amount-regression.md` | The tier-resolution bug and, more importantly, the deploy-drift root cause: production ran payment code 867 lines behind `HEAD` for five days. Source of ADR 0005 and ADR 0010. |
| `incident_2026-08-05_phone-email-cross-contamination.md` | Contact-detail bleed between records. Informs the member matching and claim rules (MEM-08, CON-25 to CON-27). |
| `PAYMENT_OPERATIONS_RUNBOOK.md` | How payment exceptions were actually triaged. The operational knowledge behind the internal console's requirements. |
| `PAYMENT_RESILIENCE_AUDIT_2026-08-07.md` | The failure modes the previous team catalogued in the payment path. |
| `FINAL_PAYMENT_INTEGRITY_REPORT_2026-08-07.md` | What integrity guarantees existed and what they cost to reach. |
| `PHASE3_PAYMENT_CAPTURE_LEDGER_2026-08-07.md` | The "universal capture guarantee" reasoning — record the capture the instant Paystack confirms, before resolution can fail. Carried into the Phase 3 design. |
| `FINANCIAL_DRIFT_ROOT_CAUSE_REPORT.md` | Why balances drifted. Source of ADR 0003. |
| `KOLEKTO_FINAL_FINANCIAL_FORENSICS.md` | The duplicate-contribution investigation and its remediation. |

## What the previous system got right

Worth stating, because a rebuild makes it easy to assume everything was bad. It
was not. These were correct, and they are carried forward as rules rather than
as code:

- **Paystack webhook HMAC verified over the raw body,** rejecting on mismatch.
- **Mandatory server-side re-verification** against `/transaction/verify` on
  every path. No code anywhere trusted a browser-reported amount or status.
- **Validation at initiation, not verification.** After the August incident,
  amount and tier mismatches were rejected with a `409` *before* Paystack was
  called — the only place where rejecting is free.
- **A real state machine in the database.** `ppc_enforce_state_machine` enforced
  a transition table and made capture facts write-once, with comments explaining
  which fault injection found each rule.
- **Concurrency taken seriously.** `request_withdrawal_atomic()` re-checked the
  withdrawal cap inside one transaction under an advisory lock on
  `collection_id`, explicitly to close a TOCTOU race that Node-side checking
  cannot.
- **Deletion of financial history blocked at the database.**
  `enforce_collection_delete_guard` refused to hard-delete any collection with
  contributions, wallets, withdrawals or deposits.
- **Idempotency enforced by partial unique indexes,** which held: zero live
  duplicate `(payment_reference, line_index)` pairs across 5,573 contributions.
- **A CI job that refused to run integration tests against the production
  project ref.**
- **Correlation-prefixed logging** (`[verify ref=…] VERIFY_PAYSTACK_OK`), which
  is the only reason the August incident could be reconstructed.

The pattern is that the guardrails were added one incident at a time, after the
architecture was already fixed. This repository puts them in first.
