/** PUT /v1/organization/role-notifications body (validated in the controller). */
export type UpdateRoleNotificationsBody = {
  settings: Array<{
    role: string;
    policyNotifications: boolean;
    taskReminders: boolean;
    taskAssignments: boolean;
    taskMentions: boolean;
    weeklyTaskDigest: boolean;
    findingNotifications: boolean;
  }>;
};
