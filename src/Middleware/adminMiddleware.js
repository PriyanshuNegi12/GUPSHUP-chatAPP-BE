const loadAuthenticatedUser = require('./auth');

const adminMiddleware = async (req, res, next) => {
    try {
        const { user, payload, token } = await loadAuthenticatedUser(req);
        if (user.role != 'admin') throw new Error("User Doesn't Exists");
        req.result = user;
        req.tokenPayload = payload;
        req.token = token;
        next();
    } catch (err) {
        res.status(401).send("Error:  " + err);
    }
};

module.exports = adminMiddleware;