/* ═══════════════════════════════════════════════════════════════
   HoboStreamer — Hobo Bucks (Virtual Currency UI)
   1 Hobo Buck = $1.00 USD
   ═══════════════════════════════════════════════════════════════ */

/**
 * Generate Buy Hobo Bucks modal HTML.
 */
function hoboBucksBuyModal() {
    return `
        <h3><i class="fa-solid fa-coins"></i> Buy Hobo Bucks</h3>
        <p class="muted" style="margin-bottom:16px">1 Hobo Buck = $1.00</p>

        <div class="form-group">
            <label>Amount</label>
            <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:12px">
                <button class="btn btn-outline" onclick="setBuyAmount(5)">5 HB<br><small>$5</small></button>
                <button class="btn btn-outline" onclick="setBuyAmount(10)">10 HB<br><small>$10</small></button>
                <button class="btn btn-outline" onclick="setBuyAmount(25)">25 HB<br><small>$25</small></button>
                <button class="btn btn-outline" onclick="setBuyAmount(50)">50 HB<br><small>$50</small></button>
                <button class="btn btn-outline" onclick="setBuyAmount(100)">100 HB<br><small>$100</small></button>
                <button class="btn btn-outline" onclick="setBuyAmount(250)">250 HB<br><small>$250</small></button>
            </div>
        </div>

        <div class="form-group">
            <label>Custom Amount</label>
            <input type="number" id="modal-buy-amount" class="form-input" placeholder="Enter amount" min="1">
        </div>
        <div class="form-group" style="text-align:center;padding:8px;background:var(--bg-primary);border-radius:var(--radius)">
            <span id="modal-buy-price" style="font-size:1.2rem;color:var(--accent);font-weight:700">$0.00</span>
        </div>

        <div id="buy-providers" style="margin-top:8px">
            <p class="muted" style="font-size:0.85rem;text-align:center"><i class="fa-solid fa-spinner fa-spin"></i> Loading payment options…</p>
        </div>`;
}

/** Populate the buy modal with the enabled payment providers (called after render). */
async function _initBuyBucks() {
    const box = document.getElementById('buy-providers');
    if (!box) return;
    let cfg;
    try { cfg = await api('/payments/config'); } catch { cfg = null; }
    if (!cfg || !cfg.enabled) {
        box.innerHTML = '<p class="muted" style="font-size:0.85rem;text-align:center">Purchases aren’t available right now.</p>';
        return;
    }
    const min = cfg.minPurchaseUsd || 5;
    const amtInput = document.getElementById('modal-buy-amount');
    if (amtInput) { amtInput.min = min; if (!amtInput.value) amtInput.value = min; updateBuyPrice(); }
    const P = cfg.providers || {};
    const btn = (prov, label, icon, color) => P[prov]
        ? `<button class="btn btn-lg" style="width:100%;margin-top:8px;justify-content:center;background:${color};color:#fff;border:none" onclick="doPurchase('${prov}')"><i class="${icon}"></i> Pay with ${label}</button>`
        : '';
    const buttons = [
        btn('stripe', 'Card (Stripe)', 'fa-solid fa-credit-card', '#635bff'),
        btn('paypal', 'PayPal', 'fa-brands fa-paypal', '#003087'),
        btn('ccbill', 'Card (CCBill)', 'fa-solid fa-credit-card', '#2a6'),
        btn('crypto', 'Crypto', 'fa-brands fa-bitcoin', '#f7931a'),
    ].filter(Boolean).join('');
    box.innerHTML = buttons || '<p class="muted" style="font-size:0.85rem;text-align:center">No payment methods are enabled.</p>';
}

async function doPurchase(provider) {
    if (!currentUser) return showModal('login');
    const amount = parseFloat(document.getElementById('modal-buy-amount').value);
    if (!amount || amount < 1) return toast('Enter a valid amount', 'error');
    try {
        const data = await api('/payments/bucks/checkout', { method: 'POST', body: { provider, amountUsd: amount } });
        if (data.url) { window.location.href = data.url; return; }
        toast('Could not start checkout', 'error');
    } catch (e) { toast(e.message || 'Purchase failed', 'error'); }
}

/* ── Channel subscriptions ─────────────────────────────────── */
function hoboSubscribeModal(username) {
    return `
        <h3><i class="fa-solid fa-star"></i> Subscribe to ${username ? username : 'this channel'}</h3>
        <p class="muted" id="sub-price-line" style="margin-bottom:16px">Monthly channel subscription.</p>
        <div id="subscribe-options" data-streamer="${username || ''}">
            <p class="muted" style="font-size:0.85rem;text-align:center"><i class="fa-solid fa-spinner fa-spin"></i> Loading…</p>
        </div>`;
}

