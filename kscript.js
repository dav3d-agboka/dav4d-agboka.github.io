/* ══════════════════════════════════════════════════════════════
   D-SWIFT  |  kscript.js  (Supabase version)
   Requires supabase-client.js to be loaded first (defines `sb` and
   syncLegacyUserStorage()).
   - Products loaded from Supabase (public read via RLS)
   - Wishlist synced with Supabase (if logged in)
   - Cart persists in localStorage until paid for or removed
   - Checkout calls Paystack, then the place_order() Postgres function
   ══════════════════════════════════════════════════════════════ */

const SWIFT_FEE       = 0.05;
const PAYSTACK_KEY    = 'pk_test_5c141c098cbdf209fcb1258ce762861f7573f8f7'; // replace with your live key
const DELIVERY_PHONE  = '233552767149'; // fixed D-Swift delivery partner — international format, no + or leading 0
const CART_KEY        = 'swiftCart';

// ── Auth helpers ──────────────────────────────────
// Read from the legacy localStorage mirror that supabase-client.js keeps
// in sync (see syncLegacyUserStorage() there). Prefer sb.auth.getSession()
// directly in any new code.
function isLoggedIn() { return localStorage.getItem('swiftLoggedIn') === 'true'; }
function getUser()    { return JSON.parse(localStorage.getItem('swiftCurrentUser') || 'null'); }

// ── Cart persistence ───────────────────────────────
function loadCart() {
    try { return JSON.parse(localStorage.getItem(CART_KEY) || '[]'); }
    catch (_) { return []; }
}
function saveCart() {
    localStorage.setItem(CART_KEY, JSON.stringify(cart));
}

// ── Products cache ────────────────────────────────
let allProducts = [];
let wishIds     = [];
let cart        = loadCart();
let currentCategory = 'all';
let currentSearch   = '';

// ── DOM refs ──────────────────────────────────────
const productsGrid   = document.getElementById('productsGrid');
const cartIcon       = document.getElementById('cartIcon');
const mobileCartIcon = document.getElementById('mobileCartIcon');
const mobCartBtn     = document.getElementById('mobCartBtn');
const cartContainer  = document.getElementById('cartContainer');
const closeCart      = document.getElementById('closeCart');
const overlay        = document.getElementById('overlay');
const cartItemsEl    = document.getElementById('cartItems');
const cartTotalEl    = document.getElementById('cartTotal');
const checkoutBtn    = document.querySelector('.checkout-btn');

// ── Maps a Supabase `products` row (snake_case) to the camelCase shape
//    the rest of this file (and the old PHP API) already expects. ──
function mapProductRow(p) {
    return {
        id:          p.id,
        sellerId:    p.seller_id,
        sellerName:  p.seller_name,
        sellerPhone: p.seller_phone,
        name:        p.name,
        category:    p.category,
        price:       parseFloat(p.price),
        description: p.description,
        image:       p.image,
        extraImages: p.extra_images || [],
    };
}

// ════════════════════════════════════════════════
//  INIT
// ════════════════════════════════════════════════
async function init() {
    // Make sure the legacy localStorage mirror reflects the *current*
    // Supabase session before anything below reads isLoggedIn()/getUser()
    // — supabase-client.js's onAuthStateChange listener also does this,
    // but it fires asynchronously, so we await it explicitly here too.
    const { data: { session } } = await sb.auth.getSession();
    await syncLegacyUserStorage(session);

    injectPaystackScript();
    createSuccessModal();
    createProductModal();
    setupWishlistPanel();
    setupEventListeners();
    startBannerSlider();
    startFlashTimer();
    updateNavForUser();
    refreshDeliveryNote();
    updateCart(); // reflect the cart restored from localStorage right away, not just after the next add/remove

    setupSearch();

    // Load wishlist if logged in
    if (isLoggedIn()) {
        const user = getUser();
        try {
            const { data, error } = await sb.from('wishlist').select('product_id').eq('user_id', user.id);
            if (!error) wishIds = (data || []).map(w => w.product_id);
        } catch (_) {}
    }
    updateWishlistBadge(); // reflect the restored wishlist right away, not just after the next toggle

    // Load products
    await loadProducts();
}

async function loadProducts(cat = 'all') {
    if (productsGrid) productsGrid.innerHTML = '<div style="text-align:center;padding:40px;color:#aaa;"><i class="fas fa-spinner fa-spin" style="font-size:2rem;"></i><p>Loading products…</p></div>';
    try {
        let query = sb.from('products').select('*')
            .order('is_builtin', { ascending: false })
            .order('created_at', { ascending: false });
        if (cat && cat !== 'all') query = query.eq('category', cat);

        const { data, error } = await query;
        if (error) throw error;
        allProducts = (data || []).map(mapProductRow);
        renderProducts();
    } catch (err) {
        if (productsGrid) productsGrid.innerHTML = '<div style="text-align:center;padding:40px;color:#e05555;"><i class="fas fa-exclamation-triangle"></i><p>Could not load products. Please try again shortly.</p></div>';
    }
}

