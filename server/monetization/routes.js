/**
 * HoboStreamer — Monetization API Routes
 * 
 * POST   /api/funds/purchase       - Buy Hobo Bucks
 * POST   /api/funds/donate         - Donate to a streamer
 * POST   /api/funds/cashout        - Request cashout
 * GET    /api/funds/balance         - Get user balance
 * GET    /api/funds/history         - Get transaction history
 * GET    /api/funds/leaderboard/:id - Get stream donation leaderboard
 * POST   /api/funds/goals          - Create a donation goal
 * GET    /api/funds/goals/:userId  - Get user's donation goals
 */
const express = require('express');
const { requireAuth, requireAdmin } = require('../auth/auth');
const hoboBucks = require('./hobo-bucks');
const db = require('../db/database');

const router = express.Router();

// ── Buy Hobo Bucks ───────────────────────────────────────────
router.post('/purchase', requireAuth, (req, res) => {
    try {
        const { amount, paypal_transaction_id } = req.body;
        if (!amount || amount <= 0) {
            return res.status(400).json({ error: 'Invalid amount' });
        }

        // In production, validate PayPal transaction here
        hoboBucks.purchase(req.user.id, amount, paypal_transaction_id);

        const user = db.getUserById(req.user.id);
        res.json({
            message: `Purchased ${amount} Hobo Bucks`,
            balance: user.hobo_bucks_balance,
        });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// ── Donate to Streamer ───────────────────────────────────────
router.post('/donate', requireAuth, (req, res) => {
    try {
        let { streamer_id, stream_id, amount, message } = req.body;
        if (!amount || amount <= 0) {
            return res.status(400).json({ error: 'Invalid donation' });
        }

        // Resolve streamer_id from the stream record if not provided
        if (!streamer_id && stream_id) {
            const stream = db.getStreamById(stream_id);
            if (stream) streamer_id = stream.user_id;
        }
        if (!streamer_id) {
            return res.status(400).json({ error: 'Could not determine streamer' });
        }

        const result = hoboBucks.donate(req.user.id, streamer_id, stream_id, amount, message);

        // Broadcast donation to chat
        const chatServer = require('../chat/chat-server');
        chatServer.broadcastToStream(stream_id, {
            type: 'donation',
            username: req.user.display_name,
            amount,
            message: message || '',
            timestamp: new Date().toISOString(),
        });

        const user = db.getUserById(req.user.id);
        res.json({ ...result, balance: user.hobo_bucks_balance });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// ── Request Cashout ──────────────────────────────────────────
router.post('/cashout', requireAuth, (req, res) => {
    try {
        const { amount, paypal_email } = req.body;
        if (!amount || !paypal_email) {
            return res.status(400).json({ error: 'Amount and PayPal email required' });
        }

        const result = hoboBucks.requestCashout(req.user.id, amount, paypal_email);
        res.json(result);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// ── Get Balance ──────────────────────────────────────────────
router.get('/balance', requireAuth, (req, res) => {
    const user = db.getUserById(req.user.id);
    res.json({
        balance: user.hobo_bucks_balance,
        usd_value: user.hobo_bucks_balance.toFixed(2),
    });
});

// ── Transaction History ──────────────────────────────────────
router.get('/history', requireAuth, (req, res) => {
    const limit = Math.min(parseInt(req.query.limit || '50'), 200);
    const history = hoboBucks.getHistory(req.user.id, limit);
    res.json({ transactions: history });
});

// ── Stream Donation Leaderboard ──────────────────────────────
router.get('/leaderboard/:streamId', (req, res) => {
    const leaderboard = hoboBucks.getLeaderboard(req.params.streamId);
    res.json({ leaderboard });
});

// ── Create Donation Goal ─────────────────────────────────────
router.post('/goals', requireAuth, (req, res) => {
    try {
        const { title, target_amount } = req.body;
        if (!title || !target_amount) {
            return res.status(400).json({ error: 'Title and target amount required' });
        }
        hoboBucks.createGoal(req.user.id, title, target_amount);
        const goals = hoboBucks.getGoals(req.user.id);
        res.status(201).json({ goals });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// ── Get User Goals ───────────────────────────────────────────
router.get('/goals/:userId', (req, res) => {
    const goals = hoboBucks.getGoals(req.params.userId);
    res.json({ goals });
});

// ── Admin: Approve Cashout ───────────────────────────────────
router.post('/cashout/:id/approve', requireAdmin, (req, res) => {
    try {
        hoboBucks.approveCashout(req.params.id);
        res.json({ message: 'Cashout approved' });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// ── Admin: Deny Cashout ──────────────────────────────────────
router.post('/cashout/:id/deny', requireAdmin, (req, res) => {
    try {
        hoboBucks.denyCashout(req.params.id, req.body.reason);
        res.json({ message: 'Cashout denied, funds refunded' });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// ── Admin: Get Pending Cashouts ──────────────────────────────
router.get('/cashouts/pending', requireAdmin, (req, res) => {
    const pending = db.all(`
        SELECT t.*, u.username, u.display_name, u.email
        FROM transactions t
        JOIN users u ON t.from_user_id = u.id
        WHERE t.type = 'cashout' AND t.status = 'escrow'
        ORDER BY t.created_at ASC
    `);
    res.json({ cashouts: pending });
});

module.exports = router;
