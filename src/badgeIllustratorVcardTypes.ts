export interface VCardFieldState {
  enabled: boolean;
  value: string;
}

export interface VCardSettings {
  firstName: VCardFieldState;
  lastName: VCardFieldState;
  fullName: VCardFieldState;
  organization: VCardFieldState;
  role: VCardFieldState;
  email: VCardFieldState;
  phone: VCardFieldState;
  note: VCardFieldState;
}
