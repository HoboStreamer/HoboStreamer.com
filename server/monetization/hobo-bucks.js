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
    donate(fromUserId, toUserId, streamId, amount, message) {
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

        // Update donation goals
        this.updateGoals(toUserId, amount);

        return { success: true, amount };
    }

    /**
     * Update active donation goals for a user
     */
    updateGoals(userId, amount) {
        const goals = db.all(
            'SELECT * FROM donation_goals WHERE user_id = ? AND is_active = 1 ORDER BY created_at',
            [userId]
        );

        for (const goal of goals) {
            const newAmount = Math.min(goal.current_amount + amount, goal.target_amount);
            db.run('UPDATE donation_goals SET current_amount = ? WHERE id = ?',
                [newAmount, goal.id]);

            if (newAmount >= goal.target_amount) {
                db.run('UPDATE donation_goals SET is_active = 0 WHERE id = ?', [goal.id]);
            }
        }
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
     * Get active donation goals for a user
     */
    getGoals(userId) {
        return db.all(
            'SELECT * FROM donation_goals WHERE user_id = ? AND is_active = 1 ORDER BY created_at',
            [userId]
        );
    }

    /**
     * Create a donation goal
     */
    createGoal(userId, title, targetAmount) {
        const safeTitle = normalizeText(title, 120);
        const safeAmount = normalizeMoneyAmount(targetAmount);
        if (!safeTitle) throw new Error('Title is required');
        return db.run(
            'INSERT INTO donation_goals (user_id, title, target_amount) VALUES (?, ?, ?)',
            [userId, safeTitle, safeAmount]
        );
    }
}

module.exports = new HoboBucks();
