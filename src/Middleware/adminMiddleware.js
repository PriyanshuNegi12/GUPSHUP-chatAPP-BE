const loadAuthenticatedUser = require('./auth');
const sendError = require('../Utils/sendError');

const adminMiddleware = async (req, res, next) => {
    try {
        const { user, payload, token } = await loadAuthenticatedUser(req);
        if (user.role !== 'admin') throw new Error("Admins only");
        req.result = user;
        req.tokenPayload = payload;
        req.token = token;
        next();
    } catch (err) {
        sendError(res, 401, "Session expired. Please log in again.");
    }
};

module.exports = adminMiddleware;