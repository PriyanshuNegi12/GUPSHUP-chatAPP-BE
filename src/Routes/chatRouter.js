const express = require('express');
const chatRouter = express.Router();
const userMiddleware = require('../Middleware/userMiddleware');
const {openDirectChat, getChatList, getMessages, sendMessage,deleteMessage, markRead, createGroup, addGroupMembers, getMembers, leaveGroup, removeMember} = require('../Controller/userChat');

chatRouter.post('/direct/:userId', userMiddleware, openDirectChat);
chatRouter.get('/list', userMiddleware, getChatList);
chatRouter.post('/group', userMiddleware, createGroup);
chatRouter.post('/group/:conversationId/members', userMiddleware, addGroupMembers);
chatRouter.delete('/messages/:messageId', userMiddleware, deleteMessage);
chatRouter.get('/:conversationId/messages', userMiddleware, getMessages);
chatRouter.post('/:conversationId/messages', userMiddleware, sendMessage);
chatRouter.post('/:conversationId/read', userMiddleware, markRead);
chatRouter.get('/:conversationId/members', userMiddleware, getMembers);
chatRouter.delete('/group/:conversationId/leave', userMiddleware, leaveGroup);
chatRouter.delete('/group/:conversationId/members/:userId', userMiddleware, removeMember);

module.exports = chatRouter;

// #    Method	    Route	                                Purpose
// 1    POST	    /chat/direct/:userId	                Open a 1-to-1 chat with a friend (create it, or return the existing one)
// 2    GET	        /chat/list	                            Home screen: all my chats
// 3    GET	        /chat/:conversationId/messages	        Message history of one chat
// 4    POST	    /chat/:conversationId/messages	        Send a text message
// 5    DELETE	    /chat/messages/:messageId	            Delete my own message (for everyone)
// 6    POST	    /chat/:conversationId/read	            Mark the chat as read (blue ticks)
// 7    POST	    /chat/group	                            Create a group
// 8    POST	    /chat/group/:conversationId/members	    Add friends to a group (creator only)
// 9    GET	        /chat/:conversationId/members	        See who is in a chat