// ════════════════════════════════════════════════
//  PRODUCT RENDERING
// ════════════════════════════════════════════════
function renderProducts() {
    if (!productsGrid) return;
    productsGrid.innerHTML = '';

    // Filter by search term
    const q = currentSearch.toLowerCase().trim();
    const filtered = q
        ? allProducts.filter(p =>
            p.name.toLowerCase().includes(q) ||
            p.category.toLowerCase().includes(q) ||
            (p.description && p.description.toLowerCase().includes(q)) ||
            (p.sellerName && p.sellerName.toLowerCase().includes(q))
          )
        : allProducts;

    if (!filtered.length) {
        productsGrid.innerHTML = q
            ? `<div style="text-align:center;padding:40px;color:#aaa;">
                <i class="fas fa-search" style="font-size:2rem;"></i>
                <p>No products found for "<strong>${q}</strong>"</p>
               </div>`
            : '<div style="text-align:center;padding:40px;color:#aaa;"><i class="fas fa-box-open" style="font-size:2rem;"></i><p>No products found.</p></div>';
        return;
    }
    filtered.forEach(product => {
        const wishlisted = wishIds.includes(product.id);
        const card = document.createElement('div');
        card.className = 'product-card';
        const sellerBadge = product.sellerId
            ? `<div style="font-size:0.65rem;color:#888;margin-top:2px;">by ${product.sellerName || 'Seller'}</div>`
            : '';
        card.innerHTML = `
            <div class="product-image" style="position:relative;cursor:pointer;" data-id="${product.id}">
                <img src="${product.image}" alt="${product.name}" loading="lazy"
                     onerror="this.style.background='#f0f0f0';this.src='';">
                <button class="heart-btn ${wishlisted ? 'active' : ''}" data-id="${product.id}" title="Wishlist">
                    <i class="${wishlisted ? 'fas' : 'far'} fa-heart"></i>
                </button>
            </div>
            <div class="product-info" style="cursor:pointer;" data-id="${product.id}">
                <div class="product-category">${product.category}</div>
                <h3 class="product-name">${product.name}</h3>
                ${sellerBadge}
                <div class="product-price">GH&#8373; ${parseFloat(product.price).toFixed(2)}</div>
                <div class="product-actions">
                    <button class="add-to-cart" data-id="${product.id}">Add to Cart</button>
                </div>
            </div>`;
        productsGrid.appendChild(card);
    });
}

function updateAllHearts() {
    document.querySelectorAll('.heart-btn').forEach(btn => {
        const id = parseInt(btn.getAttribute('data-id'));
        const on = wishIds.includes(id);
        btn.classList.toggle('active', on);
        btn.querySelector('i').className = on ? 'fas fa-heart' : 'far fa-heart';
    });
}

// ════════════════════════════════════════════════
//  WISHLIST
// ════════════════════════════════════════════════
async function toggleWishlist(id) {
    if (!isLoggedIn()) {
        showNotification('Login to save to wishlist!');
        setTimeout(() => window.location.href = 'login.html', 1200);
        return false;
    }
    const user = getUser();
    const already = wishIds.includes(id);
    try {
        if (already) {
            const { error } = await sb.from('wishlist').delete().eq('user_id', user.id).eq('product_id', id);
            if (error) { showNotification('Could not update wishlist. Please try again.'); return false; }
            wishIds = wishIds.filter(x => x !== id);
        } else {
            const { error } = await sb.from('wishlist').insert({ user_id: user.id, product_id: id });
            if (error) { showNotification('Could not update wishlist. Please try again.'); return false; }
            wishIds.push(id);
        }
        updateWishlistBadge();
        updateAllHearts();
        return !already;
    } catch (_) { return false; }
}

function isWishlisted(id) { return wishIds.includes(id); }

function updateWishlistBadge() {
    const count = wishIds.length;
    const badge = document.getElementById('wishlistBadge');
    if (!badge) return;
    if (count > 0) { badge.textContent = count; badge.style.display = 'flex'; }
    else badge.style.display = 'none';
}

