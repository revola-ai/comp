/**
 * The hand-off between the pre-authentication limiter and HybridAuthGuard.
 * The limiter takes a slot when a machine-credential request arrives and
 * registers its refund here; HybridAuthGuard releases it the moment it accepts
 * the credential (or finds the credential store down), not when the handler
 * finishes, so a long-running authenticated request holds no slot. A request
 * that fails authentication or is aborted during validation never releases its
 * slot.
 */
const refunds = new WeakMap<object, () => void>();

export function holdCredentialSlot({
  request,
  refund,
}: {
  request: object;
  refund: () => void;
}): void {
  refunds.set(request, refund);
}

/** Gives the request's slot back, if it holds one; later calls do nothing. */
export function releaseCredentialSlot(request: object): void {
  const refund = refunds.get(request);
  refunds.delete(request);
  refund?.();
}
