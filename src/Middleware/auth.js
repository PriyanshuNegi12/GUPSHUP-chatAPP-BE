const jwt = require('jsonwebtoken');
const User = require('../Models/user');
const client = require('../Config/Redis');

async function loadAuthenticatedUser(req) {
    const { token } = req.cookies;
    if (!token) throw new Error("No session cookie");

    const payload = jwt.verify(token, process.env.JWT_KEY);
    const { _id } = payload;
    if (!_id) throw new Error("Invalid token");

    const isBlocked = await client.exists(`token:${token}`);
    if (isBlocked) throw new Error("Session has been logged out");

    const user = await User.findById(_id);
    
    if (!user || !user.isActive) throw new Error("Account not found or deactivated");

    return { user, payload, token };
}

module.exports = loadAuthenticatedUser;