// ════════════════════════════════════════════════
//  PRODUCT MODAL
// ════════════════════════════════════════════════
function createProductModal() {
    const modal = document.createElement('div');
    modal.id = 'productModal';
    modal.innerHTML = `
    <div class="pm-backdrop" id="pmBackdrop"></div>
    <div class="pm-sheet" id="pmSheet">
        <button class="pm-close" id="pmClose"><i class="fas fa-times"></i></button>
        <div class="pm-gallery" id="pmGallery"></div>
        <div class="pm-thumbs" id="pmThumbs"></div>
        <div class="pm-body">
            <div class="pm-cat" id="pmCat"></div>
            <h2 class="pm-name" id="pmName"></h2>
            <div class="pm-price" id="pmPrice"></div>
            <div class="pm-seller" id="pmSeller"></div>
            <div class="pm-desc-label">Description</div>
            <div class="pm-desc" id="pmDesc"></div>
            <div class="pm-actions">
                <button class="pm-wishlist-btn" id="pmWishBtn"><i class="fas fa-heart"></i> <span>Wishlist</span></button>
                <button class="pm-cart-btn" id="pmCartBtn"><i class="fas fa-shopping-cart"></i> Add to Cart</button>
            </div>
        </div>
    </div>`;
    document.body.appendChild(modal);
    document.getElementById('pmBackdrop').addEventListener('click', closeProductModal);
    document.getElementById('pmClose').addEventListener('click', closeProductModal);
}

function openProductModal(product) {
    const allImages = [product.image, ...(product.extraImages || [])].filter(Boolean);
    const gallery   = document.getElementById('pmGallery');
    const thumbs    = document.getElementById('pmThumbs');

    gallery.innerHTML = allImages.length
        ? `<img src="${allImages[0]}" class="pm-main-img" id="pmMainImg" alt="${product.name}">`
        : `<div class="pm-no-img"><i class="fas fa-image"></i></div>`;
    thumbs.innerHTML  = allImages.length > 1
        ? allImages.map((img, i) =>
            `<img src="${img}" class="pm-thumb ${i===0?'active':''}" onclick="switchModalImg(this,'${img}')" alt="img${i}">`
          ).join('') : '';

    document.getElementById('pmCat').textContent   = product.category || '';
    document.getElementById('pmName').textContent  = product.name;
    document.getElementById('pmPrice').textContent = `GH₵ ${parseFloat(product.price).toFixed(2)}`;
    document.getElementById('pmSeller').innerHTML  = product.sellerId
        ? `<i class="fas fa-store"></i> Sold by ${product.sellerName || 'Seller'}`
        : `<i class="fas fa-store"></i> Sold by D-Swift`;
    document.getElementById('pmDesc').textContent  = product.description || 'No description provided.';

    const wishBtn    = document.getElementById('pmWishBtn');
    const wishlisted = isWishlisted(product.id);
    wishBtn.classList.toggle('active', wishlisted);
    wishBtn.querySelector('span').textContent = wishlisted ? 'Wishlisted' : 'Wishlist';

    wishBtn.onclick = async () => {
        const now = await toggleWishlist(product.id);
        wishBtn.classList.toggle('active', now);
        wishBtn.querySelector('span').textContent = now ? 'Wishlisted' : 'Wishlist';
        showNotification(now ? `${product.name} added to wishlist!` : 'Removed from wishlist.');
    };
    document.getElementById('pmCartBtn').onclick = () => { addToCart(product.id); closeProductModal(); };

    document.getElementById('productModal').classList.add('open');
    document.body.style.overflow = 'hidden';
}

function closeProductModal() {
    document.getElementById('productModal').classList.remove('open');
    document.body.style.overflow = '';
}
function switchModalImg(thumb, src) {
    document.getElementById('pmMainImg').src = src;
    document.querySelectorAll('.pm-thumb').forEach(t => t.classList.remove('active'));
    thumb.classList.add('active');
}

// ════════════════════════════════════════════════
//  CART
// ════════════════════════════════════════════════
function addToCart(id) {
    const product = allProducts.find(p => p.id === id);
    if (!product) return;
    const existing = cart.find(i => i.id === id);
    if (existing) existing.quantity++;
    else cart.push({ ...product, quantity: 1 });
    updateCart();
    showNotification(`${product.name} added to cart!`);
}
function removeFromCart(id) {
    cart = cart.filter(i => i.id !== id);
    updateCart();
}
function updateQuantity(id, change) {
    const item = cart.find(i => i.id === id);
    if (!item) return;
    item.quantity += change;
    if (item.quantity <= 0) removeFromCart(id);
    else updateCart();
}
function updateCart() {
    saveCart();
    const total = cart.reduce((s, i) => s + i.price * i.quantity, 0);
    if (cart.length === 0) {
        cartItemsEl.innerHTML = `<div class="cart-empty"><i class="fas fa-shopping-cart"></i><p>Your cart is empty</p></div>`;
    } else {
        cartItemsEl.innerHTML = '';
        cart.forEach(item => {
            const el = document.createElement('div');
            el.className = 'cart-item';
            el.innerHTML = `
                <div class="cart-item-image"><img src="${item.image}" alt="${item.name}" onerror="this.style.display='none'"></div>
                <div class="cart-item-details">
                    <div class="cart-item-name">${item.name}</div>
                    <div class="cart-item-price">GH&#8373; ${item.price.toFixed(2)}</div>
                    <div class="cart-item-controls">
                        <button class="quantity-btn minus" data-id="${item.id}">-</button>
                        <span class="quantity">${item.quantity}</span>
                        <button class="quantity-btn plus"  data-id="${item.id}">+</button>
                        <button class="remove-item" data-id="${item.id}"><i class="fas fa-trash"></i></button>
                    </div>
                </div>`;
            cartItemsEl.appendChild(el);
        });
        document.querySelectorAll('.quantity-btn.minus').forEach(btn =>
            btn.addEventListener('click', e => updateQuantity(parseInt(e.currentTarget.getAttribute('data-id')), -1)));
        document.querySelectorAll('.quantity-btn.plus').forEach(btn =>
            btn.addEventListener('click', e => updateQuantity(parseInt(e.currentTarget.getAttribute('data-id')), 1)));
    }
    if (cartTotalEl) cartTotalEl.textContent = `GH₵ ${total.toFixed(2)}`;
    const count = cart.reduce((s, i) => s + i.quantity, 0);
    document.querySelectorAll('.cart-count').forEach(el => el.textContent = count);
}

