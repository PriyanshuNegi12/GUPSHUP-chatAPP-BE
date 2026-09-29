const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require('socket.io');
require('dotenv').config();
const main = require('./Config/DB');
const cors = require('cors');
const userRouter = require('./Routes/userRouter');
const client = require('./Config/Redis');
const cookieParser = require('cookie-parser');
const friendRouter = require('./Routes/friendRouter');
const chatRouter = require('./Routes/chatRouter');
const chattingSocket = require('./Routes/chattingSocket');
const { default: mongoose } = require('mongoose');

// FIX: without this, req.ip behind a reverse proxy (Render/Railway/Heroku/
// nginx, etc.) resolves to the PROXY's IP, not the visitor's. That means the
// login rate limiter's per-IP counter is effectively one shared counter for
// every single visitor — 5 failed logins from anyone locks out everyone for
// 15 minutes. `1` trusts exactly one hop (the platform's own proxy), which
// is correct for a standard single-proxy deployment.
app.set('trust proxy', 1);

const io = new Server(server, {
    cors: {
        origin: process.env.CLIENT_URL,
        credentials: true,
    },
    // How fast we notice a friend went offline without a clean disconnect
    // (wifi off, airplane mode, laptop put to sleep, tab killed by the OS —
    // none of these send a proper close, so Socket.IO can only tell via
    // this heartbeat). Defaults are pingInterval 25000 / pingTimeout 20000,
    // i.e. up to ~45s before "online" is corrected. This brings worst case
    // down to ~15s: every 10s the server pings each socket, and if a pong
    // doesn't come back within 5s it's declared dead -> disconnect fires ->
    // online:{userId} is cleared -> presence:offline is broadcast.
    pingInterval: 10000,
    pingTimeout: 5000,
});
app.set('io', io);

process.on('unhandledRejection', (err) => {
    console.error('Unhandled rejection:', err);
});

app.use(cors({
    origin: process.env.CLIENT_URL,
    credentials: true
}));

app.use(cookieParser());
app.use(express.json({ limit: '1mb' }));

app.get('/api/health', async (req, res) => {
    try {
        await client.ping();
        await mongoose.connection.db.admin().ping();
        res.status(200).send('OK');
    } catch (err) {
        // FIX: was responding 401 (Unauthorized) on a dependency failure —
        // semantically wrong, and can make load balancers / uptime monitors
        // treat "database is down" as "auth is broken".
        res.status(503).send('Service unavailable');
    }
});

app.use('/user', userRouter);
app.use('/friend', friendRouter);
app.use('/chat', chatRouter);

chattingSocket(io);

app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ message: "Something went wrong" });
});

// FIX: KEYS blocks the entire Redis event loop while it scans every key in
// the database — harmless on a tiny local dev DB, but a real stall on a
// shared/production instance with more keys. scanIterator does the same
// cleanup without blocking anything else talking to Redis.
async function scanAndDelete(pattern) {
    const keys = [];
    for await (const key of client.scanIterator({ MATCH: pattern, COUNT: 100 })) {
        keys.push(key);
    }
    if (keys.length) await client.del(keys);
}

async function clearStalePresence() {
    await scanAndDelete('online:*');
}

// NEW: if the process crashed or was force-restarted mid-call, callpeer /
// callpending / callringing keys from before the restart could otherwise
// wrongly mark real users as "already in a call" until their TTL expires.
async function clearStaleCallState() {
    await Promise.all([
        scanAndDelete('callpeer:*'),
        scanAndDelete('callpending:*'),
        scanAndDelete('callringing:*'),
    ]);
}

async function initialConnections() {
    try {
        await Promise.all([main(), client.connect()]);
        console.log("Connected to MongoDB and Redis");
        await clearStalePresence();
        await clearStaleCallState();
        server.listen(process.env.PORT_NUMBER, () => {
            console.log("Listening on port", process.env.PORT_NUMBER);
        });
    } catch (err) {
        // FIX: previously any failure here (bad Mongo URI, Redis down, etc.)
        // was only caught by the top-level unhandledRejection logger, which
        // logs and moves on — server.listen() never ran, but the process
        // stayed alive, so the app *looked* up (process running, host shows
        // green) while actually serving nothing on any route.
        console.error("Failed to start server:", err);
        process.exit(1);
    }
}
initialConnections();