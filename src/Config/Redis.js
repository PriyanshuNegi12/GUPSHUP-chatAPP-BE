const { createClient } = require('redis');

const client = createClient({
    username: 'default',
    password: process.env.REDIS_PASSWORD,
    socket: {
        host: process.env.REDIS_HOST,
        port: process.env.REDIS_PORT
    }
});

client.on('error', (err) => console.error('Redis Client Error', err)); // NEW: without this, a dropped Redis connection fails silently

module.exports = client;