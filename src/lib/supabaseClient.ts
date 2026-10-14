import { createClient } from '@supabase/supabase-js';
import { validateSupabaseConfig } from './supabaseConfig.mjs';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || '';
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || '';

export const supabaseConfigurationError = validateSupabaseConfig(supabaseUrl, supabaseAnonKey);
export const supabase = supabaseConfigurationError ? null : createClient(supabaseUrl, supabaseAnonKey);

export function requireSupabase() {
  if (!supabase) throw new Error(supabaseConfigurationError || 'Supabase is not configured.');
  return supabase;
}
