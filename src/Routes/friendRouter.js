const express = require('express');
const friendRouter = express.Router();
const userMiddleware = require('../Middleware/userMiddleware');
const {sendFriendRequest, acceptFriendRequest, rejectFriendRequest, cancelFriendRequest, unfriend, blockFriend, unblockFriend, getAllFriends, getAllReceivedRequests, getAllSentRequests, getAllBlocked} = require('../Controller/friendship');

friendRouter.post('/request/:userId', userMiddleware, sendFriendRequest);
friendRouter.post('/accept/:userId', userMiddleware, acceptFriendRequest);
friendRouter.delete('/reject/:userId', userMiddleware, rejectFriendRequest);
friendRouter.delete('/cancel/:userId', userMiddleware, cancelFriendRequest);
friendRouter.delete('/remove/:userId', userMiddleware, unfriend);
friendRouter.post('/block/:userId', userMiddleware, blockFriend);
friendRouter.delete('/block/:userId', userMiddleware, unblockFriend);
friendRouter.get('/list', userMiddleware, getAllFriends);
friendRouter.get('/requests/received', userMiddleware, getAllReceivedRequests);
friendRouter.get('/requests/sent', userMiddleware, getAllSentRequests);
friendRouter.get('/blocked', userMiddleware, getAllBlocked);

module.exports = friendRouter;