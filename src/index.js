const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require('socket.io');
require('dotenv').config();
const main = require('./Config/DB'); // FIXED: was './config/DB' (lowercase) — works on Windows/Mac, breaks on Linux's case-sensitive filesystem
const cors = require('cors');
const userRouter = require('./Routes/userRouter');
const client = require('./Config/Redis');
const cookieParser = require('cookie-parser');
const friendRouter = require('./Routes/friendRouter');
const chatRouter = require('./Routes/chatRouter');
const chattingSocket = require('./Routes/chattingSocket');

const io = new Server(server, {
    cors: {
        origin: process.env.CLIENT_URL,
        credentials: true,
    },
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
        res.status(200).send('OK - dependency check failed');
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

async function initialConnections() {
    await Promise.all([main(), client.connect()]);
    console.log("Connected DB!!!!!!!");
    server.listen(process.env.PORT_NUMBER, () => {
        console.log("Listening!!!!!!");
    });
}
initialConnections();