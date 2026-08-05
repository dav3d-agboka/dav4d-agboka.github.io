/* ══════════════════════════════════════════════════════════════
   D-SWIFT  |  loginscript.js  (Supabase Auth version)
   Requires supabase-client.js to be loaded first (defines `sb`).

   Password hashing, email verification, and session tokens are now
   handled entirely by Supabase Auth — no more api/login.php,
   api/register.php, api/forgot_password.php, api/resend_verify.php.

   For backward compatibility with pages not yet migrated
   (profile.html, seller.html, etc.), we still mirror the logged-in
   user into localStorage under the same keys as before
   (swiftLoggedIn / swiftCurrentUser / swiftToken) every time auth
   state changes.
   ══════════════════════════════════════════════════════════════ */

// ── Desktop flip ─────────────────────────────────────
const registerButton = document.getElementById('register');
const loginButton    = document.getElementById('login');
const container      = document.getElementById('container');
if (registerButton) registerButton.onclick = () => container.className = 'active';
if (loginButton)    loginButton.onclick    = () => container.className = 'close';

// ── Role selector ────────────────────────────────────
function selectRole(role) {
    document.getElementById('regRole').value = role;
    document.getElementById('roleBuyer').classList.toggle('selected', role === 'buyer');
    document.getElementById('roleSeller').classList.toggle('selected', role === 'seller');
}

// ── Mobile tab switch ────────────────────────────────
function mobSwitch(tab) {
    document.querySelector('.login').classList.toggle('mob-active', tab === 'login');
    document.querySelector('.register').classList.toggle('mob-active', tab === 'register');
    window.scrollTo(0, 0);
}

// ── Remember Me: prefill email left from a previous visit ─
document.addEventListener('DOMContentLoaded', () => {
    const rememberedEmail = localStorage.getItem('swiftRememberedEmail');
    const emailInput      = document.getElementById('loginEmail');
    const rememberBox     = document.getElementById('rememberMe');
    if (rememberedEmail && emailInput && rememberBox) {
        emailInput.value    = rememberedEmail;
        rememberBox.checked = true;
    }
});

// ── syncLegacyUserStorage() lives in supabase-client.js now — it runs
//    automatically on every auth state change (see onAuthStateChange
//    there), so login/register below just need to await it once to get
//    the freshly-synced legacy user object back for the redirect logic.

function showToast(message) {
    const toast = document.getElementById('swiftToast');
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(showToast._timer);
    showToast._timer = setTimeout(() => toast.classList.remove('show'), 2500);
}

// ── Social connect buttons — real Supabase OAuth ─────
// Provider IDs Supabase expects: github, facebook, linkedin_oidc, twitter.
// Each provider must first be enabled (with its own client id/secret) in
// Supabase Dashboard → Authentication → Providers — same "not set up yet"
// idea as the old oauth_providers.php, just configured there instead.
const OAUTH_PROVIDER_MAP = {
    facebook: 'facebook',
    twitter:  'twitter',
    github:   'github',
    linkedin: 'linkedin_oidc',
};

document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('.social-icon').forEach(el => {
        el.addEventListener('click', async (e) => {
            e.preventDefault();
            const key      = (el.dataset.provider || '').toLowerCase();
            const provider = OAUTH_PROVIDER_MAP[key];
            if (!provider) return;

            const role = document.getElementById('regRole')?.value || 'buyer';
            const { error } = await sb.auth.signInWithOAuth({
                provider,
                options: {
                    redirectTo: window.location.origin + window.location.pathname.replace(/login\.html$/, '') + 'oauth_result.html',
                    queryParams: { role }, // read back out of the URL by oauth_result.html if you want role-aware signup there
                }
            });
            if (error) showToast(`${key[0].toUpperCase() + key.slice(1)} login isn't set up yet.`);
        });
    });
});

