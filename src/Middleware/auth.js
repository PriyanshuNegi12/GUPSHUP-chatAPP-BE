const jwt = require('jsonwebtoken');
const User = require('../Models/user');
const client = require('../Config/Redis');

// Shared by userMiddleware and adminMiddleware so verify/blacklist/lookup
// isn't duplicated in two places.
async function loadAuthenticatedUser(req) {
    const { token } = req.cookies;
    if (!token) throw new Error("Invalid Cookie!!!!!!!!!");

    const payload = jwt.verify(token, process.env.JWT_KEY);
    const { _id } = payload;
    if (!_id) throw new Error("Invalid token");

    const user = await User.findById(_id);
    if (!user) throw new Error("user Node Found!!!!!!!!!");

    const isBlocked = await client.exists(`token:${token}`);
    if (isBlocked) throw new Error("Invalid Token");

    return { user, payload, token };
}

module.exports = loadAuthenticatedUser;