// ════════════════════════════════════════════════
//  CHECKOUT (Paystack → place_order() Postgres function)
// ════════════════════════════════════════════════
function injectPaystackScript() {
    if (document.getElementById('paystackScript')) return;
    const s = document.createElement('script');
    s.id = 'paystackScript'; s.src = 'https://js.paystack.co/v1/inline.js'; s.async = true;
    document.head.appendChild(s);
}

function refreshDeliveryNote() {
    const note = document.getElementById('deliveryNote');
    const text = document.getElementById('deliveryNoteText');
    if (!note || !text) return;

    const user = isLoggedIn() ? getUser() : null;
    const hasPhone    = !!(user && user.phone);
    const hasLocation = !!(user && user.location);

    if (!user) {
        note.classList.remove('missing');
        text.textContent = 'We deliver every order — log in to see your delivery details.';
        return;
    }
    if (!hasPhone) {
        note.classList.add('missing');
        text.textContent = 'Add a phone number to your profile so our delivery partner can reach you.';
        return;
    }
    if (!hasLocation) {
        note.classList.add('missing');
        text.textContent = 'Add a delivery address to your profile so our delivery partner knows where to deliver.';
        return;
    }
    note.classList.remove('missing');
    text.textContent = `Delivering to ${user.location} — we'll contact you on ${user.phone}.`;
}

// ════════════════════════════════════════════════
//  ORDER SUCCESS MODAL  (shown right after payment)
// ════════════════════════════════════════════════
function injectSuccessModalStyles() {
    if (document.getElementById('smStyles')) return;
    const style = document.createElement('style');
    style.id = 'smStyles';
    style.textContent = `
        #successModal, #errorModal { display:none; position:fixed; inset:0; z-index:4000; align-items:center; justify-content:center; padding:20px; }
        #successModal.open, #errorModal.open { display:flex; }
        #successModal .sm-backdrop, #errorModal .sm-backdrop { position:absolute; inset:0; background:rgba(26,26,46,0.55); backdrop-filter:blur(2px); }
        #successModal .sm-box, #errorModal .sm-box { position:relative; background:#fff; border-radius:20px; width:100%; max-width:400px; overflow:hidden; box-shadow:0 20px 60px rgba(0,0,0,0.3); text-align:center; font-family:'Poppins',Arial,sans-serif; max-height:90vh; overflow-y:auto; }
        #successModal .sm-top, #errorModal .sm-top { background:linear-gradient(135deg,#1DBF73,#0ea968); padding:34px 24px 26px; color:#fff; }
        #successModal .sm-check, #errorModal .sm-check { width:68px; height:68px; border-radius:50%; background:rgba(255,255,255,0.2); margin:0 auto 12px; display:flex; align-items:center; justify-content:center; font-size:2.2rem; }
        #successModal .sm-top h2, #errorModal .sm-top h2 { font-size:1.3rem; margin:0 0 4px; color:#fff; }
        #successModal .sm-top p, #errorModal .sm-top p { font-size:0.85rem; opacity:0.9; margin:0; color:#fff; }
        #successModal .sm-body, #errorModal .sm-body { padding:22px 26px 26px; }
        #successModal .sm-ref, #errorModal .sm-ref { font-size:0.78rem; color:#888; background:#f6f7fb; border-radius:8px; padding:8px 12px; margin-bottom:14px; font-family:monospace; letter-spacing:0.3px; }
        #successModal .sm-ref b, #errorModal .sm-ref b { color:#1a1a2e; }
        #successModal .sm-row, #errorModal .sm-row { display:flex; justify-content:space-between; align-items:center; font-size:0.85rem; color:#555; padding:7px 0; border-bottom:1px solid #f0f0f0; }
        #successModal .sm-row:last-of-type, #errorModal .sm-row:last-of-type { border-bottom:none; }
        #successModal .sm-row .val, #errorModal .sm-row .val { font-weight:700; color:#1a1a2e; }
        #successModal .sm-note, #errorModal .sm-note { display:flex; align-items:flex-start; gap:8px; text-align:left; background:#f0fbf8; border:1px solid #d4f2ec; border-radius:10px; padding:10px 12px; margin:14px 0 18px; font-size:0.78rem; color:#333; }
        #successModal .sm-note i, #errorModal .sm-note i { color:#1DBF73; margin-top:2px; }
        #successModal .sm-actions, #errorModal .sm-actions { display:flex; flex-direction:column; gap:10px; }
        #successModal .sm-btn, #errorModal .sm-btn { display:block; width:100%; padding:12px; border-radius:30px; font-size:0.9rem; font-weight:700; cursor:pointer; border:none; text-decoration:none; font-family:inherit; transition:opacity 0.2s; box-sizing:border-box; }
        #successModal .sm-btn.primary, #errorModal .sm-btn.primary { background:#ff4b2b; color:#fff; }
        #successModal .sm-btn.secondary, #errorModal .sm-btn.secondary { background:#f0f0f0; color:#1a1a2e; }
        #successModal .sm-btn.whatsapp, #errorModal .sm-btn.whatsapp { background:#25D366; color:#fff; }
        #successModal .sm-btn.whatsapp i, #errorModal .sm-btn.whatsapp i { margin-right:4px; }
        #successModal .sm-btn:hover, #errorModal .sm-btn:hover { opacity:0.9; }
        #errorModal .sm-note i { color:#c0392b !important; }
    `;
    document.head.appendChild(style);
}

