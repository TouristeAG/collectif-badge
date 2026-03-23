export type PersonCategory =
  | "volunteer"
  | "permanent_guest"
  | "volunteer_guest"
  | "temporary_guest";

export interface PersonRecord {
  id: string;
  eventManagerId?: string;
  source: string;
  rowNumber: number;
  category: PersonCategory;
  displayName: string;
  abbreviation?: string;
  email?: string;
  phone?: string;
  nfcCardUid?: string;
  rank?: string;
  active?: boolean;
  invitations?: number;
  venue?: string;
  eventDate?: string;
  artistName?: string;
  artistContactPhone?: string;
  notes?: string;
}

export interface SheetNames {
  guestList: string;
  volunteerGuestList: string;
  volunteers: string;
  tempGuestList: string;
}

export interface SheetsLoadPayload {
  spreadsheetId: string;
  sheetNames: SheetNames;
}

export interface PeopleResponse {
  people: PersonRecord[];
  counts: {
    total: number;
    volunteers: number;
    permanentGuests: number;
    volunteerGuests: number;
    temporaryGuests: number;
  };
}
