// BackEnd/src/Middleware/userMiddleware.js
const loadAuthenticatedUser = require('./auth');
const sendError = require('../Utils/sendError');

const userMiddleware = async (req, res, next) => {
    try {
        const { user, payload, token } = await loadAuthenticatedUser(req);
        req.result = user;
        req.tokenPayload = payload;
        req.token = token;
        next();
    } catch (err) {
        sendError(res, 401, "Session expired. Please log in again.");
    }
};

module.exports = userMiddleware;