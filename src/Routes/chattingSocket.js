const jwt = require('jsonwebtoken');
const User = require('../Models/user');
const Member = require('../Models/member');
const Message = require('../Models/message');
const Friendship = require('../Models/friendship');
const client = require('../Config/Redis');
const chatService = require('../Services/chatService');

const isId = (v) => typeof v === 'string' && /^[0-9a-f]{24}$/i.test(v);
const PUBLIC_CALL_FIELDS = 'username firstname avatar';
const PENDING_CALL_TTL = 45; // a bit longer than the client's 30s ring timeout, so it always wins the race

function parseCookieHeader(raw) {
    const out = {};
    raw.split(';').forEach((pair) => {
        const idx = pair.indexOf('=');
        if (idx === -1) return;
        const key = pair.slice(0, idx).trim();
        const val = pair.slice(idx + 1).trim();
        if (key) out[key] = decodeURIComponent(val);
    });
    return out;
}

async function getFriendIds(me) {
    const friendships = await Friendship.find({
        status: 'accepted',
        $or: [{ requester: me }, { recipient: me }],
    }).select('requester recipient').lean();

    return friendships.map((f) =>
        String(f.requester) === String(me) ? String(f.recipient) : String(f.requester)
    );
}

const getPairKey = (a, b) => [String(a), String(b)].sort().join('_');

// who a user is currently on an ANSWERED call with
async function getCallPeer(userId) {
    return client.get(`callpeer:${userId}`);
}
async function setCallPeer(a, b) {
    await Promise.all([
        client.set(`callpeer:${a}`, b, { EX: 4 * 60 * 60 }),
        client.set(`callpeer:${b}`, a, { EX: 4 * 60 * 60 }),
    ]);
}
async function clearCallPeer(a, b) {
    await Promise.all([client.del(`callpeer:${a}`), b ? client.del(`callpeer:${b}`) : null]);
}

// NEW: tracks a call that's RINGING but not yet answered. Without this,
// call:answer / call:reject / call:ice-candidate / call:end had no way to
// verify the sender was actually part of a real call — any logged-in user
// could forge these events against any other user id (hijack/kill a call,
// or falsely mark someone as busy for 4 hours).
//
// callpending:{calleeId}  -> { from: callerId, callId }   (who's calling ME)
// callringing:{callerId}  -> calleeId                     (who I'M calling)
// Both expire on their own if nothing happens, so a crashed process never
// leaves someone stuck "in a call" forever.
async function setPendingCall(callerId, calleeId, callId) {
    await Promise.all([
        client.set(`callpending:${calleeId}`, JSON.stringify({ from: callerId, callId: callId || null }), { EX: PENDING_CALL_TTL }),
        client.set(`callringing:${callerId}`, calleeId, { EX: PENDING_CALL_TTL }),
    ]);
}
async function getPendingCall(calleeId) {
    const raw = await client.get(`callpending:${calleeId}`);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
}
async function clearPending(callerId, calleeId) {
    await Promise.all([
        calleeId ? client.del(`callpending:${calleeId}`) : null,
        callerId ? client.del(`callringing:${callerId}`) : null,
    ]);
}

