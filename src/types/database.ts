export interface Profile {
  id: string;
  couple_id: string | null;
  name: string;
  timezone: string;
  last_seen_at: string;
  created_at: string;
}

export interface Couple {
  id: string;
  invite_code: string;
  anniversary_date: string | null;
  created_at: string;
  breakup_requested_by: string | null;
  breakup_requested_at: string | null;
}

export interface UserSession {
  user: {
    id: string;
    email: string;
  };
  profile: Profile | null;
  couple: Couple | null;
  partner: Profile | null;
}
