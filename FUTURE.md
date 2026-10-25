# Future problems

Open problems that the current MVP does not solve. Nothing here is implemented. Each entry describes the risk, why the current design cannot handle it, and the directions worth evaluating later.

---

## 1. Illegal or dangerous contents in sealed storage boxes

### The problem

Storage listings (for example `storage-nook` in `lib/seed.mjs`) accept **sealed boxes only**. The listing rules forbid food, liquids, valuables, cash, documents, and hazardous goods, but those rules are only text the renter is shown. Nothing checks them.

A renter can:

1. Sign up with a fake or borrowed identity. Today identities are freely switchable demo profiles with no verification (see `RELIABILITY.md`, item 1).
2. Book a storage space and hand over sealed boxes.
3. Put anything inside: drugs, weapons, stolen goods, counterfeit items, explosives or flammables, wildlife products, or evidence of a crime.
4. Disappear. Stop paying, never collect, or abandon the boxes.

The host sees only the outside of the box. The handover flow in `store.mjs` records a six-digit code, a condition photo, and a note. That proves *a box* changed hands at a time. It says nothing about what is inside or who the renter really is.

### Why this matters

| Who | Risk |
|---|---|
| **Host** | Holds the goods on their premises. If police find contraband, the host has to explain why it is there. Liability depends on local law, but "I didn't know" may need to be proven. Hazardous contents (gas, batteries, chemicals) can cause fire, leaks, pests, or injury. |
| **Sparely (platform)** | Facilitated the arrangement and holds the booking records. Could face legal exposure, takedown demands, payment-provider bans, and reputation damage ("app used to hide drugs"). |
| **Other renters** | Share the same space. A leak, fire, or raid affects their belongings too. |
| **Law enforcement** | Needs to trace who stored the item. Fake identity means the trail stops at Sparely's records. |

### Why the current design cannot catch it

- **No identity verification.** The account behind a booking is not tied to a real person. Faking credentials costs nothing.
- **Sealed means opaque.** The host is told not to open boxes, so the one person who could notice something cannot.
- **Inventory is self-declared.** The renter writes what is "in" the box. A lie looks the same as the truth.
- **Photos show the outside only.** Photo hashes (`RELIABILITY.md`, evidence section) prove the record was not changed. They do not prove contents.
- **Abandonment has no end state.** The overdue and recovery flows assume the item belongs to the host and will come back. Storage reverses this: the *renter's* goods are left with the host, and there is no defined process for unclaimed boxes.

### Hard constraints

Any fix has to balance these. They pull against each other:

- **Privacy.** Most renters store ordinary things: clothes, books, hostel belongings between semesters. Forcing every box open is invasive and will drive honest users away.
- **Host safety.** Hosts are ordinary people, not trained inspectors. Asking them to search boxes puts them at risk and creates disputes ("you stole my watch").
- **Legal limits.** Searching someone's property or holding their ID may need consent, documented terms, and data-protection compliance (for India, the DPDP Act 2023). Rules differ by region.
- **Software cannot see inside a box.** No backend change makes contents visible. The answer is a mix of identity, deterrence, process, and terms, not code alone.

### Possible directions (not decided)

Listed roughly from least to most invasive. A real solution likely combines several.

1. **Verified identity before storage bookings.**
   Require verified phone plus government ID verification (for example DigiLocker or Aadhaar-based e-KYC through a licensed provider) for the storage category only. This does not stop contraband, but it removes anonymity, which is the main thing that makes the scheme attractive. Store only the verification result and reference, never ID images, in line with keeping sensitive data out of the database and handoff docs.

2. **Explicit legal declaration at booking.**
   Renter signs a declaration that the contents are legal, owned by them, and match the inventory, with consent to inspection under defined conditions and acknowledgement that Sparely cooperates with lawful requests. Save it with the booking, like the versioned rental policy is saved today. This shifts liability and is a deterrent.

3. **Open-then-seal handover.**
   Instead of "bring sealed boxes", the renter packs or shows the contents at handover, both parties record a contents photo, then the box is sealed with a numbered tamper-evident seal and the seal number is recorded. More friction, but it closes the "host never saw it" gap. Could be optional, with a lower deposit or a "verified contents" label as an incentive.

4. **Inspection right in the terms.**
   Host or operator may open a box only with documented cause (smell, leak, noise, police request), with a witness or operator present, and with photos at every step. Never a solo host search.

5. **Category limits and risk signals.**
   Cap box count, size, and weight for new or unverified accounts. Flag patterns for operator review: many short bookings, prepaid long terms with no contact, mismatched names, renters who never collect. Operators review flags. A flag is never treated as proof (same principle as `RELIABILITY.md`, item 1).

6. **Abandonment and disposal process.**
   Define what happens after non-payment or non-collection: reminders, final notice, a holding period, then supervised opening with an operator, inventory, and lawful disposal or handover to police if anything illegal is found. Needs legal review before it ships.

7. **Host protection.**
   Clear host guidance: do not open boxes alone; if you suspect something dangerous, stop, step away, contact support or police. An escalation path in the recovery system for "suspected prohibited contents", separate from damage claims.

8. **Law-enforcement request process.**
   A documented, audited way to respond to lawful requests for booking and identity records, with retention periods defined in advance.

### What would need to change in the backend (later)

Only as a sketch for when this is picked up:

- A verification status on users, checked before storage bookings are accepted.
- A per-booking contents declaration and optional seal number(s), versioned like `policyVersion`.
- A new recovery or incident type for suspected prohibited contents, with operator-only actions and append-only records (reuse the patterns in `lib/recovery.mjs`).
- An abandonment state for storage bookings with timed notices, alongside the existing overdue watchdog.
- Frontend work for all of the above goes through `frontend/HANDOFF.md`, not done directly.

### Open questions

- Which identity provider, and what does it cost per verification?
- Is Sparely an intermediary or a storage operator under local law? This changes liability a lot.
- Should storage be limited to staffed or commercial hosts (like the "staffed office building" in the sample listing) until verification exists?
- How long must booking and identity records be kept, and how are they deleted afterward?
- Who pays for disposal of abandoned or hazardous goods?

### Current status

**Not addressed.** Until at least verified identity, a signed contents declaration, and a host escalation path exist, storage listings should not be advertised as "secure" or "verified", and should not launch to the public with anonymous renters.
