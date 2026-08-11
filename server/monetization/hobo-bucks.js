/**
 * HoboStreamer — Hobo Bucks Engine
 * 
 * Virtual currency: 1 Hobo Buck = $1.00 USD
 * Features: 
 *   - Buy Hobo Bucks (PayPal)
 *   - Donate to streamers
 *   - Donation goals with progress bars
 *   - Escrow cashout with admin approval
 *   - Subscription tiers
 */
const db = require('../db/database');
const config = require('../config');

function normalizeMoneyAmount(amount) {
    const value = Number(amount);
    if (!Number.isFinite(value)) throw new Error('Amount must be a valid number');
    const rounded = Math.round(value * 100) / 100;
    if (rounded <= 0) throw new Error('Amount must be positive');
    if (rounded > 10000) throw new Error('Amount exceeds maximum allowed');
    return rounded;
}

function normalizeText(value, maxLen = 300) {
    if (value === undefined || value === null || value === '') return null;
    const text = String(value).trim();
    if (!text) return null;
    if (text.length > maxLen) throw new Error(`Text must be ${maxLen} characters or fewer`);
    return text;
}

function validatePaypalEmail(value) {
    const email = String(value || '').trim();
    if (!email) throw new Error('PayPal email required');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
        throw new Error('Invalid PayPal email');
    }
    return email;
}

class HoboBucks {
    /**
     * Purchase Hobo Bucks
     * @param {number} userId 
     * @param {number} amount - Number of Hobo Bucks to purchase
     * @param {string} paypalTxId - PayPal transaction ID
     */
    purchase(userId, amount, paypalTxId) {
        amount = normalizeMoneyAmount(amount);
        const txId = normalizeText(paypalTxId, 128);
        const tx = db.createTransaction({
            from_user_id: null,
            to_user_id: userId,
            amount,
            type: 'purchase',
            status: 'completed',
            message: `Purchased ${amount} Hobo Bucks`,
        });

        // Update PayPal reference
        if (txId) {
            db.run('UPDATE transactions SET paypal_transaction_id = ? WHERE id = ?',
            [txId, tx.lastInsertRowid]);
        }

        db.addHoboBucks(userId, amount);
        return tx;
    }

    /**
     * Donate Hobo Bucks to a streamer
     * @param {number} fromUserId - Donor
     * @param {number} toUserId - Streamer
     * @param {number} streamId - Current stream
     * @param {number} amount - Hobo Bucks to donate
     * @param {string} message - Donation message
     */
    donate(fromUserId, toUserId, streamId, amount, message, goalId = null) {
        amount = normalizeMoneyAmount(amount);
        message = normalizeText(message, 300);

        // Deduct from donor
        if (!db.deductHoboBucks(fromUserId, amount)) {
            throw new Error('Insufficient Hobo Bucks');
        }

        // Credit streamer (held in their balance)
        db.addHoboBucks(toUserId, amount);

        // Record transaction
        db.createTransaction({
            from_user_id: fromUserId,
            to_user_id: toUserId,
            stream_id: streamId,
            amount,
            type: 'donation',
            status: 'completed',
            message: message || null,
        });

        // Apply toward a donation goal (the donor's pick, else the sole active goal).
        const goalResult = this.applyDonationToGoal(toUserId, amount, goalId);

        return {
            success: true,
            amount,
            goal: goalResult ? goalResult.goal : null,      // the goal that advanced (for the widget)
            goalReached: goalResult && goalResult.reached ? goalResult.goal : null,
        };
    }

    /**
     * Route a donation toward a single goal: the donor's chosen goal if valid+active,
     * otherwise the streamer's sole active goal (if exactly one). Returns
     * { goal, reached } for the goal that advanced, or null if none applied.
     */
    applyDonationToGoal(userId, amount, goalId = null) {
        const uid = Number(userId);
        let target = null;
        if (goalId) {
            const g = db.getDonationGoalById(goalId);
            if (g && Number(g.user_id) === uid && g.is_active) target = g;
        }
        if (!target) {
            const active = db.getActiveDonationGoals(uid);
            if (active.length === 1) target = active[0];
        }
        if (!target) return null;
        return db.addToDonationGoal(target.id, amount);
    }

    /**
     * Request cashout (goes to escrow for admin review)
     */
    requestCashout(userId, amount, paypalEmail) {
        amount = normalizeMoneyAmount(amount);
        paypalEmail = validatePaypalEmail(paypalEmail);
        if (amount < config.hoboBucks.minCashout) {
            throw new Error(`Minimum cashout is $${config.hoboBucks.minCashout.toFixed(2)}`);
        }

        if (!db.deductHoboBucks(userId, amount)) {
            throw new Error('Insufficient Hobo Bucks');
        }

        const tx = db.createTransaction({
            from_user_id: userId,
            to_user_id: null,
            amount,
            type: 'cashout',
            status: 'escrow',
            message: `Cashout to PayPal: ${paypalEmail}`,
        });

        return {
            transaction_id: tx.lastInsertRowid,
            amount,
            usd_value: amount.toFixed(2),
            status: 'escrow',
            hold_days: config.hoboBucks.escrowDays,
        };
    }

