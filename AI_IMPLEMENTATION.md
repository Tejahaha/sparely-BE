# How AI works in Sparely

Sparely uses AI in four places. The rule is the same everywhere: the AI only **reads or writes words**, and the app itself makes every decision and checks every word before anyone sees it. If the AI is switched off, slow or gets something wrong, the app still works. It just skips the AI part.

---

## 1. "Find my fit": understanding what you typed

**What it does:** you type what you need in your own words. The AI picks out the useful bits, and the app searches the real listings with them.

**Example**
> You type: *"I need to keep 20 boxes and a cycle in Gachibowli for 2 months from next Monday."*
>
> The AI reads: storage · 20 boxes, 1 cycle · Gachibowli · 2 months · from next Monday.
>
> The app then:
> - works out the dates itself (next Monday to two months later);
> - estimates your things need about **42 sq ft**;
> - shows the Gachibowli storage space and tells you: *"Smaller than the ~42 sq ft your items need. Try fewer items, or split them across two spaces."*

**What the app checks:** dates in the past are ignored, and only real categories count. If you said a budget, prices within it come first. If the AI fails, simple keyword matching is used instead.

---

## 2. Matching by meaning

**What it does:** it finds listings that fit what you mean, even when you don't use the listing's words.

**Example**
> You type: *"The floor is filthy after the party."*
>
> No listing says "filthy" or "party", but the app understands this is about cleaning and shows the **wet & dry vacuum**.
>
> You type: *"I want to bake a cake."*
>
> Nothing on Sparely fits, so it shows nothing rather than guess.

**What the app checks:** it only offers a match on meaning alone when one listing is clearly the best fit. Otherwise it stays quiet.

---

## 3. Polite return reminders

**What it does:** when something is returned late, the renter gets a friendly reminder. The AI writes the wording; the app decides when to send it.

**Example**
> Teja's drill was due back yesterday at 10 am. Teja receives:
>
> *"Hi Teja, the drill was due back on 12 Dec, 10:00 am IST. Please contact the host today, or request more time on the booking."*

**What the app checks:** the reminder must contain the exact due date, can't mention money, fines or police, and can't invent any numbers. If the AI's wording breaks a rule, a fixed friendly message is sent instead. The same reminder is never sent twice.

---

## 4. Case brief for the operator

**What it does:** when a rental goes wrong, the operator (Mira) usually has to read the whole history. The case brief sums it up at the top of the case.

**Example**
> A host says a charger is missing and wants ₹500 from the deposit. Mira opens the case and sees:
>
> - **What happened:** Light kit collected and returned on 25 Oct.
> - **Host says:** The charger is missing; proposes a ₹500 deduction.
> - **Renter says:** Nothing recorded.
> - **Evidence:** Photos at collection and at return.
> - **Missing:** The renter has not responded yet.
> - **Waiting for you:** A ₹500 deduction from a ₹1,000 deposit awaits review.
>
> Each line has a small tag (like **F11**) that opens the exact record it came from.

**What the app checks:**
- **Sources:** every line must point to a real record.
- **Numbers:** every amount and date must match the case.
- **No verdicts:** the brief can never say who is right or what is fair.
- **Fallback:** a plain summary built from the records shows instantly, and the AI version replaces it when ready (about 30 seconds on the current computer).
- **Decision:** Mira still decides and writes her own reason.

---

## Where the AI runs

- **The computer:** a separate PC at home runs two free models through Ollama. `gemma3:4b` reads and writes text; `nomic-embed-text` handles "matching by meaning".
- **Testing on your PC:** the app reaches that computer over Wi-Fi.
- **The live website:** it can only use the AI if that computer is reachable securely over the internet (Tailscale Funnel with a secret key, see `OLLAMA_PRODUCTION.md`), or if a paid AI service is set up. Without that, the live site works fine with the AI parts switched off.

## Removed

- **Message translation** was removed, because people type in the language they want.
