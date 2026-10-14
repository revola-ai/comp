import type { Prisma } from '@db';
import type { UpdatePeopleDto } from '../dto/update-people.dto';

/**
 * Splits a PATCH /v1/people/:id body into the Member columns to write and the
 * User fields (name, email) that live on the member's user.
 */
export function buildMemberUpdate(updateData: UpdatePeopleDto): {
  member: Prisma.MemberUncheckedUpdateInput;
  user: { name?: string; email?: string };
} {
  const { name, email, createdAt, onboardDate, offboardDate, ...memberFields } =
    updateData;
  const member: Prisma.MemberUncheckedUpdateInput = { ...memberFields };

  if (createdAt !== undefined) member.createdAt = new Date(createdAt);
  if (onboardDate !== undefined) {
    member.onboardDate = onboardDate ? new Date(onboardDate) : null;
  }
  if (offboardDate !== undefined) {
    member.offboardDate = offboardDate ? new Date(offboardDate) : null;
  }

  // An explicitly cleared fleetDmLabelId (present but undefined) unlinks.
  if (
    memberFields.fleetDmLabelId === undefined &&
    'fleetDmLabelId' in memberFields
  ) {
    member.fleetDmLabelId = null;
  }

  // Un-exempting clears reason + justification so a future re-exemption
  // starts from a clean state. The audit log retains the prior values
  // from the original exempt-true request.
  if (member.backgroundCheckExempt === false) {
    member.backgroundCheckExemptReason = null;
    member.backgroundCheckExemptJustification = null;
  }

  // Reactivation: the status dropdown sends { isActive: true } via PATCH. A
  // member deactivated via offboarding (or the skip-offboarding path) carries
  // deactivated:true, which hides them from the people list. Clear it so
  // isActive and deactivated stay in sync and the member is fully restored.
  if (member.isActive === true) member.deactivated = false;

  return {
    member,
    user: {
      ...(name !== undefined ? { name } : {}),
      ...(email !== undefined ? { email } : {}),
    },
  };
}
