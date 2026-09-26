const express = require("express");
const { userRegister, userLogin, userLogout, adminRegister, deleteProfile, checkAvailability, searchUsers } = require("../Controller/userAuth");
const { getProfile, updateProfile } = require("../Controller/userProfile");
const { listUsers, deleteUserByAdmin } = require("../Controller/userAdmin"); // NEW
const userMiddleware = require("../Middleware/userMiddleware");
const adminMiddleware = require('../Middleware/adminMiddleware');
const { loginRateLimiter } = require("../Middleware/rateLimiter");
const userRouter = express.Router();

userRouter.post('/register', userRegister);
userRouter.get('/available', checkAvailability);
userRouter.get('/search', userMiddleware, searchUsers);
userRouter.post('/login', loginRateLimiter, userLogin);
userRouter.post('/logout', userMiddleware, userLogout);
userRouter.post("/admin/register", adminMiddleware, adminRegister);
userRouter.get('/admin/users', adminMiddleware, listUsers);              // NEW
userRouter.delete('/admin/users/:userId', adminMiddleware, deleteUserByAdmin); // NEW
userRouter.delete('/deleteProfile', userMiddleware, deleteProfile);
userRouter.get('/profile', userMiddleware, getProfile);
userRouter.patch('/profile', userMiddleware, updateProfile);
userRouter.get('/check', userMiddleware, (req, res) => {
    res.status(200).json({
        user: {
            firstname: req.result.firstname,
            username: req.result.username,
            _id: req.result._id,
            role: req.result.role,
        },
        message: "Valid User"
    });
});

module.exports = userRouter;