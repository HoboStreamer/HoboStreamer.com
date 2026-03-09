/**
 * HoboStreamer — Hobo Coins Engine
 * 
 * Free loyalty currency (like Twitch Channel Points)
 * Global across all streams — earned by watching & chatting.
 * 
 * Earning rates:
 *   - Watching a live stream: 10 coins per 5 minutes
 *   - Sending a chat message: 5 coins (max 1 per minute)
 *   - Following a streamer: 50 coins (one-time)
 *   - Watch streak bonus: 2x every 60 minutes continuous
 * 
 * Spending: Streamer-configured rewards (custom buttons)
 */
const db = require('../db/database');

// ── Earning rates ────────────────────────────────────────────
const COINS = {
    WATCH_PER_5MIN: 10,          // passive watching
    CHAT_BONUS: 5,               // per qualifying message
    CHAT_COOLDOWN_MS: 60_000,    // 1 message per minute earns coins
    FOLLOW_BONUS: 50,            // one-time follow reward
    STREAK_MULTIPLIER: 2,        // after 60 min continuous
    STREAK_THRESHOLD_MIN: 60,    // minutes before streak kicks in
};

// In-memory cooldown tracker (userId → lastChatCoinTime)
const chatCooldowns = new Map();

class HoboCoins {

    /**
     * Award coins for watching (called by heartbeat interval)
     * @param {number} userId
     * @param {number} streamId
     * @returns {{ coins: number, total: number } | null}
     */
    awardWatch(userId, streamId) {
        if (!userId || !streamId) return null;

        // Update watch time
        db.upsertWatchTime(userId, streamId);
        const wt = db.getWatchTime(userId, streamId);
        if (!wt) return null;

        // Only award every 5 minutes
        if (wt.minutes_watched % 5 !== 0) return null;

        let coins = COINS.WATCH_PER_5MIN;

        // Streak bonus: 2x after 60 min continuous
        if (wt.minutes_watched >= COINS.STREAK_THRESHOLD_MIN) {
            coins *= COINS.STREAK_MULTIPLIER;
        }

        db.addHoboCoins(userId, coins);
        db.createCoinTransaction({
            user_id: userId,
            stream_id: streamId,
            amount: coins,
            type: 'watch',
            message: wt.minutes_watched >= COINS.STREAK_THRESHOLD_MIN
                ? `Watch streak bonus (${wt.minutes_watched} min)`
                : `Watching stream (${wt.minutes_watched} min)`,
        });

        // Update coins_earned on watch_time record
        db.run('UPDATE watch_time SET coins_earned = coins_earned + ? WHERE id = ?',
            [coins, wt.id]);

        const user = db.getUserById(userId);
        return { coins, total: user ? user.hobo_coins_balance : 0 };
    }

    /**
     * Award coins for chatting (with cooldown)
     * @param {number} userId
     * @param {number} streamId
     * @returns {{ coins: number, total: number } | null}
     */
    awardChat(userId, streamId) {
        if (!userId) return null;

        const now = Date.now();
        const lastTime = chatCooldowns.get(userId) || 0;
        if (now - lastTime < COINS.CHAT_COOLDOWN_MS) return null;

        chatCooldowns.set(userId, now);

        db.addHoboCoins(userId, COINS.CHAT_BONUS);
        db.createCoinTransaction({
            user_id: userId,
            stream_id: streamId,
            amount: COINS.CHAT_BONUS,
            type: 'chat_bonus',
            message: 'Chat activity bonus',
        });

        const user = db.getUserById(userId);
        return { coins: COINS.CHAT_BONUS, total: user ? user.hobo_coins_balance : 0 };
    }

    /**
     * Award one-time follow bonus
     * @param {number} userId
     * @param {number} streamerId
     */
    awardFollow(userId, streamerId) {
        if (!userId) return null;

        // Check if user already got follow bonus for this streamer
        const existing = db.get(
            `SELECT id FROM coin_transactions WHERE user_id = ? AND type = 'follow_bonus' AND message LIKE '%streamer:' || ? || '%'`,
            [userId, streamerId]
        );
        if (existing) return null;

        db.addHoboCoins(userId, COINS.FOLLOW_BONUS);
        db.createCoinTransaction({
            user_id: userId,
            stream_id: null,
            amount: COINS.FOLLOW_BONUS,
            type: 'follow_bonus',
            message: `Followed streamer:${streamerId}`,
        });

        const user = db.getUserById(userId);
        return { coins: COINS.FOLLOW_BONUS, total: user ? user.hobo_coins_balance : 0 };
    }

