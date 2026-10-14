// Remove only obsolete browser-fallback records, including previously stored passwords.
// Never touch Supabase's session keys or any remote account/profile/couple data.
export function clearLegacyLocalData(): void {
  try {
    for (const key of ['nooki_mock_users', 'nooki_mock_profiles', 'nooki_mock_couples', 'nooki_current_user_id']) {
      localStorage.removeItem(key);
    }
  } catch {
    // Browsers may disable storage. This must not prevent live authentication.
  }
}