async function _initSubscribe() {
    const box = document.getElementById('subscribe-options');
    if (!box) return;
    const username = box.dataset.streamer;
    let cfg, info;
    try { [cfg, info] = await Promise.all([api('/payments/config'), api(`/payments/channel/${encodeURIComponent(username)}`)]); }
    catch { box.innerHTML = '<p class="muted">Subscriptions unavailable.</p>'; return; }
    const priceLine = document.getElementById('sub-price-line');
    if (priceLine) priceLine.textContent = `$${(info.priceUsd || cfg.subPriceUsd || 4.99).toFixed(2)}/month · ${info.subscriberCount || 0} subscriber${info.subscriberCount === 1 ? '' : 's'}`;
    if (info.subscribed) { box.innerHTML = '<p style="text-align:center;color:#53fc18"><i class="fa-solid fa-circle-check"></i> You’re subscribed!</p>'; return; }
    if (!cfg.enabled) { box.innerHTML = '<p class="muted" style="text-align:center">Subscriptions aren’t available right now.</p>'; return; }
    let html = '';
    if (cfg.providers && cfg.providers.stripe) {
        html += `<button class="btn btn-lg btn-primary" style="width:100%;margin-top:8px;justify-content:center" onclick="doSubscribe('${username}','stripe')"><i class="fa-solid fa-credit-card"></i> Subscribe with Card (auto-renews)</button>`;
    }
    html += `<button class="btn btn-lg" style="width:100%;margin-top:8px;justify-content:center;background:var(--accent);color:#111;border:none" onclick="doSubscribe('${username}','bucks')"><i class="fa-solid fa-coins"></i> Subscribe with Hobo Bucks (30 days)</button>`;
    box.innerHTML = html;
}

async function doSubscribe(username, provider) {
    if (!currentUser) return showModal('login');
    try {
        const data = await api('/payments/subscribe', { method: 'POST', body: { provider, streamer: username } });
        if (data.url) { window.location.href = data.url; return; }
        if (data.ok) { toast('Subscribed! 🎉', 'success'); if (typeof loadBalance === 'function') loadBalance(); closeModal(); }
    } catch (e) { toast(e.message || 'Subscription failed', 'error'); }
}

function showSubscribeModal(username) {
    const content = document.getElementById('modal-content');
    content.innerHTML = hoboSubscribeModal(username);
    document.getElementById('modal-overlay').classList.add('show');
    _initSubscribe();
}

function openSubscribeForCurrentStream() {
    const d = (typeof currentStreamData !== 'undefined' && currentStreamData) || {};
    const username = d.username || d.user_username || d.streamer_username || d.channel_username || d.owner_username;
    if (!username) return toast('No channel selected', 'error');
    showSubscribeModal(username);
}

function setBuyAmount(amount) {
    document.getElementById('modal-buy-amount').value = amount;
    updateBuyPrice();
}

function updateBuyPrice() {
    const amount = parseFloat(document.getElementById('modal-buy-amount')?.value) || 0;
    const price = document.getElementById('modal-buy-price');
    if (price) price.textContent = `$${amount.toFixed(2)}`;
}

// Attach price update to input
document.addEventListener('input', (e) => {
    if (e.target.id === 'modal-buy-amount') updateBuyPrice();
});

async function doPurchase() {
    if (!currentUser) return showModal('login');
    const amount = parseFloat(document.getElementById('modal-buy-amount').value);
    if (!amount || amount < 1) return toast('Enter a valid amount', 'error');

    try {
        // Simulated purchase — in production this would go through PayPal first
        const data = await api('/funds/purchase', {
            method: 'POST',
            body: { amount, paypalTransactionId: `demo_${Date.now()}` }
        });
        toast(`Purchased ${amount} Hobo Bucks!`, 'success');
        loadBalance();
        closeModal();
    } catch (e) { toast(e.message || 'Purchase failed', 'error'); }
}

/**
 * Generate Donate modal HTML.
 */