function createSuccessModal() {
    if (document.getElementById('successModal')) return;
    injectSuccessModalStyles();
    const modal = document.createElement('div');
    modal.id = 'successModal';
    modal.innerHTML = `
    <div class="sm-backdrop" id="smBackdrop"></div>
    <div class="sm-box">
        <div class="sm-top">
            <div class="sm-check"><i class="fas fa-check"></i></div>
            <h2>Order Confirmed!</h2>
            <p>Payment received — your order is on its way to being packed.</p>
        </div>
        <div class="sm-body">
            <div class="sm-ref">Order Ref: <b id="smRef"></b></div>
            <div id="smItems"></div>
            <div class="sm-row"><span>Total Paid</span><span class="val" id="smTotal"></span></div>
            <div class="sm-note">
                <i class="fas fa-motorcycle"></i>
                <span>Our delivery partner has been notified automatically and will contact you to confirm your delivery address.</span>
            </div>
            <div class="sm-actions">
                <a class="sm-btn whatsapp" id="smDeliveryBtn" href="#" target="_blank" rel="noopener"><i class="fab fa-whatsapp"></i> Message Delivery Guy</a>
                <a class="sm-btn primary" id="smTrackBtn" href="#"><i class="fas fa-truck-fast"></i> Track My Order</a>
                <button class="sm-btn secondary" id="smCloseBtn">Continue Shopping</button>
            </div>
        </div>
    </div>`;
    document.body.appendChild(modal);
    document.getElementById('smBackdrop').addEventListener('click', closeSuccessModal);
    document.getElementById('smCloseBtn').addEventListener('click', closeSuccessModal);
}

function showSuccessModal(ref, items, total) {
    document.getElementById('smRef').textContent = ref;
    document.getElementById('smTotal').textContent = `GH₵ ${total.toFixed(2)}`;
    document.getElementById('smItems').innerHTML = items.map(i =>
        `<div class="sm-row"><span>${i.name} &times;${i.qty}</span><span class="val">GH&#8373; ${(i.price * i.qty).toFixed(2)}</span></div>`
    ).join('');

    const siteBase  = window.location.href.replace(/[^/]*$/, '');
    const trackUrl  = `${siteBase}track.html?ref=${encodeURIComponent(ref)}`;
    const riderUrl  = `${trackUrl}&role=rider`;
    document.getElementById('smTrackBtn').href = trackUrl;

    const user      = getUser();
    const itemsText = items.map(i => `${i.name} x${i.qty}`).join(', ');
    const waMsg = `Hi, I just placed order #${ref} on D-Swift (${itemsText}) — total GH₵ ${total.toFixed(2)}. `
                + `My name is ${user ? user.name : 'a D-Swift buyer'}`
                + `${user && user.phone ? ` and my number is ${user.phone}` : ''}`
                + `${user && user.location ? `, delivery address: ${user.location}` : ''}.\n\n`
                + `Please use this link to update me on my order status (Packed / Out for Delivery / Delivered):\n${riderUrl}`;
    document.getElementById('smDeliveryBtn').href =
        `https://wa.me/${DELIVERY_PHONE}?text=${encodeURIComponent(waMsg)}`;

    const modalEl = document.getElementById('successModal');
    modalEl.classList.add('open');
    modalEl.style.display = 'flex';
    document.body.style.overflow = 'hidden';
}

