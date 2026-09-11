// routes/analytics.js
// A first-cut Analytics Dashboard feed — enough to see the pilot working,
// not meant to be the final word in reporting.

const express = require('express');
const db = require('../db');

const router = express.Router();

router.get('/summary', (req, res) => {
  const accounts = db.prepare(`SELECT type, COUNT(*) AS count FROM accounts GROUP BY type`).all();
  const totals = db.prepare(`
    SELECT
      COALESCE(SUM(litres), 0) AS totalLitres,
      COALESCE(SUM(amount_ksh), 0) AS totalRevenueKsh,
      COALESCE(SUM(points_earned), 0) AS totalPointsIssued
    FROM fuel_transactions
  `).get();
  const redeemed = db.prepare(`
    SELECT COALESCE(SUM(points_requested), 0) AS totalPointsRedeemed
    FROM redemptions WHERE status = 'approved'
  `).get();
  const byStation = db.prepare(`
    SELECT station, COUNT(*) AS fillUps, SUM(litres) AS litres
    FROM fuel_transactions
    WHERE station IS NOT NULL
    GROUP BY station
    ORDER BY litres DESC
  `).all();

  res.json({
    accountsByType: accounts,
    totalLitres: totals.totalLitres,
    totalRevenueKsh: totals.totalRevenueKsh,
    totalPointsIssued: totals.totalPointsIssued,
    totalPointsRedeemed: redeemed.totalPointsRedeemed,
    outstandingPointsLiability: totals.totalPointsIssued - redeemed.totalPointsRedeemed,
    byStation,
  });
});

module.exports = router;