// ════════════════════════════════════════════════════
//  REGISTER
// ════════════════════════════════════════════════════
document.getElementById('registerBtn').addEventListener('click', async function () {
    const name     = document.getElementById('regName').value.trim();
    const email    = document.getElementById('regEmail').value.trim();
    const password = document.getElementById('regPassword').value;
    const phone    = document.getElementById('regPhone').value.trim();
    const role     = document.getElementById('regRole').value;
    const errorEl  = document.getElementById('regError');

    errorEl.style.color = '#ff4b2b';
    if (!name || !email || !password || !phone) { errorEl.textContent = 'Please fill in all required fields.'; return; }
    if (password.length < 6)          { errorEl.textContent = 'Password must be at least 6 characters.'; return; }

    this.disabled = true; this.textContent = 'Creating account…';

    try {
        // name/phone/role ride along as user_metadata — the
        // handle_new_user() trigger on the database reads them to
        // populate the profiles row automatically.
        const { data, error } = await sb.auth.signUp({
            email, password,
            options: { data: { name, phone, role } }
        });

        if (error) { errorEl.textContent = error.message; return; }

        // Supabase's default settings require email confirmation before a
        // session is issued — data.session is null in that case.
        if (!data.session) {
            errorEl.style.color = '#4ecdc4';
            errorEl.textContent = '✅ Account created! Check your email to confirm, then log in.';
            this.textContent = 'Create Account';
            return;
        }

        await syncLegacyUserStorage(data.session);
        errorEl.style.color = '#4ecdc4';
        errorEl.textContent = '✅ Account created! Redirecting…';
        setTimeout(() => {
            window.location.href = role === 'seller' ? 'seller.html' : 'profile.html';
        }, 1500);

    } catch (err) {
        errorEl.textContent = 'Network error. Check your connection and try again.';
    } finally {
        this.disabled = false;
        if (this.textContent === 'Creating account…') this.textContent = 'Create Account';
    }
});

// ════════════════════════════════════════════════════
//  LOGIN
// ════════════════════════════════════════════════════
document.getElementById('loginBtn').addEventListener('click', async function () {
    const email    = document.getElementById('loginEmail').value.trim();
    const password = document.getElementById('loginPassword').value;
    const errorEl  = document.getElementById('loginError');

    errorEl.style.color = '#ff4b2b';
    if (!email || !password) { errorEl.textContent = 'Please enter your email and password.'; return; }

    this.disabled = true; this.textContent = 'Logging in…';

    try {
        const { data, error } = await sb.auth.signInWithPassword({ email, password });

        if (error) {
            if (error.message.toLowerCase().includes('email not confirmed')) {
                errorEl.innerHTML = `Your email is not verified yet. 
                    <span id="resendLink" style="color:#1325e8;cursor:pointer;text-decoration:underline;">
                    Resend verification email</span>`;
                document.getElementById('resendLink')?.addEventListener('click', () => resendVerify(email));
                return;
            }
            errorEl.textContent = 'Incorrect email or password.';
            return;
        }

        const legacyUser = await syncLegacyUserStorage(data.session);

        if (document.getElementById('rememberMe')?.checked) {
            localStorage.setItem('swiftRememberedEmail', email);
        } else {
            localStorage.removeItem('swiftRememberedEmail');
        }

        errorEl.style.color = '#4ecdc4';
        errorEl.textContent = 'Login successful! Redirecting…';
        setTimeout(() => {
            window.location.href = (legacyUser?.role === 'seller') ? 'seller.html' : 'profile.html';
        }, 800);

    } catch (err) {
        errorEl.textContent = 'Network error. Check your connection and try again.';
    } finally {
        this.disabled = false; this.textContent = 'Log In';
    }
});

// ════════════════════════════════════════════════════
//  FORGOT PASSWORD
// ════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', () => {
    injectForgotModal();
    const forgetSpan = document.querySelector('span.forget');
    if (forgetSpan) {
        forgetSpan.style.cursor = 'pointer';
        forgetSpan.onclick = () => document.getElementById('forgotModal').style.display = 'flex';
    }
});