    /**
     * Redeem a reward (spend coins)
     * @param {number} userId
     * @param {number} rewardId
     * @param {number} streamId
     * @param {string} userInput - optional viewer message
     * @returns {{ redemption: object, remaining: number }}
     */
    redeem(userId, rewardId, streamId, userInput) {
        const reward = db.getCoinRewardById(rewardId);
        if (!reward) throw new Error('Reward not found');
        if (!reward.is_enabled) throw new Error('Reward is disabled');

        // Check user has enough coins
        if (!db.deductHoboCoins(userId, reward.cost)) {
            throw new Error('Not enough Hobo Coins');
        }

        // Check per-user cooldown
        if (reward.cooldown_seconds > 0) {
            const lastRedemption = db.get(
                `SELECT created_at FROM coin_redemptions WHERE reward_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT 1`,
                [rewardId, userId]
            );
            if (lastRedemption) {
                const elapsed = (Date.now() - new Date(lastRedemption.created_at.replace(' ', 'T') + 'Z').getTime()) / 1000;
                if (elapsed < reward.cooldown_seconds) {
                    // Refund
                    db.addHoboCoins(userId, reward.cost);
                    throw new Error(`Cooldown: wait ${Math.ceil(reward.cooldown_seconds - elapsed)}s`);
                }
            }
        }

        // Check max per stream
        if (reward.max_per_stream > 0 && streamId) {
            const count = db.get(
                `SELECT COUNT(*) as c FROM coin_redemptions WHERE reward_id = ? AND stream_id = ?`,
                [rewardId, streamId]
            );
            if (count && count.c >= reward.max_per_stream) {
                db.addHoboCoins(userId, reward.cost);
                throw new Error('Max redemptions reached for this stream');
            }
        }

        // Create redemption
        const result = db.createCoinRedemption({
            reward_id: rewardId,
            user_id: userId,
            stream_id: streamId,
            user_input: userInput,
        });

        // Log transaction
        db.createCoinTransaction({
            user_id: userId,
            stream_id: streamId,
            amount: -reward.cost,
            type: 'redeem',
            reward_id: rewardId,
            message: `Redeemed: ${reward.title}`,
        });

        // Increment redemption count
        db.run('UPDATE coin_rewards SET redemption_count = redemption_count + 1 WHERE id = ?', [rewardId]);

        const user = db.getUserById(userId);
        return {
            redemption: {
                id: result.lastInsertRowid,
                reward: reward,
                user_input: userInput,
            },
            remaining: user ? user.hobo_coins_balance : 0,
        };
    }

    /**
     * Get user's coin balance
     */
    getBalance(userId) {
        const user = db.getUserById(userId);
        return user ? user.hobo_coins_balance : 0;
    }

    /**
     * Get available rewards for a stream/channel
     * @param {number} streamerId - the streamer's user ID
     */
    getRewards(streamerId) {
        const streamerRewards = db.getCoinRewardsByStreamer(streamerId);
        // Also get global rewards
        const globals = db.all(
            'SELECT * FROM coin_rewards WHERE is_global = 1 AND is_enabled = 1 ORDER BY sort_order, cost'
        );
        return [...globals, ...streamerRewards];
    }

    /**
     * Admin: grant coins to a user
     */
    adminGrant(userId, amount, reason) {
        db.addHoboCoins(userId, amount);
        db.createCoinTransaction({
            user_id: userId,
            amount,
            type: 'admin_grant',
            message: reason || 'Admin grant',
        });
        const user = db.getUserById(userId);
        return user ? user.hobo_coins_balance : 0;
    }

    /**
     * Get earning rates config (for UI display)
     */
    getRates() {
        return { ...COINS };
    }
}

module.exports = new HoboCoins();
