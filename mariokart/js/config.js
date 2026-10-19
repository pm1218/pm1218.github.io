// Public client configuration. Both values are safe to commit: the anon key
// only grants what the Row Level Security policies in supabase/schema.sql
// allow, and every policy requires a whitelisted, signed-in member.
//
// Find them in Supabase → Project Settings → API.
export const CONFIG = {
  SUPABASE_URL: 'https://wjphmocgvrcrsisytzyo.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_Htl-9kW8fTNr2XD2Upwrgw_HHNWtagS',
  APP_NAME: 'Kart Club',
};