function hoboBucksDonateModal() {
    return `
        <h3><i class="fa-solid fa-gift"></i> Donate Hobo Bucks</h3>
        <p class="muted" style="margin-bottom:16px">Support this streamer!</p>

        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:12px">
            <button class="btn btn-outline" onclick="setDonateAmount(1)">1 HB</button>
            <button class="btn btn-outline" onclick="setDonateAmount(2)">2 HB</button>
            <button class="btn btn-outline" onclick="setDonateAmount(5)">5 HB</button>
            <button class="btn btn-outline" onclick="setDonateAmount(10)">10 HB</button>
            <button class="btn btn-outline" onclick="setDonateAmount(25)">25 HB</button>
            <button class="btn btn-outline" onclick="setDonateAmount(50)">50 HB</button>
        </div>

        <div class="form-group">
            <label>Amount</label>
            <input type="number" id="modal-donate-amount" class="form-input" placeholder="Amount" min="1">
        </div>
        <div class="form-group">
            <label>Message (optional)</label>
            <input type="text" id="modal-donate-message" class="form-input" placeholder="Say something nice..." maxlength="200">
        </div>

        <button class="btn btn-primary btn-lg" onclick="doDonate()" style="width:100%;margin-top:8px">
            <i class="fa-solid fa-coins"></i> Donate
        </button>`;
}

function setDonateAmount(amount) {
    document.getElementById('modal-donate-amount').value = amount;
}

async function doDonate() {
    if (!currentUser) return showModal('login');
    if (!currentStreamId) return toast('No stream selected', 'error');

    const amount = parseFloat(document.getElementById('modal-donate-amount').value);
    const message = document.getElementById('modal-donate-message').value.trim();

    if (!amount || amount < 1) return toast('Enter a valid amount', 'error');

    try {
        const streamerId = currentStreamData ? currentStreamData.user_id : null;
        await api('/funds/donate', {
            method: 'POST',
            body: { streamer_id: streamerId, stream_id: currentStreamId, amount, message }
        });
        toast(`Donated $${amount.toFixed(2)} Hobo Bucks!`, 'success');
        loadBalance();
        closeModal();
    } catch (e) { toast(e.message || 'Donation failed', 'error'); }
}

/**
 * Generate Cashout modal HTML.
 */
function hoboBucksCashoutModal() {
    return `
        <h3><i class="fa-solid fa-money-bill-transfer"></i> Cash Out</h3>
        <p class="muted" style="margin-bottom:16px">Minimum $5.00. Funds are held in escrow until admin approves.</p>

        <div class="form-group">
            <label>Amount (Hobo Bucks)</label>
            <input type="number" id="modal-cashout-amount" class="form-input" placeholder="5" min="5">
        </div>
        <div class="form-group">
            <label>PayPal Email</label>
            <input type="email" id="modal-cashout-email" class="form-input" placeholder="your@paypal.com">
        </div>
        <div class="form-group" style="text-align:center;padding:8px;background:var(--bg-primary);border-radius:var(--radius)">
            You'll receive: <strong id="modal-cashout-usd">$0.00</strong>
        </div>

        <button class="btn btn-primary btn-lg" onclick="doCashout()" style="width:100%;margin-top:8px">
            <i class="fa-solid fa-money-bill-transfer"></i> Request Cashout
        </button>`;
}

document.addEventListener('input', (e) => {
    if (e.target.id === 'modal-cashout-amount') {
        const amt = parseFloat(e.target.value) || 0;
        const usd = document.getElementById('modal-cashout-usd');
        if (usd) usd.textContent = `$${amt.toFixed(2)}`;
    }
});

// Show a toast when returning from a hosted checkout, then clean the URL.
document.addEventListener('DOMContentLoaded', () => {
    const q = new URLSearchParams(location.search);
    const purchase = q.get('purchase'), sub = q.get('sub');
    if (!purchase && !sub) return;
    if (purchase === 'success' || sub === 'success') {
        toast(sub === 'success' ? 'Subscription active! 🎉' : 'Purchase complete — your Hobo Bucks are on the way!', 'success');
        if (typeof loadBalance === 'function') setTimeout(loadBalance, 1500);
    } else if (purchase === 'cancel' || sub === 'cancel') {
        toast('Checkout canceled.', 'info');
    } else if (purchase === 'error') {
        toast('Payment could not be completed.', 'error');
    }
    q.delete('purchase'); q.delete('sub');
    history.replaceState(null, '', location.pathname + (q.toString() ? '?' + q.toString() : ''));
});

async function doCashout() {
    if (!currentUser) return showModal('login');
    const amount = parseFloat(document.getElementById('modal-cashout-amount').value);
    const paypalEmail = document.getElementById('modal-cashout-email').value.trim();

    if (!amount || amount < 5) return toast('Minimum cashout is $5.00', 'error');
    if (!paypalEmail) return toast('PayPal email required', 'error');

    try {
        await api('/funds/cashout', {
            method: 'POST',
            body: { amount, paypalEmail }
        });
        toast('Cashout requested! Awaiting admin approval.', 'success');
        loadBalance();
        closeModal();
    } catch (e) { toast(e.message || 'Cashout failed', 'error'); }
}
