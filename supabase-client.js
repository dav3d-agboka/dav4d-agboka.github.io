/* ══════════════════════════════════════════════════════════════
   D-SWIFT  |  supabase-client.js
   One shared Supabase client, loaded by every page BEFORE
   kscript.js / loginscript.js / script.js.

   Include this in <head> or right before your other scripts:
     <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
     <script src="supabase-client.js"></script>
   ══════════════════════════════════════════════════════════════ */

const SUPABASE_URL = 'https://ckcrjzzhpbukavpkqity.supabase.co';
const SUPABASE_KEY = 'sb_publishable_Tpl4e3q8ByhZsoe6uVmgkg_Pr63GSo7';

// `supabase` here is the global from the CDN script above (window.supabase).
// We rename our client to `sb` so it doesn't collide with that global.
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true, // needed for OAuth + email-confirmation redirects
    }
});

// ── Legacy localStorage bridge ────────────────────────
// Pages written before the Supabase migration (or not yet updated) read
// the logged-in user from localStorage under these three keys. Rather
// than rewrite every single page in one pass, we keep that bridge alive:
// this listener fires on load and on every login/logout/token-refresh,
// re-fetching the profiles row and mirroring it into the same keys the
// old PHP-based loginscript.js used to write. New code should prefer
// `sb.auth.getSession()` / `sb.from('profiles')` directly instead of
// reading localStorage — this bridge exists for the not-yet-migrated
// pages only, and can be deleted once every page is converted.
async function syncLegacyUserStorage(session) {
    if (!session) {
        localStorage.removeItem('swiftToken');
        localStorage.removeItem('swiftLoggedIn');
        localStorage.removeItem('swiftCurrentUser');
        return null;
    }

    const { data: profile, error } = await sb
        .from('profiles')
        .select('*')
        .eq('id', session.user.id)
        .single();

    if (error || !profile) return null;

    const legacyUser = {
        id:         profile.id,
        name:       profile.name,
        email:      profile.email,
        phone:      profile.phone,
        role:       profile.role,
        bio:        profile.bio,
        location:   profile.location,
        storeName:  profile.store_name,
        profilePic: profile.profile_pic,
        isVerified: !!session.user.email_confirmed_at,
        joinDate:   new Date(profile.join_date).toLocaleDateString('en-GB'),
    };

    localStorage.setItem('swiftToken', session.access_token);
    localStorage.setItem('swiftLoggedIn', 'true');
    localStorage.setItem('swiftCurrentUser', JSON.stringify(legacyUser));
    return legacyUser;
}

// Keeps localStorage current across tab switches, token refreshes, and
// sign-outs — not just the moment someone clicks "Log In".
sb.auth.onAuthStateChange((_event, session) => { syncLegacyUserStorage(session); });