function closeSuccessModal() {
    const modalEl = document.getElementById('successModal');
    modalEl.classList.remove('open');
    modalEl.style.display = 'none';
    document.body.style.overflow = '';
}

function handleCheckout() {
    if (!cart.length) return;
    if (!isLoggedIn()) {
        showNotification('Please login to checkout!');
        setTimeout(() => window.location.href = 'login.html', 1200);
        return;
    }
    const user = getUser();
    if (!user) { window.location.href = 'login.html'; return; }

    if (!user.phone) {
        showNotification('Please add a phone number to your profile first.');
        setTimeout(() => window.location.href = 'profile.html', 1400);
        return;
    }
    if (!user.location) {
        showNotification('Please add a delivery address to your profile first.');
        setTimeout(() => window.location.href = 'profile.html', 1400);
        return;
    }

    const total     = cart.reduce((s, i) => s + i.price * i.quantity, 0);
    const totalKobo = Math.round(total * 100);

    if (typeof PaystackPop === 'undefined') {
        showNotification('Payment system loading… please try again in a moment.');
        return;
    }

    const ref = 'DSWIFT-' + Date.now();
    const handler = PaystackPop.setup({
        key:      PAYSTACK_KEY,
        email:    user.email,
        amount:   totalKobo,
        currency: 'GHS',
        ref,
        metadata: { custom_fields: [
            { display_name: 'Customer', variable_name: 'customer', value: user.name },
            { display_name: 'Items', variable_name: 'items', value: cart.map(i => `${i.name} x${i.quantity}`).join(', ') }
        ]},
        callback: response => onPaymentSuccess(response, user, total),
        onClose:  () => showNotification('Payment cancelled.')
    });
    handler.openIframe();
}

async function onPaymentSuccess(response, user, total) {
    const ref   = response.reference;
    const items = cart.map(i => ({
        id:         i.id,
        name:       i.name,
        price:      i.price,
        qty:        i.quantity,
        sellerId:    i.sellerId || null,
        sellerName:  i.sellerName || null,
        sellerPhone: i.sellerPhone || null
    }));

    // place_order() does everything orders.php's POST handler used to do
    // (insert the order, queue it for delivery, credit each seller's
    // sales with the 5% fee split, notify sellers) as one atomic,
    // security-definer database transaction.
    let saved = false;
    let serverError = 'Network error — could not reach the server.';
    try {
        const { error } = await sb.rpc('place_order', { p_ref: ref, p_items: items, p_total: total });
        if (!error) {
            saved = true;
        } else {
            serverError = error.message || 'Server error.';
        }
    } catch (err) {
        // keep default serverError — genuine network failure
    }

    cart = []; updateCart(); closeCartFn();

    if (saved) {
        showSuccessModal(ref, items, total);
    } else {
        showOrderSaveFailedModal(ref, total, serverError);
    }
}

// ════════════════════════════════════════════════
//  PAYMENT SUCCEEDED, BUT ORDER FAILED TO SAVE
// ════════════════════════════════════════════════
function showOrderSaveFailedModal(ref, total, errorMsg) {
    injectSuccessModalStyles();
    let modal = document.getElementById('errorModal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'errorModal';
        modal.innerHTML = `
        <div class="sm-backdrop" id="emBackdrop"></div>
        <div class="sm-box">
            <div class="sm-top" style="background:linear-gradient(135deg,#ff6b6b,#c0392b);">
                <div class="sm-check"><i class="fas fa-exclamation"></i></div>
                <h2>Payment Received — Order Issue</h2>
                <p>Your money was taken, but we couldn't save your order automatically.</p>
            </div>
            <div class="sm-body">
                <div class="sm-ref">Payment Ref: <b id="emRef"></b></div>
                <div class="sm-row"><span>Total Paid</span><span class="val" id="emTotal"></span></div>
                <div class="sm-note" style="background:#fff0f0;border-color:#ffd6d6;">
                    <i class="fas fa-circle-info" style="color:#c0392b;"></i>
                    <span id="emReason"></span>
                </div>
                <div class="sm-actions">
                    <a class="sm-btn primary" id="emContactBtn" href="mailto:dswift.ltd@gmail.com"><i class="fas fa-envelope"></i> Contact Support</a>
                    <button class="sm-btn secondary" id="emCloseBtn">Close</button>
                </div>
            </div>
        </div>`;
        document.body.appendChild(modal);
        document.getElementById('emBackdrop').addEventListener('click', closeOrderSaveFailedModal);
        document.getElementById('emCloseBtn').addEventListener('click', closeOrderSaveFailedModal);
    }
    document.getElementById('emRef').textContent = ref;
    document.getElementById('emTotal').textContent = `GH₵ ${total.toFixed(2)}`;
    document.getElementById('emReason').textContent =
        `Please email us with this payment reference so we can confirm your order manually. Reason: ${errorMsg}`;
    document.getElementById('emContactBtn').href =
        `mailto:dswift.ltd@gmail.com?subject=${encodeURIComponent('Order not saved — ref ' + ref)}&body=${encodeURIComponent('My payment reference is ' + ref + ' for GH₵ ' + total.toFixed(2) + '. My order did not save on the site. Please help me complete it.')}`;
    modal.classList.add('open');
    document.body.style.overflow = 'hidden';
}
function closeOrderSaveFailedModal() {
    const modal = document.getElementById('errorModal');
    if (modal) modal.classList.remove('open');
    document.body.style.overflow = '';
}

