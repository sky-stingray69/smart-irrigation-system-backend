const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { authenticateJWT } = require('../middleware/auth');

const signToken = (userId) =>
  jwt.sign({ id: userId }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  });

/**
 * POST /api/v1/auth/register
 * Create a new portal user (first user becomes admin).
 */
router.post('/register', async (req, res) => {
  const { email, password, name } = req.body;

  if (!email || !password || !name) {
    return res.status(400).json({ error: 'email, password, and name are required.' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }

  try {
    const existingCount = await User.countDocuments();
    const role = existingCount === 0 ? 'admin' : 'viewer'; // First user = admin

    const user = await User.create({ email, password, name, role });
    const token = signToken(user._id);

    return res.status(201).json({
      message: 'User registered successfully.',
      token,
      user: { id: user._id, email: user.email, name: user.name, role: user.role },
    });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ error: 'An account with this email already exists.' });
    }
    console.error('Registration error:', err);
    return res.status(500).json({ error: 'Failed to register user.' });
  }
});

/**
 * POST /api/v1/auth/login
 */
router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'email and password are required.' });
  }

  try {
    const user = await User.findOne({ email }).select('+password');
    if (!user || !(await user.comparePassword(password))) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const token = signToken(user._id);
    return res.status(200).json({
      token,
      user: { id: user._id, email: user.email, name: user.name, role: user.role },
    });
  } catch (err) {
    console.error('Login error:', err);
    return res.status(500).json({ error: 'Login failed.' });
  }
});

/**
 * GET /api/v1/auth/me
 * Return current user info from JWT.
 */
router.get('/me', authenticateJWT, (req, res) => {
  res.status(200).json({ user: req.user });
});

module.exports = router;