    /**
     * Admin: Approve a cashout (release from escrow)
     */
    approveCashout(transactionId) {
        const tx = db.get('SELECT * FROM transactions WHERE id = ? AND status = ?',
            [transactionId, 'escrow']);
        if (!tx) throw new Error('Transaction not found or not in escrow');

        db.run('UPDATE transactions SET status = ? WHERE id = ?', ['completed', transactionId]);
        return tx;
    }

    /**
     * Admin: Deny a cashout (refund to user)
     */
    denyCashout(transactionId, reason) {
        const tx = db.get('SELECT * FROM transactions WHERE id = ? AND status = ?',
            [transactionId, 'escrow']);
        if (!tx) throw new Error('Transaction not found or not in escrow');

        // Refund the amount
        db.addHoboBucks(tx.from_user_id, tx.amount);
        db.run('UPDATE transactions SET status = ? WHERE id = ?', ['refunded', transactionId]);

        return tx;
    }

    /**
     * Get user's transaction history
     */
    getHistory(userId, limit = 50) {
        return db.all(`
            SELECT * FROM transactions
            WHERE from_user_id = ? OR to_user_id = ?
            ORDER BY created_at DESC LIMIT ?
        `, [userId, userId, limit]);
    }

    /**
     * Get donation leaderboard for a stream
     */
    getLeaderboard(streamId, limit = 10) {
        return db.all(`
            SELECT from_user_id, u.username, u.display_name, u.avatar_url,
                   SUM(amount) as total_donated
            FROM transactions t
            JOIN users u ON t.from_user_id = u.id
            WHERE t.stream_id = ? AND t.type = 'donation' AND t.status = 'completed'
            GROUP BY from_user_id
            ORDER BY total_donated DESC
            LIMIT ?
        `, [streamId, limit]);
    }

    /**
     * Goals shown to viewers in the on-stream widget: active goals + any reached in the
     * last hour (so a completed goal celebrates, then auto-clears).
     */
    getGoals(userId) {
        return db.getDonationGoalsForWidget(userId, 1);
    }

    /** All of a streamer's goals (active + completed) for the dashboard manager. */
    getManageGoals(userId) {
        return db.getAllDonationGoals(userId);
    }

    /**
     * Create a donation goal (optionally with an uploaded image/video already
     * transcoded to a served URL).
     */
    createGoal(userId, { title, target_amount, image_url = null, media_type = null } = {}) {
        const safeTitle = normalizeText(title, 120);
        const safeAmount = Math.round(normalizeMoneyAmount(target_amount));
        if (!safeTitle) throw new Error('Title is required');
        const mt = ['image', 'video'].includes(media_type) ? media_type : null;
        return db.createDonationGoal(userId, { title: safeTitle, target_amount: safeAmount, image_url: image_url || null, media_type: mt });
    }

    /** Update a goal the user owns. */
    updateGoal(id, userId, patch = {}) {
        const g = db.getDonationGoalById(id);
        if (!g || Number(g.user_id) !== Number(userId)) throw new Error('Goal not found');
        const fields = {};
        if (patch.title !== undefined) { const t = normalizeText(patch.title, 120); if (!t) throw new Error('Title is required'); fields.title = t; }
        if (patch.target_amount !== undefined) fields.target_amount = Math.round(normalizeMoneyAmount(patch.target_amount));
        if (patch.image_url !== undefined) fields.image_url = patch.image_url || null;
        if (patch.media_type !== undefined) fields.media_type = ['image', 'video'].includes(patch.media_type) ? patch.media_type : null;
        if (patch.is_active !== undefined) {
            fields.is_active = patch.is_active ? 1 : 0;
            // Re-activating a goal clears its reached_at so it isn't stuck in the celebration window.
            if (patch.is_active) fields.current_amount = Math.min(g.current_amount, g.target_amount - 1 < 0 ? 0 : g.target_amount);
        }
        if (patch.sort_order !== undefined) fields.sort_order = parseInt(patch.sort_order, 10) || 0;
        db.updateDonationGoal(id, userId, fields);
        return db.getDonationGoalById(id);
    }

    /** Delete a goal the user owns; returns the removed row (for media cleanup). */
    deleteGoal(id, userId) {
        const g = db.getDonationGoalById(id);
        if (!g || Number(g.user_id) !== Number(userId)) throw new Error('Goal not found');
        db.deleteDonationGoal(id, userId);
        return g;
    }
}

module.exports = new HoboBucks();