// ════════════════════════════════════════════════
//  SEARCH
// ════════════════════════════════════════════════
function setupSearch() {
    const inputs = [
        document.querySelector('.mobile-search-bar input'),
        document.querySelector('.desktop-search input')
    ].filter(Boolean);

    inputs.forEach(input => {
        input.addEventListener('input', async () => {
            currentSearch = input.value;
            inputs.forEach(i => { if (i !== input) i.value = input.value; });

            if (currentSearch.trim() && currentCategory !== 'all') {
                currentCategory = 'all';
                document.querySelectorAll('.category-btn').forEach(b =>
                    b.classList.toggle('active', b.getAttribute('data-cat') === 'all'));
                await loadProducts('all');
                return;
            }
            renderProducts();
        });

        input.addEventListener('keydown', e => {
            if (e.key === 'Escape') {
                input.value = '';
                currentSearch = '';
                inputs.forEach(i => i.value = '');
                renderProducts();
            }
        });
    });
}

// ════════════════════════════════════════════════
//  EVENT LISTENERS
// ════════════════════════════════════════════════
function setupEventListeners() {
    [cartIcon, mobileCartIcon, mobCartBtn].forEach(el => {
        if (el) el.addEventListener('click', openCart);
    });
    if (closeCart) closeCart.addEventListener('click', closeCartFn);
    if (overlay)   overlay.addEventListener('click', closeCartFn);

    document.addEventListener('click', async e => {
        const heartBtn = e.target.closest('.heart-btn');
        if (heartBtn) {
            e.stopPropagation();
            const id      = parseInt(heartBtn.getAttribute('data-id'));
            const product = allProducts.find(p => p.id === id);
            const now     = await toggleWishlist(id);
            showNotification(now ? `${product?.name || 'Item'} added to wishlist!` : 'Removed from wishlist.');
            return;
        }
        if (e.target.classList.contains('add-to-cart')) {
            e.stopPropagation();
            addToCart(parseInt(e.target.getAttribute('data-id')));
            return;
        }
        const removeBtn = e.target.closest('.remove-item');
        if (removeBtn) { removeFromCart(parseInt(removeBtn.getAttribute('data-id'))); return; }

        const imgArea  = e.target.closest('.product-image[data-id]');
        const infoArea = e.target.closest('.product-info[data-id]');
        const clickedId = (imgArea || infoArea)?.getAttribute('data-id');
        if (clickedId) {
            const product = allProducts.find(p => p.id === parseInt(clickedId));
            if (product) openProductModal(product);
        }
    });

    document.querySelectorAll('.category-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.category-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentCategory = btn.getAttribute('data-cat') || 'all';
            currentSearch = '';
            document.querySelectorAll('.mobile-search-bar input, .desktop-search input')
                .forEach(i => i.value = '');
            loadProducts(currentCategory);
        });
    });

    if (checkoutBtn) checkoutBtn.addEventListener('click', handleCheckout);
}

function openCart() {
    cartContainer.classList.add('active');
    overlay.classList.add('active');
    refreshDeliveryNote();
}
function closeCartFn() { cartContainer.classList.remove('active'); overlay.classList.remove('active'); }

// ── Nav ──────────────────────────────────────────
function updateNavForUser() {
    const profileIcon = document.getElementById('profileIcon');
    if (!isLoggedIn()) return;
    const u = getUser();
    if (!u) return;

    if (profileIcon) {
        profileIcon.href  = u.role === 'seller' ? 'seller.html' : 'profile.html';
        profileIcon.title = u.name.split(' ')[0];
        profileIcon.innerHTML = u.profilePic
            ? `<img src="${u.profilePic}" alt="${u.name.split(' ')[0]}">`
            : `<i class="fas fa-user-circle"></i>`;
    }
}

