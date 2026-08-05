/* ══════════════════════════════════════════════════
   D-SWIFT  |  script.js
   Contact page — sends form straight to Supabase
   (requires supabase-client.js to be loaded first)
══════════════════════════════════════════════════ */

document.addEventListener('DOMContentLoaded', () => {
    const sendBtn = document.querySelector('.contact_form_submit');
    if (!sendBtn) return;

    sendBtn.addEventListener('click', async () => {
        const name    = document.querySelector('input[placeholder="Name"]')?.value.trim();
        const email   = document.querySelector('input[placeholder="Email"]')?.value.trim();
        const message = document.querySelector('textarea')?.value.trim();

        if (!name || !email || !message) {
            alert('Please fill in all fields.');
            return;
        }

        sendBtn.disabled    = true;
        sendBtn.textContent = 'Sending…';

        const { error } = await sb.from('contacts').insert({ name, email, message });

        if (!error) {
            alert('✅ Message received! We will get back to you soon.');
            document.querySelector('input[placeholder="Name"]').value  = '';
            document.querySelector('input[placeholder="Email"]').value = '';
            document.querySelector('textarea').value = '';
        } else {
            alert('❌ ' + (error.message || 'Something went wrong.'));
        }

        sendBtn.disabled    = false;
        sendBtn.textContent = 'Send';
    });
});
