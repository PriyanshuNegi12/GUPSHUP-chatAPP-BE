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

app.set('trust proxy', 1);

const io = new Server(server, {
    cors: {
        origin: process.env.CLIENT_URL,
        credentials: true,
    },
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

async function scanAndDelete(pattern) {
    const keys = [];
    for await (const key of client.scanIterator({ MATCH: pattern, COUNT: 100 })) {
        keys.push(key);
    }
    if (keys.length) await client.del(...keys);
}

async function clearStalePresence() {
    await scanAndDelete('online:*');
}

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
        console.error("Failed to start server:", err);
        process.exit(1);
    }
}
initialConnections();