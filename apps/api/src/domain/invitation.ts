export interface InvitationPolicy {
  allows(email: string): boolean;
}

export class AllowedEmailInvitationPolicy implements InvitationPolicy {
  private readonly emails: Set<string>;
  constructor(value: string) {
    this.emails = new Set(
      value
        .split(',')
        .map((email) => email.trim().toLowerCase())
        .filter(Boolean),
    );
  }
  allows(email: string) {
    return this.emails.has(email.trim().toLowerCase());
  }
}