// ── Notification toast ───────────────────────────
function showNotification(msg) {
    const n = document.createElement('div');
    n.textContent = msg;
    n.style.cssText = `position:fixed;bottom:80px;right:16px;background:var(--primary);color:white;
        padding:12px 20px;border-radius:8px;box-shadow:0 4px 12px rgba(0,0,0,0.15);
        z-index:3000;transform:translateY(60px);opacity:0;transition:all 0.3s;
        font-size:0.85rem;max-width:280px;`;
    document.body.appendChild(n);
    setTimeout(() => { n.style.transform = 'translateY(0)'; n.style.opacity = '1'; }, 10);
    setTimeout(() => {
        n.style.transform = 'translateY(60px)'; n.style.opacity = '0';
        setTimeout(() => document.body.removeChild(n), 300);
    }, 3000);
}

// ── Banner slider ────────────────────────────────
function startBannerSlider() {
    const slides = document.querySelectorAll('.banner-slide');
    const dots   = document.querySelectorAll('.dot');
    if (!slides.length) return;
    let current = 0;
    function goTo(i) {
        slides[current].classList.remove('active'); dots[current]?.classList.remove('active');
        current = i % slides.length;
        slides[current].classList.add('active'); dots[current]?.classList.add('active');
    }
    dots.forEach((d, i) => d.addEventListener('click', () => goTo(i)));
    setInterval(() => goTo(current + 1), 3500);
}

// ── Flash sale countdown ──────────────────────────
function startFlashTimer() {
    const el = document.getElementById('flashTimer');
    if (!el) return;
    let secs = 6 * 3600;
    setInterval(() => {
        secs--; if (secs < 0) secs = 6 * 3600;
        const h = String(Math.floor(secs / 3600)).padStart(2, '0');
        const m = String(Math.floor((secs % 3600) / 60)).padStart(2, '0');
        const s = String(secs % 60).padStart(2, '0');
        el.textContent = `${h}h : ${m}m : ${s}s`;
    }, 1000);
}

// ── Wishlist panel ───────────────────────────────
function setupWishlistPanel() {
    const closeBtn = document.getElementById('closeWishlist');
    const wOverlay = document.getElementById('wishlistOverlay');
    if (closeBtn) closeBtn.addEventListener('click', closeWishlistPanel);
    if (wOverlay) wOverlay.addEventListener('click', closeWishlistPanel);
}
function openWishlistPanel() {
    renderWishlistPanel();
    document.getElementById('wishlistPanel').classList.add('active');
    document.getElementById('wishlistOverlay').classList.add('active');
    document.body.style.overflow = 'hidden';
}
function closeWishlistPanel() {
    document.getElementById('wishlistPanel').classList.remove('active');
    document.getElementById('wishlistOverlay').classList.remove('active');
    document.body.style.overflow = '';
}
function renderWishlistPanel() {
    const items = allProducts.filter(p => wishIds.includes(p.id));
    const el    = document.getElementById('wishlistItemsList');
    updateWishlistBadge();
    if (!items.length) {
        el.innerHTML = `<div class="cart-empty"><i class="fas fa-heart" style="color:#ffcdd2;"></i>
            <p>Your wishlist is empty</p><p style="font-size:0.8rem;color:#bbb;margin-top:4px;">Tap ❤️ on any product</p></div>`;
        return;
    }
    el.innerHTML = items.map(p => `
        <div class="wl-item" id="wl-${p.id}">
            <img class="wl-item-img" src="${p.image}" alt="${p.name}" onerror="this.style.background='#f0f0f0';this.src='';">
            <div class="wl-item-info">
                <div class="wl-item-cat">${p.category}</div>
                <div class="wl-item-name">${p.name}</div>
                <div class="wl-item-price">GH₵ ${parseFloat(p.price).toFixed(2)}</div>
            </div>
            <div class="wl-item-btns">
                <button class="wl-add-cart" onclick="addToCart(${p.id})"><i class="fas fa-cart-plus"></i> Cart</button>
                <button class="wl-remove" onclick="removeFromWishlistPanel(${p.id})"><i class="fas fa-heart-broken"></i> Remove</button>
            </div>
        </div>`).join('');
}
async function removeFromWishlistPanel(id) {
    await toggleWishlist(id);
    const row = document.getElementById('wl-' + id);
    if (row) {
        row.style.transition = 'opacity 0.25s,transform 0.25s';
        row.style.opacity    = '0';
        row.style.transform  = 'translateX(40px)';
        setTimeout(() => renderWishlistPanel(), 260);
    }
}

document.addEventListener('DOMContentLoaded', init);