function injectForgotModal() {
    const modal = document.createElement('div');
    modal.id = 'forgotModal';
    modal.innerHTML = `
    <div class="fm-backdrop" onclick="closeForgot()"></div>
    <div class="fm-box">
        <button class="fm-close" onclick="closeForgot()">✕</button>
        <div class="fm-icon">🔐</div>
        <h2>Forgot Password?</h2>
        <p>Enter your email and we'll send you a reset link.</p>
        <input type="email" id="forgotEmail" placeholder="Your email address">
        <button id="forgotBtn" onclick="sendReset()">Send Reset Link</button>
        <div id="forgotMsg"></div>
    </div>`;

    const style = document.createElement('style');
    style.textContent = `
    #forgotModal { position:fixed;inset:0;display:none;align-items:center;justify-content:center;z-index:9999; }
    .fm-backdrop { position:absolute;inset:0;background:rgba(0,0,0,.5);backdrop-filter:blur(3px); }
    .fm-box { position:relative;background:#fff;border-radius:16px;padding:44px 28px 36px;
        width:90%;max-width:400px;text-align:center;box-shadow:0 12px 40px rgba(0,0,0,.2);
        animation:fmIn .25s ease; }
    @keyframes fmIn { from{transform:scale(.9);opacity:0} to{transform:scale(1);opacity:1} }
    .fm-close { position:absolute;top:10px;right:10px;z-index:2;width:28px;height:28px;padding:0;margin:0;
        display:flex;align-items:center;justify-content:center;background:#f2f2f4;border:none;border-radius:50%;
        font-size:14px;line-height:1;cursor:pointer;color:#777;transition:background .15s ease,color .15s ease; }
    .fm-close:hover { background:#e6e6ea; color:#333; }
    .fm-icon { font-size:44px; margin:10px 0 10px; }
    .fm-box h2 { font-size:20px;color:#1d2129;margin-bottom:6px; }
    .fm-box p  { font-size:13px;color:#888;margin-bottom:18px; }
    .fm-box input { width:100%;padding:12px 14px;border:2px solid #e0e0e0;border-radius:10px;
        font-size:14px;margin-bottom:12px;outline:none;font-family:inherit; }
    .fm-box input:focus { border-color:#8f10b7; }
    #forgotBtn { width:100%;padding:13px;border:none;border-radius:40px;
        background:linear-gradient(135deg,#1325e8,#8f10b7);color:#fff;
        font-size:15px;font-weight:700;cursor:pointer;font-family:inherit; }
    #forgotBtn:disabled { opacity:.6;cursor:not-allowed; }
    #forgotMsg { font-size:13px;margin-top:12px;min-height:18px; }`;
    document.head.appendChild(style);
    document.body.appendChild(modal);
}

function closeForgot() {
    document.getElementById('forgotModal').style.display = 'none';
    document.getElementById('forgotMsg').textContent = '';
    document.getElementById('forgotEmail').value = '';
}

async function sendReset() {
    const email = document.getElementById('forgotEmail').value.trim();
    const msgEl = document.getElementById('forgotMsg');
    const btn   = document.getElementById('forgotBtn');

    if (!email) { msgEl.style.color='#e74c3c'; msgEl.textContent = 'Please enter your email.'; return; }

    btn.disabled = true; btn.textContent = 'Sending…';

    try {
        const { error } = await sb.auth.resetPasswordForEmail(email, {
            redirectTo: window.location.origin + window.location.pathname.replace(/login\.html$/, '') + 'reset_password.html'
        });
        msgEl.style.color = error ? '#e74c3c' : '#2e7d32';
        msgEl.textContent = error ? error.message : 'If that email is registered, a reset link has been sent.';
        if (!error) btn.textContent = '✅ Sent!';
        else { btn.disabled = false; btn.textContent = 'Send Reset Link'; }
    } catch (err) {
        msgEl.style.color = '#e74c3c';
        msgEl.textContent = 'Network error. Check your connection and try again.';
        btn.disabled = false; btn.textContent = 'Send Reset Link';
    }
}

// ════════════════════════════════════════════════════
//  RESEND VERIFICATION EMAIL
// ════════════════════════════════════════════════════
async function resendVerify(email) {
    const errorEl = document.getElementById('loginError');
    errorEl.style.color = '#888';
    errorEl.textContent = 'Sending verification email…';
    try {
        const { error } = await sb.auth.resend({ type: 'signup', email });
        errorEl.style.color = error ? '#ff4b2b' : '#4ecdc4';
        errorEl.textContent = error ? error.message : 'Verification email sent!';
    } catch (_) {
        errorEl.textContent = 'Failed to resend. Try again.';
    }
}
