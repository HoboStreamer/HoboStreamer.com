/**
 * HoboStreamer — Hobo Coins API Routes
 * 
 * GET    /api/coins/balance         - Get user's coin balance
 * GET    /api/coins/rates           - Get earning rates
 * GET    /api/coins/history         - Get coin transaction history
 * GET    /api/coins/rewards/:userId - Get available rewards for a streamer
 * POST   /api/coins/rewards         - Create a reward (streamer)
 * PUT    /api/coins/rewards/:id     - Update a reward (streamer)
 * DELETE /api/coins/rewards/:id     - Delete a reward (streamer)
 * POST   /api/coins/redeem          - Redeem a reward (viewer)
 * POST   /api/coins/heartbeat       - Watch time heartbeat (earns coins)
 * GET    /api/coins/redemptions      - Get pending redemptions (streamer)
 * POST   /api/coins/redemptions/:id  - Resolve a redemption (streamer)
 * POST   /api/coins/admin/grant      - Admin: grant coins to user
 */
const express = require('express');
const { requireAuth, requireAdmin } = require('../auth/auth');
const hoboCoins = require('./hobo-coins');
const db = require('../db/database');

const router = express.Router();

// ── Get Coin Balance ─────────────────────────────────────────
router.get('/balance', requireAuth, (req, res) => {
    const balance = hoboCoins.getBalance(req.user.id);
    res.json({ balance });
});

// ── Get Earning Rates ────────────────────────────────────────
router.get('/rates', (req, res) => {
    res.json({ rates: hoboCoins.getRates() });
});

// ── Coin Transaction History ─────────────────────────────────
router.get('/history', requireAuth, (req, res) => {
    const limit = Math.min(parseInt(req.query.limit || '50'), 200);
    const history = db.getCoinTransactions(req.user.id, limit);
    res.json({ transactions: history });
});

// ── Watch Heartbeat (earn coins passively) ───────────────────
router.post('/heartbeat', requireAuth, (req, res) => {
    try {
        const { streamId } = req.body;
        if (!streamId) return res.status(400).json({ error: 'streamId required' });

        const result = hoboCoins.awardWatch(req.user.id, streamId);
        if (result) {
            return res.json({ earned: result.coins, balance: result.total });
        }
        // No coins earned this tick (not on a 5-min boundary)
        const balance = hoboCoins.getBalance(req.user.id);
        res.json({ earned: 0, balance });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// ── Get Available Rewards ────────────────────────────────────
router.get('/rewards/:userId', (req, res) => {
    const rewards = hoboCoins.getRewards(parseInt(req.params.userId));
    res.json({ rewards });
});

// ── Create Reward (Streamer) ─────────────────────────────────
router.post('/rewards', requireAuth, (req, res) => {
    try {
        const { title, description, cost, icon, color, cooldown_seconds, max_per_stream, requires_input } = req.body;
        if (!title || !cost) {
            return res.status(400).json({ error: 'Title and cost required' });
        }
        if (cost < 1) {
            return res.status(400).json({ error: 'Cost must be at least 1' });
        }

        db.createCoinReward({
            streamer_id: req.user.id,
            title,
            description,
            cost,
            icon,
            color,
            cooldown_seconds,
            max_per_stream,
            requires_input,
        });

        const rewards = hoboCoins.getRewards(req.user.id);
        res.status(201).json({ rewards });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// ── Update Reward ────────────────────────────────────────────
router.put('/rewards/:id', requireAuth, (req, res) => {
    try {
        const reward = db.getCoinRewardById(req.params.id);
        if (!reward || reward.streamer_id !== req.user.id) {
            return res.status(403).json({ error: 'Not your reward' });
        }

        const allowed = ['title', 'description', 'cost', 'icon', 'color',
                         'cooldown_seconds', 'max_per_stream', 'requires_input', 'is_enabled', 'sort_order'];
        const fields = {};
        for (const key of allowed) {
            if (req.body[key] !== undefined) fields[key] = req.body[key];
        }

        db.updateCoinReward(req.params.id, fields);
        const rewards = hoboCoins.getRewards(req.user.id);
        res.json({ rewards });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// ── Delete Reward ────────────────────────────────────────────
router.delete('/rewards/:id', requireAuth, (req, res) => {
    try {
        const reward = db.getCoinRewardById(req.params.id);
        if (!reward || reward.streamer_id !== req.user.id) {
            return res.status(403).json({ error: 'Not your reward' });
        }
        db.deleteCoinReward(req.params.id);
        res.json({ message: 'Reward deleted' });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// ── Redeem Reward (Viewer) ───────────────────────────────────
router.post('/redeem', requireAuth, (req, res) => {
    try {
        const { rewardId, streamId, userInput } = req.body;
        if (!rewardId) return res.status(400).json({ error: 'rewardId required' });

        const result = hoboCoins.redeem(req.user.id, rewardId, streamId, userInput);

        // Broadcast redemption to chat so streamer sees it
        try {
            const chatServer = require('../chat/chat-server');
            const reward = result.redemption.reward;
            chatServer.broadcastToStream(streamId, {
                type: 'redemption',
                username: req.user.display_name || req.user.username,
                reward_title: reward.title,
                reward_icon: reward.icon,
                reward_color: reward.color,
                cost: reward.cost,
                user_input: userInput || '',
                timestamp: new Date().toISOString(),
            });
        } catch { /* chat broadcast optional */ }

        res.json({
            message: `Redeemed "${result.redemption.reward.title}"`,
            remaining: result.remaining,
            redemption_id: result.redemption.id,
        });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// ── Get Pending Redemptions (Streamer Queue) ─────────────────
router.get('/redemptions', requireAuth, (req, res) => {
    const pending = db.getPendingRedemptions(req.user.id);
    res.json({ redemptions: pending });
});

// ── Resolve Redemption (Streamer) ────────────────────────────
router.post('/redemptions/:id', requireAuth, (req, res) => {
    try {
        const { status } = req.body; // 'fulfilled' or 'rejected'
        if (!['fulfilled', 'rejected'].includes(status)) {
            return res.status(400).json({ error: 'Status must be fulfilled or rejected' });
        }

        // Verify this redemption belongs to one of the streamer's rewards
        const redemption = db.get('SELECT r.*, cr.streamer_id FROM coin_redemptions r JOIN coin_rewards cr ON r.reward_id = cr.id WHERE r.id = ?',
            [req.params.id]);
        if (!redemption || redemption.streamer_id !== req.user.id) {
            return res.status(403).json({ error: 'Not your redemption' });
        }

        // If rejected, refund coins
        if (status === 'rejected') {
            const reward = db.getCoinRewardById(redemption.reward_id);
            if (reward) {
                db.addHoboCoins(redemption.user_id, reward.cost);
                db.createCoinTransaction({
                    user_id: redemption.user_id,
                    amount: reward.cost,
                    type: 'refund',
                    reward_id: redemption.reward_id,
                    message: `Refunded: ${reward.title} (rejected by streamer)`,
                });
            }
        }

        db.resolveRedemption(req.params.id, status);
        res.json({ message: `Redemption ${status}` });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// ── Admin: Grant Coins ───────────────────────────────────────
router.post('/admin/grant', requireAdmin, (req, res) => {
    try {
        const { userId, amount, reason } = req.body;
        if (!userId || !amount) return res.status(400).json({ error: 'userId and amount required' });

        const newBalance = hoboCoins.adminGrant(userId, amount, reason);
        res.json({ message: `Granted ${amount} Hobo Coins`, balance: newBalance });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

module.exports = router;
