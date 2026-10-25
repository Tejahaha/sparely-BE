// Cancellation, no-show and inaccessible-storage consequences per lifecycle stage (whole rupees,
// computed on the server from the snapshotted quote). Deposits are always refunded in full:
// a cancellation is never a damage decision.
export const cancellationStages = {
  requested: { label: 'Cancelled or declined before the host confirmed', rentalRefundPct: 100, depositRefundPct: 100 },
  confirmed_early: { label: 'Renter cancels a confirmed booking more than 24 hours before collection', rentalRefundPct: 100, depositRefundPct: 100 },
  confirmed_late: { label: 'Renter cancels within 24 hours of collection, or after the collection time', rentalRefundPct: 50, depositRefundPct: 100 },
  renter_no_show: { label: 'Renter did not come to collect (agreed by the renter or decided by an operator)', rentalRefundPct: 50, depositRefundPct: 100 },
  host_cancelled: { label: 'Host cancels a confirmed booking', rentalRefundPct: 100, depositRefundPct: 100 },
  host_no_show: { label: 'Host did not hand over (agreed by the host or decided by an operator)', rentalRefundPct: 100, depositRefundPct: 100 },
  inaccessible_storage: { label: 'Storage space was inaccessible at the agreed time (agreed by the host or decided by an operator)', rentalRefundPct: 100, depositRefundPct: 100 },
};
// demo-v1 bookings (before these rules existed) said only "no payment was taken": every stage refunds in full.
export const legacyCancellationStages = Object.fromEntries(Object.entries(cancellationStages).map(([k, v]) => [k, { ...v, rentalRefundPct: 100, depositRefundPct: 100 }]));
export const cancellationRulesFor = policy => policy?.cancellation?.stages || legacyCancellationStages;

export const rentalPolicy = {
  version: 'demo-v2',
  cancellation: { lateWindowHours: 24, noShowResponseHours: 24, stages: cancellationStages },
  title: 'Sparely demo rental policy',
  graceMinutes: 30,
  responseHours: 48,
  rules: [
    'Return by the agreed time. A 30-minute grace period is shown before an overdue alert.',
    'Overdue items cannot be booked again until returned. No late charge is added automatically in this demo.',
    'Extensions require the renter’s request, available dates, an updated quote, and the host’s approval.',
    'Ordinary wear has no damage charge. New damage or missing accessories must be described with collection and return evidence.',
    'A host may propose a repair or replacement deduction up to the refundable deposit. The renter has 48 hours to respond.',
    'An operator reviews the evidence and response before approving or reducing a proposed deduction. A decision needs a written reason.',
    'Items reported damaged remain paused until the review is resolved and the host marks them available again.',
    'Cancelling before the host confirms, or more than 24 hours before collection, refunds the rental in full. A renter cancelling within 24 hours of collection (or after it) gets 50% of the rental back; the other 50% goes to the host.',
    'A host cancellation, a host no-show or inaccessible storage refunds the renter in full. A renter no-show refunds 50% of the rental. Deposits are always refunded in full on cancellation.',
    'A reported no-show is only a report: the other party can agree or dispute it within 24 hours, and an operator decides disputed or unanswered reports. Nobody is treated as at fault automatically.',
    'Collection needs both parties to accept the same agreement revision (checklist, conditions, access, price). Any change creates a new revision that both accept again.',
    'All payments, deposit holds, and deductions are simulated. This is a prototype policy, shown before booking.',
  ],
};

export function attentionFor(booking, details, now, policy = rentalPolicy) {
  const claim = details.claim;
  if (booking.status === 'under_review' && claim) return {
    kind: claim.status === 'disputed' ? 'disputed' : 'damage_review',
    title: claim.status === 'disputed' ? 'The renter has disputed this claim.' : 'Returned, with a condition issue to review.',
    detail: 'The item is paused and the simulated deposit stays on hold. An operator must review the evidence before any deduction.',
  };
  if (booking.status === 'active') {
    const lateMinutes = Math.max(0, Math.ceil((now - Date.parse(booking.end)) / 60000));
    if (lateMinutes > policy.graceMinutes) return { kind: 'overdue', title: `Return overdue by ${lateMinutes < 60 ? `${lateMinutes} minutes` : `${Math.floor(lateMinutes / 60)}h ${lateMinutes % 60}m`}.`, detail: 'The grace period has ended. Further bookings are blocked until return. Contact the host or request an extension; no late fee is added automatically.', lateMinutes };
    if (lateMinutes > 0) return { kind: 'grace', title: 'The agreed return time has passed.', detail: `You are within the ${policy.graceMinutes}-minute grace period. Arrange the return now.`, lateMinutes };
    if (Date.parse(booking.end) - now <= 2 * 3600_000) return { kind: 'due_soon', title: 'Return is due within two hours.', detail: 'Check the return time and arrange a handover. Request an extension before relying on extra time.' };
  }
  if (booking.status === 'confirmed' && now > Date.parse(booking.start) + policy.graceMinutes * 60000) return { kind: 'pickup_missed', title: 'Collection has not been recorded.', detail: 'The collection time and grace period have passed. Contact each other or cancel to release the dates; this does not prove who missed the handover.' };
  return null;
}