function chattingSocket(io) {

    io.use(async (socket, next) => {
        try {
            const raw = socket.handshake.headers.cookie;
            if (!raw) return next(new Error("Unauthorized"));

            const { token } = parseCookieHeader(raw);
            if (!token) return next(new Error("Unauthorized"));

            const isBlocked = await client.exists(`token:${token}`);
            if (isBlocked) return next(new Error("Unauthorized"));

            const payload = jwt.verify(token, process.env.JWT_KEY);

            const user = await User.findById(payload._id).select('isActive').lean();
            if (!user || !user.isActive) return next(new Error("Unauthorized"));

            socket.userId = String(payload._id);
            next();
        } catch (err) {
            next(new Error("Unauthorized"));
        }
    });

    io.on("connection", async (socket) => {
        const me = socket.userId;

        socket.join(me);

        const wasOffline = (await client.sCard(`online:${me}`)) === 0;
        await client.sAdd(`online:${me}`, socket.id);

        try {
            const friendIds = await getFriendIds(me);

            const onlineFlags = await Promise.all(
                friendIds.map(async (fid) => ({ fid, online: (await client.sCard(`online:${fid}`)) > 0 }))
            );
            socket.emit('presence:initial', {
                onlineUserIds: onlineFlags.filter((f) => f.online).map((f) => f.fid),
            });

            if (wasOffline) {
                friendIds.forEach((fid) => io.to(fid).emit('presence:online', { userId: me }));
            }
        } catch (err) {
            console.error("presence-on-connect failed:", err);
        }

        try {
            const now = new Date();
            const myMemberships = await Member.find({ user: me }).select('conversation lastDeliveredAt').lean();

            await Promise.all(myMemberships.map(async (m) => {
                const hasNew = await Message.exists({
                    conversation: m.conversation,
                    sender: { $ne: me },
                    deletedAt: null,
                    ...(m.lastDeliveredAt && { createdAt: { $gt: m.lastDeliveredAt } }),
                });
                if (!hasNew) return;

                await Member.updateOne({ conversation: m.conversation, user: me }, { lastDeliveredAt: now });

                io.to(String(m.conversation)).emit("delivered", {
                    conversationId: String(m.conversation),
                    userId: me,
                    deliveredAt: now,
                });
            }));
        } catch (err) {
            console.error("delivered-on-reconnect failed:", err);
        }

        socket.on("checkOnline", async (targetUserId, callback) => {
            try {
                if (!isId(targetUserId)) return callback?.({ online: false });
                const count = await client.sCard(`online:${targetUserId}`);
                callback?.({ online: count > 0 });
            } catch (err) {
                callback?.({ online: false });
            }
        });

        socket.on("joinChat", async (conversationId, callback) => {
            try {
                if (!isId(conversationId)) return callback?.({ ok: false });
                const isMember = await Member.exists({ conversation: conversationId, user: me });
                if (!isMember) return callback?.({ ok: false });
                socket.join(conversationId);
                callback?.({ ok: true });
            } catch (err) {
                callback?.({ ok: false });
            }
        });

        socket.on("leaveChat", (conversationId) => {
            socket.leave(conversationId);
        });

        socket.on("typing", async (conversationId) => {
            try {
                if (!isId(conversationId)) return;
                const members = await Member.find({ conversation: conversationId }).select('user').lean();
                if (!members.some((m) => String(m.user) === me)) return;
                members
                    .filter((m) => String(m.user) !== me)
                    .forEach((m) => io.to(String(m.user)).emit("typing", { conversationId, userId: me }));
            } catch (err) {
                console.error("typing broadcast failed:", err);
            }
        });

        socket.on("stopTyping", async (conversationId) => {
            try {
                if (!isId(conversationId)) return;
                const members = await Member.find({ conversation: conversationId }).select('user').lean();
                if (!members.some((m) => String(m.user) === me)) return;
                members
                    .filter((m) => String(m.user) !== me)
                    .forEach((m) => io.to(String(m.user)).emit("stopTyping", { conversationId, userId: me }));
            } catch (err) {
                console.error("stopTyping broadcast failed:", err);
            }
        });

        socket.on("sendMessage", async ({ conversationId, text } = {}, callback) => {
            try {
                if (!isId(conversationId)) return callback?.({ ok: false, message: "Invalid chat" });
                const payload = await chatService.sendMessage(io, { me, conversationId, text });
                callback?.({ ok: true, message: payload });
            } catch (err) {
                callback?.({ ok: false, message: err.status ? err.message : "Something went wrong" });
            }
        });

        socket.on("markRead", async (conversationId, callback) => {
            try {
                if (!isId(conversationId)) return callback?.({ ok: false });
                const result = await chatService.markRead(io, { me, conversationId });
                callback?.({ ok: true, readAt: result.lastReadAt });
            } catch (err) {
                callback?.({ ok: false });
            }
        });

        socket.on("deleteMessage", async (messageId, callback) => {
            try {
                if (!isId(messageId)) return callback?.({ ok: false });
                await chatService.deleteMessage(io, { me, messageId });
                callback?.({ ok: true });
            } catch (err) {
                callback?.({ ok: false });
            }
        });

        // ================= WebRTC call signaling =================
        // This server never touches media — only relays SDP offers/answers
        // and ICE candidates between two friends' sockets. All actual
        // audio/video routing happens peer-to-peer in the browsers.

        socket.on("call:offer", async ({ toUserId, conversationId, offer, callType, callId } = {}, callback) => {
            try {
                if (!isId(toUserId) || toUserId === me) return callback?.({ ok: false, reason: "invalid" });
                if (!offer || !['audio', 'video'].includes(callType)) return callback?.({ ok: false, reason: "invalid" });

                const isFriend = await Friendship.exists({ pairKey: getPairKey(me, toUserId), status: 'accepted' });
                if (!isFriend) return callback?.({ ok: false, reason: "not-friends" });

                const isOnline = (await client.sCard(`online:${toUserId}`)) > 0;
                if (!isOnline) return callback?.({ ok: false, reason: "offline" });

                const [myPeer, theirPeer, theirPending] = await Promise.all([
                    getCallPeer(me), getCallPeer(toUserId), getPendingCall(toUserId),
                ]);
                if (myPeer) return callback?.({ ok: false, reason: "already-in-call" });
                if (theirPeer || theirPending) {
                    io.to(me).emit('call:busy', { userId: toUserId });
                    return callback?.({ ok: false, reason: "busy" });
                }

                const caller = await User.findById(me).select(PUBLIC_CALL_FIELDS).lean();
                await setPendingCall(me, toUserId, callId);

                io.to(toUserId).emit('call:incoming', {
                    fromUserId: me,
                    fromUser: caller,
                    conversationId,
                    offer,
                    callType,
                    callId,
                });

                callback?.({ ok: true });
            } catch (err) {
                console.error("call:offer failed:", err);
                callback?.({ ok: false, reason: "error" });
            }
        });

        socket.on("call:answer", async ({ toUserId, answer, callId } = {}) => {
            try {
                if (!isId(toUserId) || !answer) return;
                const pending = await getPendingCall(me); // is someone actually ringing me, and is it them?
                if (!pending || pending.from !== toUserId || (callId && pending.callId && pending.callId !== callId)) return;

                await clearPending(toUserId, me);
                await setCallPeer(me, toUserId); // call is now considered connected
                io.to(toUserId).emit('call:answer', { fromUserId: me, answer });
            } catch (err) {
                console.error("call:answer failed:", err);
            }
        });

        socket.on("call:ice-candidate", async ({ toUserId, candidate } = {}) => {
            if (!isId(toUserId) || !candidate) return;
            // Candidates start flowing before the answer, so "active call"
            // alone isn't enough — also allow while either side is ringing.
            const [peer, iAmRingingThem, theyAreRingingMe] = await Promise.all([
                getCallPeer(me),
                client.get(`callringing:${me}`),
                getPendingCall(me),
            ]);
            const authorized = peer === toUserId
                || iAmRingingThem === toUserId
                || (theyAreRingingMe && theyAreRingingMe.from === toUserId);
            if (!authorized) return;

            io.to(toUserId).emit('call:ice-candidate', { fromUserId: me, candidate });
        });

        socket.on("call:reject", async ({ toUserId } = {}) => {
            if (!isId(toUserId)) return;
            const pending = await getPendingCall(me);
            if (pending && pending.from === toUserId) await clearPending(toUserId, me);
            io.to(toUserId).emit('call:rejected', { fromUserId: me });
        });

        socket.on("call:end", async ({ toUserId } = {}) => {
            try {
                if (!isId(toUserId)) return;

                const peer = await getCallPeer(me);
                if (peer === toUserId) {
                    io.to(toUserId).emit('call:ended', { fromUserId: me });
                    await clearCallPeer(me, toUserId);
                    return;
                }

                // not yet answered — I might be the caller cancelling, or the
                // callee hanging up before formally rejecting
                const [iAmRingingThem, theyAreRingingMe] = await Promise.all([
                    client.get(`callringing:${me}`),
                    getPendingCall(me),
                ]);
                if (iAmRingingThem === toUserId) {
                    io.to(toUserId).emit('call:ended', { fromUserId: me });
                    await clearPending(me, toUserId);
                } else if (theyAreRingingMe && theyAreRingingMe.from === toUserId) {
                    io.to(toUserId).emit('call:ended', { fromUserId: me });
                    await clearPending(toUserId, me);
                }
            } catch (err) {
                console.error("call:end failed:", err);
            }
        });
        // =============== end WebRTC call signaling ===============

        socket.on("disconnect", async () => {
            try {
                await client.sRem(`online:${me}`, socket.id);
                const remaining = await client.sCard(`online:${me}`);

                if (remaining === 0) {
                    const now = new Date();
                    await User.updateOne({ _id: me }, { lastSeenAt: now });

                    // if this was the last tab/device and they were mid-call
                    // (answered or still ringing either direction), notify the peer
                    const [peer, theyAreRingingMe, iAmRingingThem] = await Promise.all([
                        getCallPeer(me),
                        getPendingCall(me),
                        client.get(`callringing:${me}`),
                    ]);
                    if (peer) {
                        io.to(peer).emit('call:ended', { fromUserId: me });
                        await clearCallPeer(me, peer);
                    }
                    if (theyAreRingingMe) {
                        io.to(theyAreRingingMe.from).emit('call:ended', { fromUserId: me });
                        await clearPending(theyAreRingingMe.from, me);
                    }
                    if (iAmRingingThem) {
                        io.to(iAmRingingThem).emit('call:ended', { fromUserId: me });
                        await clearPending(me, iAmRingingThem);
                    }

                    const friendIds = await getFriendIds(me);
                    friendIds.forEach((fid) =>
                        io.to(fid).emit('presence:offline', { userId: me, lastSeenAt: now })
                    );
                }
            } catch (err) {
                console.error("disconnect cleanup failed:", err);
            }
        });
    });
}

module.exports = chattingSocket;